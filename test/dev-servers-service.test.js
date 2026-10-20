'use strict';
/**
 * app/dev-servers-service.js (BACKLOG #119 A4): when the listener table is asked for, and what each tab's page is told. Every effect
 * (the PowerShell call, the tab list, the clock) is a fake here.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createDevServersService } = require('../app/dev-servers-service');
const { INTERVAL_MS } = require('../host/dev-servers');

const table = (listeners, procs = []) => `${JSON.stringify({ listeners, procs })}\nEND\n`;
const L = (port, pid) => ({ port, pid, addr: '127.0.0.1' });

function rig({ tabs = [{ key: 'a', cwd: 'C:\\p\\a' }], bases = { 'C:\\p\\a': 20000 }, hosts = {}, replies = [] } = {}) {
  const sent = [];
  const calls = [];
  const timers = [];
  const queue = [...replies];
  let clock = 1000;
  const exec = (script) => {
    calls.push(script);
    const next = queue.length ? queue.shift() : table([]);
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const svc = createDevServersService({
    exec, tabs: () => tabs, portBaseOf: cwd => (cwd in bases ? bases[cwd] : null), hostPidOf: key => (key in hosts ? hosts[key] : null),
    send: (key, state) => sent.push([key, state]), now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.live = false; },
    log: () => {},
  });
  const live = () => timers.filter(t => t.live);
  const tick = () => { const t = live()[0]; assert.ok(t, 'a timer is waiting'); t.live = false; t.fn(); };
  const settle = () => new Promise(r => setImmediate(r));
  return { svc, sent, calls, timers, live, tick, settle, advance: (ms) => { clock += ms; }, tabs };
}

test('nothing is asked until a window is in view', async () => {
  const r = rig();
  r.svc.start();
  await r.settle();
  assert.strictEqual(r.calls.length, 0, 'minimised until told otherwise');
  r.svc.setMinimised(false);
  await r.settle();
  assert.strictEqual(r.calls.length, 1);
});

test('a sample tells each tab its own block, with the process name', async () => {
  const r = rig({ replies: [table([L(20003, 40), L(3000, 50)], [{ pid: 40, ppid: 1, name: 'node.exe', start: '1' }, { pid: 50, ppid: 1, name: 'x.exe', start: '1' }])] });
  r.svc.start(); r.svc.setMinimised(false);
  await r.settle();
  assert.strictEqual(r.sent.length, 1);
  const [key, state] = r.sent[0];
  assert.strictEqual(key, 'a');
  assert.strictEqual(state.ok, true);
  assert.deepStrictEqual(state.inBlock, [{ port: 20003, pid: 40, name: 'node' }]);
  assert.strictEqual(state.base, 20000);
});

test('one call serves every tab, and each is told its own block', async () => {
  const r = rig({
    tabs: [{ key: 'a', cwd: 'C:\\p\\a' }, { key: 'b', cwd: 'C:\\p\\b' }], bases: { 'C:\\p\\a': 20000, 'C:\\p\\b': 20100 },
    replies: [table([L(20003, 40), L(20103, 41)], [{ pid: 40, ppid: 1, name: 'node.exe', start: '1' }, { pid: 41, ppid: 1, name: 'py.exe', start: '1' }])],
  });
  r.svc.start(); r.svc.setMinimised(false);
  await r.settle();
  assert.strictEqual(r.calls.length, 1);
  const byKey = Object.fromEntries(r.sent);
  assert.deepStrictEqual(byKey.a.inBlock.map(x => x.port), [20003]);
  assert.deepStrictEqual(byKey.b.inBlock.map(x => x.port), [20103]);
});

test('a tab with no block is told so: no ports, base null (the chip then has nothing to count)', async () => {
  const r = rig({ bases: {}, replies: [table([L(20003, 40)])] });
  r.svc.start(); r.svc.setMinimised(false);
  await r.settle();
  assert.strictEqual(r.sent[0][1].base, null);
  assert.deepStrictEqual(r.sent[0][1].inBlock, []);
});

test('the next sample is a gap after the last one ended, not a fixed rate', async () => {
  const r = rig();
  r.svc.start(); r.svc.setMinimised(false);
  await r.settle();
  assert.strictEqual(r.live().length, 1);
  assert.strictEqual(r.live()[0].ms, INTERVAL_MS);
  r.tick(); await r.settle();
  assert.strictEqual(r.calls.length, 2);
});

test('an unchanged table is not sent again; a changed one is', async () => {
  const r = rig({ replies: [table([L(20003, 40)]), table([L(20003, 40)]), table([L(20003, 40), L(20004, 41)])] });
  r.svc.start(); r.svc.setMinimised(false);
  await r.settle();
  r.tick(); await r.settle();
  assert.strictEqual(r.sent.length, 1, 'same table, nothing new to say');
  r.tick(); await r.settle();
  assert.strictEqual(r.sent.length, 2);
  assert.strictEqual(r.sent[1][1].inBlock.length, 2);
});

test('minimising stops the clock and the in-flight wait; restoring asks again at once', async () => {
  const r = rig();
  r.svc.start(); r.svc.setMinimised(false);
  await r.settle();
  assert.strictEqual(r.live().length, 1);
  r.svc.setMinimised(true);
  assert.strictEqual(r.live().length, 0, 'no timer while minimised');
  const before = r.calls.length;
  r.svc.setMinimised(false);
  await r.settle();
  assert.strictEqual(r.calls.length, before + 1);
});

test('no tab, no call', async () => {
  const r = rig({ tabs: [] });
  r.svc.start(); r.svc.setMinimised(false);
  await r.settle();
  assert.strictEqual(r.calls.length, 0);
  assert.strictEqual(r.live().length, 0);
});

test('a failed sample keeps the last good answer, marked stale; three in a row make it unknown, never a confident zero', async () => {
  const r = rig({ replies: [table([L(20003, 40)]), new Error('boom'), new Error('boom'), new Error('boom'), table([L(20003, 40)])] });
  r.svc.start(); r.svc.setMinimised(false);
  await r.settle();
  r.tick(); await r.settle();
  assert.strictEqual(r.sent.at(-1)[1].stale, true);
  assert.strictEqual(r.sent.at(-1)[1].inBlock.length, 1, 'the old figure, said to be old');
  r.tick(); await r.settle();
  r.tick(); await r.settle();
  const unknown = r.sent.at(-1)[1];
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual('inBlock' in unknown, false, 'no list at all: nothing to read as zero');
  r.tick(); await r.settle();
  assert.strictEqual(r.sent.at(-1)[1].ok, true, 'a good sample recovers');
  assert.strictEqual(r.sent.at(-1)[1].stale, false);
});

test('a document that is not the table counts as a failure', async () => {
  const r = rig({ replies: ['garbage'] });
  r.svc.start(); r.svc.setMinimised(false);
  await r.settle();
  assert.strictEqual(r.sent.length, 0, 'nothing known yet, nothing sent');
  r.tick(); await r.settle();
  assert.strictEqual(r.calls.length, 2);
});

test('the session host is the root of the outside-the-block join', async () => {
  const procs = [{ pid: 10, ppid: 1, name: 'electron.exe', start: '1' }, { pid: 11, ppid: 10, name: 'node.exe', start: '2' }];
  const r = rig({ hosts: { a: 10 }, replies: [table([L(5173, 11)], procs)] });
  r.svc.start(); r.svc.setMinimised(false);
  await r.settle();
  assert.deepStrictEqual(r.sent[0][1].outside, [{ port: 5173, pid: 11, name: 'node' }]);
});

test('snapshot(key) is the last thing that tab was told; a stopped service asks nothing more', async () => {
  const r = rig({ replies: [table([L(20003, 40)])] });
  r.svc.start(); r.svc.setMinimised(false);
  await r.settle();
  assert.strictEqual(r.svc.snapshot('a').inBlock.length, 1);
  assert.strictEqual(r.svc.snapshot('zzz'), null);
  r.svc.stop();
  assert.strictEqual(r.live().length, 0);
  r.svc.setMinimised(true); r.svc.setMinimised(false);
  await r.settle();
  assert.strictEqual(r.calls.length, 1);
});

test('refresh() asks soon when a tab appears while the clock is idle', async () => {
  const r = rig({ tabs: [] });
  r.svc.start(); r.svc.setMinimised(false);
  await r.settle();
  r.tabs.push({ key: 'a', cwd: 'C:\\p\\a' });
  r.svc.refresh();
  await r.settle();
  assert.strictEqual(r.calls.length, 1);
});

test('a refresh while a sample is in flight does not start a second one', async () => {
  const r = rig();
  r.svc.start(); r.svc.setMinimised(false);
  r.svc.refresh(); r.svc.refresh();
  await r.settle();
  assert.strictEqual(r.calls.length, 1);
});
