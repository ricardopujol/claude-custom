'use strict';
/**
 * Main's side of Ctrl+V: read the OS clipboard for the window, and only for it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { readClipboard, registerClipboardHandlers, CLIPBOARD_READ } = require('../app/clipboard-bridge');

function fakeClipboard({ text = '', image = false } = {}) {
  const calls = { readImage: 0 };
  return {
    calls,
    readText: () => text,
    readImage: () => { calls.readImage++; return { isEmpty: () => !image }; },
  };
}

test('text on the clipboard comes back as text', () => {
  assert.deepStrictEqual(readClipboard(fakeClipboard({ text: 'abc' })), { text: 'abc', hasImage: false });
});

test('an image with no text is reported as an image', () => {
  assert.deepStrictEqual(readClipboard(fakeClipboard({ image: true })), { text: '', hasImage: true });
});

test('the image is not decoded when there is text -- text wins anyway', () => {
  // readImage() decodes a bitmap; with text present its answer is never used.
  const cb = fakeClipboard({ text: 'abc', image: true });
  readClipboard(cb);
  assert.strictEqual(cb.calls.readImage, 0);
});

test('an empty clipboard is empty, not an error', () => {
  assert.deepStrictEqual(readClipboard(fakeClipboard()), { text: '', hasImage: false });
});

test('a clipboard that throws reads as empty rather than crashing the handler', () => {
  const cb = { readText: () => { throw new Error('locked by another app'); }, readImage: () => { throw new Error('x'); } };
  assert.deepStrictEqual(readClipboard(cb), { text: '', hasImage: false });
});

test('a non-string readText is treated as no text', () => {
  const cb = { readText: () => undefined, readImage: () => ({ isEmpty: () => true }) };
  assert.deepStrictEqual(readClipboard(cb), { text: '', hasImage: false });
});

function fakeIpc() {
  const handlers = new Map();
  return { handlers, handle: (ch, fn) => handlers.set(ch, fn) };
}

test('the handler answers the window it was registered for', async () => {
  const ipcMain = fakeIpc();
  const win = { webContents: {} };
  registerClipboardHandlers({ ipcMain, clipboard: fakeClipboard({ text: 'hi' }), win });
  const handler = ipcMain.handlers.get(CLIPBOARD_READ);
  assert.strictEqual(typeof handler, 'function');
  assert.deepStrictEqual(await handler({ sender: win.webContents }), { text: 'hi', hasImage: false });
});

test('any other sender gets an empty clipboard, never its contents', async () => {
  // Same fromWindow gate as every secrets:* handler: a handler that answers
  // anyone is not a boundary, and a clipboard routinely holds a password.
  const ipcMain = fakeIpc();
  registerClipboardHandlers({ ipcMain, clipboard: fakeClipboard({ text: 'hunter2' }), win: { webContents: {} } });
  assert.deepStrictEqual(await ipcMain.handlers.get(CLIPBOARD_READ)({ sender: {} }), { text: '', hasImage: false });
});

// Comments stripped: a channel named only in prose is not a wiring.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const app = (f) => strip(fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8'));

test('the preload invokes the channel this module handles', () => {
  assert.ok(app('preload.js').includes(`ipcRenderer.invoke('${CLIPBOARD_READ}')`),
    `preload.js must invoke '${CLIPBOARD_READ}'`);
});

test('main.js actually registers the handlers for its window', () => {
  const main = app('main.js');
  assert.match(main, /require\(['"]\.\/clipboard-bridge['"]\)/);
  assert.match(main, /registerClipboardHandlers\(\s*\{[^}]*ipcMain[^}]*clipboard[^}]*win[^}]*\}\s*\)/);
});
