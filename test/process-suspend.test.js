'use strict';
/**
 * host/process-suspend.js (BACKLOG #19): the Resources panel's Pause / Resume. One PowerShell call per action, every process
 * re-proved (pid AND start time, on the handle it then suspends through) at the moment it is touched, and the answer REAL:
 * a process that was not suspended is not reported as one. `pid` and `start` are written raw into PowerShell source, so the
 * same strict guard as the kill (host/resource-kill.js validTarget) stands in front of it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const S = require('../host/process-suspend');
const K = require('../host/resource-kill');

const recording = (out = '5 done\nEND\n') => {
  const calls = [];
  return { calls, exec: async (script) => { calls.push(script); return out; } };
};

test('the guard IS the kill\'s guard: the same targets are accepted and refused', () => {
  fc.assert(fc.property(fc.anything(), (t) => S.validTarget(t) === K.validTarget(t)), { numRuns: 300 });
  assert.strictEqual(S.validTarget({ pid: 5, start: '134355977388659781' }), true);
  assert.strictEqual(S.validTarget({ pid: 5, start: '1; calc' }), false);
});

test('a bad target executes nothing and every row is a failure', async () => {
  const { calls, exec } = recording();
  const r = await S.suspendVerified('suspend', [{ pid: 5, start: '1' }, { pid: 6, start: 'x' }], { exec });
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(r, [{ pid: 5, status: 'failed', text: 'not a valid target' }, { pid: 6, status: 'failed', text: 'not a valid target' }]);
});

test('an empty list, or an action that is not suspend or resume, executes nothing', async () => {
  const { calls, exec } = recording();
  assert.deepStrictEqual(await S.suspendVerified('suspend', [], { exec }), []);
  assert.deepStrictEqual(await S.suspendVerified('freeze', [{ pid: 5, start: '1' }], { exec }), [{ pid: 5, status: 'failed', text: 'not a valid action' }]);
  assert.deepStrictEqual(await S.suspendVerified(undefined, [{ pid: 5, start: '1' }], { exec }), [{ pid: 5, status: 'failed', text: 'not a valid action' }]);
  assert.strictEqual(calls.length, 0);
});

test('a valid suspend runs one script that names each pid with its start, suspends through NtSuspendProcess, and is answered', async () => {
  const { calls, exec } = recording('5 done\n6 done\nEND\n');
  const r = await S.suspendVerified('suspend', [{ pid: 5, start: '134000000000000001' }, { pid: 6, start: '134000000000000002' }], { exec });
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].includes('[NtPause]::NtSuspendProcess('));
  assert.ok(!calls[0].includes('[NtPause]::NtResumeProcess('));
  assert.match(calls[0], /\$rootId = 5\b/);
  assert.match(calls[0], /P 5 134000000000000001\b/);
  assert.match(calls[0], /P 6 134000000000000002\b/);
  assert.deepStrictEqual(r, [{ pid: 5, status: 'done' }, { pid: 6, status: 'done' }]);
});

test('a resume uses NtResumeProcess, and never scans for or refuses on protected processes (waking one is harmless)', async () => {
  const { calls, exec } = recording('5 done\nEND\n');
  await S.suspendVerified('resume', [{ pid: 5, start: '134000000000000001' }], { exec });
  assert.ok(calls[0].includes('[NtPause]::NtResumeProcess('));
  assert.ok(!calls[0].includes('[NtPause]::NtSuspendProcess('));
  assert.doesNotMatch(calls[0], /protected process/);
});

test('a suspend re-proves the start on the opened handle, then refuses a reused pid and a protected subtree', async () => {
  const { calls, exec } = recording();
  await S.suspendVerified('suspend', [{ pid: 5, start: '134000000000000001' }], { exec });
  const script = calls[0];
  assert.match(script, /\$p\.Handle/);
  assert.match(script, /StartTime\.ToFileTimeUtc/);
  assert.match(script, /reused/);
  assert.match(script, /a protected process/, 'a protected process started under the root since the list was read blocks the suspend');
  assert.ok(script.indexOf('protected process') < script.indexOf('P 5 134000000000000001'), 'the protected scan comes BEFORE anything is suspended');
});

test('the script reads every answer line it prints back: done, gone, reused, failed', async () => {
  const out = '5 done\n6 gone\n7 reused\n8 failed access denied\nEND\n';
  const r = await S.suspendVerified('suspend', [5, 6, 7, 8].map(pid => ({ pid, start: '1' })), { exec: async () => out });
  assert.deepStrictEqual(r, [
    { pid: 5, status: 'done' }, { pid: 6, status: 'gone' }, { pid: 7, status: 'reused' }, { pid: 8, status: 'failed', text: 'access denied' },
  ]);
});

test('no answer is UNKNOWN, not "not suspended": the target may have been suspended (PR #158 Dexter 2)', async () => {
  const targets = [{ pid: 5, start: '1' }, { pid: 6, start: '1' }];
  assert.deepStrictEqual(await S.suspendVerified('suspend', targets, { exec: async () => '' }),
    targets.map(t => ({ pid: t.pid, status: 'failed', unknown: true, text: 'no answer from the suspend' })));
  assert.deepStrictEqual(await S.suspendVerified('suspend', targets, { exec: async () => '5 done\nEND\n' }),
    [{ pid: 5, status: 'done' }, { pid: 6, status: 'failed', unknown: true, text: 'no answer from the suspend' }]);
});

test('an answer cut off by the timeout still names what it suspended: every "done" line before the cutoff is believed', async () => {
  const targets = [{ pid: 24, start: '1' }, { pid: 25, start: '2' }];
  const r = await S.suspendVerified('suspend', targets, { exec: async () => '24 done\n24 start 1\n' });
  assert.deepStrictEqual(r, [{ pid: 24, status: 'done', start: '1' }, { pid: 25, status: 'failed', unknown: true, text: 'no answer from the suspend' }]);
  const both = await S.suspendVerified('suspend', targets, { exec: async () => '24 done\n25 done\n' });
  assert.deepStrictEqual(both.map(x => x.status), ['done', 'done']);
  const extra = await S.suspendVerified('suspend', [targets[0]], { exec: async () => '24 done\n99 done\n99 start 7\n' });
  assert.deepStrictEqual(extra, [{ pid: 24, status: 'done' }, { pid: 99, status: 'done', extra: true, start: '7' }]);
});

test('a cutoff does NOT make a "gone", "reused" or "failed" believable: only a done is', async () => {
  const r = await S.suspendVerified('suspend', [{ pid: 5, start: '1' }], { exec: async () => '5 gone\n' });
  assert.deepStrictEqual(r, [{ pid: 5, status: 'failed', unknown: true, text: 'no answer from the suspend' }]);
});

test('a process the script found itself (started under the root since the list) is reported as extra, never dropped', async () => {
  const r = await S.suspendVerified('suspend', [{ pid: 5, start: '1' }], { exec: async () => '5 done\n9 done\n10 failed denied\nEND\n' });
  assert.deepStrictEqual(r, [{ pid: 5, status: 'done' }, { pid: 9, status: 'done', extra: true }, { pid: 10, status: 'failed', extra: true, text: 'denied' }]);
});

test('an exec that throws gives an UNKNOWN failure for every target, with the reason', async () => {
  const r = await S.suspendVerified('resume', [{ pid: 5, start: '1' }], { exec: async () => { throw new Error('powershell missing'); } });
  assert.deepStrictEqual(r, [{ pid: 5, status: 'failed', unknown: true, text: 'powershell missing' }]);
});

test('an exec that throws something without a message still says that it could not run', async () => {
  const r = await S.suspendVerified('resume', [{ pid: 5, start: '1' }], { exec: async () => { throw null; } });
  assert.deepStrictEqual(r, [{ pid: 5, status: 'failed', unknown: true, text: 'the suspend could not be run' }]);
});

test('answer text is read line by line: a status word inside another line does not count', async () => {
  const r = await S.suspendVerified('suspend', [{ pid: 5, start: '1' }], { exec: async () => 'warning: 5 done maybe\nEND\n' });
  assert.deepStrictEqual(r, [{ pid: 5, status: 'failed', unknown: true, text: 'no answer from the suspend' }]);
});

test('the proved start of each process that was suspended rides back, so an extra can be woken through the same proof', async () => {
  const out = '5 done\n9 done\n10 failed denied\n5 start 134000000000000001\n9 start 134000000000000009\nEND\n';
  const r = await S.suspendVerified('suspend', [{ pid: 5, start: '134000000000000001' }], { exec: async () => out });
  assert.deepStrictEqual(r, [
    { pid: 5, status: 'done', start: '134000000000000001' },
    { pid: 9, status: 'done', extra: true, start: '134000000000000009' },
    { pid: 10, status: 'failed', extra: true, text: 'denied' },
  ]);
});

test('a start line for a process that was not "done" is ignored: only a suspended process has a proven start', async () => {
  const r = await S.suspendVerified('suspend', [{ pid: 5, start: '1' }], { exec: async () => '5 gone\n5 start 77\nEND\n' });
  assert.deepStrictEqual(r, [{ pid: 5, status: 'gone' }]);
});

test('the script prints each start the moment it suspends, checks the suspend count, and a resume repeats until nothing is suspended', async () => {
  const { calls, exec } = recording();
  await S.suspendVerified('suspend', [{ pid: 5, start: '134000000000000001' }], { exec });
  assert.ok(calls[0].includes('[Console]::Out.WriteLine("$id start $want")'));
  assert.match(calls[0], /already suspended/);
  assert.ok(!calls[0].includes('$done.Keys'), 'no end-of-run start dump: it would be lost to a cutoff');
  const r = recording();
  await S.suspendVerified('resume', [{ pid: 5, start: '134000000000000001' }], { exec: r.exec });
  assert.ok(r.calls[0].includes('for ($i = 0; $i -lt 8; $i++)'));
  assert.match(r.calls[0], /still suspended after 8 resumes/);
});
