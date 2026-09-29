'use strict';
/**
 * Dexter N2 (PR #64 round 2): the toggle watcher must (a) know what the SET
 * path already told this window, and (b) never turn a transient read failure
 * into a confident "on".
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  watchImagesEnabled, registerAvatarHandlers, AVATAR_KEY, PUSH_CHANNEL, SET_CHANNEL,
} = require('../app/avatar-bridge');

function stateStore(initial) {
  const s = { state: { status: 'ok', value: initial } };
  return {
    s,
    read: (n, f) => (s.state.status === 'ok' ? s.state.value : f),
    readState: () => s.state,
    update: (n, f, fn) => { s.state = { status: 'ok', value: fn(s.state.value || f) }; },
  };
}
function rig(initial) {
  const store = stateStore(initial);
  const sent = [];
  const win = { webContents: { send: (ch, v) => sent.push([ch, v]) } };
  const sync = {};
  const handlers = new Map();
  registerAvatarHandlers({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, store, win, dialog: {}, sync });
  let listener;
  watchImagesEnabled({ store, file: 'f', win, sync, watchFile: (f, o, l) => { listener = l; }, unwatchFile: () => {} });
  const set = (v) => handlers.get(SET_CHANNEL)({ sender: win.webContents }, v);
  return { store, sent, set, poke: () => listener(), sync };
}

test('N2: a change made through THIS window\'s SET path is remembered, so a later change back is still pushed', () => {
  const r = rig({ imagesEnabled: true });
  r.set(false);                                              // user clicks off here
  r.store.s.state = { status: 'ok', value: { imagesEnabled: false } };
  r.poke();                                                  // poll sees the file change: nothing new to say
  r.sent.length = 0;
  r.store.s.state = { status: 'ok', value: { imagesEnabled: true } };   // another window turns it back on
  r.poke();
  assert.deepStrictEqual(r.sent, [[PUSH_CHANNEL, true]]);
});

test('N2: without the shared memory the scenario from the review would have been missed (the watcher alone still said true)', () => {
  // The watcher started at true; SET pushed false; the store then goes back to
  // true. Only `sync.last` (updated by SET) makes that difference visible.
  const r = rig({ imagesEnabled: true });
  r.set(false);
  assert.strictEqual(r.sync.last, false);
});

test('N2: an UNREADABLE read pushes nothing and does not move last', () => {
  const r = rig({ imagesEnabled: false });
  r.sync.last = false;
  r.store.s.state = { status: 'unreadable', value: null, error: new Error('EBUSY') };
  r.poke();
  assert.deepStrictEqual(r.sent, []);
  assert.strictEqual(r.sync.last, false);
  r.store.s.state = { status: 'ok', value: { imagesEnabled: true } };   // the retry poll succeeds
  r.poke();
  assert.deepStrictEqual(r.sent, [[PUSH_CHANNEL, true]]);
});

test('N2: a CORRUPT file pushes nothing either', () => {
  const r = rig({ imagesEnabled: false });
  r.store.s.state = { status: 'corrupt', value: null, error: new Error('bad json') };
  r.poke();
  assert.deepStrictEqual(r.sent, []);
});

test('N2: a file that is genuinely MISSING (fresh install) reads as on', () => {
  const r = rig({ imagesEnabled: false });
  r.store.s.state = { status: 'missing', value: null };
  r.poke();
  assert.deepStrictEqual(r.sent, [[PUSH_CHANNEL, true]]);
});

test('the AVATAR_KEY record is what the watcher reads', () => {
  assert.strictEqual(AVATAR_KEY, 'avatar-global');
});
