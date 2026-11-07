'use strict';
/**
 * app/quit-log.js: the quit's timeline, to a file, only when CLAUDE_CUSTOM_QUIT_LOG names one (BACKLOG #74 A,
 * verify/probe-quit-linger.js reads it). Off means nothing is written and nothing is listened to.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createQuitLog, wireQuitLog, markWillQuitEnd } = require('../app/quit-log');

function logRig() {
  const lines = [];
  let t = 1000;
  const mark = createQuitLog('quit.log', { append: (file, text) => lines.push([file, text]), now: () => t++ });
  return { lines, mark };
}

test('no file (unset, empty, not a string) is a no-op that writes nothing', () => {
  for (const file of [undefined, null, '', 42]) {
    let wrote = 0;
    const mark = createQuitLog(file, { append: () => { wrote++; } });
    mark('before-quit');
    assert.strictEqual(wrote, 0, String(file));
  }
});

test('a line is "<ms> <step>", appended to the named file', () => {
  const r = logRig();
  r.mark('before-quit');
  r.mark('quit');
  assert.deepStrictEqual(r.lines, [['quit.log', '1000 before-quit\n'], ['quit.log', '1001 quit\n']]);
});

test('a failing append never throws into the quit', () => {
  const mark = createQuitLog('quit.log', { append: () => { throw new Error('disk full'); } });
  assert.doesNotThrow(() => mark('will-quit first'));
});

function appRig() {
  const app = new EventEmitter();
  const proc = new EventEmitter();
  const steps = [];
  wireQuitLog(app, (s) => steps.push(s), proc);
  return { app, proc, steps };
}

test('the app\'s quit events are marked, the first will-quit listener before any other', () => {
  const r = appRig();
  const order = [];
  // A listener registered BEFORE the wiring would run first without prependListener.
  const app = new EventEmitter();
  app.on('will-quit', () => order.push('other'));
  wireQuitLog(app, (s) => order.push(s), new EventEmitter());
  app.emit('will-quit', {});
  assert.deepStrictEqual(order, ['will-quit first', 'other']);

  r.app.emit('before-quit');
  r.app.emit('window-all-closed');
  r.app.emit('will-quit', { defaultPrevented: true });
  r.app.emit('quit');
  r.proc.emit('exit', 0);
  assert.deepStrictEqual(r.steps, ['before-quit', 'window-all-closed', 'will-quit first (prevented)', 'quit', 'process exit 0']);
});

test('a window\'s close and closed, and a page\'s destroyed and render-process-gone, are marked with their ids', () => {
  const r = appRig();
  const w = new EventEmitter(); w.id = 3;
  r.app.emit('browser-window-created', {}, w);
  w.emit('close', { defaultPrevented: false });
  w.emit('closed');
  w.emit('closed');
  const wc = new EventEmitter(); wc.id = 7; wc.getType = () => 'browserView';
  r.app.emit('web-contents-created', {}, wc);
  wc.emit('render-process-gone', {}, { reason: 'clean-exit' });
  wc.emit('destroyed');
  assert.deepStrictEqual(r.steps, ['window 3 close', 'window 3 closed', 'webContents 7 render-process-gone clean-exit', 'webContents 7 (browserView) destroyed']);
});

test('markWillQuitEnd marks after every listener registered before it', () => {
  const app = new EventEmitter();
  const order = [];
  app.on('will-quit', () => order.push('other'));
  markWillQuitEnd(app, (s) => order.push(s));
  app.emit('will-quit', {});
  assert.deepStrictEqual(order, ['other', 'will-quit last']);
});

test('no mark function wires nothing', () => {
  const app = new EventEmitter();
  wireQuitLog(app, null, new EventEmitter());
  markWillQuitEnd(app, undefined);
  assert.strictEqual(app.eventNames().length, 0);
});
