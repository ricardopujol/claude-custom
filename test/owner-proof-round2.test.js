'use strict';
/**
 * PR #261 review round (fix/owner-proof): Dexter 1-5, Miguel I1-I3 / S2-S4.
 *
 *   Dexter 1 (2nd half)  a launch with a live owner asks `who` without waiting for its OWN start: the hand-over does not use it. The claim
 *                        gets `resolveStart()` and asks it only once the decision needs the start (publish).
 *   Dexter 4             a launch that could not learn its start at run() learns it later: reclaim() asks again (it stayed no-self-start).
 *   Dexter 2 / Miguel I3 the window pipe answers `who` too (host/window-router.js), so a window claim can prove its owner without
 *                        powershell.exe.
 *   Dexter 3             the restore proof's query gets the one retry: a first query that timed out is not 'unknown' when the retry answers.
 * Real files and real pipes; pids are made up (unique per test).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const uniquePid = () => 900_000_000 + Math.floor(Math.random() * 90_000_000);
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 10)); }
};
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// ---- owner-file: the start is resolved only when the decision needs it -----------------------------------------------------------

test('claimFile: no start yet + resolveStart -> asked at the publish, and the file names the resolved start', async () => {
  const { claimFile } = require('../host/owner-file');
  const dir = tmpDir('cc-r2-');
  const file = path.join(dir, 'owner.json');
  let asked = 0;
  const r = await claimFile({ file, self: { pid: 20, start: null }, startTimes: async () => new Map(), now: () => 5,
    resolveStart: async () => { asked++; return 'S20'; } });
  assert.strictEqual(r.published, true);
  assert.strictEqual(asked, 1);
  assert.deepStrictEqual(JSON.parse(read(file)), { pid: 20, start: 'S20', at: 5 });
});

test('claimFile: a live owner (proven on its pipe) is handed over and resolveStart is never asked', async () => {
  const { claimFile } = require('../host/owner-file');
  const dir = tmpDir('cc-r2-');
  const file = path.join(dir, 'owner.json');
  fs.writeFileSync(file, JSON.stringify({ pid: 10, start: 'S10' }));
  let asked = 0;
  const r = await claimFile({ file, self: { pid: 20, start: null }, startTimes: async () => null, ask: async () => ({ pid: 10, start: 'S10' }),
    resolveStart: async () => { asked++; return 'S20'; } });
  assert.strictEqual(r.action, 'focus');
  assert.strictEqual(asked, 0);
});

test('claimFile: resolveStart answering null (or throwing) is still no-self-start, nothing published', async () => {
  const { claimFile } = require('../host/owner-file');
  for (const resolveStart of [async () => null, async () => { throw new Error('x'); }]) {
    const dir = tmpDir('cc-r2-');
    const file = path.join(dir, 'owner.json');
    const r = await claimFile({ file, self: { pid: 20, start: null }, startTimes: async () => new Map(), resolveStart });
    assert.strictEqual(r.reason, 'no-self-start');
    assert.strictEqual(read(file), null);
  }
});

// ---- window-claim: `who` before the own start (Dexter 1, 2nd half) -------------------------------------------------------------------

test('Dexter 1: with a live owner the launch is handed over WITHOUT waiting for its own (slow) start', async () => {
  const appClaim = require('../host/app-claim');
  const { samePath } = require('../host/project-layout');
  const dir = tmpDir('cc-r2-app-');
  const alive = new Set();
  const mk = (pid, ownStart, over = {}) => appClaim.createAppClaim({
    dir, pid, ownStart, startTimes: async (pids) => new Map(pids.filter((p) => alive.has(p)).map((p) => [p, `S${p}`])),
    launchCwd: path.resolve('/projects/a/dev'), installDir: path.resolve('/apps/j'), probe: false, env: {}, samePath,
    act: async () => {}, onExit: () => {}, log: () => {}, readyBoundMs: 5000, ...over,
  });
  const ownerPid = uniquePid();
  alive.add(ownerPid);
  const owner = mk(ownerPid, async () => `S${ownerPid}`);
  assert.strictEqual(await owner.run(), 'proceed');
  owner.markReady();
  const launchPid = uniquePid();
  // its own start takes 3 s (a busy machine); the PowerShell queries fail
  const launch = mk(launchPid, () => new Promise((r) => setTimeout(() => r(`S${launchPid}`), 3000)), { startTimes: async () => null });
  try {
    const t0 = Date.now();
    assert.strictEqual(await launch.run(), 'exit');
    assert.ok(Date.now() - t0 < 1500, `handed over without the 3 s own-start wait (${Date.now() - t0} ms)`);
  } finally { owner.stop(); launch.stop(); }
});

test('Dexter 1: a refused hand-over still takes the file over with this process\'s start (asked when it is needed)', async () => {
  const { createWindowClaim } = require('../host/window-claim');
  const taken = [];
  const c = createWindowClaim({
    enabled: true, stateRoot: 'C:\\p\\dev', pid: 20, ownStart: async () => 'S20', startTimes: async () => new Map(),
    project: null, launchCwd: 'C:\\p\\dev', explicitPort: null,
    listen: async () => ({ close: async () => {} }),
    claim: async () => ({ action: 'focus', reason: 'live-owner', owner: { pid: 10, start: 'S10' }, file: 'x', text: 'T' }),
    send: async () => ({ ok: false, error: 'closing' }),
    takeOver: (o) => { taken.push(o.self); return true; },
    release: () => true, forwardedCwd: () => undefined, act: async () => {}, onExit: () => {}, now: () => 1000, readyBoundMs: 5000, log: () => {},
  });
  assert.strictEqual(await c.run(), 'proceed');
  assert.deepStrictEqual(taken, [{ pid: 20, start: 'S20' }]);
});

// ---- Dexter 4: reclaim() learns a start that run() could not --------------------------------------------------------------------------

test('Dexter 4: run() without an own start publishes nothing; once the start is known, reclaim() publishes app.json', async () => {
  const appClaim = require('../host/app-claim');
  const { samePath } = require('../host/project-layout');
  const dir = tmpDir('cc-r2-app-');
  const pid = uniquePid();
  let start = null;
  const c = appClaim.createAppClaim({
    dir, pid, ownStart: async () => start, startTimes: async () => new Map(),
    launchCwd: path.resolve('/projects/a/dev'), installDir: path.resolve('/apps/j'), probe: false, env: {}, samePath,
    act: async () => {}, onExit: () => {}, log: () => {}, readyBoundMs: 5000,
  });
  try {
    assert.strictEqual(await c.run(), 'proceed');
    assert.strictEqual(read(path.join(dir, 'app.json')), null, 'no-self-start: nothing published');
    start = `S${pid}`;
    assert.strictEqual(await c.reclaim(), true);
    assert.deepStrictEqual(JSON.parse(read(path.join(dir, 'app.json'))).start, `S${pid}`);
    assert.deepStrictEqual(await require('../host/window-focus').who({ name: require('../host/window-focus').appPipeNameFor(pid) }),
      { pid, start: `S${pid}` }, 'and the pipe now answers who');
  } finally { c.stop(); }
});

// ---- Dexter 2 / Miguel I3: the window pipe answers who --------------------------------------------------------------------------------

test('Dexter 2: the window router answers who with the identity of a registered window; none with a start -> null', async () => {
  const focus = require('../host/window-focus');
  const { createWindowRouter } = require('../host/window-router');
  const { projectOf, samePath, isInside } = require('../host/project-layout');
  const pid = uniquePid();
  const router = createWindowRouter({ listen: focus.listen, pid, projectOf, samePath, isInside });
  let start = null;
  const handle = await router.register({ root: 'C:\\r', hasPort: () => false, accepting: () => true, whenReady: () => true, onFocus: () => {},
    who: () => (start ? { pid, start } : null) });
  try {
    assert.strictEqual(await focus.who({ pid }), null, 'no start known yet: no identity');
    start = 'S1';
    assert.deepStrictEqual(await focus.who({ pid }), { pid, start: 'S1' });
  } finally { await handle.close(); await router.stop(); }
});

test('Dexter 2: a window launch whose start-time query fails is still handed to the live window (proof by the window pipe)', async () => {
  const { createWindowClaim } = require('../host/window-claim');
  const owner = require('../host/window-owner');
  const focus = require('../host/window-focus');
  const { createWindowRouter } = require('../host/window-router');
  const { projectOf, samePath, isInside } = require('../host/project-layout');
  const pid = uniquePid();
  const router = createWindowRouter({ listen: focus.listen, pid, projectOf, samePath, isInside });
  const root = tmpDir('cc-r2-win-');
  const acted = [];
  const mk = (selfPid, over = {}) => createWindowClaim({
    enabled: true, stateRoot: root, pid: selfPid, ownStart: async () => `S${selfPid}`, startTimes: async (pids) => new Map(pids.map((p) => [p, `S${p}`])),
    project: null, launchCwd: root, explicitPort: null, root,
    listen: (entry) => router.register(entry), claim: owner.claim, send: focus.send, takeOver: owner.takeOver, release: owner.release,
    forwardedCwd: owner.forwardedCwd, act: async (m) => { acted.push(m); }, onExit: () => {}, readyBoundMs: 5000, ackMs: 2000,
    ask: (o) => focus.who({ pid: o.pid }), ...over,
  });
  const w = mk(pid);
  try {
    assert.strictEqual(await w.run(), 'proceed');
    w.markReady();
    const launch = mk(pid + 1, { listen: async () => ({ close: async () => {} }), startTimes: async () => null });
    assert.strictEqual(await launch.run(), 'exit');
    await until(() => acted.length === 1);
  } finally { w.stop(); await router.stop(); }
});

// ---- Dexter 3: the restore proof's query gets the retry ----------------------------------------------------------------------------

test('Dexter 3: a dead owner whose first query timed out is proven dead by the retry, not left unknown (the restore list survives)', async () => {
  const { proveOwner } = require('../host/owner-file');
  const { startTimes, patientStartTimes } = require('../host/proc-start');
  const owner = { pid: 12345, start: 'S12345' };
  const timesOut = async () => { throw Object.assign(new Error('timeout'), { killed: true }); };
  const absent = async () => 'END\n';
  const o = { platform: 'win32', exec: timesOut, retryExec: absent };
  assert.strictEqual(await proveOwner(owner, { startTimes: (p) => startTimes(p, { platform: 'win32', exec: timesOut }) }), 'unknown',
    'without the retry: unknown, and the restore keeps nothing');
  assert.strictEqual(await proveOwner(owner, { startTimes: (p) => patientStartTimes(p, o) }), 'dead');
});
