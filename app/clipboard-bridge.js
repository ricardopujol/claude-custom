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
const EMPTY = Object.freeze({ text: '', hasImage: false });

// { text, hasImage }. The image is only looked at when there is no text:
// readImage() decodes a bitmap, and with text present its answer is unused
// (text wins -- app/paste-action.js). A clipboard another app has locked
// throws on Windows; that reads as empty, never as a crashed handler.
function readClipboard(clipboard) {
  try {
    const raw = clipboard.readText();
    const text = typeof raw === 'string' ? raw : '';
    // Whitespace-only text is not text (Miguel, PR #55, S1): look for the
    // image, or pasteAction never learns there was one to prefer.
    if (text.trim()) return { text, hasImage: false };
    return { text, hasImage: !clipboard.readImage().isEmpty() };
  } catch {
    return { ...EMPTY };
  }
}

// Same `fromWindow` gate as every secrets:* handler in main.js: a clipboard
// routinely holds a password, and a handler that answers anyone is not a
// boundary.
function registerClipboardHandlers({ ipcMain, clipboard, win }) {
  ipcMain.handle(CLIPBOARD_READ, (event) =>
    (event && event.sender === win.webContents ? readClipboard(clipboard) : { ...EMPTY }));
}

module.exports = { readClipboard, registerClipboardHandlers, CLIPBOARD_READ };
