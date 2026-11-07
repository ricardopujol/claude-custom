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
  r.app.emit('will-quit', { defaultPrevented: false });
  r.app.emit('quit');
  r.proc.emit('exit', 0);
  // The first will-quit listener says nothing about prevention: nothing can have prevented the quit before it (PR #242 Dexter 9).
  assert.deepStrictEqual(r.steps, ['before-quit', 'window-all-closed', 'will-quit first', 'quit', 'process exit 0']);
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

test('a close prevented by a LATER listener (main.js hides to the tray) is marked once every listener has run (PR #242 Dexter 5)', async () => {
  const r = appRig();
  const w = new EventEmitter(); w.id = 1;
  r.app.emit('browser-window-created', {}, w);            // the log's listener first, as in Electron (inside the constructor)
  w.on('close', (e) => e.preventDefault());               // then main.js's own: hide to the tray
  const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  w.emit('close', ev);
  await Promise.resolve();
  assert.deepStrictEqual(r.steps, ['window 1 close', 'window 1 close prevented (the window stays: hidden, or the close was held)']);

  const r2 = appRig();
  const w2 = new EventEmitter(); w2.id = 2;
  r2.app.emit('browser-window-created', {}, w2);
  w2.emit('close', { defaultPrevented: false, preventDefault() {} });
  await Promise.resolve();
  assert.deepStrictEqual(r2.steps, ['window 2 close'], 'a close nobody prevented says nothing more');
});

test('the held quit shows on the LAST will-quit listener (the paused-resume hold in main.js)', () => {
  const app = new EventEmitter();
  const steps = [];
  app.on('will-quit', (e) => { e.defaultPrevented = true; });   // main.js's resume hold calls preventDefault
  markWillQuitEnd(app, (s) => steps.push(s));
  app.emit('will-quit', { defaultPrevented: false });
  assert.deepStrictEqual(steps, ['will-quit last (prevented)']);
});

test('the default append writes "<ms> <step>" lines that the probe reads back in order (quit-log and readTimeline, Miguel F8)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { readTimeline } = require('../verify/lib/quit-linger');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-quit-log-test-'));
  try {
    const file = path.join(dir, 'quit.log');
    let t = 1000;
    const mark = createQuitLog(file, { now: () => (t += 250) });   // the real fs.appendFileSync
    mark('window 1 close');
    mark('process exit 0');
    assert.deepStrictEqual(readTimeline(fs.readFileSync(file, 'utf8'), 1000), ['0.25s window 1 close', '0.50s process exit 0']);
    assert.deepStrictEqual(readTimeline('not a line\n', 0), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
