'use strict';
/**
 * BACKLOG #145: an OS toast's click must still reach the window that raised it. Electron delivers the click through
 * the JS Notification object; if nothing holds that object it is garbage-collected and Windows, with no handler left
 * to call, activates the app by its shared id -- some other claude-custom window. So the holder keeps every shown toast
 * until it is clicked, closed or failed.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createToastHolder, MAX_HELD } = require('../app/toast-holder');

class FakeNotification extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.shown = false; }
  show() { this.shown = true; }
}

function holder() {
  const made = [];
  const clicks = [];
  class N extends FakeNotification { constructor(o) { super(o); made.push(this); } }
  const h = createToastHolder({ Notification: N, onClick: (sender) => clicks.push(sender) });
  return { h, made, clicks };
}

test('a shown toast is held, so its click handler cannot be collected', () => {
  const { h, made } = holder();
  h.show({ title: 't', body: 'b', silent: true }, 'senderA');
  assert.strictEqual(made.length, 1);
  assert.strictEqual(made[0].shown, true);
  assert.deepStrictEqual(made[0].opts, { title: 't', body: 'b', silent: true });
  assert.strictEqual(h.held(), 1);
});

test('`close` (a Windows timeout into the Action Center) keeps the toast held, and a later click still routes', () => {
  const { h, made, clicks } = holder();
  h.show({ title: 't' }, 'senderA');
  made[0].emit('close');
  assert.strictEqual(h.held(), 1);
  made[0].emit('click');
  assert.deepStrictEqual(clicks, ['senderA']);
  assert.strictEqual(h.held(), 0);
});

test('at most MAX_HELD toasts are held: a new one evicts the oldest', () => {
  const { h, made, clicks } = holder();
  for (let i = 0; i <= MAX_HELD; i++) h.show({ title: String(i) }, `s${i}`);
  assert.strictEqual(MAX_HELD, 20);
  assert.strictEqual(h.held(), MAX_HELD);
  made[0].emit('click');                     // the evicted one is no longer held; its click still routes if it fires
  assert.deepStrictEqual(clicks, ['s0']);
  assert.strictEqual(h.held(), MAX_HELD, 'releasing an evicted toast removes nothing else');
  made[1].emit('click');
  assert.strictEqual(h.held(), MAX_HELD - 1);
});

test('a show() that throws is released, logged, and does not throw out of the holder', () => {
  const logs = [];
  class N extends FakeNotification { show() { throw new Error('no presenter'); } }
  const h = createToastHolder({ Notification: N, onClick() {}, log: (m) => logs.push(m) });
  let r;
  assert.doesNotThrow(() => { r = h.show({ title: 'x' }, 's'); });
  assert.strictEqual(r, null);
  assert.strictEqual(h.held(), 0);
  assert.match(logs[0], /no presenter/);
});

test('a click calls onClick with the sender that raised THAT toast, and releases it', () => {
  const { h, made, clicks } = holder();
  h.show({ title: 'a' }, 'senderA');
  h.show({ title: 'b' }, 'senderB');
  assert.strictEqual(h.held(), 2);
  made[1].emit('click');
  made[0].emit('click');
  assert.deepStrictEqual(clicks, ['senderB', 'senderA']);
  assert.strictEqual(h.held(), 0);
});

test('a failed toast is released too, and coerces its text', () => {
  const { h, made } = holder();
  h.show({ title: undefined, body: null, silent: 0 }, 's');
  assert.deepStrictEqual(made[0].opts, { title: 'claude-custom', body: '', silent: false });
  made[0].emit('failed');
  assert.strictEqual(h.held(), 0);
});

test('a throwing click handler does not escape the event emitter', () => {
  const made = [];
  class N extends FakeNotification { constructor(o) { super(o); made.push(this); } }
  const h = createToastHolder({ Notification: N, onClick: () => { throw new Error('gone'); }, log: () => {} });
  h.show({ title: 'x' }, 's');
  assert.doesNotThrow(() => made[0].emit('click'));
  assert.strictEqual(h.held(), 0, 'released before the handler ran');
});
