'use strict';
/**
 * Main's half of the fonts (BACKLOG #88):
 *
 *   fonts:get / fonts:set   the install-wide terminal font, terminal size and interface font. Electron main owns them as it owns
 *                           `look-global` and the dock layout (app/layout-bridge.js has the reasoning): a personal UI preference
 *                           with no per-project meaning, so it never round-trips through a host. Its own key,
 *                           `.harness/state/fonts-global.json`. Everything is sanitized HERE (app/fonts-display.js) before it is
 *                           saved or pushed, so a compromised page cannot store a value that breaks a CSS font stack.
 *   fonts:list              every font family installed on this PC. Enumerated host-side because Electron 33 has no
 *                           `queryLocalFonts` (measured 2026-10-14): PowerShell's InstalledFontCollection on Windows (0.3 s, 186
 *                           families here, per-user installs included), `fc-list` elsewhere. Cached for a short while and asked
 *                           again after it, so a font installed later appears on its own.
 *
 * Other project windows are other mains sharing the store file: the layout bridge's `watchLayout` follows this record too (given
 * FONT_NAMES), so a change in one window reaches the rest.
 *
 * Its own module so it can be tested without booting Electron.
 */
const { execFile } = require('child_process');
const { readLayoutState } = require('./layout-bridge');
const { sanitizeSettings, parseFamilyList, sanitizeFamily, stackFor } = require('./fonts-display');

const FONTS_KEY = 'fonts-global';
const GET_CHANNEL = 'fonts:get';
const SET_CHANNEL = 'fonts:set';
const LIST_CHANNEL = 'fonts:list';
const PUSH_CHANNEL = 'fonts-global';
const FONT_NAMES = { key: FONTS_KEY, get: GET_CHANNEL, set: SET_CHANNEL, push: PUSH_CHANNEL };

const LIST_TTL_MS = 30000;
const LIST_TIMEOUT_MS = 15000;
// Windows PowerShell writes piped output in the OEM code page, which execFile would decode as UTF-8 and turn every non-ASCII family
// name into U+FFFD: the script says UTF-8 first.
const POWERSHELL_FONTS = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; '
  + '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }';

// By its full path, so a planted powershell.exe in the working directory or an odd PATH is never what runs.
function powershellPath(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function defaultRun(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: LIST_TIMEOUT_MS, maxBuffer: 4 * 1048576 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

/**
 * fc-list prints `Family[,Alias...]` per face, with backslash escapes in a name (`Go\-Mono`, `A\, B`): the first name of the line is
 * the family, split at the first UNESCAPED comma, with its escapes removed.
 */
function firstFamilies(stdout) {
  if (typeof stdout !== 'string') return '';
  return stdout.split(/\r?\n/).map((line) => {
    let name = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\' && i + 1 < line.length) { name += line[i + 1]; i += 1; continue; }
      if (c === ',') break;
      name += c;
    }
    return name;
  }).join('\n');
}

function createFontLister({ platform = process.platform, run = defaultRun, now = Date.now, ttlMs = LIST_TTL_MS } = {}) {
  let cached = null;       // { at, families }
  let inFlight = null;
  async function enumerate() {
    if (platform === 'win32') {
      return parseFamilyList(await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_FONTS]));
    }
    return parseFamilyList(firstFamilies(await run('fc-list', [':', 'family'])));
  }
  return {
    async list() {
      if (cached && now() - cached.at < ttlMs) return cached.families;
      if (inFlight) return inFlight;
      inFlight = enumerate().then((families) => {
        cached = { at: now(), families };
        return families;
      }).finally(() => { inFlight = null; });     // a failure is not cached: the next ask tries again
      return inFlight;
    },
  };
}

/**
 * The script main runs in the tab strip and the indexing overlay (separate pages with their own tiny bridges, so no new member is
 * added to either) to give them the interface font: it sets or clears `--font-ui`, which their stylesheets read with the old font as
 * the fallback. The stack is built from the sanitized family only, and embedded as a JSON string.
 */
function uiFontScript(settings) {
  const family = sanitizeFamily(settings && settings.uiFont);
  if (!family) return "document.documentElement.style.removeProperty('--font-ui')";
  return `document.documentElement.style.setProperty('--font-ui', ${JSON.stringify(stackFor(family, 'ui'))})`;
}

/** The stored settings, sanitized (the defaults when the record is missing or unreadable). */
function readFontSettings(store) {
  return sanitizeSettings(readLayoutState(store, FONTS_KEY).layout);
}

function registerFontHandlers({ ipcMain, store, sync = {}, isSender, send, lister = createFontLister() }) {
  const fromView = (e) => !!e && typeof isSender === 'function' && isSender(e.sender) === true;

  ipcMain.handle(GET_CHANNEL, (e) => {
    if (!fromView(e)) return null;
    const answer = readLayoutState(store, FONTS_KEY);
    // The page may treat only `ok` and `missing` as an answer; an unreadable or corrupt record is said, never defaulted silently.
    return { status: answer.status, settings: sanitizeSettings(answer.layout) };
  });

  // `value` is a PATCH: only the fields it names change, merged into the record as it is NOW, under the store's lock. A page that
  // sent the whole record from its cache would undo what another window saved a moment earlier (Dexter 3).
  ipcMain.handle(SET_CHANNEL, (e, value) => {
    if (!fromView(e)) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const own = (k) => Object.prototype.hasOwnProperty.call(value, k);
    const patch = {};
    const cleanPatch = sanitizeSettings(value);
    for (const key of ['terminalFont', 'terminalSize', 'uiFont']) if (own(key)) patch[key] = cleanPatch[key];
    let clean;
    try {
      store.update(FONTS_KEY, null, (prev) => { clean = { ...sanitizeSettings(prev), ...patch }; return clean; });
    } catch (err) {
      console.error('[main] could not save the fonts:', err && err.message);
      return null;
    }
    // The watcher must know what this window was just told, or it would push the same record back when its own write lands.
    sync.last = JSON.stringify(clean);
    try { send(PUSH_CHANNEL, clean); } catch { /* window is going away */ }
    return clean;
  });

  ipcMain.handle(LIST_CHANNEL, async (e) => {
    if (!fromView(e)) return null;
    try {
      return { ok: true, families: await lister.list() };
    } catch (err) {
      return { ok: false, error: `couldn't list the installed fonts: ${(err && err.message) || 'unknown reason'}` };
    }
  });
}

module.exports = {
  registerFontHandlers, createFontLister, firstFamilies, powershellPath, POWERSHELL_FONTS, uiFontScript, readFontSettings,
  FONTS_KEY, FONT_NAMES, GET_CHANNEL, SET_CHANNEL, LIST_CHANNEL, PUSH_CHANNEL, LIST_TTL_MS,
};
