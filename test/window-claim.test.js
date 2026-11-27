'use strict';
/**
 * host/window-claim.js: the launch-time orchestration of "one window per project", with its effects handed in (PR #247 Miguel I2),
 * and the owner's life cycle: it says no once it is quitting (Dexter 1 / Miguel B1), never stays a zombie (Dexter 5 / Miguel I1).
 * The module is loaded inside each test so a missing module fails every test.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const load = () => require('../host/window-claim');
const real = () => ({
  owner: require('../host/window-owner'),
  focus: require('../host/window-focus'),
});
const uniquePid = () => 900_000_000 + Math.floor(Math.random() * 90_000_000);
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 10)); }
};
const PROJECT = { kind: 'container', root: 'C:\\p', dev: 'C:\\p\\dev' };

// ---- with every effect faked: the branches ------------------------------------------------------------------------

function fakes(over = {}) {
  const calls = [];
  const deps = {
    enabled: true, stateRoot: 'C:\\p\\dev', pid: 20, ownStart: async () => 'S20', startTimes: async () => new Map(),
    project: PROJECT, launchCwd: 'C:\\p\\dev', explicitPort: null,
    listen: async (o) => { calls.push(['listen', o.pid]); return { close: async () => { calls.push(['pipe-close']); } }; },
    claim: async () => ({ action: 'proceed', reason: 'no-owner', published: true }),
    send: async (o) => { calls.push(['send', o.pid, o.msg]); return { ok: true }; },
    takeOver: () => { calls.push(['takeOver']); return true; },
    release: (o) => { calls.push(['release', o.selfPid, o.selfStart]); return true; },
    forwardedCwd: (cwd, project) => (cwd === 'C:\\p\\dev' || !project ? undefined : cwd),
    act: async (msg) => { calls.push(['act', msg]); },
    onExit: (fn) => { calls.push(['onExit']); deps.exitHook = fn; },
    now: () => 1000, readyBoundMs: 5000, log: () => {},
    ...over,
  };
  return { deps, calls };
}
const live = { action: 'focus', reason: 'live-owner', owner: { pid: 10, start: 'S10' }, file: 'x' };

test('claim: disabled (a probe window) proceeds and touches nothing', async () => {
  const { createWindowClaim } = load();
  const { deps, calls } = fakes({ enabled: false });
  assert.strictEqual(await createWindowClaim(deps).run(), 'proceed');
  assert.deepStrictEqual(calls, []);
});

test('claim: a live owner that accepts -> exit; no takeover; the launch\'s lane and port are forwarded', async () => {
  const { createWindowClaim } = load();
  const { deps, calls } = fakes({ claim: async () => live, launchCwd: 'C:\\p\\feat-x', explicitPort: 7702 });
  assert.strictEqual(await createWindowClaim(deps).run(), 'exit');
  assert.deepStrictEqual(calls.filter(c => c[0] === 'send'), [['send', 10, { cwd: 'C:\\p\\feat-x', port: 7702 }]]);
  assert.ok(!calls.some(c => c[0] === 'takeOver'));
  assert.ok(!calls.some(c => c[0] === 'onExit'), 'a launch that ends registers no exit hook');
});

test('claim: a launch from dev\\ forwards no lane at all', async () => {
  const { createWindowClaim } = load();
  const { deps, calls } = fakes({ claim: async () => live });
  await createWindowClaim(deps).run();
  assert.deepStrictEqual(calls.filter(c => c[0] === 'send'), [['send', 10, {}]]);
});

test('claim: an owner that refuses (it is quitting) -> this launch opens its window and takes the file over', async () => {
  const { createWindowClaim } = load();
  const { deps, calls } = fakes({ claim: async () => live, send: async () => ({ ok: false, error: 'closing' }) });
  assert.strictEqual(await createWindowClaim(deps).run(), 'proceed');
  assert.ok(calls.some(c => c[0] === 'takeOver'));
  assert.ok(calls.some(c => c[0] === 'onExit'), 'it now owns the file, so it releases it on exit');
});

test('claim: an owner that cannot be reached -> takeover, never a lost launch', async () => {
  const { createWindowClaim } = load();
  const { deps, calls } = fakes({ claim: async () => live, send: async () => ({ ok: false, error: 'socket error: ENOENT' }) });
  assert.strictEqual(await createWindowClaim(deps).run(), 'proceed');
  assert.ok(calls.some(c => c[0] === 'takeOver'));
});

test('claim: an answer that is not exactly { ok: true } is not an acceptance (null, array, string, truthy ok) and never throws', async () => {
  const { createWindowClaim } = load();
  for (const answer of [null, undefined, [], 'ok', 1, { ok: 'yes' }, { ok: 1 }, {}]) {
    const { deps, calls } = fakes({ claim: async () => live, send: async () => answer });
    assert.strictEqual(await createWindowClaim(deps).run(), 'proceed', JSON.stringify(answer));
    assert.ok(calls.some(c => c[0] === 'takeOver'), JSON.stringify(answer));
  }
});

test('claim: no owner -> proceed, the file is ours, and the exit hook releases it by pid AND start time', async () => {
  const { createWindowClaim } = load();
  const { deps, calls } = fakes();
  assert.strictEqual(await createWindowClaim(deps).run(), 'proceed');
  assert.ok(!calls.some(c => c[0] === 'send'));
  deps.exitHook();
  assert.deepStrictEqual(calls.filter(c => c[0] === 'release'), [['release', 20, 'S20']]);
});

test('claim: the pipe could not listen -> proceed, and a file published for a window nobody can reach is released at once', async () => {
  const { createWindowClaim } = load();
  const { deps, calls } = fakes({ listen: async () => { throw new Error('EADDRINUSE'); } });
  assert.strictEqual(await createWindowClaim(deps).run(), 'proceed');
  assert.deepStrictEqual(calls.filter(c => c[0] === 'release'), [['release', 20, 'S20']]);
});

test('claim: the check throwing is the old behaviour: proceed, no crash', async () => {
  const { createWindowClaim } = load();
  const { deps } = fakes({ claim: async () => { throw new Error('boom'); } });
  assert.strictEqual(await createWindowClaim(deps).run(), 'proceed');
});

test('claim: this process\'s own start time unknown -> the claim gets none, nothing is published by it, the launch proceeds', async () => {
  const { createWindowClaim } = load();
  let self = null;
  const { deps } = fakes({ ownStart: async () => null, claim: async (o) => { self = o.self; return { action: 'proceed', published: false }; } });
  assert.strictEqual(await createWindowClaim(deps).run(), 'proceed');
  assert.deepStrictEqual(self, { pid: 20, start: null });
});

// ---- the owner's life cycle ---------------------------------------------------------------------------------------

test('accepting: yes while starting inside the bound, no past it, yes again once ready, never after stop()', async () => {
  const { createWindowClaim } = load();
  let t = 1000;
  const { deps } = fakes({ now: () => t, readyBoundMs: 5000 });
  const c = createWindowClaim(deps);
  await c.run();
  assert.strictEqual(c.accepting(), true);
  t = 5999; assert.strictEqual(c.accepting(), true);
  t = 6001; assert.strictEqual(c.accepting(), false, 'a start that has not finished within the bound is not a window to hand launches to');
  c.markReady();
  assert.strictEqual(c.accepting(), true);
  c.stop();
  assert.strictEqual(c.accepting(), false);
});

test('stop(): releases the file by pid + start, closes the pipe, and does both only once', async () => {
  const { createWindowClaim } = load();
  const { deps, calls } = fakes();
  const c = createWindowClaim(deps);
  await c.run();
  calls.length = 0;
  c.stop(); c.stop();
  assert.deepStrictEqual(calls.filter(c2 => c2[0] === 'release'), [['release', 20, 'S20']]);
  await until(() => calls.some(c2 => c2[0] === 'pipe-close'));
  assert.strictEqual(calls.filter(c2 => c2[0] === 'pipe-close').length, 1);
});

test('the launch\'s action waits for the window to be ready, and never happens after stop()', async () => {
  const { createWindowClaim } = load();
  let handler = null;
  const listen = async (o) => { handler = o.onFocus; return { close: async () => {} }; };
  const a = fakes({ listen });
  const ca = createWindowClaim(a.deps);
  await ca.run();
  const pending = handler({ cwd: 'C:\\p\\feat-x' });
  await new Promise(r => setTimeout(r, 30));
  assert.ok(!a.calls.some(c => c[0] === 'act'), 'not ready: nothing acted');
  ca.markReady();
  await pending;
  assert.deepStrictEqual(a.calls.filter(c => c[0] === 'act'), [['act', { cwd: 'C:\\p\\feat-x' }]]);

  const b = fakes({ listen });
  const cb = createWindowClaim(b.deps);
  await cb.run();
  const p2 = handler({});
  cb.stop();
  cb.markReady();
  await p2;
  assert.ok(!b.calls.some(c => c[0] === 'act'), 'a window that is quitting does not act');
});

test('the pipe is given the owner\'s accepting() as its gate', async () => {
  const { createWindowClaim } = load();
  let gate = null;
  const { deps } = fakes({ listen: async (o) => { gate = o.accepting; return { close: async () => {} }; } });
  const c = createWindowClaim(deps);
  await c.run();
  assert.strictEqual(typeof gate, 'function');
  c.stop();
  assert.strictEqual(gate(), false);
});

// ---- real owner file + real pipes: the situations the findings named -----------------------------------------------

async function realClaim(root, pid, acts, extra = {}) {
  const { owner, focus } = real();
  const { createWindowClaim } = load();
  const starts = extra.starts || (async (pids) => new Map(pids.map(p => [p, `S${p}`])));
  const c = createWindowClaim({
    enabled: true, stateRoot: root, pid, ownStart: async () => `S${pid}`, startTimes: starts,
    project: { kind: 'container', root: path.dirname(root), dev: root }, launchCwd: extra.launchCwd || root, explicitPort: null,
    listen: focus.listen, claim: owner.claim, send: focus.send, takeOver: owner.takeOver, release: owner.release,
    forwardedCwd: owner.forwardedCwd, act: async (msg) => { acts.push([pid, msg]); }, onExit: () => {},
    now: Date.now, readyBoundMs: 60_000, log: () => {},
  });
  return c;
}

test('real: a second launch hands over to the first, which acts on it once ready; the second ends', async () => {
  const root = path.join(tmpDir('cc-window-claim-'), 'dev');
  fs.mkdirSync(root, { recursive: true });
  const acts = [];
  const a = await realClaim(root, uniquePid(), acts);
  assert.strictEqual(await a.run(), 'proceed');
  a.markReady();
  const bPid = uniquePid();
  const b = await realClaim(root, bPid, acts, { launchCwd: path.join(path.dirname(root), 'feat-x') });
  assert.strictEqual(await b.run(), 'exit');
  await until(() => acts.length === 1);
  assert.strictEqual(acts[0][1].cwd, path.join(path.dirname(root), 'feat-x'));
  await a.stop();
});

test('real: close and reopen. The owner is quitting (before-quit): a launch inside that window opens its own window and owns the file', async () => {
  const { owner } = real();
  const root = path.join(tmpDir('cc-window-claim-'), 'dev');
  fs.mkdirSync(root, { recursive: true });
  const acts = [];
  const wPid = uniquePid();
  const w = await realClaim(root, wPid, acts);
  await w.run();
  w.markReady();
  w.stop();                                            // before-quit: the file is released, the pipe closed
  const lPid = uniquePid();
  const l = await realClaim(root, lPid, acts);
  assert.strictEqual(await l.run(), 'proceed', 'a launch during the quit gets a window');
  assert.strictEqual(owner.parseOwner(fs.readFileSync(path.join(root, '.claude-custom', 'window.json'), 'utf8')).pid, lPid);
  assert.deepStrictEqual(acts, [], 'the quitting window was never asked to act');
  await l.stop();
});

// ---- single-instance PR 3 step 3: the message carries the root; message(), tag and ackMs are optional deps --------------------------

test('PR 3: the message carries the root (the router picks the window by it), with the lane and port as before', async () => {
  const { createWindowClaim } = load();
  const { deps, calls } = fakes({ claim: async () => live, root: 'C:\p', launchCwd: 'C:\p\feat-x', explicitPort: 7702 });
  assert.strictEqual(await createWindowClaim(deps).run(), 'exit');
  assert.deepStrictEqual(calls.filter(c => c[0] === 'send'), [['send', 10, { root: 'C:\p', cwd: 'C:\p\feat-x', port: 7702 }]]);
});

test('PR 3: the entry handed to listen names this window: its root and hasPort', async () => {
  const { createWindowClaim } = load();
  let opts = null;
  const hasPort = (p) => p === 7001;
  const { deps } = fakes({ root: 'C:\p', hasPort, listen: async (o) => { opts = o; return { close: async () => {} }; } });
  await createWindowClaim(deps).run();
  assert.strictEqual(opts.root, 'C:\p');
  assert.strictEqual(opts.hasPort, hasPort);
  assert.strictEqual(typeof opts.accepting, 'function');
  assert.strictEqual(typeof opts.whenReady, 'function');
  assert.strictEqual(typeof opts.onFocus, 'function');
});

test('PR 3: message() replaces the message; ackMs is handed to send; the defaults are today\'s', async () => {
  const { createWindowClaim } = load();
  const sent = [];
  const send = async (o) => { sent.push(o); return { ok: true }; };
  const a = fakes({ claim: async () => live, send, message: () => ({ cwd: 'C:\q', install: 'I', probe: false }), ackMs: 10_000 });
  await createWindowClaim(a.deps).run();
  assert.deepStrictEqual(sent[0].msg, { cwd: 'C:\q', install: 'I', probe: false });
  assert.strictEqual(sent[0].ackMs, 10_000);
  sent.length = 0;
  const b = fakes({ claim: async () => live, send });
  await createWindowClaim(b.deps).run();
  assert.strictEqual(sent[0].ackMs, undefined);
});

test('PR 3: tag names the claim in its log lines (default "one window")', async () => {
  const { createWindowClaim } = load();
  const lines = [];
  const refuse = async () => ({ ok: false, error: 'no ack' });
  const a = fakes({ claim: async () => live, send: refuse, tag: 'single instance', log: (l) => lines.push(l) });
  await createWindowClaim(a.deps).run();
  assert.ok(lines.some((l) => /single instance: owner pid 10 did not accept \(no ack\)/.test(l)), lines.join('\n'));
  lines.length = 0;
  const b = fakes({ claim: async () => live, send: refuse, log: (l) => lines.push(l) });
  await createWindowClaim(b.deps).run();
  assert.ok(lines.some((l) => /one window: owner pid 10 did not accept/.test(l)), lines.join('\n'));
});

test('PR 3, real files + a real router: two windows of one process each publish their own window.json with the same pid, and a launch of B reaches B', async () => {
  const { createWindowClaim } = load();
  const { owner, focus } = real();
  const { createWindowRouter } = require('../host/window-router');
  const { projectOf, samePath, isInside } = require('../host/project-layout');
  const pid = uniquePid();
  const router = createWindowRouter({ listen: focus.listen, pid, projectOf, samePath, isInside });
  const rootA = tmpDir('cc-claim-a-');
  const rootB = tmpDir('cc-claim-b-');
  const acted = { a: [], b: [] };
  const mk = (root, who, selfPid) => createWindowClaim({
    enabled: true, stateRoot: root, pid: selfPid, ownStart: async () => `S${selfPid}`, startTimes: async (pids) => new Map(pids.map((p) => [p, `S${p}`])),
    project: null, launchCwd: root, explicitPort: null, root,
    listen: (entry) => router.register(entry), claim: owner.claim, send: focus.send, takeOver: owner.takeOver, release: owner.release,
    forwardedCwd: owner.forwardedCwd, act: async (m) => { acted[who].push(m); }, onExit: () => {}, readyBoundMs: 5000, ackMs: 2000,
  });
  const a = mk(rootA, 'a', pid);
  const b = mk(rootB, 'b', pid);
  try {
    assert.strictEqual(await a.run(), 'proceed');
    assert.strictEqual(await b.run(), 'proceed');
    a.markReady(); b.markReady();
    const fileOf = (r) => JSON.parse(fs.readFileSync(path.join(r, '.claude-custom', 'window.json'), 'utf8'));
    assert.strictEqual(fileOf(rootA).pid, pid);
    assert.strictEqual(fileOf(rootB).pid, pid);
    // a second launch of B, from "another process" (its own pid, no router of its own: it never gets to listen)
    const launch = createWindowClaim({
      enabled: true, stateRoot: rootB, pid: pid + 1, ownStart: async () => `S${pid + 1}`, startTimes: async (pids) => new Map(pids.map((p) => [p, `S${p}`])),
      project: null, launchCwd: rootB, explicitPort: null, root: rootB,
      listen: async () => ({ close: async () => {} }), claim: owner.claim, send: focus.send, takeOver: owner.takeOver, release: owner.release,
      forwardedCwd: owner.forwardedCwd, act: async () => {}, onExit: () => {}, readyBoundMs: 5000, ackMs: 2000,
    });
    assert.strictEqual(await launch.run(), 'exit');
    await until(() => acted.b.length === 1);
    assert.strictEqual(acted.a.length, 0, 'A heard nothing of B\'s launch');
    assert.ok(samePath(acted.b[0].root, rootB));
  } finally { a.stop(); b.stop(); await router.stop(); }
});

// ---- PR #258 round 1, Dexter 1 / Miguel S2: a live but slow owner is not taken over on the ack timeout alone ---------------------------

test('D1: "no ack" from an owner still proven live: one more send with no ack bound and the full wait; it says ok -> exit, no takeover', async () => {
  const { createWindowClaim } = load();
  const sent = [];
  const lines = [];
  const { deps, calls } = fakes({
    claim: async () => live, ackMs: 10_000, log: (l) => lines.push(l),
    prove: async () => 'live',
    send: async (o) => { sent.push(o); return sent.length === 1 ? { ok: false, error: 'no ack' } : { ok: true }; },
  });
  assert.strictEqual(await createWindowClaim(deps).run(), 'exit');
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[0].ackMs, 10_000);
  assert.strictEqual(sent[1].ackMs, undefined, 'the second send waits for the answer, not for an ack');
  assert.strictEqual(sent[1].timeoutMs, 5000 + 10_000, 'readyBound + slack');
  assert.ok(!calls.some((c) => c[0] === 'takeOver'));
  assert.ok(lines.some((l) => /did not acknowledge within 10000 ms but is still alive/.test(l)), lines.join('\n'));
});

test('D1: an owner that cannot be proven either way is waited for too (never taken over on the timeout alone)', async () => {
  const { createWindowClaim } = load();
  const sent = [];
  const { deps, calls } = fakes({ claim: async () => live, ackMs: 10_000, prove: async () => 'unknown',
    send: async (o) => { sent.push(o); return sent.length === 1 ? { ok: false, error: 'no ack' } : { ok: true }; } });
  assert.strictEqual(await createWindowClaim(deps).run(), 'exit');
  assert.ok(!calls.some((c) => c[0] === 'takeOver'));
});

test('D1: the true-hang path stays: no answer to the second send either -> proceed and take the file over', async () => {
  const { createWindowClaim } = load();
  const sent = [];
  const { deps, calls } = fakes({ claim: async () => live, ackMs: 10_000, prove: async () => 'live',
    send: async (o) => { sent.push(o); return sent.length === 1 ? { ok: false, error: 'no ack' } : { ok: false, error: 'timed out after 15000ms' }; } });
  assert.strictEqual(await createWindowClaim(deps).run(), 'proceed');
  assert.ok(calls.some((c) => c[0] === 'takeOver'));
  assert.strictEqual(sent.length, 2);
});

test('D1: "no ack" from an owner proven DEAD since: taken over at once, no second send', async () => {
  const { createWindowClaim } = load();
  const sent = [];
  const { deps, calls } = fakes({ claim: async () => live, ackMs: 10_000, prove: async () => 'dead',
    send: async (o) => { sent.push(o); return { ok: false, error: 'no ack' }; } });
  assert.strictEqual(await createWindowClaim(deps).run(), 'proceed');
  assert.strictEqual(sent.length, 1);
  assert.ok(calls.some((c) => c[0] === 'takeOver'));
});

test('D1: the default prove is the owner-file proof over startTimes', async () => {
  const { createWindowClaim } = load();
  const sent = [];
  const { deps } = fakes({ claim: async () => live, ackMs: 10_000, startTimes: async () => new Map([[10, 'S10']]),
    send: async (o) => { sent.push(o); return sent.length === 1 ? { ok: false, error: 'no ack' } : { ok: true }; } });
  assert.strictEqual(await createWindowClaim(deps).run(), 'exit', 'S10 is the start the owner file names: live, so it is waited for');
});

test('PR #258 Dexter 13: refuse() true (the quit question is up) -> not accepting, even when ready', async () => {
  const { createWindowClaim } = load();
  let refuse = false;
  const { deps } = fakes({ refuse: () => refuse });
  const c = createWindowClaim(deps);
  await c.run();
  c.markReady();
  assert.strictEqual(c.accepting(), true);
  refuse = true;
  assert.strictEqual(c.accepting(), false);
});
