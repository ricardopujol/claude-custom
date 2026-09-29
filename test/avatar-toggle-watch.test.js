'use strict';
/**
 * Dexter F3 (PR #64): the images toggle is install-wide, but every project
 * window is its own Electron main. A change made in window P must reach window
 * Q's renderer, or Q's videos keep playing after the user turned images off.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { watchImagesEnabled, AVATAR_KEY, PUSH_CHANNEL } = require('../app/avatar-bridge');
const { createStore } = require('../host/store');

function fakeStore(initial) {
  const data = { [AVATAR_KEY]: initial };
  return { data, read: (n, f) => (n in data ? data[n] : f), update: (n, f, fn) => { data[n] = fn(data[n] || f); } };
}
function harness(initial) {
  const store = fakeStore(initial);
  const sent = [];
  const win = { webContents: { send: (ch, v) => sent.push([ch, v]) } };
  const w = { listeners: [], unwatched: [] };
  const stop = watchImagesEnabled({
    store, file: '/state/avatar-global.json', win,
    watchFile: (f, o, l) => w.listeners.push({ f, o, l }),
    unwatchFile: (f, l) => w.unwatched.push({ f, l }),
  });
  return { store, sent, w, stop, poke: () => w.listeners[0].l({ mtimeMs: 2 }, { mtimeMs: 1 }) };
}

test('a change written by another window is pushed to this window', () => {
  const h = harness({ imagesEnabled: true });
  h.store.data[AVATAR_KEY] = { imagesEnabled: false };     // "the other window"
  h.poke();
  assert.deepStrictEqual(h.sent, [[PUSH_CHANNEL, false]]);
});

test('a poll where the value did not change pushes nothing', () => {
  const h = harness({ imagesEnabled: true });
  h.poke(); h.poke();
  assert.deepStrictEqual(h.sent, []);
});

test('it follows the value both ways and never repeats itself', () => {
  const h = harness({ imagesEnabled: true });
  h.store.data[AVATAR_KEY] = { imagesEnabled: false }; h.poke(); h.poke();
  h.store.data[AVATAR_KEY] = { imagesEnabled: true }; h.poke();
  assert.deepStrictEqual(h.sent, [[PUSH_CHANNEL, false], [PUSH_CHANNEL, true]]);
});

test('a file that becomes unreadable or corrupt reads as ON, like a fresh install', () => {
  const h = harness({ imagesEnabled: false });
  h.store.data[AVATAR_KEY] = 'garbage';
  h.poke();
  assert.deepStrictEqual(h.sent, [[PUSH_CHANNEL, true]]);
});

test('the watcher polls the store file it was given, and stop() unwatches exactly that listener', () => {
  const h = harness({ imagesEnabled: true });
  assert.strictEqual(h.w.listeners[0].f, '/state/avatar-global.json');
  h.stop();
  assert.strictEqual(h.w.unwatched.length, 1);
  assert.strictEqual(h.w.unwatched[0].l, h.w.listeners[0].l);
});

test('a window that has gone away does not make the watcher throw', () => {
  const h = harness({ imagesEnabled: true });
  h.store.data[AVATAR_KEY] = { imagesEnabled: false };
  const listener = h.w.listeners[0].l;
  assert.doesNotThrow(() => {
    const bad = watchImagesEnabled({
      store: h.store, file: 'x', win: { webContents: { send: () => { throw new Error('destroyed'); } } },
      watchFile: (f, o, l) => { h.bad = l; }, unwatchFile: () => {},
    });
    h.store.data[AVATAR_KEY] = { imagesEnabled: true };
    h.bad();
    bad();
  });
  assert.ok(listener);
});

test('REAL fs: a second store instance writing the file (another main) is noticed by the first', async () => {
  const dir = tmpDir('cc-avw-');
  const mine = createStore({ dir });
  const theirs = createStore({ dir });
  mine.update(AVATAR_KEY, {}, () => ({ imagesEnabled: true }));
  let got;
  const seen = new Promise((r) => { got = r; });
  const stop = watchImagesEnabled({
    store: mine, file: path.join(dir, `${AVATAR_KEY}.json`),
    win: { webContents: { send: (ch, v) => got(v) } }, intervalMs: 50,
  });
  try {
    theirs.update(AVATAR_KEY, {}, () => ({ imagesEnabled: false }));
    const v = await Promise.race([seen, new Promise((r) => setTimeout(() => r('timeout'), 4000))]);
    assert.strictEqual(v, false);
  } finally {
    stop();
  }
});
