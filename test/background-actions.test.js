'use strict';
// The ▾ menu's effects, out of app/main.js (Miguel, PR 2 Y1/Y2): the native
// template, Open, Stop and the popup wait, with every effect injected.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { menuTemplate, createBackgroundActions, popupUntilClosed } = require('../app/background-actions');

const ROW = { install: 'C:\\cc\\feat-a', build: 'feat-a', own: true, port: 7701, pid: 101, cwd: 'C:\\x', exact: true, windows: 0 };
const item = (over = {}) => ({ label: 'a  ·  feat-a  ·  3 h  ·  no window', open: { kind: 'window', port: 7701, cwd: 'C:\\x' }, stop: true, row: ROW, ...over });

test('menuTemplate: one entry per session, Open and Stop… in a submenu, enabled as the model says', () => {
  const seen = [];
  const t = menuTemplate({ items: [item(), item({ open: null, stop: false })], footer: null },
    { open: o => seen.push(['open', o]), stop: r => seen.push(['stop', r]) });
  assert.strictEqual(t.length, 2);
  assert.deepStrictEqual(t[0].submenu.map(s => [s.label, s.enabled]), [['Open', true], ['Stop…', true]]);
  assert.deepStrictEqual(t[1].submenu.map(s => [s.label, s.enabled]), [['Open', false], ['Stop…', false]]);
  t[0].submenu[0].click();
  t[0].submenu[1].click();
  assert.deepStrictEqual(seen, [['open', item().open], ['stop', ROW]]);
});

test("menuTemplate: a tab here reads 'Go to its tab'", () => {
  const t = menuTemplate({ items: [item({ open: { kind: 'select-tab', key: 'k' } })], footer: null }, { open() {}, stop() {} });
  assert.strictEqual(t[0].submenu[0].label, 'Go to its tab');
});

test('menuTemplate: & in a folder or footer is shown, never read as a mnemonic', () => {
  const t = menuTemplate({ items: [item({ label: 'R&D  ·  b' })], footer: 'A & B' }, { open() {}, stop() {} });
  assert.strictEqual(t[0].label, 'R&&D  ·  b');
  assert.strictEqual(t[t.length - 1].label, 'A && B');
});

test('menuTemplate: the footer is a disabled line, after a separator only when there are sessions', () => {
  const none = menuTemplate({ items: [], footer: 'No sessions' }, { open() {}, stop() {} });
  assert.deepStrictEqual(none, [{ label: 'No sessions', enabled: false }]);
  const some = menuTemplate({ items: [item()], footer: 'x' }, { open() {}, stop() {} });
  assert.deepStrictEqual(some.slice(1), [{ type: 'separator' }, { label: 'x', enabled: false }]);
  assert.strictEqual(menuTemplate({ items: [item()], footer: null }, { open() {}, stop() {} }).length, 1);
});

function actions(over = {}) {
  const calls = [];
  const deps = {
    select: k => calls.push(['select', k]),
    focusWindow: () => calls.push(['focus']),
    spawnWindow: o => { calls.push(['spawn', o]); return { pid: 55 }; },
    confirmStop: async r => { calls.push(['confirm', r.pid]); return true; },
    inform: async t => calls.push(['inform', t]),
    stopHost: async () => ({ outcome: 'stopped', text: 'Stopped that session.', how: 'stop-if-idle', reason: null }),
    log: m => calls.push(['log', m]),
    ...over,
  };
  return { a: createBackgroundActions(deps), calls };
}

test('open: a tab here is selected and the window comes forward', () => {
  const { a, calls } = actions();
  assert.deepStrictEqual(a.open({ kind: 'select-tab', key: 'k' }), { selected: 'k' });
  assert.deepStrictEqual(calls, [['select', 'k'], ['focus']]);
});

test('open: anything else is a window of its own on that host, and nothing for no Open', () => {
  const { a, calls } = actions();
  assert.deepStrictEqual(a.open({ kind: 'window', port: 7701, cwd: 'C:\\x' }), { pid: 55 });
  assert.deepStrictEqual(calls.filter(c => c[0] === 'spawn'), [['spawn', { port: 7701, cwd: 'C:\\x' }]]);
  assert.strictEqual(a.open(null), null);
});

test('open: a spawn that throws is logged and answers null', () => {
  const { a, calls } = actions({ spawnWindow: () => { throw new Error('ENOENT'); } });
  assert.strictEqual(a.open({ kind: 'window', port: 7701, cwd: 'C:\\x' }), null);
  assert.ok(calls.some(c => c[0] === 'log' && /ENOENT/.test(c[1])));
});

test('stop: asks first; a cancel stops nothing', async () => {
  let asked = 0;
  const { a, calls } = actions({ confirmStop: async () => false, stopHost: async () => { asked += 1; return {}; } });
  assert.deepStrictEqual(await a.stop(ROW), { outcome: 'cancelled' });
  assert.strictEqual(asked, 0);
  assert.ok(!calls.some(c => c[0] === 'inform'));
});

test('stop: stopped is its own answer; anything else is said out loud', async () => {
  const ok = actions();
  assert.strictEqual((await ok.a.stop(ROW)).outcome, 'stopped');
  assert.ok(!ok.calls.some(c => c[0] === 'inform'));
  const refused = actions({ stopHost: async () => ({ outcome: 'has-window', text: 'It has a window.', how: null, reason: null }) });
  assert.strictEqual((await refused.a.stop(ROW)).outcome, 'has-window');
  assert.deepStrictEqual(refused.calls.filter(c => c[0] === 'inform'), [['inform', 'It has a window.']]);
});

test('stop: a stop that throws is failed, and says so', async () => {
  const { a, calls } = actions({ stopHost: async () => { throw new Error('boom'); } });
  const r = await a.stop(ROW);
  assert.strictEqual(r.outcome, 'failed');
  assert.deepStrictEqual(calls.filter(c => c[0] === 'inform'), [['inform', "Couldn't stop that session."]]);
});

test('stop: the log names pid, port, build and how', async () => {
  const { a, calls } = actions();
  await a.stop(ROW);
  assert.ok(calls.some(c => c[0] === 'log' && c[1] === '[main] Stop (background): stopped (pid 101, port 7701, build feat-a, how stop-if-idle)'));
});

// Miguel Y2: a window closed with the menu open may never call the popup's
// callback, which would leave main's one-at-a-time flag set for good.
test('popupUntilClosed: resolves on the menu closing, or on the window closing first', async () => {
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  let cb = null;
  const menu = { popup: (o) => { cb = o.callback; }, closePopup: () => {} };
  const p1 = popupUntilClosed(menu, win);
  cb();
  await p1;
  const p2 = popupUntilClosed(menu, win);
  win.emit('closed');
  await p2;
  assert.strictEqual(win.listenerCount('closed'), 0, 'no listener left behind');
});

test('popupUntilClosed: an already-destroyed window resolves at once, without a popup', async () => {
  let popped = false;
  const win = new EventEmitter();
  win.isDestroyed = () => true;
  await popupUntilClosed({ popup: () => { popped = true; } }, win);
  assert.strictEqual(popped, false);
});

// Windowless sessions PR 3: *Stop all in this project*.
test('menuTemplate: Stop all sits after the sessions, enabled as the model says, and hands over its rows', () => {
  const seen = [];
  const t = menuTemplate({ items: [item()], footer: null, stopAll: { rows: [ROW], enabled: true } },
    { open() {}, stop() {}, stopAll: rows => seen.push(rows) });
  assert.deepStrictEqual(t.slice(1).map(x => x.type || x.label), ['separator', 'Stop all in this project…']);
  t[2].click();
  assert.deepStrictEqual(seen, [[ROW]]);
  const off = menuTemplate({ items: [item()], footer: null, stopAll: { rows: [], enabled: false } }, { open() {}, stop() {}, stopAll() {} });
  assert.strictEqual(off[2].enabled, false);
  assert.strictEqual(menuTemplate({ items: [item()], footer: null, stopAll: null }, { open() {}, stop() {} }).length, 1);
});

test('stopAll: one confirmation for all; a cancel stops nothing', async () => {
  let asked = 0;
  const { a } = actions({ confirmStopAll: async () => false, stopHost: async () => { asked += 1; return {}; } });
  assert.deepStrictEqual(await a.stopAll([ROW, { ...ROW, pid: 102 }]), { outcome: 'cancelled' });
  assert.strictEqual(asked, 0);
});

test('stopAll: stops them one at a time, and says once what was kept', async () => {
  const order = [];
  let inFlight = 0;
  const { a, calls } = actions({
    confirmStopAll: async rows => { calls.push(['confirmAll', rows.length]); return true; },
    stopHost: async (r) => {
      inFlight += 1; assert.strictEqual(inFlight, 1, 'one at a time');
      order.push(r.pid); await new Promise(res => setImmediate(res)); inFlight -= 1;
      return r.pid === 102 ? { outcome: 'has-window', text: 'It has a window.' } : { outcome: 'stopped', text: 'Stopped.' };
    },
  });
  const r = await a.stopAll([ROW, { ...ROW, pid: 102, cwd: 'C:\\y' }]);
  assert.deepStrictEqual(order, [101, 102]);
  assert.deepStrictEqual(r.results.map(x => x.outcome), ['stopped', 'has-window']);
  const told = calls.filter(c => c[0] === 'inform');
  assert.strictEqual(told.length, 1);
  assert.match(told[0][1], /Stopped 1 of 2/);
  assert.match(told[0][1], /C:\\y.*It has a window\./);
});

test('stopAll: a stop that throws counts as kept, and the rest still run', async () => {
  const { a, calls } = actions({
    confirmStopAll: async () => true,
    stopHost: async (r) => { if (r.pid === 101) throw new Error('x'); return { outcome: 'stopped', text: 'Stopped.' }; },
  });
  const r = await a.stopAll([ROW, { ...ROW, pid: 102 }]);
  assert.deepStrictEqual(r.results.map(x => x.outcome), ['failed', 'stopped']);
  assert.match(calls.filter(c => c[0] === 'inform')[0][1], /Stopped 1 of 2/);
});

test('stopAll: all stopped is said too, once', async () => {
  const { a, calls } = actions({ confirmStopAll: async () => true });
  await a.stopAll([ROW]);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'inform'), [['inform', 'Stopped 1 of 1 session.']]);
});
