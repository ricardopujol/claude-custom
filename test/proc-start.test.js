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

test('selfStartTime is null when the query fails, and asks again next time', async () => {
  let fail = true;
  const exec = async () => { if (fail) throw new Error('x'); return `${process.pid} 5\nEND\n`; };
  const self = createSelfStartTime(opts({ exec }));
  assert.strictEqual(await self(), null);
  fail = false;
  assert.strictEqual(await self(), '5');
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

test('REAL powershell: a killed process is no longer listed (the plain case; a corpse kept by a held handle is left to the probe)', { skip: process.platform !== 'win32' }, async () => {
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
    await new Promise(r => setTimeout(r, 1500));
    const dead = await asked([pid]);
    assert.ok(dead, 'the query ran (5 tries)');
    assert.strictEqual(dead.has(pid), false, 'dead: not listed');
  } finally {
    try { holder.stdin.write('\n'); } catch { /* gone */ }
    try { holder.kill(); } catch { /* gone */ }
  }
});
