'use strict';
/**
 * app/quit-watchdog.js: quitting must finish whatever a panel's renderer is doing (PR #122 R2-1, lead 2026-10-08, BACKLOG #74 A).
 * Measured: after a panel page calls window.print(), Electron enters a nested wait that never ends; app.exit(0) returns, the
 * event loop keeps running, and the process never terminates. A timer armed at will-quit and ending the process is what does.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { armQuitWatchdog, QUIT_GRACE_MS } = require('../app/quit-watchdog');

function rig(opts = {}) {
  const app = new EventEmitter(); const timers = []; const kills = [];
  const handle = armQuitWatchdog(app, { setTimer: (fn, ms) => { const t = { fn, ms, unref() { this.unrefed = true; } }; timers.push(t); return t; }, hardKill: () => kills.push('kill'), ...opts });
  return { app, timers, kills, handle };
}

test('nothing is armed until the app is really quitting', () => {
  const r = rig();
  assert.strictEqual(r.timers.length, 0);
});

test('will-quit arms ONE timer of the grace period; when it fires the process is ended', () => {
  const r = rig();
  r.app.emit('will-quit', { preventDefault() {} });
  r.app.emit('will-quit', { preventDefault() {} });
  assert.strictEqual(r.timers.length, 1);
  assert.strictEqual(r.timers[0].ms, QUIT_GRACE_MS);
  assert.deepStrictEqual(r.kills, []);
  r.timers[0].fn();
  assert.deepStrictEqual(r.kills, ['kill']);
});

test('the timer is unref()ed: a clean exit is never held up by it', () => {
  const r = rig();
  r.app.emit('will-quit', { preventDefault() {} });
  assert.strictEqual(r.timers[0].unrefed, true);
});

test('a quit another handler cancels (preventDefault) arms nothing', () => {
  const r = rig();
  r.app.on('will-quit', (e) => e.preventDefault());       // registered after the watchdog: it still runs first, so it must look again
  r.app.emit('will-quit', { defaultPrevented: true, preventDefault() {} });
  assert.strictEqual(r.timers.length, 0);
});

test('the grace period is long enough for the app\'s own cleanup', () => {
  assert.ok(QUIT_GRACE_MS >= 3000 && QUIT_GRACE_MS <= 15000);
});
