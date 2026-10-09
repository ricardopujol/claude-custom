'use strict';
/**
 * host/resource-pause.js (BACKLOG #19): the Resources panel's Pause / Resume. It judges a Pause with the SAME guard as Stop
 * (host/resource-stop.js stopDecision: a pid proved by its start time, a descendant of this window's session host, not claude, a
 * host, a ConPTY or Electron), suspends the exact subtree root first, and believes the answer only as far as it goes.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createPauser } = require('../host/resource-pause');
const { createPauseStore } = require('../host/pause-state');
const { suspendVerified } = require('../host/process-suspend');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
const p = (pid, ppid, name, cmd, start) => ({ pid, ppid, name, cmd: cmd || null, start: String(start), priv: 1 });
const world = () => [
  p(10, 1, 'electron.exe', `${EXE} ${INSTALL}`, 1000),
  p(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`, 1010),
  p(21, 20, 'conhost.exe', 'conhost.exe --headless', 1020),
  p(22, 20, 'claude.exe', 'claude.exe', 1030),
  p(23, 22, 'bash.exe', 'bash -c burn', 5000),
  p(24, 23, 'node.exe', 'node burn.js', 5100),
  p(25, 24, 'node.exe', 'node helper.js', 5200),
  p(26, 22, 'node.exe', 'node other.js', 5300),
  p(40, 1, 'node.exe', 'node unrelated.js', 1040),
];
const done = (...pids) => pids.map(pid => ({ pid, status: 'done' }));

function setup({ procs = world(), suspend, now = () => 1000 } = {}) {
  const store = createPauseStore({ now });
  const calls = [];
  const pauser = createPauser({
    readProcs: async () => procs,
    hostPids: () => [20],
    suspend: suspend || (async (action, targets) => { calls.push([action, targets.map(t => t.pid)]); return targets.map(t => ({ pid: t.pid, status: 'done' })); }),
    store,
  });
  return { store, calls, pauser };
}
const wrapCalls = (calls, fn) => async (action, targets) => { calls.push([action, targets.map(t => t.pid)]); return fn(action, targets); };

test('pause: a child of this window\'s session is suspended with everything below it, root first, and recorded', async () => {
  const { store, calls, pauser } = setup();
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.deepStrictEqual(calls, [['suspend', [24, 25]]]);
  assert.deepStrictEqual(r, { ok: true, pid: 24, name: 'node.exe', since: 1000 });
  assert.strictEqual(store.isPaused(24, '5100'), true);
  assert.deepStrictEqual(store.list()[0].pids, [{ pid: 24, start: '5100' }, { pid: 25, start: '5200' }]);
});

test('pause: refused with the stop guard\'s own reason, and nothing is suspended', async () => {
  const cases = [
    [{ pid: 22, startTime: '1030' }, 'protected'],        // claude
    [{ pid: 40, startTime: '1040' }, 'not-ours'],
    [{ pid: 99, startTime: '1' }, 'gone'],
    [{ pid: 24, startTime: '5101' }, 'reused'],
    [{ pid: 24 }, 'invalid'],
    [null, 'invalid'],
  ];
  for (const [req, reason] of cases) {
    const { store, calls, pauser } = setup();
    const r = await pauser.pause(req);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, reason, JSON.stringify(req));
    assert.strictEqual(typeof r.text, 'string');
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(store.list(), []);
  }
});

test('pause: an unreadable process list is refused', async () => {
  const store = createPauseStore();
  const pauser = createPauser({ readProcs: async () => null, hostPids: () => [20], suspend: async () => { throw new Error('must not run'); }, store });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.reason, 'unreadable');
  const pauser2 = createPauser({ readProcs: async () => { throw new Error('boom'); }, hostPids: () => [20], suspend: async () => { throw new Error('must not run'); }, store });
  assert.strictEqual((await pauser2.pause({ pid: 24, startTime: '5100' })).reason, 'unreadable');
});

test('pause: what is already paused is refused, and nothing more is suspended (a second suspend would need a second resume)', async () => {
  const { calls, pauser } = setup();
  await pauser.pause({ pid: 24, startTime: '5100' });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'already');
  assert.strictEqual(calls.length, 1);
});

test('pause: two clicks at once suspend once (the second is refused as busy while the first is in flight)', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = [];
  const { pauser } = setup({ suspend: wrapCalls(calls, async (a, t) => { await gate; return done(...t.map(x => x.pid)); }) });
  const first = pauser.pause({ pid: 24, startTime: '5100' });
  await new Promise(r => setImmediate(r));
  const second = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'busy');
  release();
  assert.strictEqual((await first).ok, true);
  assert.strictEqual(calls.length, 1);
});

test('pause: the busy mark is released after a refusal, so the next try is judged fresh', async () => {
  const { pauser } = setup({ procs: [] });
  assert.strictEqual((await pauser.pause({ pid: 24, startTime: '5100' })).reason, 'gone');
  assert.strictEqual((await pauser.pause({ pid: 24, startTime: '5100' })).reason, 'gone');
});

test('pause: the target reported gone, reused or failed is not paused, and says why', async () => {
  for (const [status, reason] of [['gone', 'gone'], ['reused', 'reused'], ['failed', 'suspend-failed']]) {
    const { store, pauser } = setup({ suspend: async (a, t) => t.map(x => ({ pid: x.pid, status, text: status === 'failed' ? 'access denied' : undefined })) });
    const r = await pauser.pause({ pid: 24, startTime: '5100' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, reason);
    if (status === 'failed') assert.match(r.text, /access denied/);
    assert.deepStrictEqual(store.list(), []);
  }
});

test('pause: a child that exited meanwhile is fine; one that refused rolls the pause back and wakes what was suspended', async () => {
  const calls = [];
  const a = setup({ suspend: wrapCalls(calls, async (act, t) => t.map(x => ({ pid: x.pid, status: x.pid === 25 ? 'gone' : 'done' }))) });
  const ok = await a.pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(a.store.list()[0].pids, [{ pid: 24, start: '5100' }], 'only what was suspended is recorded');

  const calls2 = [];
  const b = setup({ suspend: wrapCalls(calls2, async (act, t) => (act === 'suspend'
    ? t.map(x => ({ pid: x.pid, status: x.pid === 25 ? 'failed' : 'done', text: x.pid === 25 ? 'denied' : undefined }))
    : t.map(x => ({ pid: x.pid, status: 'done' })))) });
  const bad = await b.pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, 'suspend-failed');
  assert.deepStrictEqual(calls2, [['suspend', [24, 25]], ['resume', [24]]]);
  assert.deepStrictEqual(b.store.list(), [], 'a pause that did not hold is not recorded');
});

test('pause: a process the suspend found itself (extra) is recorded, so a resume wakes it too', async () => {
  const { store, pauser } = setup({ suspend: async (act, t) => [...t.map(x => ({ pid: x.pid, status: 'done' })), { pid: 77, status: 'done', extra: true, start: '7700' }] });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, true);
  assert.ok(store.list()[0].pids.some(x => x.pid === 77 && x.start === '7700'));
});

test('pause: a rollback wakes the extra the suspend found too, through its proved start', async () => {
  const calls = [];
  const { pauser } = setup({ suspend: wrapCalls(calls, async (act, t) => (act === 'suspend'
    ? [{ pid: 24, status: 'done' }, { pid: 25, status: 'failed', text: 'x' }, { pid: 77, status: 'done', extra: true, start: '7700' }]
    : t.map(x => ({ pid: x.pid, status: 'done' })))) });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.stuck === undefined, 'nothing is stuck when the rollback goes through');
  assert.deepStrictEqual(calls[1], ['resume', [24, 77]]);
});

test('pause: a rollback that fails is said, with the pids left suspended', async () => {
  const { pauser } = setup({ suspend: async (act, t) => (act === 'suspend'
    ? t.map(x => ({ pid: x.pid, status: x.pid === 25 ? 'failed' : 'done' }))
    : t.map(x => ({ pid: x.pid, status: 'failed', text: 'no' }))) });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.stuck, [24]);
  assert.match(r.text, /24/);
});

test('pause: a suspend that throws is a failure, not a crash, and what it may have suspended stays RECORDED (nothing frozen is forgotten)', async () => {
  const { store, pauser } = setup({ suspend: async () => { throw new Error('powershell died'); } });
  const r = await pauser.pause({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'suspend-failed');
  assert.match(r.text, /powershell died/);
  assert.deepStrictEqual(r.stuck, [24, 25]);
  assert.deepStrictEqual(store.list()[0].pids, [{ pid: 24, start: '5100' }, { pid: 25, start: '5200' }]);
});

// ---- resume ------------------------------------------------------------------------------------------------------------

test('resume: wakes exactly the set that was suspended, then forgets it', async () => {
  const { store, calls, pauser } = setup();
  await pauser.pause({ pid: 24, startTime: '5100' });
  const r = await pauser.resume({ pid: 24, startTime: '5100' });
  assert.deepStrictEqual(r, { ok: true, pid: 24 });
  assert.deepStrictEqual(calls, [['suspend', [24, 25]], ['resume', [24, 25]]]);
  assert.deepStrictEqual(store.list(), []);
});

test('resume: what is not paused is refused, and nothing is resumed (not by us, not a second time)', async () => {
  const { calls, pauser } = setup();
  assert.strictEqual((await pauser.resume({ pid: 24, startTime: '5100' })).reason, 'not-paused');
  await pauser.pause({ pid: 24, startTime: '5100' });
  await pauser.resume({ pid: 24, startTime: '5100' });
  assert.strictEqual((await pauser.resume({ pid: 24, startTime: '5100' })).reason, 'not-paused');
  assert.strictEqual((await pauser.resume({ pid: 40, startTime: '1040' })).reason, 'not-paused');
  assert.strictEqual((await pauser.resume({ pid: 24 })).reason, 'invalid');
  assert.strictEqual((await pauser.resume(null)).reason, 'invalid');
  assert.deepStrictEqual(calls.filter(c => c[0] === 'resume').length, 1);
});

test('resume: a process that left meanwhile is "Already exited", and is not paused any more', async () => {
  const calls = [];
  const { store, pauser } = setup({ suspend: wrapCalls(calls, async (act, t) => t.map(x => ({ pid: x.pid, status: act === 'resume' ? 'gone' : 'done' }))) });
  await pauser.pause({ pid: 24, startTime: '5100' });
  const r = await pauser.resume({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'gone');
  assert.deepStrictEqual(store.list(), []);
});

test('resume: a pid that is another process now is not touched further and is not paused any more', async () => {
  const { store, pauser } = setup({ suspend: async (act, t) => t.map(x => ({ pid: x.pid, status: act === 'resume' ? 'reused' : 'done' })) });
  await pauser.pause({ pid: 24, startTime: '5100' });
  const r = await pauser.resume({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.reason, 'reused');
  assert.deepStrictEqual(store.list(), []);
});

test('resume: a failure keeps the process paused, narrowed to what is still suspended, so it can be tried again', async () => {
  let fail = true;
  const calls = [];
  const { store, pauser } = setup({ suspend: wrapCalls(calls, async (act, t) => t.map(x => ({ pid: x.pid, status: act === 'resume' && fail && x.pid === 25 ? 'failed' : 'done', text: 'denied' }))) });
  await pauser.pause({ pid: 24, startTime: '5100' });
  const r = await pauser.resume({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'resume-failed');
  assert.strictEqual(store.isPaused(24, '5100'), true);
  fail = false;
  const again = await pauser.resume({ pid: 24, startTime: '5100' });
  assert.strictEqual(again.ok, true);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'resume'), [['resume', [24, 25]], ['resume', [25]]]);
});

test('resume: when the root itself could not be resumed it stays in the set, so the entry stays valid', async () => {
  const { store, pauser } = setup({ suspend: async (act, t) => t.map(x => ({ pid: x.pid, status: act === 'resume' && x.pid === 24 ? 'failed' : 'done' })) });
  await pauser.pause({ pid: 24, startTime: '5100' });
  await pauser.resume({ pid: 24, startTime: '5100' });
  assert.deepStrictEqual(store.list()[0].pids, [{ pid: 24, start: '5100' }]);
});

test('resume: a resume that throws keeps it paused', async () => {
  let boom = false;
  const { store, pauser } = setup({ suspend: async (act, t) => { if (act === 'resume' && boom) throw new Error('ps died'); return done(...t.map(x => x.pid)); } });
  await pauser.pause({ pid: 24, startTime: '5100' });
  boom = true;
  const r = await pauser.resume({ pid: 24, startTime: '5100' });
  assert.strictEqual(r.reason, 'resume-failed');
  assert.match(r.text, /ps died/);
  assert.strictEqual(store.isPaused(24, '5100'), true);
});

test('resumeAll: wakes everything that is paused (the app is quitting), once each, and says what it could not', async () => {
  const { store, calls, pauser } = setup();
  await pauser.pause({ pid: 24, startTime: '5100' });
  await pauser.pause({ pid: 26, startTime: '5300' });
  const r = await pauser.resumeAll();
  assert.strictEqual(r.resumed, 2);
  assert.strictEqual(r.failed, 0);
  assert.deepStrictEqual(store.list(), []);
  assert.strictEqual(calls.filter(c => c[0] === 'resume').length, 2);
});

test('pause: a process whose subtree holds something already paused is refused (it would be suspended twice and one resume would not wake it)', async () => {
  const { calls, pauser } = setup();
  await pauser.pause({ pid: 24, startTime: '5100' });
  const r = await pauser.pause({ pid: 23, startTime: '5000' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'already');
  assert.strictEqual(calls.length, 1);
});

test('pause: a refused overlapping request does not release the busy marks of the one still in flight', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = [];
  const { pauser } = setup({ suspend: wrapCalls(calls, async (a, t) => { await gate; return done(...t.map(x => x.pid)); }) });
  const first = pauser.pause({ pid: 24, startTime: '5100' });
  await new Promise(r => setImmediate(r));
  const parent = await pauser.pause({ pid: 23, startTime: '5000' });      // its subtree holds 24 and 25
  assert.strictEqual(parent.reason, 'busy');
  const child = await pauser.pause({ pid: 25, startTime: '5200' });       // 25 is part of the first request's set
  assert.strictEqual(child.reason, 'busy', 'the first request is still in flight, so 25 is still marked');
  release();
  assert.strictEqual((await first).ok, true);
  assert.strictEqual(calls.length, 1);
});
