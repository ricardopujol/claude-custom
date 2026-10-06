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

function load() {
  const exposed = {}; const sent = []; const invoked = []; const listeners = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: { send: (ch, ...a) => sent.push([ch, ...a]), invoke: (ch, ...a) => { invoked.push([ch, ...a]); return Promise.resolve({ ok: true }); },
      on: (ch, fn) => { listeners[ch] = fn; }, removeAllListeners: (ch) => { delete listeners[ch]; } },
  };
  const requires = [];
  vm.runInNewContext(SRC, { require: (n) => { requires.push(n); return electron; }, module: {}, console });
  return { exposed, sent, invoked, requires, listeners };
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
