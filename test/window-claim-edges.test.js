'use strict';
/**
 * PR #247 round 2 edges (BACKLOG #216): host/window-claim.js + host/window-focus.js.
 *   M1  a cancelled quit must not leave the window latched `stopped`: resume() makes it an owner again.
 *   M2  a launch is never told ok by an owner that has not finished starting (it would be dropped if that owner then ends):
 *       it is held until the owner is ready (ok, then act), or told no when the owner stops / the start bound passes.
 *   M3  a takeover is made only with the bytes the refusal was judged on; a failed one goes back to the claim.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const load = () => require('../host/window-claim');
const uniquePid = () => 900_000_000 + Math.floor(Math.random() * 90_000_000);
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 10)); }
};
const mkRoot = () => { const root = path.join(tmpDir('cc-window-edges-'), 'dev'); fs.mkdirSync(root, { recursive: true }); return root; };
const ownerFile = (root) => path.join(root, '.claude-custom', 'window.json');
const settles = async (p, ms) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); await new Promise(r => setTimeout(r, ms)); return done; };

function fakes(over = {}) {
  const calls = [];
  const deps = {
    enabled: true, stateRoot: 'C:\\p\\dev', pid: 20, ownStart: async () => 'S20', startTimes: async () => new Map(),
    project: { kind: 'container', root: 'C:\\p', dev: 'C:\\p\\dev' }, launchCwd: 'C:\\p\\dev', explicitPort: null,
    listen: async (o) => { calls.push(['listen', o.pid]); return { close: async () => { calls.push(['pipe-close']); } }; },
    claim: async () => ({ action: 'proceed', reason: 'no-owner', published: true }),
    send: async (o) => { calls.push(['send', o.pid]); return { ok: true }; },
    takeOver: () => { calls.push(['takeOver']); return true; },
    release: (o) => { calls.push(['release', o.selfPid, o.selfStart]); return true; },
    forwardedCwd: () => undefined,
    act: async () => {},
    onExit: () => { calls.push(['onExit']); },
    now: () => 1000, readyBoundMs: 5000, log: () => {},
    ...over,
  };
  return { deps, calls };
}
const live = { action: 'focus', reason: 'live-owner', owner: { pid: 10, start: 'S10' }, file: 'x' };

function realClaim(root, pid, acts, extra = {}) {
  const owner = require('../host/window-owner');
  const focus = require('../host/window-focus');
  const { createWindowClaim } = load();
  return createWindowClaim({
    enabled: true, stateRoot: root, pid, ownStart: async () => `S${pid}`, startTimes: async (pids) => new Map(pids.map(p => [p, `S${p}`])),
    project: { kind: 'container', root: path.dirname(root), dev: root }, launchCwd: root, explicitPort: null,
    listen: focus.listen, claim: owner.claim, send: focus.send, takeOver: owner.takeOver, release: owner.release,
    forwardedCwd: owner.forwardedCwd, act: async (msg) => { acts.push([pid, msg]); }, onExit: () => {},
    now: Date.now, readyBoundMs: extra.readyBoundMs || 60_000, log: extra.log || (() => {}),
  });
}

// ---- M1 -----------------------------------------------------------------------------------------------------------

test('M1 fake: resume() after stop() makes the window an owner again (accepting, pipe re-listened, file re-claimed, released again on stop)', async () => {
  const { createWindowClaim } = load();
  const { deps, calls } = fakes();
  const c = createWindowClaim(deps);
  await c.run();
  c.markReady();
  c.stop();
  assert.strictEqual(c.accepting(), false);
  calls.length = 0;
  await c.resume();
  assert.strictEqual(c.accepting(), true);
  assert.ok(calls.some(x => x[0] === 'listen'), 'the pipe is listening again');
  c.stop();
  assert.deepStrictEqual(calls.filter(x => x[0] === 'release'), [['release', 20, 'S20']]);
});

test('M1 real: Quit then Cancel. before-quit stops the claim, the cancel resumes it, and the next launch is handed to the window', async () => {
  const root = mkRoot();
  const acts = [];
  const w = realClaim(root, uniquePid(), acts);
  await w.run();
  w.markReady();
  w.stop();
  await w.resume();
  const l = realClaim(root, uniquePid(), acts);
  assert.strictEqual(await l.run(), 'exit', 'the launch is handed to the window that stayed open');
  await until(() => acts.length === 1);
  w.stop();
});

test('M1 real: a launch DURING the quit (no resume) still gets its own window', async () => {
  const root = mkRoot();
  const acts = [];
  const w = realClaim(root, uniquePid(), acts);
  await w.run();
  w.markReady();
  w.stop();
  const l = realClaim(root, uniquePid(), acts);
  assert.strictEqual(await l.run(), 'proceed');
  l.stop();
});

// ---- M2 -----------------------------------------------------------------------------------------------------------

test('M2 real: a launch is held by an owner that has not finished starting; the owner ending gives it a window of its own', async () => {
  const root = mkRoot();
  const acts = [];
  const w = realClaim(root, uniquePid(), acts);
  await w.run();                                       // starting: no markReady yet
  const lPid = uniquePid();
  const l = realClaim(root, lPid, acts);
  const lp = l.run();
  assert.strictEqual(await settles(lp, 250), false, 'held, not answered ok before the window is ready');
  w.stop();                                            // attach-only refusal / startup throw / no-port exit: the owner ends before ready
  assert.strictEqual(await lp, 'proceed');
  assert.strictEqual(JSON.parse(fs.readFileSync(ownerFile(root), 'utf8')).pid, lPid);
  assert.deepStrictEqual(acts, []);
  l.stop();
});

test('M2 real: the held launch is handed over and acted on once the owner IS ready', async () => {
  const root = mkRoot();
  const acts = [];
  const wPid = uniquePid();
  const w = realClaim(root, wPid, acts);
  await w.run();
  const l = realClaim(root, uniquePid(), acts);
  const lp = l.run();
  await new Promise(r => setTimeout(r, 100));
  w.markReady();
  assert.strictEqual(await lp, 'exit');
  await until(() => acts.length === 1);
  assert.strictEqual(acts[0][0], wPid);
  w.stop();
});

test('M2 real: an owner whose start hangs past the bound lets the held launch go: it opens its own window', async () => {
  const root = mkRoot();
  const acts = [];
  const w = realClaim(root, uniquePid(), acts, { readyBoundMs: 300 });
  await w.run();
  const logs = [];
  const l = realClaim(root, uniquePid(), acts, { readyBoundMs: 300, log: (m) => logs.push(m) });
  const t = Date.now();
  assert.strictEqual(await l.run(), 'proceed');
  // The OWNER's bound ended the hold (answer 'closing' after ~300 ms), not the launch's own 10 s send timeout (PR #248 Dexter 3).
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
  assert.ok(logs.some(m => /did not accept \(closing\)/.test(m)), logs.join(' | '));
  l.stop();
  w.stop();
});

test('M2: the launch waits for an answer longer than the owner may take to start (send gets a timeout past readyBoundMs)', async () => {
  const { createWindowClaim } = load();
  let timeoutMs = null;
  const { deps } = fakes({ claim: async () => live, send: async (o) => { timeoutMs = o.timeoutMs; return { ok: true }; }, readyBoundMs: 5000 });
  await createWindowClaim(deps).run();
  assert.ok(timeoutMs > 5000, `timeoutMs ${timeoutMs}`);
});

// ---- M3 -----------------------------------------------------------------------------------------------------------

test('M3 fake: the takeover uses the bytes the refusal was judged on, and a failed one goes back to the claim and hands over to the new owner', async () => {
  const { createWindowClaim } = load();
  const seen = [];
  const claims = [{ ...live, text: 'W-BYTES' }, { action: 'focus', reason: 'live-owner', owner: { pid: 11, start: 'S11' }, file: 'x', text: 'L1-BYTES' }];
  const sends = [];
  const { deps, calls } = fakes({
    claim: async () => claims.shift(),
    send: async (o) => { sends.push(o.pid); return o.pid === 10 ? { ok: false, error: 'closing' } : { ok: true }; },
    takeOver: (o) => { seen.push(o.judgedText); return false; },
  });
  assert.strictEqual(await createWindowClaim(deps).run(), 'exit', 'L2 is handed to L1 and ends');
  assert.deepStrictEqual(seen, ['W-BYTES']);
  assert.deepStrictEqual(sends, [10, 11]);
  assert.ok(!calls.some(c => c[0] === 'onExit'));
});

test('M3 fake: a takeover that keeps failing ends in a window, never a lost launch or a loop', async () => {
  const { createWindowClaim } = load();
  let sends = 0, claims = 0, takeOvers = 0;
  const { deps } = fakes({
    claim: async () => { claims++; return { ...live, text: 'W' }; },
    send: async () => { sends++; return { ok: false, error: 'closing' }; },
    takeOver: () => { takeOvers++; return false; },
  });
  assert.strictEqual(await createWindowClaim(deps).run(), 'proceed');
  // exactly three tries (each real send may wait readyBound + 10 s): PR #248 Dexter 4
  assert.deepStrictEqual([claims, sends, takeOvers], [3, 3, 3]);
});

test('M3 real: the double click. L1 took over after W released; L2\'s takeover with the bytes it judged (W\'s) fails and leaves L1\'s file alone (the hand-over itself is the M3 fake test)', async () => {
  const owner = require('../host/window-owner');
  const root = mkRoot();
  const acts = [];
  const w = realClaim(root, uniquePid(), acts);
  await w.run();
  w.markReady();
  const wText = fs.readFileSync(ownerFile(root), 'utf8');
  const l1Pid = uniquePid();
  const l1 = realClaim(root, l1Pid, acts);
  w.stop();                                            // W quits: its file is released
  assert.strictEqual(await l1.run(), 'proceed');       // L1 publishes its own file
  // L2 judged W's bytes before the release, and its takeover comes now:
  assert.strictEqual(owner.takeOver({ stateRoot: root, self: { pid: uniquePid(), start: 'SX' }, judgedText: wText }), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(ownerFile(root), 'utf8')).pid, l1Pid, 'L1\'s file is untouched');
  l1.stop();
});
