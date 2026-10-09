'use strict';
/**
 * PR #130 review, Dexter #2: the reaper proved a pid's start time, then killed it in a separate round trip, so the pid
 * could change owner in between; and killPidTree answered taskkill's "not found" (status 128) by trying
 * process.kill(pid) on that same unproven pid.
 *
 * killProven(pid, start) (host/kill-tree.js) proves and kills in ONE PowerShell call: it opens the process, holds its
 * handle (a held handle keeps Windows from reusing the pid), checks StartTime on it, and only then runs taskkill /T.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const { killProven, killProvenBatch, parseProvenKill, killPidTree } = require('../host/kill-tree');
const { startTimes } = require('../host/proc-start');

test('parseProvenKill: each answer of the PowerShell step maps to one outcome; anything else is unknown', () => {
  const r = (stdout) => ({ status: 0, stdout });
  assert.strictEqual(parseProvenKill(r('KILLED 0\r\n')), 'killed');
  assert.strictEqual(parseProvenKill(r('KILLED 128\r\n')), 'gone');
  assert.strictEqual(parseProvenKill(r('KILLED 1\r\n')), 'failed');
  assert.strictEqual(parseProvenKill(r('GONE\r\n')), 'gone');
  assert.strictEqual(parseProvenKill(r('MISMATCH\r\n')), 'mismatch');
  assert.strictEqual(parseProvenKill(r('UNKNOWN\r\n')), 'unknown');
  assert.strictEqual(parseProvenKill(r('')), 'unknown');
  assert.strictEqual(parseProvenKill({ error: new Error('ENOENT') }), 'unknown');
  assert.strictEqual(parseProvenKill(null), 'unknown');
});

test('killProven: a bad pid or start runs nothing and is unknown (nothing to prove against)', () => {
  let ran = 0;
  const run = () => { ran++; return { stdout: 'KILLED 0' }; };
  assert.strictEqual(killProven(0, '1', { run }), 'unknown');
  assert.strictEqual(killProven(5, null, { run }), 'unknown');
  assert.strictEqual(killProven(5, '12a', { run }), 'unknown');
  assert.strictEqual(ran, 0);
});

test('killProven: the one script holds the handle and compares the start before taskkill, with this pid and start', () => {
  let script = '';
  const run = (exe, args) => { script = args[args.length - 1]; return { stdout: 'KILLED 0' }; };
  assert.strictEqual(killProven(4321, '134000000000000123', { run }), 'killed');
  const handle = script.indexOf('.Handle');
  const compare = script.indexOf("'134000000000000123'");
  const kill = script.indexOf('taskkill');
  assert.ok(handle > 0 && compare > handle && kill > compare, 'handle, then the start comparison, then the kill');
  assert.match(script, /\/PID 4321 \/T \/F/);
});

test('killPidTree: taskkill\'s "not found" (128) is final, no process.kill fallback on that pid; access denied (1) still falls back', () => {
  const fallbacks = [];
  killPidTree(4321, { run: () => ({ status: 128, stderr: 'not found' }), fallback: (p) => fallbacks.push(p), platform: 'win32' });
  assert.deepStrictEqual(fallbacks, []);
  killPidTree(4321, { run: () => ({ status: 1, stderr: 'Access is denied' }), fallback: (p) => fallbacks.push(p), platform: 'win32' });
  assert.deepStrictEqual(fallbacks, [4321]);
});

const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });

test('killProven (real process, real PowerShell): a wrong start time leaves it running; the right one kills it', {
  skip: process.platform !== 'win32' && 'PowerShell + taskkill: Windows only',
}, async () => {
  const c = sleeper();
  const exited = new Promise(r => c.once('exit', r));
  try {
    const start = (await startTimes([c.pid])).get(c.pid);
    assert.match(String(start), /^\d+$/);
    const wrong = (BigInt(start) + 10n).toString();
    assert.strictEqual(killProven(c.pid, wrong), 'mismatch');
    assert.strictEqual(c.exitCode, null, 'a mismatched start must not kill');
    assert.strictEqual(killProven(c.pid, start), 'killed');
    await exited;
  } finally { if (c.exitCode === null && c.signalCode === null) c.kill(); }
});

test('killProvenAsync (PR #132 Dexter F2): the same one script and the same answers, through an async run; a bad pid or start runs nothing', async () => {
  const { killProvenAsync } = require('../host/kill-tree');
  let script = '';
  let ran = 0;
  const runAsync = async (exe, args) => { ran++; script = args[args.length - 1]; return { stdout: 'KILLED 0' }; };
  assert.strictEqual(await killProvenAsync(4321, '134000000000000123', { runAsync }), 'killed');
  assert.ok(script.indexOf('.Handle') > 0 && script.indexOf("'134000000000000123'") > script.indexOf('.Handle') && script.indexOf('taskkill') > script.indexOf("'134000000000000123'"));
  assert.match(script, /\/PID 4321 \/T \/F/);
  assert.strictEqual(await killProvenAsync(0, '1', { runAsync }), 'unknown');
  assert.strictEqual(await killProvenAsync(5, 'x', { runAsync }), 'unknown');
  assert.strictEqual(ran, 1);
  for (const [stdout, want] of [['MISMATCH', 'mismatch'], ['GONE', 'gone'], ['KILLED 1', 'failed'], ['', 'unknown']]) {
    assert.strictEqual(await killProvenAsync(7, '5', { runAsync: async () => ({ stdout }) }), want);
  }
  assert.strictEqual(await killProvenAsync(7, '5', { runAsync: async () => { throw new Error('spawn failed'); } }), 'unknown');
  assert.strictEqual(await killProvenAsync(7, '5', { runAsync: async () => ({ error: new Error('x'), stdout: '' }) }), 'unknown');
});

test('killProvenAsync: it does not block the event loop while PowerShell runs', async () => {
  const { killProvenAsync } = require('../host/kill-tree');
  let ticked = false;
  const slow = () => new Promise(r => setTimeout(() => r({ stdout: 'GONE' }), 30));
  const p = killProvenAsync(7, '5', { runAsync: slow });
  setImmediate(() => { ticked = true; });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(ticked, true);
  assert.strictEqual(await p, 'gone');
});

// The status relay's sweep reads a start from the process TABLE (CIM, microsecond precision) and ends it later through
// killProven, whose handle read is 100 ns precise: a tolerance covers that rounding, and nothing wider.
test('killProven toleranceTicks: the compare is numeric within the tolerance; without it the compare stays exact', () => {
  let exact = ''; let tol = '';
  killProven(4321, '134000000000000123', { run: (e, a) => { exact = a[a.length - 1]; return { stdout: 'KILLED 0' }; } });
  killProven(4321, '134000000000000123', { toleranceTicks: 20000, run: (e, a) => { tol = a[a.length - 1]; return { stdout: 'KILLED 0' }; } });
  assert.match(exact, /\[string\]\$s -ne '134000000000000123'/);
  assert.match(tol, /Abs\(\[long\]\$s - 134000000000000123\) -gt 20000/);
  assert.strictEqual(killProven(4321, '1', { toleranceTicks: -1, run: () => assert.fail('a bad tolerance runs nothing') }), 'unknown');
  assert.strictEqual(killProven(4321, '1', { toleranceTicks: 1e21, run: () => assert.fail('an unsafe tolerance runs nothing') }), 'unknown');
  assert.strictEqual(killProven(4321, '1', { toleranceTicks: 'x', run: () => assert.fail('a bad tolerance runs nothing') }), 'unknown');
});

test('killProven toleranceTicks (real PowerShell): a start within the tolerance kills, one beyond it does not', {
  skip: process.platform !== 'win32' && 'PowerShell + taskkill: Windows only',
}, async () => {
  const c = sleeper();
  const exited = new Promise(r => c.once('exit', r));
  try {
    const start = (await startTimes([c.pid])).get(c.pid);
    const near = (d) => killProven(c.pid, (BigInt(start) + d).toString(), { toleranceTicks: 20000 });
    // both sides of the tolerance, and its exact edge (a mutant -gt -> -ge, or a dropped Abs, changes one of these)
    assert.strictEqual(near(30000n), 'mismatch');
    assert.strictEqual(near(-30000n), 'mismatch', 'the negative side');
    assert.strictEqual(near(20001n), 'mismatch', 'one tick beyond the edge');
    assert.strictEqual(near(-20001n), 'mismatch', 'one tick beyond the edge, negative side');
    assert.strictEqual(c.exitCode, null);
    assert.strictEqual(near(20000n), 'killed', 'exactly at the edge is within');
    await exited;
  } finally { if (c.exitCode === null && c.signalCode === null) c.kill(); }
});

// ---- killProvenBatch: PR #145 Miguel Y2 / Dexter F3 -- the relay's fallback proves and kills ALL pending pids in ONE PowerShell call ----

test('killProvenBatch: 200 pending pids are ONE spawn, every pid and start in its script, one timeout for the batch', () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ pid: 1000 + i, start: String(134000000000000000n + BigInt(i)) }));
  const runs = [];
  const out = killProvenBatch(items, { toleranceTicks: 20000, timeoutMs: 10000, run: (exe, args, o) => { runs.push([exe, args, o]); return { stdout: items.map(t => `${t.pid} KILLED 0`).join('\r\n') + '\r\n' }; } });
  assert.strictEqual(runs.length, 1, 'one PowerShell call for the whole batch');
  assert.strictEqual(runs[0][2].timeout, 10000);
  const script = runs[0][1][runs[0][1].length - 1];
  for (const t of [items[0], items[199]]) assert.ok(script.includes(String(t.pid)) && script.includes(t.start), `${t.pid} is in the script`);
  assert.match(script, /Abs\(\[long\]\$s - \$t\[1\]\) -gt 20000/);
  assert.strictEqual(out.size, 200);
  assert.strictEqual(out.get(1000), 'killed');
});

test('killProvenBatch: each pid gets its own answer; a pid with no answer, a failed run and bad items are unknown or skipped', () => {
  const items = [{ pid: 11, start: '1' }, { pid: 12, start: '2' }, { pid: 13, start: '3' }, { pid: 14, start: '4' }];
  const out = killProvenBatch(items, { run: () => ({ stdout: '11 KILLED 0\r\n12 MISMATCH\r\n13 GONE\r\nnoise\r\n' }) });
  assert.deepStrictEqual([...out], [[11, 'killed'], [12, 'mismatch'], [13, 'gone'], [14, 'unknown']]);
  assert.deepStrictEqual([...killProvenBatch(items, { run: () => ({ error: new Error('timeout'), stdout: '' }) })].map(e => e[1]), ['unknown', 'unknown', 'unknown', 'unknown']);
  let ran = 0;
  const none = killProvenBatch([{ pid: 0, start: '1' }, { pid: 5, start: 'x' }, null], { run: () => { ran++; return { stdout: '' }; } });
  assert.strictEqual(ran, 0, 'nothing valid, nothing run');
  assert.strictEqual(none.size, 0);
  assert.throws(() => killProvenBatch(items, { toleranceTicks: 1e21 }), /toleranceTicks/);
});

test('killProvenBatch (real PowerShell): the right start is killed, a wrong start and a gone pid are not, in one call', {
  skip: process.platform !== 'win32' && 'PowerShell + taskkill: Windows only',
}, async () => {
  const a = sleeper(); const b = sleeper();
  const exitedA = new Promise(r => a.once('exit', r));
  try {
    const starts = await startTimes([a.pid, b.pid]);
    const out = killProvenBatch([
      { pid: a.pid, start: starts.get(a.pid) },
      { pid: b.pid, start: (BigInt(starts.get(b.pid)) + 50000n).toString() },
      { pid: 2147483646, start: '1' },
    ], { toleranceTicks: 20000 });
    assert.strictEqual(out.get(a.pid), 'killed');
    assert.strictEqual(out.get(b.pid), 'mismatch');
    assert.strictEqual(out.get(2147483646), 'gone');
    await exitedA;
    assert.strictEqual(b.exitCode, null, 'a mismatched start must not kill');
  } finally { for (const c of [a, b]) if (c.exitCode === null && c.signalCode === null) c.kill(); }
});
