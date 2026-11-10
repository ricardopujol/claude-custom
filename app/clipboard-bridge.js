'use strict';
/**
 * Main's half of Ctrl+V (BACKLOG #12, #8): the window asks, main reads the OS
 * clipboard and answers. contextIsolation stays on; the page never touches
 * Electron's clipboard module.
 *
 * Its own module rather than inline in main.js so it can be tested, and so
 * verify/probe-paste.js registers the SHIPPED handler rather than a copy.
 */

const CLIPBOARD_READ = 'clipboard:read';
const CLIPBOARD_WRITE = 'clipboard:write';
const CLIPBOARD_PASTE_FILES = 'clipboard:paste-files';
const EMPTY = Object.freeze({ text: '', hasImage: false });

// Files copied in Explorer (BACKLOG #136 (1)). MEASURED 2026-11-07 (Electron 33, Windows 11, two files put on the clipboard the way
// Explorer's Copy does): availableFormats() is ['text/uri-list'] and readText() is ''; readBuffer('FileNameW') holds only the FIRST
// file's name. So this only says files are there: the page takes every one of them from a native paste event (CLIPBOARD_PASTE_FILES).
function hasFileList(clipboard) {
  try { if (typeof clipboard.availableFormats === 'function' && clipboard.availableFormats().includes('text/uri-list')) return true; } catch { /* locked */ }
  try {
    if (typeof clipboard.readBuffer === 'function') {
      const b = clipboard.readBuffer('FileNameW');
      if (b && b.length && b.toString('utf16le').replace(/\u0000+$/, '') !== '') return true;
    }
  } catch { /* locked or not Windows */ }
  return false;
}

// { text, hasImage }, plus `hasFiles: true` when files are all it holds. The image is only looked at when there is no text:
// readImage() decodes a bitmap, and with text present its answer is unused (text wins -- app/paste-action.js); files only when there
// is neither, so a text or image paste reads exactly as before. A clipboard another app has locked throws on Windows; that reads as
// empty, never as a crashed handler.
function readClipboard(clipboard) {
  try {
    const raw = clipboard.readText();
    const text = typeof raw === 'string' ? raw : '';
    // Whitespace-only text is not text (Miguel, PR #55, S1): look for the
    // image, or pasteAction never learns there was one to prefer.
    if (text.trim()) return { text, hasImage: false };
    if (!clipboard.readImage().isEmpty()) return { text, hasImage: true };
    return hasFileList(clipboard) ? { text, hasImage: false, hasFiles: true } : { text, hasImage: false };
  } catch {
    return { ...EMPTY };
  }
}

// Ctrl+C with a selection: put it on the clipboard. Only a non-empty string
// is written -- an empty write would wipe what the user had copied, for
// nothing. A clipboard another app has locked throws on Windows; that's
// reported, never a crashed handler.
function writeClipboard(clipboard, text) {
  if (typeof text !== 'string' || text === '') return { ok: false, error: 'nothing to copy' };
  try {
    clipboard.writeText(text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// Same `fromWindow` gate as every secrets:* handler in main.js: a clipboard
// routinely holds a password, and a handler that answers anyone is not a
// boundary.
//
// `isSender(webContents)` replaces "the window's own page" when the window is a
// shell of tab views (worktree tabs): the sender is then one of its views, and
// the window's own webContents is only the tab strip. Absent, the old rule.
function registerClipboardHandlers({ ipcMain, clipboard, win, isSender }) {
  const allowed = (event) => !!event && (typeof isSender === 'function'
    ? isSender(event.sender) === true
    : event.sender === win.webContents);
  ipcMain.handle(CLIPBOARD_READ, (event) =>
    (allowed(event) ? readClipboard(clipboard) : { ...EMPTY }));
  // Writing is gated too: a page that could set the clipboard could plant a
  // command for the user's next Ctrl+V.
  ipcMain.handle(CLIPBOARD_WRITE, (event, text) =>
    (allowed(event) ? writeClipboard(clipboard, text) : { ok: false, error: 'not this window' }));
  // #136 (1): a native paste into the asking page, so its paste event carries the copied files as File objects (the drop's own path
  // source, webUtils.getPathForFile). ONLY when files are all the clipboard holds: a native paste of TEXT would reach xterm raw, the
  // path pasteFrame exists to close (Miguel, PR #55, B1).
  ipcMain.handle(CLIPBOARD_PASTE_FILES, (event) => {
    if (!allowed(event)) return { ok: false, error: 'not this window' };
    if (readClipboard(clipboard).hasFiles !== true) return { ok: false, error: 'no files on the clipboard' };
    try { event.sender.paste(); return { ok: true }; } catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
  });
}

module.exports = { readClipboard, writeClipboard, registerClipboardHandlers, CLIPBOARD_READ, CLIPBOARD_WRITE, CLIPBOARD_PASTE_FILES };
