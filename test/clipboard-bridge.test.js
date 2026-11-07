'use strict';
/**
 * Main's side of Ctrl+V: read the OS clipboard for the window, and only for it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { readClipboard, writeClipboard, registerClipboardHandlers, CLIPBOARD_READ, CLIPBOARD_WRITE } = require('../app/clipboard-bridge');

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

test('whitespace-only text still looks for the image (Miguel, PR #55, S1)', () => {
  // Otherwise pasteAction never learns there was one to prefer.
  assert.deepStrictEqual(readClipboard(fakeClipboard({ text: ' ', image: true })), { text: ' ', hasImage: true });
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

// --- Ctrl+C copy: main writes the selection for the window, and only for it -

function fakeWritable() {
  const writes = [];
  return { writes, writeText: (t) => writes.push(t), readText: () => '', readImage: () => ({ isEmpty: () => true }) };
}

test('writeClipboard puts the text on the clipboard and says so', () => {
  const cb = fakeWritable();
  assert.deepStrictEqual(writeClipboard(cb, 'copied'), { ok: true });
  assert.deepStrictEqual(cb.writes, ['copied']);
});

test('writeClipboard refuses anything but a non-empty string, and writes nothing', () => {
  // An empty write would wipe what the user had copied, for nothing.
  for (const bad of ['', undefined, null, 42, {}]) {
    const cb = fakeWritable();
    assert.strictEqual(writeClipboard(cb, bad).ok, false, JSON.stringify(bad));
    assert.deepStrictEqual(cb.writes, [], JSON.stringify(bad));
  }
});

test('a clipboard that throws is reported, never a crashed handler', () => {
  const cb = { writeText: () => { throw new Error('locked'); } };
  assert.deepStrictEqual(writeClipboard(cb, 'x'), { ok: false, error: 'locked' });
});

test('the write handler writes for its own window', async () => {
  const ipcMain = fakeIpc();
  const win = { webContents: {} };
  const cb = fakeWritable();
  registerClipboardHandlers({ ipcMain, clipboard: cb, win });
  assert.deepStrictEqual(await ipcMain.handlers.get(CLIPBOARD_WRITE)({ sender: win.webContents }, 'sel'), { ok: true });
  assert.deepStrictEqual(cb.writes, ['sel']);
});

test('any other sender cannot write the clipboard', async () => {
  const ipcMain = fakeIpc();
  const cb = fakeWritable();
  registerClipboardHandlers({ ipcMain, clipboard: cb, win: { webContents: {} } });
  assert.strictEqual((await ipcMain.handlers.get(CLIPBOARD_WRITE)({ sender: {} }, 'evil')).ok, false);
  assert.deepStrictEqual(cb.writes, []);
});

test('the preload invokes the write channel with the text', () => {
  assert.ok(app('preload.js').includes(`ipcRenderer.invoke('${CLIPBOARD_WRITE}', text)`),
    `preload.js must invoke '${CLIPBOARD_WRITE}' with the text`);
});

// --- a window made of tab views (worktree tabs): the gate is a predicate -----

test('with isSender, the handlers answer any of the window\'s views and nobody else', async () => {
  const ipcMain = fakeIpc();
  const views = [{ id: 'a' }, { id: 'b' }];
  const isSender = (s) => views.includes(s);
  registerClipboardHandlers({
    ipcMain, clipboard: Object.assign(fakeWritable(), { readText: () => 'hi' }), win: { webContents: { id: 'strip' } }, isSender,
  });
  const read = ipcMain.handlers.get(CLIPBOARD_READ);
  assert.deepStrictEqual(await read({ sender: views[0] }), { text: 'hi', hasImage: false });
  assert.deepStrictEqual(await read({ sender: views[1] }), { text: 'hi', hasImage: false });
  // The window's OWN page (the strip) is not a view: the predicate decides.
  assert.deepStrictEqual(await read({ sender: { id: 'strip' } }), { text: '', hasImage: false });
  const write = ipcMain.handlers.get(CLIPBOARD_WRITE);
  assert.strictEqual((await write({ sender: views[1] }, 'x')).ok, true);
  assert.strictEqual((await write({ sender: {} }, 'x')).ok, false);
});

// --- #136 (1): a file copied in Explorer and pasted with Ctrl+V acts like a drop (Ricardo 2026-11-06) ----------------------------
// MEASURED 2026-11-07 on the Katana (Electron 33, two files put on the clipboard with Set-Clipboard -Path, as Explorer's Copy does):
// main's clipboard.availableFormats() is ['text/uri-list'], readText() is '', and readBuffer('FileNameW') holds only the FIRST file's
// name (UTF-16, NUL-ended). A paste EVENT in the page carries both as File objects whose webUtils.getPathForFile is the real path. So
// main only says files are there; the page takes them from a native paste, the drop's own source.

const { CLIPBOARD_PASTE_FILES } = require('../app/clipboard-bridge');

function fakeFileClipboard({ text = '', image = false, formats = ['text/uri-list'], fileNameW = 'C:\\x\\a.md\u0000', throws = false } = {}) {
  const calls = { readBuffer: 0, formats: 0 };
  return {
    calls,
    readText: () => text,
    readImage: () => ({ isEmpty: () => !image }),
    availableFormats: () => { calls.formats++; if (throws) throw new Error('locked'); return formats; },
    readBuffer: (f) => { calls.readBuffer++; if (throws) throw new Error('locked'); return Buffer.from(f === 'FileNameW' ? fileNameW : '', 'utf16le'); },
  };
}

test('#136 (1): files copied in Explorer (no text, no image) are reported as files', () => {
  assert.deepStrictEqual(readClipboard(fakeFileClipboard()), { text: '', hasImage: false, hasFiles: true });
});

test('#136 (1): either measured sign is enough: the text/uri-list format, or a FileNameW name', () => {
  assert.strictEqual(readClipboard(fakeFileClipboard({ formats: [] })).hasFiles, true, 'FileNameW alone');
  assert.strictEqual(readClipboard(fakeFileClipboard({ fileNameW: '' })).hasFiles, true, 'text/uri-list alone');
  assert.deepStrictEqual(readClipboard(fakeFileClipboard({ formats: [], fileNameW: '' })), { text: '', hasImage: false });
});

test('#136 (1): text still wins, exactly as before: with text on the clipboard nothing about files is looked at', () => {
  const cb = fakeFileClipboard({ text: 'hello' });
  assert.deepStrictEqual(readClipboard(cb), { text: 'hello', hasImage: false });
  assert.strictEqual(cb.calls.readBuffer + cb.calls.formats, 0);
});

test('#136 (1): an image still wins over files (the CLI attaches it itself, #8)', () => {
  assert.deepStrictEqual(readClipboard(fakeFileClipboard({ image: true })), { text: '', hasImage: true });
});

test('#136 (1): a clipboard whose format reads throw is simply not files', () => {
  assert.deepStrictEqual(readClipboard(fakeFileClipboard({ throws: true })), { text: '', hasImage: false });
});

test('#136 (1): the paste-files handler asks the SENDER for a native paste, for the window\'s own pages only', async () => {
  const ipcMain = fakeIpc();
  const pasted = [];
  const win = { webContents: { paste: () => pasted.push('win') } };
  registerClipboardHandlers({ ipcMain, clipboard: fakeFileClipboard(), win });
  const handler = ipcMain.handlers.get(CLIPBOARD_PASTE_FILES);
  assert.strictEqual(typeof handler, 'function', 'the channel is handled');
  assert.deepStrictEqual(await handler({ sender: win.webContents }), { ok: true });
  assert.deepStrictEqual(pasted, ['win']);
  const stranger = { paste: () => pasted.push('stranger') };
  assert.strictEqual((await handler({ sender: stranger })).ok, false);
  assert.deepStrictEqual(pasted, ['win'], 'nobody else gets a paste');
  // and with nothing but files on the clipboard: no text paste can be started from here, so a text-only clipboard is refused too
  const ipc2 = fakeIpc();
  const w2 = { webContents: { paste: () => pasted.push('w2') } };
  registerClipboardHandlers({ ipcMain: ipc2, clipboard: fakeClipboard({ text: 'hunter2' }), win: w2 });
  assert.strictEqual((await ipc2.handlers.get(CLIPBOARD_PASTE_FILES)({ sender: w2.webContents })).ok, false);
  assert.ok(!pasted.includes('w2'));
});

test('#136 (1): the preload invokes the paste-files channel', () => {
  assert.ok(app('preload.js').includes(`ipcRenderer.invoke('${CLIPBOARD_PASTE_FILES}')`), `preload.js must invoke '${CLIPBOARD_PASTE_FILES}'`);
});
