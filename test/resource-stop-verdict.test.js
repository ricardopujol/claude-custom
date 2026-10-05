'use strict';
// host/resource-stop.js stop(): "Stopped" only for what really stopped, judged on the TARGET's own entry, never the first
// one. Release #117 Mortimer survivor 2.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../host/resource-stop');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
const row = (pid, ppid, name, cmd, start) => ({ pid, ppid, name, cmd, start: String(start), priv: 1 });
const procs = [
  row(10, 1, 'electron.exe', `${EXE} ${INSTALL}`, 1010),
  row(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`, 1020),
  row(22, 20, 'claude.exe', 'claude.exe', 1030),
  row(30, 22, 'node.exe', 'node x', 5000),
  row(31, 30, 'node.exe', 'child', 5100),
  row(32, 30, 'node.exe', 'child2', 5200),
];
const run = (answer) => S.stop({ pid: 30, startTime: '5000' }, { readProcs: async () => procs, hostPids: () => [20], kill: async () => answer });

test('stop verdict: a target answered "reused" is NOT ok', async () => {
  const r = await run([{ pid: 30, status: 'reused' }]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'reused');
  assert.strictEqual(r.text, S.reasonText('reused'));
});

test('stop verdict: a target answered "gone" is NOT ok', async () => {
  const r = await run([{ pid: 30, status: 'gone' }]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'gone');
});

test('stop verdict: the verdict is the TARGET\'s entry, not the first one (a killed child first does not make it ok)', async () => {
  const r = await run([{ pid: 31, status: 'killed' }, { pid: 30, status: 'failed', text: 'x' }]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'kill-failed');
  assert.match(r.text, /: x$/);
});

test('stop verdict: a failed child first does not stop a killed target from being ok', async () => {
  const r = await run([{ pid: 31, status: 'failed', text: 'denied' }, { pid: 30, status: 'killed' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.pid, 30);
});

test('stop verdict: a reused or gone child first does not decide a reused/gone target either', async () => {
  assert.strictEqual((await run([{ pid: 31, status: 'killed' }, { pid: 30, status: 'reused' }])).reason, 'reused');
  assert.strictEqual((await run([{ pid: 31, status: 'killed' }, { pid: 30, status: 'gone' }])).reason, 'gone');
});

test('stop verdict: failedChildren is exactly the failed non-target entries', async () => {
  const r = await run([{ pid: 30, status: 'killed' }, { pid: 31, status: 'failed', text: 'denied' }, { pid: 32, status: 'killed' }]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.failedChildren, [{ pid: 31, text: 'denied' }]);
  const none = await run([{ pid: 30, status: 'killed' }, { pid: 31, status: 'killed' }, { pid: 32, status: 'reused' }]);
  assert.strictEqual('failedChildren' in none, false, 'only "failed" children are reported');
});

test('stop verdict: a failed child with no text is listed with just its pid', async () => {
  const r = await run([{ pid: 30, status: 'killed' }, { pid: 31, status: 'failed' }]);
  assert.deepStrictEqual(r.failedChildren, [{ pid: 31 }]);
});

test('stop verdict: junk entries and a non-array answer are never a success', async () => {
  assert.strictEqual((await run([null, undefined, { status: 'killed' }])).ok, false);
  assert.strictEqual((await run('30 killed')).ok, false);
  assert.strictEqual((await run(null)).reason, 'kill-failed');
});

test('stop verdict: a kill that throws is kill-failed with its message; a throw without one still says why', async () => {
  const withMsg = await S.stop({ pid: 30, startTime: '5000' }, { readProcs: async () => procs, hostPids: () => [20], kill: async () => { throw new Error('boom'); } });
  assert.strictEqual(withMsg.ok, false);
  assert.strictEqual(withMsg.reason, 'kill-failed');
  assert.strictEqual(withMsg.text, `${S.reasonText('kill-failed')}: boom`);
  const bare = await S.stop({ pid: 30, startTime: '5000' }, { readProcs: async () => procs, hostPids: () => [20], kill: async () => { throw 'plain'; } });
  assert.strictEqual(bare.text, `${S.reasonText('kill-failed')}: plain`);
});

test('stop verdict: a failed target with no text says only the reason, never "undefined"', async () => {
  const r = await run([{ pid: 30, status: 'failed' }]);
  assert.strictEqual(r.text, S.reasonText('kill-failed'));
  assert.strictEqual((await run([])).text, S.reasonText('kill-failed'));
});
