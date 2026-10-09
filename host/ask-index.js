'use strict';
/**
 * The per-worktree index behind "ask the repo" (BACKLOG #33, DESIGN_ASK_REPO.md): every indexable file of one worktree,
 * chunked (host/ask-chunks.js) with an embedding per chunk, kept in memory and saved to `dir` (the app's data folder, keyed
 * by worktree path) -- NEVER inside the worktree, so it cannot be committed, linted, or searched by the very thing it serves.
 *
 *   createIndex({ dir, embedModel, listFiles, statFile, readFile, embed, ... })
 *     .refresh(worktree)  -> { files, chunks, embedded, reused, removed, unreadable, keywordOnly, embedFailure }
 *     .get(worktree)      -> { files: [{ rel, size, mtimeMs, lines, chunks: [{ start, end, ownStart, text, vec }] }], ... } | null
 *     .progress(worktree) -> { state: 'none' | 'building' | 'ready', done, total }
 *
 * REFRESH IS INCREMENTAL, by the memo pattern of host/agent-stats-cache.js: a file whose size+mtime match what was saved is
 * trusted outright; a changed or new file is re-chunked and re-embedded; a file that is gone is dropped, never left behind.
 * The property that matters (test/ask-index.test.js): after ANY sequence of edits, an incremental refresh gives exactly the
 * index a from-scratch build gives. A first build of this repo is 7-10 minutes of embedding (2026-10-03 measurement), so a
 * build is saved every few files and survives an interrupted run, and its progress is readable while it runs.
 *
 * ONE RUN AT A TIME per worktree: a refresh asked for while another runs gets that run's promise.
 *
 * THE EMBEDDER BEING DOWN IS NOT AN ERROR HERE. The chunks are kept with `vec: null` (keywords still work), the result says
 * `keywordOnly: true` and why, and the next refresh fills the missing vectors in. After one failed batch the rest of that
 * refresh does not hammer a stopped Ollama.
 *
 * What is indexed is the 2026-10-03 finding: test/ and verify/ repeat every identifier and crowd the source out of the top
 * results (excluding them lifted recall 2-4 questions of 10), so they, vendored code, lockfiles and huge files stay out.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { chunkFile, splitLines } = require('./ask-chunks');
const { renameWithRetryAsync } = require('./atomic-write');

const VERSION = 1;
const MAX_FILE_BYTES = 400_000;
const EMBED_INPUT_CHARS = 2000;
const INDEXABLE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.md', '.css', '.html', '.py', '.ps1']);
const SKIP_DIRS = new Set(['test', 'tests', 'verify', 'node_modules', 'vendor', 'third_party', 'dist', 'build', 'coverage', '.git', '.harness']);
const SAVE_EVERY_MS = 10_000;
const ORPHAN_TMP_MS = 3600_000;

function isIndexable(rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/');
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some(p => SKIP_DIRS.has(p))) return false;
  if (/\.min\.[a-z]+$/i.test(name) || /^(package-lock|pnpm-lock|yarn\.lock)/i.test(name)) return false;
  return INDEXABLE_EXT.has(path.extname(name).toLowerCase());
}

const vecToB64 = (v) => Buffer.from(Float32Array.from(v).buffer).toString('base64');
function b64ToVec(s) {
  const b = Buffer.from(s, 'base64');
  const copy = new Uint8Array(b.length); copy.set(b); // a fresh, aligned buffer: Buffer's pool is not
  return new Float32Array(copy.buffer, 0, Math.floor(copy.length / 4));
}

/** The real filesystem / git behind the injected seams. */
const realDeps = {
  listFiles: (wt) => new Promise((resolve, reject) => {
    execFile('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: wt, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, out) => {
      if (err) reject(err); else resolve(String(out).split('\0').filter(Boolean));
    });
  }),
  // lstat, not stat: git lists a tracked symlink as an entry, and following it would index a file outside the worktree (PR #136 S2).
  statFile: async (wt, rel) => { try { const s = await fsp.lstat(path.join(wt, rel)); return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null; } catch { return null; } },
  readFile: (wt, rel) => fsp.readFile(path.join(wt, rel), 'utf8'),
};

const keyOf = (wt) => path.resolve(wt).replace(/\\/g, '/').toLowerCase();

function createIndex({
  dir, embedModel = 'snowflake-arctic-embed2:latest', embed, batchSize = 16, saveEveryMs = SAVE_EVERY_MS,
  listFiles = realDeps.listFiles, statFile = realDeps.statFile, readFile = realDeps.readFile, now = Date.now,
  readIndexFile = (f) => fsp.readFile(f, 'utf8'), writeIndexFile = (f, text) => fsp.writeFile(f, text, 'utf8'),
} = {}) {
  const worlds = new Map(); // key -> { data, loading, running, progress, partial, error }
  const needsVectors = (f) => f.chunks.some(c => c.vec === null);
  const serialised = new WeakMap(); // a finished file's JSON text, so a save re-stringifies only what changed

  const world = (wt) => {
    const k = keyOf(wt);
    if (!worlds.has(k)) worlds.set(k, { data: null, loading: null, running: null, partial: false, error: null, progress: { state: 'none', done: 0, total: 0 } });
    return worlds.get(k);
  };
  const fileFor = (wt) => path.join(dir, crypto.createHash('sha1').update(keyOf(wt)).digest('hex').slice(0, 16) + '.json');

  // The latch is the PROMISE of the read, not a flag set before it (PR #136 Dexter D1): a second caller during the read waits
  // for the same answer instead of seeing "no index" and re-embedding every file over the saved one.
  function load(wt, w) {
    if (!w.loading) w.loading = readSaved(wt, w);
    return w.loading;
  }

  async function readSaved(wt, w) {
    try {
      const p = JSON.parse(await readIndexFile(fileFor(wt)));
      if (!p || p.version !== VERSION || p.embedModel !== embedModel || !Array.isArray(p.files)) return;
      w.data = {
        embedModel, builtAt: p.builtAt,
        files: p.files.map(f => ({
          rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, lines: f.lines,
          chunks: f.chunks.map(c => ({ start: c.s, end: c.e, ownStart: c.o, text: c.t, vec: typeof c.v === 'string' ? b64ToVec(c.v) : null })),
        })),
      };
      // A save made mid-build says so: it loads as 'partial' and the build resumes (M5), never as a finished index.
      w.partial = p.complete === false;
      if (w.progress.state === 'none') w.progress = { state: w.partial ? 'partial' : 'ready', done: w.data.files.length, total: w.data.files.length };
    } catch { /* missing, corrupt, or from another version: an empty index, rebuilt */ }
  }

  // Stringified a few files at a time with a turn of the event loop between, and a finished file's text kept: a save of a
  // 3,000-chunk index used to stall the host for the whole stringify, every 25 files (PR #136 M3).
  async function serialise(wt, data, complete) {
    const parts = [];
    for (let i = 0; i < data.files.length; i++) {
      const f = data.files[i];
      let text = serialised.get(f);
      if (text === undefined) {
        text = JSON.stringify({
          rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, lines: f.lines,
          chunks: f.chunks.map(c => ({ s: c.start, e: c.end, o: c.ownStart, t: c.text, v: c.vec ? vecToB64(c.vec) : null })),
        });
        if (!needsVectors(f)) serialised.set(f, text);
      }
      parts.push(text);
      if (i % 20 === 19) await new Promise(resolve => setImmediate(resolve));
    }
    // The header comes first and small, so a sweep can read which worktree a file belongs to without parsing 20 MB.
    const head = JSON.stringify({ version: VERSION, embedModel, worktree: path.resolve(wt), builtAt: data.builtAt, complete });
    return head.slice(0, -1) + ',"files":[' + parts.join(',') + ']}';
  }

  async function save(wt, data, complete) {
    try {
      const text = await serialise(wt, data, complete);
      await fsp.mkdir(dir, { recursive: true });
      const file = fileFor(wt);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        await writeIndexFile(tmp, text);
        await renameWithRetryAsync(tmp, file);
      } catch (err) {
        try { await fsp.unlink(tmp); } catch { /* nothing left */ }
        throw err;
      }
    } catch (err) {
      console.warn('[ask-index] could not save the index:', err && err.message); // a lost save is a rebuild next launch, said once
    }
  }

  async function run(wt, w) {
    await load(wt, w);
    const listed = (await listFiles(wt)).map(r => String(r).replace(/\\/g, '/')).filter(isIndexable);
    const previous = new Map((w.data ? w.data.files : []).map(f => [f.rel, f]));
    const kept = [];
    const todo = [];
    let unreadable = 0;
    for (const rel of [...new Set(listed)].sort()) {
      const st = await statFile(wt, rel);
      if (!st || st.size > MAX_FILE_BYTES) continue;
      const prev = previous.get(rel);
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) { kept.push(prev); if (needsVectors(prev)) todo.push({ rel, st, prev }); } else todo.push({ rel, st });
    }
    const removed = [...previous.keys()].filter(r => !kept.some(f => f.rel === r) && !todo.some(t => t.rel === r)).length;

    w.progress = { state: 'building', done: 0, total: todo.length };
    let embedded = 0;
    let embedFailure = null;
    const done = new Map();
    let lastSave = now();

    const assemble = () => {
      const byRel = new Map(kept.map(f => [f.rel, f]));
      for (const [rel, f] of done) byRel.set(rel, f);
      return { embedModel, builtAt: now(), files: [...byRel.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1)) };
    };

    for (const t of todo) {
      let file = t.prev;
      if (!file) {
        let text;
        try { text = await readFile(wt, t.rel); } catch { unreadable++; w.progress.done++; continue; }
        const lines = splitLines(text).length;
        const chunks = chunkFile(t.rel, text).map(c => ({ start: c.start, end: c.end, ownStart: c.ownStart, text: c.text, vec: null }));
        file = { rel: t.rel, size: t.st.size, mtimeMs: t.st.mtimeMs, lines, chunks };
      }
      if (!embedFailure && file.chunks.length) {
        for (let i = 0; i < file.chunks.length; i += batchSize) {
          const batch = file.chunks.slice(i, i + batchSize);
          const r = await embed(batch.map(c => `${t.rel}:${c.start}-${c.end}\n${c.text}`.slice(0, EMBED_INPUT_CHARS)));
          if (!r.ok) { embedFailure = r.reason; break; }
          batch.forEach((c, j) => { c.vec = Float32Array.from(r.vectors[j]); });
        }
        if (embedFailure) file.chunks.forEach(c => { c.vec = null; }); // a half-embedded file is all-or-nothing: retried whole
      }
      if (!needsVectors(file)) embedded++;
      done.set(t.rel, file);
      w.progress.done++;
      if (now() - lastSave >= saveEveryMs) { await save(wt, assemble(), false); lastSave = now(); }
    }

    // Files whose read failed are not in `done`; a stale copy of one is not kept either (it no longer matches the disk).
    w.data = assemble();
    await save(wt, w.data, true);
    w.partial = false;
    w.error = null;
    const chunks = w.data.files.reduce((n, f) => n + f.chunks.length, 0);
    const keywordOnly = w.data.files.some(needsVectors);
    w.progress = { state: 'ready', done: todo.length, total: todo.length };
    return {
      files: w.data.files.length, chunks, embedded, reused: kept.length - todo.filter(t => t.prev).length, removed, unreadable,
      keywordOnly, embedFailure,
    };
  }

  /** Forget a worktree: its saved index and its in-memory state (for /merged housekeeping). */
  async function drop(wt) {
    worlds.delete(keyOf(wt));
    try { await fsp.unlink(fileFor(wt)); } catch { /* nothing saved */ }
  }

  /**
   * Remove indexes whose worktree folder no longer exists, and tmp files an interrupted save left behind (older than an hour: a
   * live save lasts seconds, and another host may be writing one). Best effort: one unreadable entry doesn't stop the sweep.
   */
  async function sweep({ exists = (p) => fs.existsSync(p) } = {}) {
    let removedIndexes = 0; let removedTmp = 0;
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return { removedIndexes, removedTmp }; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (name.endsWith('.tmp')) {
          if (Date.now() - (await fsp.stat(file)).mtimeMs > ORPHAN_TMP_MS) { await fsp.unlink(file); removedTmp++; }
        } else if (name.endsWith('.json')) {
          const fh = await fsp.open(file, 'r');
          let head = '';
          try { const buf = Buffer.alloc(2048); const { bytesRead } = await fh.read(buf, 0, 2048, 0); head = buf.toString('utf8', 0, bytesRead); } finally { await fh.close(); }
          const m = /"worktree":("(?:[^"\\]|\\.)*")/.exec(head);
          if (m && !exists(JSON.parse(m[1]))) { await fsp.unlink(file); removedIndexes++; }
        }
      } catch { /* see above */ }
    }
    return { removedIndexes, removedTmp };
  }

  function refresh(wt) {
    const w = world(wt);
    if (w.running) return w.running;
    // A failed run is REMEMBERED (PR #136 D2/M1): with no saved index the state is 'failed' with the reason; over a saved one the
    // data stays usable but carries the error until a refresh succeeds. It never stays looking like a build in progress.
    w.running = run(wt, w).catch((err) => {
      w.error = (err && err.message) || String(err);
      w.progress = { state: w.data ? (w.partial ? 'partial' : 'ready') : 'failed', done: w.progress.done, total: w.progress.total };
      throw err;
    }).finally(() => { w.running = null; });
    return w.running;
  }

  return {
    refresh,
    get: (wt) => world(wt).data,
    load: async (wt) => { const w = world(wt); await load(wt, w); return w.data; },
    isRunning: (wt) => Boolean(world(wt).running),
    progress: (wt) => {
      const w = world(wt);
      return { ...w.progress, partial: w.partial, ...(w.error ? { error: w.error } : {}) };
    },
    fileFor,
    drop,
    sweep,
  };
}

module.exports = { createIndex, isIndexable, vecToB64, b64ToVec, VERSION, realDeps };
