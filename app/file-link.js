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
 * streams (a ':' past the drive), NUL. Relative paths resolve against the
 * clicked tab's own folder (tab.cwd), never the app's.
 */
const path = require('path');

const MAX_PATH = 1024, MAX_LISTS = 32, MAX_OPTIONS = 8;

const OPENABLE = new Set([
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.csv', '.tsv',
  '.xml', '.html', '.htm', '.pdf',
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

// What `abs` is on disk: { isDir, action } or null when it's neither a file
// nor a folder, or can't be read.
async function inspect(abs, fsApi) {
  let st;
  try { st = await fsApi.stat(abs); } catch { return null; }
  const isDir = st.isDirectory();
  if (!isDir && !st.isFile()) return null;
  let real = abs;
  try { real = await fsApi.realpath(abs); } catch { /* keep the given one */ }
  return { isDir, action: actionFor({ given: abs, real: String(real), isDir }) };
}

async function check(lists, cwd, fsApi) {
  if (!Array.isArray(lists)) return [];
  return Promise.all(lists.slice(0, MAX_LISTS).map(async (options) => {
    if (!Array.isArray(options)) return null;
    const opts = options.slice(0, MAX_OPTIONS);
    for (let i = 0; i < opts.length; i++) {
      const abs = safePath(opts[i], cwd);
      if (!abs) continue;
      const found = await inspect(abs, fsApi);
      if (found) return { option: i, path: abs, action: found.action, isDir: found.isDir, name: path.win32.basename(abs) };
    }
    return null;
  }));
}

async function open(p, cwd, fsApi, shellApi) {
  const abs = safePath(p, cwd);
  if (!abs) return { ok: false, why: 'refused' };
  const found = await inspect(abs, fsApi);
  if (!found) return { ok: false, why: 'gone' };
  try {
    if (found.action === 'reveal') {
      shellApi.showItemInFolder(abs);
      return { ok: true, action: 'reveal' };
    }
    const err = await shellApi.openPath(abs);
    return err ? { ok: false, why: String(err) } : { ok: true, action: 'open' };
  } catch (err) {
    return { ok: false, why: (err && err.message) || 'failed' };
  }
}

module.exports = { OPENABLE, safePath, actionFor, check, open, MAX_LISTS, MAX_OPTIONS };
