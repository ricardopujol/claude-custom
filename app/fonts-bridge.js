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
const { sanitizeSettings, parseFamilyList } = require('./fonts-display');

const FONTS_KEY = 'fonts-global';
const GET_CHANNEL = 'fonts:get';
const SET_CHANNEL = 'fonts:set';
const LIST_CHANNEL = 'fonts:list';
const PUSH_CHANNEL = 'fonts-global';
const FONT_NAMES = { key: FONTS_KEY, get: GET_CHANNEL, set: SET_CHANNEL, push: PUSH_CHANNEL };

const LIST_TTL_MS = 30000;
const LIST_TIMEOUT_MS = 15000;
const POWERSHELL_FONTS = 'Add-Type -AssemblyName System.Drawing; '
  + '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }';

function defaultRun(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: LIST_TIMEOUT_MS, maxBuffer: 4 * 1048576 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

/** fc-list prints `Family[,Alias...]: ...` per face; the first name of the line is the family. */
function firstFamilies(stdout) {
  if (typeof stdout !== 'string') return '';
  return stdout.split(/\r?\n/).map((l) => l.split(',')[0]).join('\n');
}

function createFontLister({ platform = process.platform, run = defaultRun, now = Date.now, ttlMs = LIST_TTL_MS } = {}) {
  let cached = null;       // { at, families }
  let inFlight = null;
  async function enumerate() {
    if (platform === 'win32') {
      return parseFamilyList(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_FONTS]));
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

function registerFontHandlers({ ipcMain, store, sync = {}, isSender, send, lister = createFontLister() }) {
  const fromView = (e) => !!e && typeof isSender === 'function' && isSender(e.sender) === true;

  ipcMain.handle(GET_CHANNEL, (e) => {
    if (!fromView(e)) return null;
    const answer = readLayoutState(store, FONTS_KEY);
    // The page may treat only `ok` and `missing` as an answer; an unreadable or corrupt record is said, never defaulted silently.
    return { status: answer.status, settings: sanitizeSettings(answer.layout) };
  });

  ipcMain.handle(SET_CHANNEL, (e, value) => {
    if (!fromView(e)) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const clean = sanitizeSettings(value);
    try {
      store.update(FONTS_KEY, null, () => clean);
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
  registerFontHandlers, createFontLister, firstFamilies,
  FONTS_KEY, FONT_NAMES, GET_CHANNEL, SET_CHANNEL, LIST_CHANNEL, PUSH_CHANNEL, LIST_TTL_MS,
};
