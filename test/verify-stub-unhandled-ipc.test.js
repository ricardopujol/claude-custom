'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { channelsIn, stubUnhandledIpc } = require('../verify/lib/stub-unhandled-ipc');

// An ipcMain that throws on a second handle() of a channel, as Electron's does.
function fakeIpc(preHandled = [], preListened = []) {
  const handlers = new Map(preHandled.map(c => [c, () => 'real']));
  const listeners = new Map(preListened.map(c => [c, [() => {}]]));
  return {
    handlers, listeners,
    handle(ch, fn) { if (handlers.has(ch)) throw new Error('second handler'); handlers.set(ch, fn); },
    on(ch, fn) { listeners.set(ch, [...(listeners.get(ch) || []), fn]); },
    listenerCount(ch) { return (listeners.get(ch) || []).length; },
  };
}

const PRELOAD = `
  a: () => ipcRenderer.invoke('one:get'),
  b: () => ipcRenderer.invoke( 'two:get', 5),
  c: () => ipcRenderer.invoke('one:get'),
  d: (x) => ipcRenderer.sendSync('sync:one', x),
  e: () => ipcRenderer.sendSync('sync:two') !== false,
  f: () => ipcRenderer.send('fire:forget'),
  g: () => ipcRenderer.on('push', () => {}),
`;

test('channelsIn: invoke and sendSync channels, each once; send and on are not channels to answer', () => {
  assert.deepStrictEqual(channelsIn(PRELOAD), { invoke: ['one:get', 'two:get'], sync: ['sync:one', 'sync:two'] });
  assert.deepStrictEqual(channelsIn(''), { invoke: [], sync: [] });
});

function withPreload(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-stubipc-'));
  const file = path.join(dir, 'preload.js');
  fs.writeFileSync(file, PRELOAD);
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('stubUnhandledIpc: stubs what nobody answered with null, leaves a real handler and a real listener alone', () => withPreload((file) => {
  const ipc = fakeIpc(['one:get'], ['sync:one']);
  const stubbed = stubUnhandledIpc(ipc, file);
  assert.deepStrictEqual(stubbed, { invoke: ['two:get'], sync: ['sync:two'] });
  assert.strictEqual(ipc.handlers.get('one:get')(), 'real');
  assert.strictEqual(ipc.handlers.get('two:get')(), null);
  assert.strictEqual(ipc.listenerCount('sync:one'), 1, 'the real listener is the only one');
  const ev = {};
  ipc.listeners.get('sync:two')[0](ev);
  assert.strictEqual(ev.returnValue, null, 'a sendSync stub sets returnValue, so the renderer is not left waiting');
}));

test('stubUnhandledIpc: the repo\'s real preload parses to a non-trivial channel list including the sync one that blocked the page', () => {
  const { invoke, sync } = channelsIn(fs.readFileSync(path.join(__dirname, '..', 'app', 'preload.js'), 'utf8'));
  assert.ok(invoke.length > 30, `found ${invoke.length} invoke channels`);
  assert.ok(sync.includes('resources:chipOn'));
});
