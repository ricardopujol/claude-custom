'use strict';
/**
 * OS process start times (Extension X1). The session lock and the terminal
 * warning both ask "is pid P still the process that started at T?", and
 * verify/probe-session-registry.js measured that Get-Process reports the CLI's
 * `procStart` FILETIME exactly. Every OS call is injected, so these run
 * anywhere.
 *
 * The three answers must never collapse into each other: "not running"
 * (absent from the map), "running, start unknown" (null) and "couldn't ask"
 * (the whole result is null).
 */
const test = require('node:test');
const assert = require('node:assert');

const { isAlive, startTimes, createSelfStartTime } = require('../host/proc-start');

// An exec double: records every call, answers with `stdout`, or rejects.
function fakeExec({ stdout = '', reject = null } = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    if (reject) throw reject;
    return stdout;
  };
  return { exec, calls };
}

const opts = extra => ({ platform: 'win32', ...extra });

test('startTimes parses "<pid> <filetime>" lines into a map', async () => {
  const { exec } = fakeExec({ stdout: '14072 134351841483950052\r\n18388 134351166891550275\r\nEND\r\n' });
  const m = await startTimes([14072, 18388], opts({ exec }));
  assert.deepStrictEqual([...m], [[14072, '134351841483950052'], [18388, '134351166891550275']]);
});

test('a pid that is not running is absent, not null', async () => {
  const { exec } = fakeExec({ stdout: '14072 134351841483950052\nEND\n' });
  const m = await startTimes([14072, 99999], opts({ exec }));
  assert.strictEqual(m.has(99999), false);
});

test('a running pid whose start time could not be read maps to null', async () => {
  const { exec } = fakeExec({ stdout: '4 ?\nEND\n' });
  const m = await startTimes([4], opts({ exec }));
  assert.strictEqual(m.has(4), true);
  assert.strictEqual(m.get(4), null);
});

test('junk lines, a BOM and pids nobody asked about are ignored', async () => {
  const bom = String.fromCharCode(0xfeff);
  const { exec } = fakeExec({ stdout: `${bom}WARNING: something\n12 34\n77 88\nnot a line\n12 x\nEND\n` });
  const m = await startTimes([12], opts({ exec }));
  assert.deepStrictEqual([...m], [[12, '34']]);
});

test('without the END sentinel the query did not run: null, never an empty map', async () => {
  const { exec } = fakeExec({ stdout: '' });
  assert.strictEqual(await startTimes([12], opts({ exec })), null);
  const partial = fakeExec({ stdout: '12 34\n' });
  assert.strictEqual(await startTimes([12], opts({ exec: partial.exec })), null);
});

test('a failed or timed-out exec is null', async () => {
  const { exec } = fakeExec({ reject: Object.assign(new Error('timeout'), { killed: true }) });
  assert.strictEqual(await startTimes([12], opts({ exec })), null);
});

test('only positive integer pids ever reach the command line', async () => {
  const { exec, calls } = fakeExec({ stdout: 'END\n' });
  await startTimes([12, 0, -1, 1.5, '7', null, NaN, 34], opts({ exec }));
  assert.strictEqual(calls.length, 1);
  const script = calls[0].args[calls[0].args.length - 1];
  assert.match(script, /Get-Process -Id 12,34 /);
  assert.doesNotMatch(script, /-1|1\.5|,7|,0/);
});

test('no valid pid means no process is spawned and the map is empty', async () => {
  const { exec, calls } = fakeExec({ stdout: 'END\n' });
  const m = await startTimes([0, -5, 'x'], opts({ exec }));
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(m.size, 0);
});

test('it asks powershell.exe without a profile, non-interactively', async () => {
  const { exec, calls } = fakeExec({ stdout: 'END\n' });
  await startTimes([12], opts({ exec }));
  // By absolute path (Miguel, PR #71 G1): a bare name is looked up in the
  // parent's cwd first, so a powershell.exe dropped in a project folder would run.
  assert.ok(require('path').isAbsolute(calls[0].file), calls[0].file);
  assert.match(calls[0].file, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.ok(calls[0].args.includes('-NoProfile'));
  assert.ok(calls[0].args.includes('-NonInteractive'));
});

test('off Windows there is no query: null', async () => {
  const { exec, calls } = fakeExec({ stdout: 'END\n' });
  assert.strictEqual(await startTimes([12], { platform: 'linux', exec }), null);
  assert.strictEqual(calls.length, 0);
});

test('isAlive: ESRCH is dead, EPERM is alive, success is alive', () => {
  const throwing = code => () => { throw Object.assign(new Error(code), { code }); };
  assert.strictEqual(isAlive(12, throwing('ESRCH')), false);
  assert.strictEqual(isAlive(12, throwing('EPERM')), true);
  assert.strictEqual(isAlive(12, () => true), true);
});

test('isAlive never probes a pid that is not a positive integer, and does not call it dead', () => {
  let probed = 0;
  const kill = () => { probed++; };
  for (const bad of [0, -1, 1.5, '12', null, undefined, NaN]) {
    assert.strictEqual(isAlive(bad, kill), null, `pid ${String(bad)}`);
  }
  assert.strictEqual(probed, 0);
});

test('isAlive treats any other kill error as unknown, not dead', () => {
  const kill = () => { throw Object.assign(new Error('weird'), { code: 'EINVAL' }); };
  assert.strictEqual(isAlive(12, kill), null);
});

test('selfStartTime asks once for this process and caches the answer', async () => {
  const { exec, calls } = fakeExec({ stdout: `${process.pid} 134352029638373721\nEND\n` });
  const self = createSelfStartTime(opts({ exec }));
  assert.strictEqual(await self(), '134352029638373721');
  assert.strictEqual(await self(), '134352029638373721');
  assert.strictEqual(calls.length, 1);
});

test('selfStartTime is null when the query fails, and asks again once the failure hold has passed', async () => {
  let fail = true;
  let t = 1000;
  let asked = 0;
  const exec = async () => { asked++; if (fail) throw new Error('x'); return `${process.pid} 5\nEND\n`; };
  const self = createSelfStartTime(opts({ exec, now: () => t, failHoldMs: 60_000 }));
  assert.strictEqual(await self(), null);
  fail = false;
  t += 59_999;
  assert.strictEqual(await self(), null, 'inside the hold: the failure is the answer, nothing is asked');
  assert.strictEqual(asked, 1);
  t += 1;
  assert.strictEqual(await self(), '5');
  assert.strictEqual(asked, 2);
});

// PR #261 Dexter 1 / Miguel I1 + I2: with the retry, one failed ask costs 5 + 15 s, and four callers on a launch's path asked one after the
// other (the app claim, the Resources service, the restore decision, the window claim): about 80 s before the first window.
test('selfStartTime is single-flight: N concurrent callers share ONE query (and its one retry)', async () => {
  let first = 0;
  let retry = 0;
  const slow = (ms, fn) => new Promise((resolve, reject) => setTimeout(() => { try { resolve(fn()); } catch (e) { reject(e); } }, ms));
  const self = createSelfStartTime(opts({
    exec: () => slow(30, () => { first++; throw new Error('timeout'); }),
    retryExec: () => slow(30, () => { retry++; return `${process.pid} 9\nEND\n`; }),
  }));
  const answers = await Promise.all(Array.from({ length: 6 }, () => self()));
  assert.deepStrictEqual(answers, Array(6).fill('9'));
  assert.strictEqual(first, 1);
  assert.strictEqual(retry, 1);
});

test('selfStartTime: a launch pays the own-start budget ONCE: sequential callers after a failure do not ask again (bounded wait)', async () => {
  const BUDGET = 40;          // stands for QUERY_TIMEOUT_MS + RETRY_QUERY_TIMEOUT_MS (20 s): each fake exec "times out" after BUDGET / 2
  let asked = 0;
  const timesOut = () => new Promise((_, reject) => setTimeout(() => { asked++; reject(new Error('timeout')); }, BUDGET / 2));
  const self = createSelfStartTime(opts({ exec: timesOut, retryExec: timesOut }));
  const t0 = Date.now();
  // the launch's callers, in the order main runs them: the app claim and the poller together, then three more one after the other
  await Promise.all([self(), self()]);
  for (let i = 0; i < 3; i++) assert.strictEqual(await self(), null);
  const waited = Date.now() - t0;
  assert.strictEqual(asked, 2, 'one query and its one retry for the whole launch');
  assert.ok(waited < BUDGET * 2, `the callers waited one budget, not one each (${waited} ms for a ${BUDGET} ms budget)`);
  // the real numbers: one own-start pair is at most 20 s per launch, inside the ~190 s a launch may wait (Q10)
  const ps = require('../host/proc-start');
  assert.ok(ps.QUERY_TIMEOUT_MS + ps.RETRY_QUERY_TIMEOUT_MS <= 20_000);
  assert.ok(ps.FAILED_START_HOLD_MS >= 30_000, 'the hold covers the launch path (its callers run within seconds of each other)');
});

test('patientStartTimes retries a failed query (the wrapper, not only the constants); retryExec undefined keeps the default retry (Miguel S2)', async () => {
  const { patientStartTimes } = require('../host/proc-start');
  const failing = fakeExec({ reject: new Error('timeout') });
  const retry = fakeExec({ stdout: '12 34\nEND\n' });
  const m = await patientStartTimes([12], opts({ exec: failing.exec, retryExec: retry.exec }));
  assert.deepStrictEqual([...m], [[12, '34']]);
  // an explicit undefined must not switch the retry off: the options resolve to the default retry exec (no real powershell.exe here)
  const ps = require('../host/proc-start');
  assert.strictEqual(ps.patientOptions({ retryExec: undefined }).retryExec, ps.retryExec);
  assert.strictEqual(ps.patientOptions({ retryExec: retry.exec }).retryExec, retry.exec);
});

// --- fix/owner-proof: ONE retry with a longer budget ---------------------------------------------------------------
// MEASURED 2026-11-27 (Raider): one query takes 1.3-1.7 s on a calm machine and 2.3-4.5 s under CPU load at an Electron start;
// on a busy machine it passed the 5 s budget, and a launch went on as a second process ('unproven-owner' / 'no-self-start').

test('retryExec: a query that failed (timed out) is asked ONCE more with the retry exec, and its answer is the result', async () => {
  const first = fakeExec({ reject: Object.assign(new Error('timeout'), { killed: true }) });
  const retry = fakeExec({ stdout: '12 34\nEND\n' });
  const m = await startTimes([12], opts({ exec: first.exec, retryExec: retry.exec }));
  assert.deepStrictEqual([...m], [[12, '34']]);
  assert.strictEqual(first.calls.length, 1);
  assert.strictEqual(retry.calls.length, 1);
});

test('retryExec: a query that answered is never asked again (an absent pid is an answer, not a failure)', async () => {
  const first = fakeExec({ stdout: 'END\n' });
  const retry = fakeExec({ stdout: '12 34\nEND\n' });
  const m = await startTimes([12], opts({ exec: first.exec, retryExec: retry.exec }));
  assert.strictEqual(m.size, 0);
  assert.strictEqual(retry.calls.length, 0);
});

test('retryExec: both failing is null (still "could not ask", never "not running"), after exactly two queries', async () => {
  const first = fakeExec({ reject: new Error('x') });
  const retry = fakeExec({ stdout: '12 34\n' });          // no END: did not run to the end
  assert.strictEqual(await startTimes([12], opts({ exec: first.exec, retryExec: retry.exec })), null);
  assert.strictEqual(first.calls.length + retry.calls.length, 2);
});

test('retryExec: no retry off Windows or with no valid pid (nothing is spawned)', async () => {
  const retry = fakeExec({ stdout: 'END\n' });
  assert.strictEqual(await startTimes([12], { platform: 'linux', exec: retry.exec, retryExec: retry.exec }), null);
  assert.strictEqual((await startTimes([0], opts({ exec: retry.exec, retryExec: retry.exec }))).size, 0);
  assert.strictEqual(retry.calls.length, 0);
});

test('selfStartTime with retryExec: a first query that timed out is retried, so this process still learns its start', async () => {
  const first = fakeExec({ reject: Object.assign(new Error('timeout'), { killed: true }) });
  const retry = fakeExec({ stdout: `${process.pid} 777\nEND\n` });
  const self = createSelfStartTime(opts({ exec: first.exec, retryExec: retry.exec }));
  assert.strictEqual(await self(), '777');
  assert.strictEqual(await self(), '777');
  assert.strictEqual(first.calls.length + retry.calls.length, 2, 'cached once it succeeded');
});

test('patientStartTimes and the retry budget: the retry waits longer than the first query, and stays bounded', () => {
  const ps = require('../host/proc-start');
  assert.strictEqual(typeof ps.patientStartTimes, 'function');
  assert.ok(ps.RETRY_QUERY_TIMEOUT_MS > ps.QUERY_TIMEOUT_MS);
  // Q10: a launch's whole wait is ~190 s; the proof must stay far below it
  assert.ok(ps.QUERY_TIMEOUT_MS + ps.RETRY_QUERY_TIMEOUT_MS <= 30_000);
});

// --- a process that has EXITED but is still in the table (found by verify/probe-worktree-occupancy.js) -------------
//
// Windows keeps an exited process in the process table for as long as ANYONE holds a handle to it, and
// Get-Process -Id still returns it, with its StartTime, HasExited = True. MEASURED 2026-10-03 (probe-worktree-
// occupancy, Electron 33, Windows 11): after a host was killed, its pid and start time were still listed 45 s
// later, so every consumer of "is pid P still the process that started at T?" read a dead host as alive. The
// query now skips exited processes: such a pid is ABSENT ("not running"), which is what it is.
test('the query skips a process that has exited but is still listed (HasExited)', async () => {
  const { exec, calls } = fakeExec({ stdout: 'END\n' });
  await startTimes([12, 34], opts({ exec }));
  const script = calls[0].args[calls[0].args.length - 1];
  const at = (needle) => script.indexOf(needle);
  assert.ok(at('Where-Object { -not $_.HasExited }') > at('Get-Process -Id 12,34 '), 'filtered after Get-Process');
  assert.ok(at('Where-Object { -not $_.HasExited }') < at('ForEach-Object'), 'and before the start time is read');
});

// The real query has a timeout of its own, and under the full suite's load powershell.exe can miss it: null,
// "the OS couldn't be asked". That is not an answer about the process, so the REAL tests ask again (measured:
// one null in a full run, 2026-10-03) and only judge a Map.
async function asked(pids) {
  for (let i = 0; i < 5; i++) {
    const m = await startTimes(pids);
    if (m instanceof Map) return m;
  }
  return null;
}

test('REAL powershell: this process is listed with a FILETIME, a pid nobody has is absent, and the filter keeps both answers apart', { skip: process.platform !== 'win32' }, async () => {
  const bogus = 2147483000;
  const m = await asked([process.pid, bogus]);
  assert.ok(m instanceof Map, 'the query ran');
  assert.match(m.get(process.pid), /^\d+$/);
  assert.strictEqual(m.has(bogus), false);
});

test('REAL powershell: a killed process whose handle is still HELD (a corpse Windows keeps listed) is no longer listed', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = require('child_process');
  // The holder starts a child and keeps a .NET Process object (a handle) to it until told to stop.
  const holder = spawn('powershell', ['-NoProfile', '-Command',
    "$c = Start-Process -FilePath node -ArgumentList '-e','setTimeout(()=>{},60000)' -PassThru -WindowStyle Hidden; " +
    '$c.Id; [Console]::Out.Flush(); $null = $c.Handle; [Console]::In.ReadLine() | Out-Null'],
  { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let out = '';
  holder.stdout.on('data', (d) => { out += d; });
  try {
    const deadline = Date.now() + 15000;
    while (!/^\d+/.test(out.trim()) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    const pid = Number(out.trim().split(/\s+/)[0]);
    assert.ok(Number.isInteger(pid) && pid > 0, `the child started (${out})`);
    const alive = await asked([pid]);
    assert.ok(alive, 'the query ran (5 tries)');
    assert.strictEqual(alive.has(pid), true, 'alive: listed');
    process.kill(pid, 'SIGKILL');
    // Asked until it says so, not after a fixed sleep: under the suite's load the teardown has no fixed time
    // (PR #96 Miguel Y5). The holder keeps its handle the whole while, so without the HasExited filter the
    // corpse stays listed until the deadline.
    const until = Date.now() + 15000;
    let dead = null;
    do {
      dead = await asked([pid]);
      if (dead && !dead.has(pid)) break;
      await new Promise(r => setTimeout(r, 250));
    } while (Date.now() < until);
    assert.ok(dead, 'the query ran');
    assert.strictEqual(dead.has(pid), false, 'dead: not listed');
  } finally {
    try { holder.stdin.write('\n'); } catch { /* gone */ }
    try { holder.kill(); } catch { /* gone */ }
  }
});
