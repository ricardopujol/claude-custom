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
  assert.strictEqual(calls[0].file, 'powershell.exe');
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
