'use strict';
/**
 * host/job-guard.js (BACKLOG #127): the PowerShell helper that keeps every process the session starts in a kill-on-close Job Object.
 * Pure here: a fake spawn stands in for the helper. The real job is measured by verify/probe-kill-switch-detached.js and
 * test/job-guard-process.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { createJobGuard, helperScript } = require('../host/job-guard');

// A fake helper: stdout/stdin are emitters, `kill()` records and exits it, `say()` prints a line.
function fakeHelper() {
  const h = new EventEmitter();
  h.pid = 4242;
  h.exitCode = null;
  h.signalCode = null;
  h.stdout = new EventEmitter();
  h.stdout.unref = () => {};
  h.stdin = Object.assign(new EventEmitter(), { written: [], ended: false, unref() {}, write(s) { this.written.push(s); }, end() { this.ended = true; } });
  h.killed = 0;
  h.kill = () => { h.killed++; h.exitCode = 1; h.emit('exit', 1, null); return true; };
  h.unref = () => {};
  h.say = (line) => h.stdout.emit('data', Buffer.from(line + '\n'));
  return h;
}
function guardWith(h, extra = {}) {
  const spawned = [];
  const g = createJobGuard({ spawnFn: (...a) => { spawned.push(a); return h; }, platform: 'win32', powershell: 'PS.exe', timeoutMs: 50, ...extra });
  return { g, spawned };
}
const tick = () => new Promise((r) => setImmediate(r));

test('helperScript: names the pid, ends the job only on a KILL line, and never sets kill-on-close (the helper dying ends nothing)', () => {
  const s = helperScript(777);
  assert.match(s, /\[CcJob\]::Make\(777\)/);
  assert.doesNotMatch(s, /0x2000/, 'no JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: a tree kill of the host reaches the helper, and must not end the job');
  assert.match(s, /TerminateJobObject/);
  assert.match(s, /if \(\$line -eq 'KILL'\) \{[^\n]*\[CcJob\]::Kill\(\$j\)/, 'only an explicit KILL ends the job');
  for (const bad of [0, -1, 1.5, '7', null, NaN]) assert.throws(() => helperScript(bad), /pid/, String(bad));
});

test('attach: runs PowerShell with the script encoded (no quoting to get wrong) and arms on READY with the start proven', async () => {
  const h = fakeHelper();
  const { g, spawned } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1234', exited: () => false });
  const [exe, args, opts] = spawned[0];
  assert.strictEqual(exe, 'PS.exe');
  assert.deepStrictEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.strictEqual(Buffer.from(args[3], 'base64').toString('utf16le'), helperScript(777));
  assert.strictEqual(opts.windowsHide, true);
  assert.strictEqual(g.state(), 'attaching');
  h.say('READY 286 1234');
  assert.deepStrictEqual(await p, { ok: true, ms: 286, start: '1234' });
  assert.strictEqual(g.state(), 'armed');
});

test('attach: a start time the pty does not have means the helper opened a stranger: the job is disarmed, never armed', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '9999', exited: () => false });
  h.say('READY 286 1234');
  assert.deepStrictEqual(await p, { ok: false, reason: 'start-mismatch' });
  assert.deepStrictEqual(h.stdin.written, ['DISARM\n']);
  assert.strictEqual(g.kill(), false, 'a disarmed job is never killed');
  assert.strictEqual(h.killed, 0);
});

test('attach: a pty that already exited is disarmed (its pid may be someone else\'s now)', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1234', exited: () => true });
  h.say('READY 10 1234');
  assert.deepStrictEqual(await p, { ok: false, reason: 'target-exited' });
  assert.deepStrictEqual(h.stdin.written, ['DISARM\n']);
});

test('attach: a start time that could not be read does not stop the guard (the pty was spawned a moment ago and has not exited)', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => null, exited: () => false });
  h.say('READY 10 1234');
  assert.strictEqual((await p).ok, true);
  assert.strictEqual(g.state(), 'armed');
});

test('attach: FAILED from the helper is not armed, and says why', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777 });
  h.say('FAILED AssignProcessToJobObject 5');
  assert.deepStrictEqual(await p, { ok: false, reason: 'failed: AssignProcessToJobObject 5' });
  assert.strictEqual(g.state(), 'failed');
  assert.strictEqual(g.kill(), false);
});

test('attach: a helper that never answers is told to DISARM and left to leave, never killed', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const r = await g.attach({ pid: 777 });
  assert.deepStrictEqual(r, { ok: false, reason: 'timeout' });
  assert.deepStrictEqual(h.stdin.written, ['DISARM\n']);
  assert.strictEqual(h.killed, 0);
});

test('attach: a helper that exits before it answers, or cannot start, is not armed', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777 });
  h.exitCode = 1; h.emit('exit', 1, null);
  assert.deepStrictEqual(await p, { ok: false, reason: 'helper-exited' });
  const g2 = createJobGuard({ spawnFn: () => { throw new Error('ENOENT'); }, platform: 'win32' });
  assert.deepStrictEqual(await g2.attach({ pid: 777 }), { ok: false, reason: 'spawn-failed' });
});

test('attach: off Windows, or with a bad pid, nothing is spawned', async () => {
  let spawns = 0;
  const spawnFn = () => { spawns++; return fakeHelper(); };
  assert.deepStrictEqual(await createJobGuard({ spawnFn, platform: 'linux' }).attach({ pid: 5 }), { ok: false, reason: 'not-windows' });
  for (const pid of [0, -3, 2.5, '5', undefined]) assert.deepStrictEqual(await createJobGuard({ spawnFn, platform: 'win32' }).attach({ pid }), { ok: false, reason: 'bad-pid' }, String(pid));
  assert.strictEqual(spawns, 0);
});

test('kill: tells the helper KILL, once; the helper itself is never killed (killing it would end nothing)', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1', exited: () => false });
  h.say('READY 5 1');
  await p;
  assert.strictEqual(g.kill(), true);
  assert.deepStrictEqual(h.stdin.written, ['KILL\n']);
  assert.strictEqual(h.stdin.ended, true);
  assert.strictEqual(h.killed, 0);
  assert.strictEqual(g.state(), 'ended');
  assert.strictEqual(g.kill(), false, 'a second ask (the stopper\'s retry) does nothing');
  assert.deepStrictEqual(h.stdin.written, ['KILL\n']);
});

test('kill while attaching: held until the helper has proven it opened our pty, then sent; never sent to an unproven job', async () => {
  // Proven: the stop came in the first second of the session, before the helper answered. The pty is already ended by the tree
  // kill (exited), but the start matches, so the helper holds our pty's own process: the job is ended.
  const h = fakeHelper();
  const { g } = guardWith(h);
  let ended = false;
  const p = g.attach({ pid: 777, startOf: async () => '1234', exited: () => ended });
  assert.strictEqual(g.kill(), true, 'accepted while attaching');
  assert.deepStrictEqual(h.stdin.written, [], 'nothing sent before the proof');
  ended = true;
  h.say('READY 5 1234');
  assert.strictEqual((await p).ok, true);
  assert.deepStrictEqual(h.stdin.written, ['KILL\n']);
  assert.strictEqual(g.state(), 'ended');

  // A stranger: the start differs, so the job is let go and nothing in it is ended.
  const h2 = fakeHelper();
  const { g: g2 } = guardWith(h2);
  const p2 = g2.attach({ pid: 777, startOf: async () => '1234', exited: () => true });
  g2.kill();
  h2.say('READY 5 9999');
  assert.deepStrictEqual(await p2, { ok: false, reason: 'start-mismatch' });
  assert.deepStrictEqual(h2.stdin.written, ['DISARM\n']);

  // Unproven (the start could not be read) and the pty gone: its pid may be someone else's, so nothing is ended.
  const h3 = fakeHelper();
  const { g: g3 } = guardWith(h3);
  const p3 = g3.attach({ pid: 777, startOf: async () => null, exited: () => true });
  g3.kill();
  h3.say('READY 5 1234');
  assert.deepStrictEqual(await p3, { ok: false, reason: 'target-exited' });
  assert.deepStrictEqual(h3.stdin.written, ['DISARM\n']);
});

test('kill: before anything was attached it does nothing', () => {
  assert.strictEqual(createJobGuard({ platform: 'win32' }).kill(), false);
});

test('the helper ending on its own (a tree kill of the host reached it) leaves the guard ended: no kill is sent afterwards', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1', exited: () => false });
  h.say('READY 5 1');
  await p;
  h.exitCode = 1; h.emit('exit', 1, null);
  assert.strictEqual(g.state(), 'ended');
  assert.strictEqual(g.kill(), false);
  assert.deepStrictEqual(h.stdin.written, []);
});

test('disarm: writes DISARM and closes stdin, so the job lets everything live; kill after that does nothing', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h);
  const p = g.attach({ pid: 777, startOf: async () => '1', exited: () => false });
  h.say('READY 5 1');
  await p;
  g.disarm();
  assert.deepStrictEqual(h.stdin.written, ['DISARM\n']);
  assert.strictEqual(h.stdin.ended, true);
  assert.strictEqual(g.state(), 'released');
  assert.strictEqual(g.kill(), false);
  assert.strictEqual(h.killed, 0);
});

test('a second attach releases the first helper instead of killing it', async () => {
  const first = fakeHelper();
  const second = fakeHelper();
  const helpers = [first, second];
  const g = createJobGuard({ spawnFn: () => helpers.shift(), platform: 'win32', timeoutMs: 50 });
  const p1 = g.attach({ pid: 1, startOf: async () => '1', exited: () => false });
  first.say('READY 5 1');
  await p1;
  const p2 = g.attach({ pid: 2, startOf: async () => '2', exited: () => false });
  assert.deepStrictEqual(first.stdin.written, ['DISARM\n']);
  assert.strictEqual(first.killed, 0);
  second.say('READY 5 2');
  assert.strictEqual((await p2).ok, true);
  await tick();
});

// PR #235 hub H1: what the session starts and detaches before the arm is outside the job, so host.log must say when the arm landed.
test('the log says how long after attach (the pty\'s spawn) the job armed, and why it did not', async () => {
  let clock = 1000;
  const lines = [];
  const h = fakeHelper();
  const { g } = guardWith(h, { log: (l) => lines.push(l), now: () => clock });
  const p = g.attach({ pid: 777, startOf: async () => '1', exited: () => false });
  clock = 1830;
  h.say('READY 286 1');
  await p;
  assert.ok(lines.some((l) => /^\[job-guard\] armed for pid 777 830 ms after spawn \(helper 286 ms\)$/.test(l)), lines.join(' | '));

  const lines2 = [];
  const h2 = fakeHelper();
  let clock2 = 0;
  const { g: g2 } = guardWith(h2, { log: (l) => lines2.push(l), now: () => clock2 });
  const p2 = g2.attach({ pid: 777 });
  clock2 = 40;
  h2.say('FAILED AssignProcessToJobObject 5');
  await p2;
  assert.ok(lines2.some((l) => /^\[job-guard\] not armed for pid 777 after 40 ms \(failed: AssignProcessToJobObject 5\)$/.test(l)), lines2.join(' | '));

  const lines3 = [];
  const g3 = createJobGuard({ spawnFn: () => { throw new Error('ENOENT'); }, platform: 'win32', log: (l) => lines3.push(l), now: () => 5 });
  await g3.attach({ pid: 777 });
  assert.deepStrictEqual(lines3, ['[job-guard] not armed for pid 777 after 0 ms (spawn-failed)'], 'a helper that cannot start is in host.log too');
});

test('a logger that throws never breaks the guard', async () => {
  const h = fakeHelper();
  const { g } = guardWith(h, { log: () => { throw new Error('log'); } });
  const p = g.attach({ pid: 777, startOf: async () => '1', exited: () => false });
  h.say('READY 5 1');
  assert.strictEqual((await p).ok, true);
});
