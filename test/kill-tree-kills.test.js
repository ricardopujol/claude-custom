'use strict';
/**
 * Kill tests for the release-gate survivors S6 and S20 in host/kill-tree.js (Mortimer, 2026-10-09): the pid-reuse guards of the
 * process-tree kill. Everything is injected (`run`, `killFn`, `provenKill`, `spawnFn`); no process is started or killed here.
 */
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const { killTree, killPidTree, killChildTree, killOutcomeOf, trackExit, childExited, killProven, killProvenAsync, parseProvenKill } = require('../host/kill-tree');

const START = Symbol.for('claude-custom.child.start');
const NO_START = { startTimes: async () => new Map() };

/** console.log silenced for the length of fn: the fallbacks narrate themselves. */
function quiet(fn) {
  const log = console.log; console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}
function pty(pid) {
  const p = { pid, fire: null, onExit(cb) { p.fire = cb; } };
  return p;
}

test('S6: an IPty whose onExit fired is judged ended, and is not killed by its freed pid', () => {
  const it = trackExit(pty(9), NO_START);
  assert.strictEqual(childExited(it), false, 'tracked and running');
  const before = [];
  assert.strictEqual(killChildTree(it, { killFn: (p) => before.push(p), provenKill: () => assert.fail('no proof was read') }), true, 'running: killed');
  assert.deepStrictEqual(before, [9]);

  const gone = trackExit(pty(10), NO_START);
  gone.fire();
  assert.strictEqual(childExited(gone), true);
  const kills = [];
  assert.strictEqual(killChildTree(gone, { killFn: (p) => kills.push(p), provenKill: (p) => kills.push(p) }), false);
  assert.deepStrictEqual(kills, [], 'a freed pid is not killed');
});

test('S6: a Node child whose exit event fired is ended even before exitCode is read; one that never exited is not', () => {
  const c = Object.assign(new EventEmitter(), { pid: 12, exitCode: null, signalCode: null, kill() {} });
  trackExit(c);
  assert.strictEqual(childExited(c), false);
  c.emit('exit', null, null);
  assert.strictEqual(childExited(c), true, 'the exit handler marks it');
  assert.strictEqual(childExited(null), true);
  assert.strictEqual(childExited({ pid: 5 }), true, 'an untracked IPty cannot be judged: ended');
  assert.strictEqual(childExited(Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null })), true);
  assert.strictEqual(childExited(Object.assign(new EventEmitter(), { exitCode: null, signalCode: 'SIGKILL' })), true);
  assert.strictEqual(childExited(Object.assign(new EventEmitter(), { exitCode: null })), false, 'a missing signalCode is not a signal');
});

test('S6: an IPty whose start is known is killed through the proof, with that start, once', async () => {
  const it = trackExit(pty(14), { startTimes: async () => new Map([[14, '133000000000000000']]) });
  await it[Symbol.for('claude-custom.child.startRead')];
  assert.strictEqual(it[START], '133000000000000000');
  const proven = []; const plain = [];
  assert.strictEqual(killChildTree(it, { killFn: (p) => plain.push(p), provenKill: (p, s) => proven.push([p, s]) }), true);
  assert.strictEqual(killChildTree(it, { killFn: (p) => plain.push(p), provenKill: (p, s) => proven.push([p, s]) }), false, 'a kill site runs once');
  assert.deepStrictEqual(proven, [[14, '133000000000000000']]);
  assert.deepStrictEqual(plain, []);
  assert.strictEqual(killChildTree({ pid: 0 }), false);
});

test('S6/S20: killPidTree falls back only when taskkill did not finish the job; 0 and 128 are final', () => {
  const calls = [];
  const go = (result, extra = {}) => {
    const fallback = []; const runs = [];
    quiet(() => killPidTree(9, { platform: 'win32', fallback: (p) => fallback.push(p), run: (...a) => { runs.push(a); if (result instanceof Error) throw result; return result; }, ...extra }));
    calls.push(runs);
    return { fallback, runs };
  };
  assert.deepStrictEqual(go({ status: 0 }).fallback, [], 'a clean kill is not followed by a second one');
  assert.deepStrictEqual(go({ status: 128 }).fallback, [], 'not found: the pid is gone');
  assert.deepStrictEqual(go({ status: 1, stderr: 'denied' }).fallback, [9]);
  assert.deepStrictEqual(go({ status: 255 }).fallback, [9]);
  assert.deepStrictEqual(go({ status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) }).fallback, [9]);
  assert.deepStrictEqual(go(new Error('boom')).fallback, [9]);
  assert.deepStrictEqual(calls[0], [['taskkill', ['/PID', '9', '/T', '/F'], { windowsHide: true }]], 'the exact command');
});

test('S6: off Windows taskkill is not run at all, and no pid is a no-op', () => {
  const fallback = []; let ran = 0;
  killPidTree(9, { platform: 'linux', fallback: (p) => fallback.push(p), run: () => { ran++; return { status: 0 }; } });
  assert.deepStrictEqual([ran, fallback], [0, [9]]);
  killPidTree(0, { platform: 'win32', fallback: (p) => fallback.push(p), run: () => { ran++; return { status: 1 }; } });
  killPidTree(undefined, { platform: 'win32', fallback: (p) => fallback.push(p), run: () => { ran++; return { status: 1 }; } });
  assert.deepStrictEqual([ran, fallback], [0, [9]]);
  assert.doesNotThrow(() => killPidTree(9, { platform: 'linux', fallback: () => { throw new Error('gone'); } }));
});

test('S6: killProven refuses a start that is not all digits, and a pid that is not a positive integer, without running anything', () => {
  let ran = 0;
  const run = () => { ran++; return { status: 0, stdout: 'KILLED 0\r\n' }; };
  for (const start of ["1'; calc; '5", '5x', 'x5', '', ' 5', '5 ', '5\n', '1.5', '-5', 5, null, undefined]) {
    assert.strictEqual(killProven(9, start, { run }), 'unknown', JSON.stringify(start));
  }
  for (const pid of [0, -1, 1.5, '9', null, NaN]) assert.strictEqual(killProven(pid, '5', { run }), 'unknown', String(pid));
  assert.strictEqual(ran, 0);
});

test('S6/S20: killProven runs the one PowerShell script with the exact arguments and options, and reads its answer', () => {
  const seen = [];
  const out = killProven(9, '133000', { powershell: 'ps.exe', run: (...a) => { seen.push(a); return { stdout: 'KILLED 0\r\n' }; } });
  assert.strictEqual(out, 'killed');
  const [exe, args, opts] = seen[0];
  assert.strictEqual(exe, 'ps.exe');
  assert.deepStrictEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.deepStrictEqual(opts, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.match(args[3], /Get-Process -Id 9 /);
  assert.match(args[3], /\[string\]\$s -ne '133000'/);
  assert.match(args[3], /taskkill\.exe \/PID 9 \/T \/F/);
});

test('S6: killProvenAsync judges the same way and treats a failed run as unknown', async () => {
  const seen = [];
  const runAsync = (answer) => async (...a) => { seen.push(a); if (answer instanceof Error) throw answer; return answer; };
  assert.strictEqual(await killProvenAsync(9, "1'; calc; '5", { runAsync: runAsync({ stdout: 'KILLED 0' }) }), 'unknown');
  assert.strictEqual(await killProvenAsync(0, '5', { runAsync: runAsync({ stdout: 'KILLED 0' }) }), 'unknown');
  assert.strictEqual(seen.length, 0);
  assert.strictEqual(await killProvenAsync(9, '5', { powershell: 'ps.exe', runAsync: runAsync({ stdout: 'MISMATCH\r\n' }) }), 'mismatch');
  assert.deepStrictEqual(seen[0].slice(0, 1), ['ps.exe']);
  assert.deepStrictEqual(seen[0][1].slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.deepStrictEqual(seen[0][2], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(await killProvenAsync(9, '5', { runAsync: runAsync({ error: new Error('timeout'), stdout: 'KILLED 0\r\n' }) }), 'killed', 'it printed its answer before the timeout');
  assert.strictEqual(await killProvenAsync(9, '5', { runAsync: runAsync({ error: new Error('x'), stdout: '' }) }), 'unknown');
  assert.strictEqual(await killProvenAsync(9, '5', { runAsync: runAsync(undefined) }), 'unknown');
  assert.strictEqual(await killProvenAsync(9, '5', { runAsync: runAsync(new Error('spawn')) }), 'unknown');
});

test('S6: parseProvenKill reads an answer only when it is a whole line', () => {
  const r = (stdout) => ({ status: 0, stdout });
  assert.strictEqual(parseProvenKill(r('xGONE\n')), 'unknown', 'anchored at the line start');
  assert.strictEqual(parseProvenKill(r('GONE trailing\n')), 'unknown', 'anchored at the line end');
  assert.strictEqual(parseProvenKill(r('xKILLED 0\n')), 'unknown');
  assert.strictEqual(parseProvenKill(r('KILLED 0x\n')), 'unknown');
  assert.strictEqual(parseProvenKill(r('KILLED \n')), 'unknown');
  assert.strictEqual(parseProvenKill(r('noise\nKILLED 0\r\n')), 'killed', 'any line of the output');
  assert.strictEqual(parseProvenKill(r('KILLED 0\nmore noise')), 'killed');
  assert.strictEqual(parseProvenKill(r('KILLED -1\n')), 'failed');
  assert.strictEqual(parseProvenKill({ stdout: 5 }), 'unknown');
  assert.strictEqual(parseProvenKill({ stdout: 'KILLED 0', error: new Error('x') }), 'unknown');
});

test('S20: killTree sends taskkill for the tree with the exact arguments, falls back to SIGTERM only when taskkill cannot run, and skips an ended child', () => {
  const mkChild = () => { const killed = []; return Object.assign(new EventEmitter(), { pid: 21, exitCode: null, signalCode: null, kill: (s) => killed.push(s), killed }); };
  const spawned = [];
  const killer = new EventEmitter();
  const spawnFn = (...a) => { spawned.push(a); return killer; };
  const c = trackExit(mkChild());
  killTree(c, { spawnFn });
  if (process.platform === 'win32') {
    assert.deepStrictEqual(spawned, [['taskkill', ['/PID', '21', '/T', '/F'], { windowsHide: true }]]);
    assert.deepStrictEqual(c.killed, [], 'no SIGTERM while taskkill runs');
    quiet(() => killer.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })));
    assert.deepStrictEqual(c.killed, ['SIGTERM'], 'taskkill missing: the portable kill');
    const thrower = mkChild();
    quiet(() => killTree(trackExit(thrower), { spawnFn: () => { throw new Error('spawn'); } }));
    assert.deepStrictEqual(thrower.killed, ['SIGTERM']);
  } else {
    assert.deepStrictEqual(c.killed, ['SIGTERM']);
  }
  const ended = trackExit(mkChild()); ended.emit('exit', 0, null);
  const before = spawned.length;
  killTree(ended, { spawnFn });
  killTree(null, { spawnFn });
  assert.strictEqual(spawned.length, before);
  assert.deepStrictEqual(ended.killed, []);
});

// PR #210 Dexter F5: the kill's outcome was never read, and a proven kill that did not land could not be retried.
test('F5: killChildTree remembers what the proven kill answered, and an unknown or failed one may be tried again', async () => {
  for (const [answer, retry] of [['killed', false], ['gone', false], ['mismatch', false], ['unknown', true], ['failed', true]]) {
    const it = trackExit(pty(31), { startTimes: async () => new Map([[31, '133000000000000000']]) });
    await it[Symbol.for('claude-custom.child.startRead')];
    assert.strictEqual(killOutcomeOf(it), null, 'nothing attempted yet');
    const seen = [];
    const opts = { provenKill: (p, s) => { seen.push([p, s]); return answer; }, killFn: () => assert.fail('a proven start is never killed by the raw pid') };
    assert.strictEqual(killChildTree(it, opts), true);
    assert.strictEqual(killOutcomeOf(it), answer);
    assert.strictEqual(killChildTree(it, opts), retry, `${answer}: ${retry ? 'tried again' : 'once'}`);
    assert.strictEqual(seen.length, retry ? 2 : 1, answer);
  }
});

test('F5: a raw-pid kill (start not read yet) is "sent"; an injected kill that says nothing is null', async () => {
  const early = trackExit(pty(32), NO_START);
  killChildTree(early, { killFn: () => {} });
  assert.strictEqual(killOutcomeOf(early), 'sent');
  const it = trackExit(pty(33), { startTimes: async () => new Map([[33, '133000000000000000']]) });
  await it[Symbol.for('claude-custom.child.startRead')];
  killChildTree(it, { provenKill: () => undefined });
  assert.strictEqual(killOutcomeOf(it), null);
  assert.strictEqual(killOutcomeOf(null), null);
  assert.strictEqual(killOutcomeOf({}), null);
});
