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
const { killProven, parseProvenKill, killPidTree } = require('../host/kill-tree');
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
  assert.strictEqual(killProven(4321, '1', { toleranceTicks: 'x', run: () => assert.fail('a bad tolerance runs nothing') }), 'unknown');
});

test('killProven toleranceTicks (real process): a start within the tolerance kills, one beyond it does not', {
  skip: process.platform !== 'win32' && 'PowerShell + taskkill: Windows only',
}, async () => {
  const c = sleeper();
  const exited = new Promise(r => c.once('exit', r));
  try {
    const start = (await startTimes([c.pid])).get(c.pid);
    assert.strictEqual(killProven(c.pid, (BigInt(start) + 30000n).toString(), { toleranceTicks: 20000 }), 'mismatch');
    assert.strictEqual(c.exitCode, null);
    assert.strictEqual(killProven(c.pid, (BigInt(start) + 10000n).toString(), { toleranceTicks: 20000 }), 'killed');
    await exited;
  } finally { if (c.exitCode === null && c.signalCode === null) c.kill(); }
});
