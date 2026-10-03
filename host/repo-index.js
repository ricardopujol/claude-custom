'use strict';
/**
 * The Files tab's listing (#45): what is in this worktree, one folder at a time.
 *
 *   listFiles(root, { execFile })  -> { ok: true, files } | { ok: false, error }
 *   buildIndex(files)              -> { children(dir), has(dir), size }
 *   createIndex(root, deps)        -> { refresh({ again }), list(dir) }
 *
 * WHAT IS LISTED: `git ls-files --cached --others --exclude-standard`, so tracked files AND files that are
 * new but not ignored. The design said "tracked files only"; that would hide every file Claude has just
 * Written (an untracked file until it is staged), which is exactly what #32 is for. node_modules and
 * anything gitignored still stay out. A file deleted from the disk but still in the index is listed:
 * opening it says "deleted on disk", which is the truth.
 *
 * NEVER AN EMPTY TREE THAT READS AS A CLEAN REPO. A git that is missing, a folder that is not a repository,
 * a timeout, a buffer overflow: each is `{ ok: false, error }` with the reason in words, and a failed
 * REFRESH drops the last good tree rather than serving it as current. An empty repository is `ok` and
 * empty: a real answer.
 *
 * ASYNC, never execFileSync: this host's event loop delivers the CLI's hook events, and the helper gives
 * up after 80ms (see host/fog.js). `trackedFiles()` in host.js is sync and bounded at 4s for the old map;
 * this one doesn't block.
 */
const childProcess = require('child_process');

const LS_FILES_ARGS = ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'];
const NUL = String.fromCharCode(0);
const TIMEOUT_MS = 15000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** git -z output -> distinct paths, in order. No trim: a name may begin or end with a space. */
function parseLsFiles(out) {
  if (typeof out !== 'string' || out === '') return [];
  return [...new Set(out.split(NUL).filter(Boolean))];
}

const byName = (a, b) => {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  if (x < y) return -1;
  if (x > y) return 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

function buildIndex(files) {
  // Map of Map: a file named `__proto__` or `constructor` must be an ordinary key.
  const dirs = new Map([['', new Map()]]);
  const byLower = new Map();       // lower-cased file path -> the listing's own spelling (PR #95 Dexter D3)
  let size = 0;
  const seen = new Set();
  for (const file of files) {
    if (typeof file !== 'string' || seen.has(file)) continue;
    seen.add(file);
    const parts = file.split('/').filter(Boolean);
    if (!parts.length) continue;
    size += 1;
    byLower.set(parts.join('/').toLowerCase(), parts.join('/'));
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const isFile = i === parts.length - 1;
      const full = parts.slice(0, i + 1).join('/');
      if (!dirs.has(parent)) dirs.set(parent, new Map());
      if (!isFile && !dirs.has(full)) dirs.set(full, new Map());
      dirs.get(parent).set(parts[i], { name: parts[i], path: full, kind: isFile ? 'file' : 'dir' });
    }
  }
  return {
    size,
    has: (dir) => dirs.has(dir),
    // How the listing spells this file (Windows paths are case-insensitive: a transcript may say App\x.js for
    // app/x.js), or null when it isn't a listed file.
    resolve: (p) => (typeof p === 'string' ? byLower.get(p.toLowerCase()) || null : null),
    children(dir) {
      const m = dirs.get(dir);
      if (!m) return null;
      const all = [...m.values()];
      return [...all.filter(e => e.kind === 'dir').sort(byName), ...all.filter(e => e.kind === 'file').sort(byName)];
    },
  };
}

function explain(err, stderr) {
  const text = String(stderr || '').trim();
  if (err && err.code === 'ENOENT') return 'git is not installed or could not be started';
  if (err && (err.killed || err.signal === 'SIGTERM')) return 'git took too long (timed out) listing the files';
  if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'the file list is too large to read';
  if (/not a git repository/i.test(text)) return 'not a git repository';
  const first = text.split(/\r?\n/).find(Boolean) || (err && err.message) || 'unknown error';
  return `git failed: ${first}`;
}

function listFiles(root, { execFile = childProcess.execFile } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('git', ['-C', root, ...LS_FILES_ARGS],
        { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) { resolve({ ok: false, error: explain(err, stderr) }); return; }
          resolve({ ok: true, files: parseLsFiles(stdout) });
        });
    } catch (err) {
      resolve({ ok: false, error: explain(err, '') });
    }
  });
}

function createIndex(root, deps = {}) {
  let state = null;          // { ok: true, index } | { ok: false, error }
  let running = null;
  let rerun = false;

  async function once() {
    const r = await listFiles(root, deps);
    state = r.ok ? { ok: true, index: buildIndex(r.files) } : { ok: false, error: r.error };
    return r.ok ? { ok: true, count: state.index.size } : { ok: false, error: r.error };
  }

  function refresh(opts) {
    if (running) {
      // A change that landed while git was looking may not be in its answer: run once more after it.
      if (opts && opts.again) rerun = true;
      return running;
    }
    running = (async () => {
      let status;
      try {
        do { rerun = false; status = await once(); } while (rerun);
      } finally { running = null; }
      return status;
    })();
    return running;
  }

  // The listing's spelling of a file: a string; null when it is not listed; undefined when there is no listing
  // to ask (never read, or git failed), which is not the same as "not listed".
  function resolve(p) {
    return state && state.ok ? state.index.resolve(p) : undefined;
  }

  function list(dir) {
    if (!state) return { ok: false, error: 'the file list has not been read yet' };
    if (!state.ok) return { ok: false, error: state.error };
    const entries = state.index.children(dir);
    return entries === null ? { ok: true, entries: [], missing: true } : { ok: true, entries };
  }

  return { refresh, list, resolve };
}

module.exports = { listFiles, parseLsFiles, buildIndex, createIndex, LS_FILES_ARGS };
