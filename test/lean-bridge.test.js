'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { registerLeanHandlers, GET_CHANNEL, SET_CHANNEL, NIGHT_CHANNEL, PUSH_CHANNEL } = require('../app/lean-bridge');

function harness({ views = [1, 2], strip = 9 } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const pushed = [];
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => listeners.set(ch, fn),
  };
  const isView = (s) => views.includes(s && s.id);
  const isStrip = (s) => !!s && s.id === strip;
  const api = registerLeanHandlers({ ipcMain, isView, isStrip, push: (state) => pushed.push(state) });
  const ev = (id) => ({ sender: { id } });
  return { api, pushed, get: (id) => handlers.get(GET_CHANNEL)(ev(id)), set: (id, on) => listeners.get(SET_CHANNEL)(ev(id), on), night: (id, at) => listeners.get(NIGHT_CHANNEL)(ev(id), at), handlers, listeners };
}

test('get answers a tab view and the strip, and nobody else', () => {
  const h = harness();
  assert.deepStrictEqual(h.get(1), { on: false, byBedtime: false, bedtimeSince: null, night: false });
  assert.deepStrictEqual(h.get(9).on, false);
  assert.strictEqual(h.get(77), null);
});

test('set from a view or the strip turns it on and pushes the new state once', () => {
  const h = harness();
  h.set(9, true);
  assert.strictEqual(h.pushed.length, 1);
  assert.strictEqual(h.pushed[0].on, true);
  h.set(1, true);
  assert.strictEqual(h.pushed.length, 1, 'no change, no push');
  h.set(2, false);
  assert.strictEqual(h.pushed.length, 2);
});

test('set from a stranger, or with a non-boolean, does nothing', () => {
  const h = harness();
  h.set(77, true);
  h.set(1, 'yes');
  h.set(1, 1);
  assert.strictEqual(h.pushed.length, 0);
});

test('a night reported by a tab view turns it on; the strip cannot report one', () => {
  const h = harness();
  h.night(9, 1000);
  assert.strictEqual(h.pushed.length, 0);
  h.night(1, 1000);
  assert.deepStrictEqual(h.pushed[0], { on: true, byBedtime: true, bedtimeSince: 1000, night: true });
});

test('null ends that tab\'s night; a tab closing ends it too (dropOwner)', () => {
  const h = harness();
  h.night(1, 1000);
  h.night(1, null);
  assert.strictEqual(h.pushed[1].on, false);
  h.night(2, 2000);
  h.api.dropOwner(2);
  assert.strictEqual(h.pushed[3].on, false);
});

test('a night value that is not a number or null is ignored', () => {
  const h = harness();
  h.night(1, 'tonight');
  h.night(1, { a: 1 });
  assert.strictEqual(h.pushed.length, 0);
});

test('channels are the ones the preloads use', () => {
  assert.deepStrictEqual([GET_CHANNEL, SET_CHANNEL, NIGHT_CHANNEL, PUSH_CHANNEL], ['lean:get', 'lean:set', 'lean:night', 'lean-state']);
});

const { FACES_CHANNEL, FACES_PUSH } = require('../app/lean-bridge');

function facesHarness() {
  const listeners = new Map();
  const pushed = [];
  const ipcMain = { handle() {}, on: (ch, fn) => listeners.set(ch, fn) };
  const api = registerLeanHandlers({ ipcMain, isView: (s) => s && s.id <= 2, isStrip: (s) => s && s.id === 9, push() {}, pushFaces: (f) => pushed.push(f.map(x => x.agent)) });
  return { api, pushed, send: (id, list) => listeners.get(FACES_CHANNEL)({ sender: { id } }, list) };
}

test('faces: a tab view\'s working agents reach the strip as the window\'s set; another view adds to it; a repeat says nothing', () => {
  const h = facesHarness();
  h.send(1, [{ agent: 'amy' }]);
  h.send(1, [{ agent: 'amy' }]);
  h.send(2, [{ agent: 'bob' }]);
  assert.deepStrictEqual(h.pushed, [['amy'], ['amy', 'bob']]);
});

test('faces: the strip and strangers cannot set them; a closing view takes its faces with it', () => {
  const h = facesHarness();
  h.send(9, [{ agent: 'x' }]);
  h.send(77, [{ agent: 'y' }]);
  assert.deepStrictEqual(h.pushed, []);
  h.send(1, [{ agent: 'amy' }]);
  h.api.dropOwner(1);
  assert.deepStrictEqual(h.pushed, [['amy'], []]);
});

test('faces: the channels are the ones the preloads use', () => {
  assert.deepStrictEqual([FACES_CHANNEL, FACES_PUSH], ['lean:faces', 'lean-faces']);
});
