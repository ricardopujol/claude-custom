'use strict';
/**
 * app/canvas-panel-preload.js: the ONLY thing the untrusted panel page can call (BACKLOG #71).
 *
 * Two functions, no more, each a message that main validates (app/canvas-views.js). It runs in a sandboxed preload,
 * so this test loads it with a fake `electron` and reads back what it hands the page.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'canvas-panel-preload.js'), 'utf8');

// Objects made inside the vm have another realm's prototypes; compare them as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));

function load({ top = true } = {}) {
  const exposed = {}; const sent = []; const invoked = []; const listeners = {}; const winListeners = []; const scripts = [];
  const win = { addEventListener: (type, fn, capture) => winListeners.push({ type, fn, capture }) };
  win.top = top ? win : {};
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: { send: (ch, ...a) => sent.push([ch, ...a]), invoke: (ch, ...a) => { invoked.push([ch, ...a]); return Promise.resolve({ ok: true }); },
      on: (ch, fn) => { listeners[ch] = fn; }, removeAllListeners: (ch) => { delete listeners[ch]; } },
    webFrame: { executeJavaScript: (src) => { scripts.push(src); return Promise.resolve(); } },
  };
  const requires = [];
  vm.runInNewContext(SRC, { require: (n) => { requires.push(n); return electron; }, module: {}, console, window: win, DOMException });
  return { exposed, sent, invoked, requires, listeners, winListeners, scripts };
}

test('it exposes exactly one object, claudePanel, with exactly fetch, send and three for the shelf', () => {
  const { exposed } = load();
  assert.deepStrictEqual(plain(Object.keys(exposed)), ['claudePanel']);
  assert.deepStrictEqual(plain(Object.keys(exposed.claudePanel).sort()), ['fetch', 'onShelf', 'open', 'send', 'shelf']);
});

test('it requires nothing but electron', () => {
  assert.deepStrictEqual(plain(load().requires), ['electron']);
});

test('fetch is one invoke on its own channel carrying only strings it made itself', async () => {
  const { exposed, invoked } = load();
  await exposed.claudePanel.fetch({ toString() { return 'https://a.example.com/'; } }, { method: 'POST', headers: { a: 'b' }, body: 'x', signal: 'dropped', extra: { deep: 1 } });
  assert.strictEqual(invoked.length, 1);
  assert.strictEqual(invoked[0][0], 'canvas:fetch');
  assert.deepStrictEqual(plain(invoked[0][1]), { url: 'https://a.example.com/', init: { method: 'POST', headers: { a: 'b' }, body: 'x' } });
});

test('fetch tolerates missing options and non-object options', async () => {
  const { exposed, invoked } = load();
  await exposed.claudePanel.fetch('https://a.example.com/');
  await exposed.claudePanel.fetch('https://a.example.com/', 'nonsense');
  assert.deepStrictEqual(plain(invoked.map(i => i[1].init)), [{}, {}]);
});

test('send is one message on its own channel with the text as a string', () => {
  const { exposed, sent } = load();
  exposed.claudePanel.send(12345);
  exposed.claudePanel.send({ toString() { return 'hi'; } });
  assert.deepStrictEqual(plain(sent), [['canvas:send', { kind: 'send', text: '12345' }], ['canvas:send', { kind: 'send', text: 'hi' }]]);
});

test('shelf is one invoke on its own channel; open sends the address as a string on its own channel', async () => {
  const { exposed, invoked, sent } = load();
  await exposed.claudePanel.shelf();
  exposed.claudePanel.open({ toString() { return 'https://claude.ai/artifact/aaa'; } });
  assert.deepStrictEqual(plain(invoked), [['canvas:shelf']]);
  assert.deepStrictEqual(plain(sent), [['canvas:open', { url: 'https://claude.ai/artifact/aaa' }]]);
});

test('onShelf replaces its one listener, hands the page the items, and a throwing page callback is swallowed', () => {
  const { exposed, listeners } = load();
  const got = [];
  exposed.claudePanel.onShelf((items) => got.push(items));
  listeners['canvas:shelf']({}, [{ title: 'a' }]);
  assert.deepStrictEqual(plain(got), [[{ title: 'a' }]]);
  exposed.claudePanel.onShelf(() => { throw new Error('page bug'); });
  assert.doesNotThrow(() => listeners['canvas:shelf']({}, []));
  exposed.claudePanel.onShelf('not a function');
  assert.strictEqual(listeners['canvas:shelf'], undefined, 'a non-function removes the listener rather than keeping a stale one');
});

// ---- PR #125 Dexter R2-3, Ricardo 2026-10-08 "block what we can": the file-picker guard, in every frame ---------------------------------------
const fileEvent = (tag, type, path) => ({ target: { tagName: tag, type }, composedPath: path ? () => path : undefined, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

test('every frame gets a CAPTURE-phase click guard that cancels a click on a file input, however it got there, and no other click', () => {
  const { winListeners } = load();
  const guards = winListeners.filter((l) => l.type === 'click');
  assert.strictEqual(guards.length, 1);
  assert.strictEqual(guards[0].capture, true, 'capture phase: it runs before any listener the page put on the input');
  const hit = (e) => { guards[0].fn(e); return e.defaultPrevented; };
  assert.strictEqual(hit(fileEvent('INPUT', 'file')), true);
  assert.strictEqual(hit(fileEvent('INPUT', 'FILE')), true, 'the type attribute is case-insensitive');
  const file = { tagName: 'INPUT', type: 'file' };
  assert.strictEqual(hit({ ...fileEvent('LABEL', ''), composedPath: () => [{ tagName: 'DIV' }, file, { tagName: 'BODY' }] }), true, 'found through the composed path (shadow DOM, bubbling from a child)');
  assert.strictEqual(hit(fileEvent('INPUT', 'text')), false);
  assert.strictEqual(hit(fileEvent('INPUT', 'color')), false, 'only files');
  assert.strictEqual(hit(fileEvent('BUTTON', '')), false);
  assert.strictEqual(hit({ target: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }), false);
});

test('showPicker is replaced in the page world: it throws NotAllowedError for a file input and passes everything else through', () => {
  const { scripts } = load();
  assert.strictEqual(scripts.length, 1);
  const calls = [];
  const proto = { showPicker() { calls.push(['orig', this.type]); return 'picked'; } };
  const sandbox = { HTMLInputElement: { prototype: proto }, DOMException, Object, String };
  vm.runInNewContext(scripts[0], sandbox);
  assert.throws(() => proto.showPicker.call({ type: 'file' }), (e) => e.name === 'NotAllowedError');
  assert.throws(() => proto.showPicker.call({ type: 'FILE' }), (e) => e.name === 'NotAllowedError');
  assert.strictEqual(proto.showPicker.call({ type: 'date' }), 'picked');
  assert.deepStrictEqual(calls, [['orig', 'date']]);
  assert.throws(() => Object.defineProperty(proto, 'showPicker', { value: () => 'again' }), TypeError, 'the page cannot put the original back');
});

test('the top frame gets the guard AND the bridge; a sub-frame gets the guard and NOTHING else (no claudePanel, no ipc listeners)', () => {
  const top = load({ top: true });
  assert.deepStrictEqual(plain(Object.keys(top.exposed)), ['claudePanel']);
  const sub = load({ top: false });
  assert.deepStrictEqual(plain(Object.keys(sub.exposed)), [], 'no bridge in a sub-frame');
  assert.strictEqual(sub.winListeners.filter((l) => l.type === 'click').length, 1, 'but the guard is there');
  assert.strictEqual(sub.scripts.length, 1);
  assert.deepStrictEqual(plain(sub.sent), []);
  assert.deepStrictEqual(plain(sub.invoked), []);
});
