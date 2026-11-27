'use strict';
/**
 * host/window-claim.js resume() branches and the hold's clock (PR #248 Miguel Y2 / Y3, Dexter 1 / 2). Every effect is a fake.
 */
const test = require('node:test');
const assert = require('node:assert');

const load = () => require('../host/window-claim');

function fakes(over = {}) {
  const calls = [];
  const deps = {
    enabled: true, stateRoot: 'C:\\p\\dev', pid: 20, ownStart: async () => 'S20', startTimes: async () => new Map(),
    project: { kind: 'container', root: 'C:\\p', dev: 'C:\\p\\dev' }, launchCwd: 'C:\\p\\dev', explicitPort: null,
    listen: async (o) => { deps.opts = o; calls.push('listen'); return { close: async () => { calls.push('pipe-close'); } }; },
    claim: async () => { calls.push('claim'); return { action: 'proceed', reason: 'no-owner', published: true }; },
    send: async () => ({ ok: true }),
    takeOver: () => true,
    release: () => { calls.push('release'); return true; },
    forwardedCwd: () => undefined,
    act: async () => {},
    onExit: () => { calls.push('onExit'); },
    now: () => 1000, readyBoundMs: 5000, log: () => {},
    ...over,
  };
  return { deps, calls };
}
const tick = () => new Promise(r => setTimeout(r, 20));
const count = (calls, name) => calls.filter(c => c === name).length;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('resume(): on a window that was never stopped (a cancelled plain close) it does nothing at all', async () => {
  const { createWindowClaim } = load();
  const { deps, calls } = fakes();
  const c = createWindowClaim(deps);
  await c.run();
  calls.length = 0;
  await c.resume();
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(c.accepting(), true);
});

test('resume(): disabled (a probe window) does nothing', async () => {
  const { createWindowClaim } = load();
  const { deps, calls } = fakes({ enabled: false });
  const c = createWindowClaim(deps);
  await c.resume();
  assert.deepStrictEqual(calls, []);
});

test('resume(): another window took the file meanwhile -> this one closes its pipe and is not an owner', async () => {
  const { createWindowClaim } = load();
  let n = 0;
  const { deps, calls } = fakes({
    claim: async () => { calls.push('claim'); n++; return n === 1 ? { action: 'proceed', published: true } : { action: 'focus', owner: { pid: 9, start: 'S9' }, file: 'x', text: 't' }; },
  });
  const c = createWindowClaim(deps);
  await c.run();
  c.markReady();
  c.stop();
  await tick();
  calls.length = 0;
  await c.resume();
  assert.deepStrictEqual(calls, ['listen', 'claim', 'pipe-close']);
});

test('resume(): the pipe cannot listen, but the claim published -> the file is released again at once', async () => {
  const { createWindowClaim } = load();
  let first = true;
  const { deps, calls } = fakes({
    listen: async () => { if (first) { first = false; calls.push('listen'); return { close: async () => {} }; } throw new Error('EADDRINUSE'); },
  });
  const c = createWindowClaim(deps);
  await c.run();
  c.stop();
  await tick();
  calls.length = 0;
  await c.resume();
  assert.deepStrictEqual(calls, ['claim', 'release']);
});

test('resume(): a stop() while it is still listening closes that pipe and claims nothing', async () => {
  const { createWindowClaim } = load();
  const gate = deferred();
  let n = 0;
  const { deps, calls } = fakes({
    listen: async () => { n++; calls.push('listen'); if (n === 1) return { close: async () => {} }; await gate.promise; return { close: async () => { calls.push('pipe-close'); } }; },
  });
  const c = createWindowClaim(deps);
  await c.run();
  c.stop();
  await tick();
  calls.length = 0;
  const r = c.resume();
  await tick();
  c.stop();                                            // the quit goes through while the pipe comes up
  gate.resolve();
  await r;
  assert.deepStrictEqual(calls, ['listen', 'release', 'pipe-close'], 'the stop releases; the late pipe is closed; no claim');
});

test('resume(): a stop() while the claim runs releases the file that claim publishes (PR #248 Miguel Y2)', async () => {
  const { createWindowClaim } = load();
  const gate = deferred();
  let n = 0;
  const { deps, calls } = fakes({
    claim: async () => { n++; calls.push('claim'); if (n === 1) return { action: 'proceed', published: true }; await gate.promise; return { action: 'proceed', published: true }; },
  });
  const c = createWindowClaim(deps);
  await c.run();
  c.stop();
  await tick();
  calls.length = 0;
  const r = c.resume();
  await tick();                                        // inside claim
  c.stop();                                            // release finds nothing yet
  const beforeClaimEnds = count(calls, 'release');
  gate.resolve();                                      // the claim publishes a file naming a quitting window
  await r;
  assert.strictEqual(count(calls, 'release'), beforeClaimEnds + 1, 'the file the claim published is released');
});

// ---- the hold's clock and the same-tick exit ----------------------------------------------------------------------------

test('whenReady: a wall clock stepped back 30 s does not stretch the hold past readyBoundMs (monotonic clock, PR #248 Dexter 2)', async () => {
  const { createWindowClaim } = load();
  let t = 1000;
  const { deps } = fakes({ now: () => t, readyBoundMs: 200 });
  const c = createWindowClaim(deps);
  await c.run();
  t = 1000 - 30_000;                                   // w32time steps the clock back
  const started = Date.now();
  assert.strictEqual(await deps.opts.whenReady(), false);
  assert.ok(Date.now() - started < 1500, `held ${Date.now() - started} ms`);
});

test('whenReady: markReady() and stop() in one tick (an exit right after ready) leave a held launch answered false', async () => {
  const { createWindowClaim } = load();
  const { deps } = fakes();
  const c = createWindowClaim(deps);
  await c.run();
  const held = deps.opts.whenReady();
  c.markReady();
  c.stop();
  assert.strictEqual(await held, false);
});
