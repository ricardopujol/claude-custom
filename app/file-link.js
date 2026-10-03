'use strict';
/**
 * A local path clicked in a tab's terminal (#37): what it is, and what a click
 * may do with it. Main only; the page asks, main decides, and decides AGAIN on
 * the click (a file can change between hover and click).
 *
 *   safePath(p, cwd)        -> absolute normalised path | null      (pure)
 *   actionFor({ given, real, isDir }) -> 'open' | 'reveal'           (pure)
 *   check(lists, cwd, fsApi) -> per list, the FIRST path that exists:
 *                               { option, path, action, isDir, name } | null
 *   open(p, cwd, fsApi, shellApi) -> { ok: true, action } | { ok: false, why }
 *
 * NEVER HAND THE OS SOMETHING IT RUNS. shell.openPath is ShellExecute: it
 * runs .exe .bat .cmd .ps1 .vbs .js .hta .msi .reg .scr .lnk .url, and .py or
 * .sh too when Python or Git Bash is installed. A list of what's dangerous
 * always misses one, so this is an ALLOWLIST: only OPENABLE extensions open,
 * and only when the path as written AND the file it really is (realpath) both
 * have one. Everything else, including no extension, is shown in Explorer.
 * Folders open.
 *
 * What OPENABLE still lets run (PR #92, Miguel I1): .html/.htm/.svg run
 * script, but inside the browser's sandbox, as any web page does; opening
 * Claude's .html mocks is what #37 is for. Formats that carry macros or
 * embedded objects for a desktop app are off the list: .doc .xls .ppt (and
 * their m variants), .odt .ods .odp, .rtf. The macro-free .docx .xlsx .pptx
 * stay.
 *
 * Never touched, not even stat-ed: UNC paths (\\server\share -- the existence
 * check alone would send Windows credentials to that server), device paths
 * (\\?\, \\.\), rooted (\x) and drive-relative (C:x) paths, alternate data
 * streams (a ':' past the drive), NUL, and names ending in a dot or space.
 * A path whose LAST component is a symlink to a UNC target is refused after
 * one lstat, before anything follows it (PR #92 Dexter F3). Not covered: a
 * symlink or junction in an EARLIER component pointing at a share -- planting
 * one needs write access to the disk and the right to make links, and
 * checking every component would cost an lstat each per hover.
 * Relative paths resolve against the clicked tab's own folder (tab.cwd),
 * never the app's.
 */
const path = require('path');

// One set of caps for the page and main (PR #92 Miguel S1).
const { MAX_PATH_LENGTH: MAX_PATH, MAX_CANDIDATES: MAX_LISTS, MAX_OPTIONS } = require('./file-path-parse');

const OPENABLE = new Set([
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.csv', '.tsv',
  '.html', '.htm', '.pdf',              // not .xml: Office opens Word 2003 XML, macros and all (Dexter F6)
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tif', '.tiff',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.mp4', '.mov', '.mkv', '.webm', '.avi',
  '.docx', '.xlsx', '.pptx',
  '.rpp',                                           // Reaper projects
]);

const DRIVE_ABS = /^[A-Za-z]:[\\/]/;

function safePath(p, cwd) {
  if (typeof p !== 'string' || p === '' || p.length > MAX_PATH || p.includes('\u0000')) return null;
  if (typeof cwd !== 'string' || !DRIVE_ABS.test(cwd)) return null;
  let abs;
  if (DRIVE_ABS.test(p)) abs = path.win32.normalize(p);
  else if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return null;   // UNC, device, rooted, drive-relative
  else abs = path.win32.resolve(cwd, p);
  if (!/^[A-Za-z]:\\/.test(abs) || abs.indexOf(':', 2) !== -1 || abs.length > MAX_PATH) return null;
  // Windows strips a trailing dot or space from a name; Node's stat (through
  // \\?\) does not. So `C:\x\tool.exe.` can stat as a FOLDER named that while
  // ShellExecute opens the FILE `tool.exe` and runs it (PR #92 Dexter F2).
  // Such a name means two different files to the two of them: refused.
  if (abs.slice(3).split('\\').some(seg => /[. ]$/.test(seg))) return null;
  return abs;
}

const extOf = (p) => path.win32.extname(p).toLowerCase();

// (path.win32.extname('a.txt.') is '.', and 'a.txt ' gives '.txt ': neither
// is on the list, so Windows stripping trailing dots and spaces can't sneak an
// .exe through.)
function actionFor({ given, real, isDir }) {
  if (isDir === true) return 'open';
  return OPENABLE.has(extOf(given)) && OPENABLE.has(extOf(real)) ? 'open' : 'reveal';
}

// A DEAD DRIVE MUST NOT STALL MAIN (PR #92 Miguel I3). Every hover asks main
// to stat up to MAX_LISTS x MAX_OPTIONS paths; a disconnected mapped drive can
// leave a stat hanging for a long time and hold one of libuv's few threadpool
// threads with it. So each stat (and realpath) races a timeout; a drive that
// timed out is skipped for SLOW_MS; and hover answers are cached for CACHE_MS,
// since a pointer moving along one row asks the same paths again and again.
// A click never uses the cache or the slow-drive skip: it re-decides from the
// disk (PR #92 Dexter F8: one slow stat used to fail every click on C: for a
// minute). The skip lasts SLOW_MS, short enough that a one-off slow stat on a
// local drive costs seconds of hover links, not a minute.
const TIMEOUT_MS = 1500, SLOW_MS = 15000, CACHE_MS = 2000, CACHE_MAX = 500;
const TIMED_OUT = Symbol('timed out');
const REFUSED = Symbol('refused');

// A link target that reaches a server: \\server\share, //server/share,
// \\?\UNC\server\share, UNC\server. (\\?\C:\x is a local device path.)
function remoteTarget(t) {
  const s = String(t);
  if (/^\\\\\?\\[A-Za-z]:\\/.test(s)) return false;
  return /^[\\/]{2}/.test(s) || /^UNC\\/i.test(s);
}
const newState = () => ({ slow: new Map(), cache: new Map() });
const DEFAULT_STATE = newState();
const driveOf = (abs) => abs.slice(0, 2).toUpperCase();

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([Promise.resolve(promise), late]).finally(() => clearTimeout(timer));
}

// What `abs` is on disk: { isDir, action }; null when it's neither a file nor
// a folder, or can't be read; TIMED_OUT when its drive didn't answer in time;
// REFUSED when it is a symlink to a server. `click`: ignore the slow-drive skip.
async function inspect(abs, fsApi, { state = DEFAULT_STATE, now = Date.now, timeoutMs = TIMEOUT_MS, click = false } = {}) {
  const drive = driveOf(abs);
  if (!click && (state.slow.get(drive) || 0) > now()) return TIMED_OUT;
  const slow = () => { state.slow.set(drive, now() + SLOW_MS); return TIMED_OUT; };
  // lstat does NOT follow a link; stat would, and following one to
  // \\attacker\share sends Windows credentials there (PR #92 Dexter F3).
  if (typeof fsApi.lstat === 'function') {
    let lst;
    try { lst = await withTimeout(fsApi.lstat(abs), timeoutMs); } catch { return null; }
    if (lst === TIMED_OUT) return slow();
    if (lst.isSymbolicLink()) {
      if (typeof fsApi.readlink !== 'function') return REFUSED;
      let target;
      try { target = await withTimeout(fsApi.readlink(abs), timeoutMs); } catch { return REFUSED; }
      if (target === TIMED_OUT) return slow();
      if (remoteTarget(target)) return REFUSED;
    }
  }
  let st;
  try { st = await withTimeout(fsApi.stat(abs), timeoutMs); } catch { return null; }
  if (st === TIMED_OUT) return slow();
  const isDir = st.isDirectory();
  if (!isDir && !st.isFile()) return null;
  let real = abs;
  try {
    const r = await withTimeout(fsApi.realpath(abs), timeoutMs);
    if (r === TIMED_OUT) return slow();
    real = r;
  } catch { /* keep the given one */ }
  // `real` only decides; what is opened is always `abs`. A mapped drive's
  // realpath can be a UNC path, and opening THAT would reach the server
  // (PR #92 Miguel S8).
  return { isDir, action: actionFor({ given: abs, real: String(real), isDir }) };
}

async function cachedInspect(abs, fsApi, opts) {
  const { state = DEFAULT_STATE, now = Date.now } = opts;
  const hit = state.cache.get(abs);
  if (hit && now() - hit.at < CACHE_MS) return hit.found;
  let found = await inspect(abs, fsApi, opts);
  if (found === TIMED_OUT) return null;
  if (found === REFUSED) found = null;
  if (state.cache.size >= CACHE_MAX) state.cache.clear();
  state.cache.set(abs, { found, at: now() });
  return found;
}

async function check(lists, cwd, fsApi, opts = {}) {
  if (!Array.isArray(lists)) return [];
  return Promise.all(lists.slice(0, MAX_LISTS).map(async (options) => {
    if (!Array.isArray(options)) return null;
    const opts8 = options.slice(0, MAX_OPTIONS);
    for (let i = 0; i < opts8.length; i++) {
      const abs = safePath(opts8[i], cwd);
      if (!abs) continue;
      const found = await cachedInspect(abs, fsApi, opts);
      if (found) return { option: i, path: abs, action: found.action, isDir: found.isDir, name: path.win32.basename(abs) };
    }
    return null;
  }));
}

async function open(p, cwd, fsApi, shellApi, opts = {}) {
  const abs = safePath(p, cwd);
  if (!abs) return { ok: false, why: 'refused' };
  const found = await inspect(abs, fsApi, { ...opts, click: true });
  if (found === TIMED_OUT) return { ok: false, why: 'timed out' };
  if (found === REFUSED) return { ok: false, why: 'refused' };
  if (!found) return { ok: false, why: 'gone' };
  try {
    if (found.action === 'reveal') {
      shellApi.showItemInFolder(abs);
      return { ok: true, action: 'reveal' };
    }
    // A folder is opened WITH a trailing separator: if a file were swapped in
    // its place after the check, ShellExecute fails on `file\` instead of
    // running it (PR #92 Dexter F2).
    const err = await shellApi.openPath(found.isDir ? `${abs.replace(/\\+$/, '')}\\` : abs);
    return err ? { ok: false, why: String(err) } : { ok: true, action: 'open' };
  } catch (err) {
    return { ok: false, why: (err && err.message) || 'failed' };
  }
}

module.exports = { OPENABLE, safePath, actionFor, check, open, newState, MAX_LISTS, MAX_OPTIONS };
