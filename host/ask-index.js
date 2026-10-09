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
const SKIP_DIRS = new Set(['test', 'tests', 'verify', 'node_modules', 'dist', 'build', 'coverage', '.git', '.harness']);

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
  statFile: async (wt, rel) => { try { const s = await fsp.stat(path.join(wt, rel)); return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null; } catch { return null; } },
  readFile: (wt, rel) => fsp.readFile(path.join(wt, rel), 'utf8'),
};

const keyOf = (wt) => path.resolve(wt).replace(/\\/g, '/').toLowerCase();

function createIndex({
  dir, embedModel = 'snowflake-arctic-embed2:latest', embed, batchSize = 16, saveEvery = 25,
  listFiles = realDeps.listFiles, statFile = realDeps.statFile, readFile = realDeps.readFile, now = Date.now,
} = {}) {
  const worlds = new Map(); // key -> { data, loaded, running, progress }

  const world = (wt) => {
    const k = keyOf(wt);
    if (!worlds.has(k)) worlds.set(k, { data: null, loaded: false, running: null, progress: { state: 'none', done: 0, total: 0 } });
    return worlds.get(k);
  };
  const fileFor = (wt) => path.join(dir, crypto.createHash('sha1').update(keyOf(wt)).digest('hex').slice(0, 16) + '.json');

  async function load(wt, w) {
    if (w.loaded) return;
    w.loaded = true;
    try {
      const p = JSON.parse(await fsp.readFile(fileFor(wt), 'utf8'));
      if (!p || p.version !== VERSION || p.embedModel !== embedModel || !Array.isArray(p.files)) return;
      w.data = {
        embedModel, builtAt: p.builtAt,
        files: p.files.map(f => ({
          rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, lines: f.lines,
          chunks: f.chunks.map(c => ({ start: c.s, end: c.e, ownStart: c.o, text: c.t, vec: typeof c.v === 'string' ? b64ToVec(c.v) : null })),
        })),
      };
      if (w.progress.state === 'none') w.progress = { state: 'ready', done: w.data.files.length, total: w.data.files.length };
    } catch { /* missing, corrupt, or from another version: an empty index, rebuilt */ }
  }

  async function save(wt, data) {
    const out = {
      version: VERSION, embedModel, worktree: path.resolve(wt), builtAt: data.builtAt,
      files: data.files.map(f => ({
        rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, lines: f.lines,
        chunks: f.chunks.map(c => ({ s: c.start, e: c.end, o: c.ownStart, t: c.text, v: c.vec ? vecToB64(c.vec) : null })),
      })),
    };
    try {
      await fsp.mkdir(dir, { recursive: true });
      const file = fileFor(wt);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        await fsp.writeFile(tmp, JSON.stringify(out), 'utf8');
        await renameWithRetryAsync(tmp, file);
      } catch (err) {
        try { await fsp.unlink(tmp); } catch { /* nothing left */ }
        throw err;
      }
    } catch (err) {
      console.warn('[ask-index] could not save the index:', err && err.message); // a lost save is a rebuild next launch, said once
    }
  }

  const needsVectors = (f) => f.chunks.some(c => c.vec === null);

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
    let sinceSave = 0;

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
      if (++sinceSave >= saveEvery) { sinceSave = 0; await save(wt, assemble()); }
    }

    // Files whose read failed are not in `done`; a stale copy of one is not kept either (it no longer matches the disk).
    w.data = assemble();
    await save(wt, w.data);
    const chunks = w.data.files.reduce((n, f) => n + f.chunks.length, 0);
    const keywordOnly = w.data.files.some(needsVectors);
    w.progress = { state: 'ready', done: todo.length, total: todo.length };
    return {
      files: w.data.files.length, chunks, embedded, reused: kept.length - todo.filter(t => t.prev).length, removed, unreadable,
      keywordOnly, embedFailure,
    };
  }

  function refresh(wt) {
    const w = world(wt);
    if (w.running) return w.running;
    w.running = run(wt, w).finally(() => { w.running = null; });
    return w.running;
  }

  return {
    refresh,
    get: (wt) => world(wt).data,
    load: async (wt) => { const w = world(wt); await load(wt, w); return w.data; },
    isRunning: (wt) => Boolean(world(wt).running),
    progress: (wt) => ({ ...world(wt).progress }),
    fileFor,
  };
}

module.exports = { createIndex, isIndexable, vecToB64, b64ToVec, VERSION, realDeps };
