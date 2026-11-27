'use strict';
/**
 * Kill tests for host/bounded-shutdown.js armWatchdog (BACKLOG #228; Mortimer's 2026-11-23 audit, g8: 69.2%, 16 survivors).
 *
 * The survivors sat in what armWatchdog hands to spawn (the watchdog's argv and options) and in the disarm handle's guards, which
 * the real-process tests (bounded-shutdown-process.test.js) cannot see from outside. Here child_process.spawn is replaced BEFORE
 * the module is loaded (it destructures `spawn` at require time), so the exact call is visible and no process is started.
 *
 * Equivalent mutant, not killed and not claimed:
 *   - runShutdown `steps = []` -> `steps = ["Stryker was here"]`: the one "step" is a string, calling it throws, and every step's
 *     throw is swallowed by design, so nothing observable changes.
 * Measured (one Stryker run on this file, 2026-11-28, with bounded-shutdown.test.js and this file): 69.2% (the audit's g8) -> 98.08%,
 * the one survivor being the mutant above.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const childProcess = require('node:child_process');

const MODULE = require.resolve('../host/bounded-shutdown');
const WATCHDOG = path.join(path.dirname(MODULE), 'bounded-watchdog.js');

const killTreeModule = require('../host/kill-tree');
// What the DEFAULT killTree was asked to kill. It is a recorder, never the real killPidTree: the fake child's pid is made up, and a
// mutant that disarms when it should not must not reach a real process that happens to hold that pid.
const defaultKills = [];

/** Loads a fresh host/bounded-shutdown with spawn (and the default killTree) replaced; the real ones are put back at once. */
function loadWith(fakeSpawn) {
  const real = childProcess.spawn;
  const realKill = killTreeModule.killPidTree;
  delete require.cache[MODULE];
  childProcess.spawn = fakeSpawn;
  killTreeModule.killPidTree = (p) => { defaultKills.push(p); };
  try { return require(MODULE); } finally {
    childProcess.spawn = real; killTreeModule.killPidTree = realKill; delete require.cache[MODULE];
  }
}

/** A recording fake child: `exitCode` / `signalCode` as given, every call written to `calls`. */
function fakeChild({ pid = 4321, exitCode = null, signalCode = null, onThrows = false, killThrows = false } = {}) {
  const c = { pid, exitCode, signalCode, calls: [] };
  c.on = (ev, fn) => { c.calls.push(['on', ev, typeof fn]); if (onThrows) throw new Error('on'); return c; };
  c.unref = () => { c.calls.push(['unref']); };
  c.kill = () => { c.calls.push(['kill']); if (killThrows) throw new Error('gone'); return true; };
  return c;
}

function arm(opts, childOpts) {
  const seen = [];
  const child = fakeChild(childOpts);
  const { armWatchdog } = loadWith((...a) => { seen.push(a); return child; });
  const killed = [];
  const disarm = armWatchdog({ killTree: (p) => { killed.push(p); }, ...opts });
  return { seen, child, killed, disarm };
}

test('armWatchdog: the watchdog is this node, running bounded-watchdog.js with pid, bound, log file and start as its argv', () => {
  const { seen } = arm({ boundMs: 1234, pid: 77, logFile: 'C:\\x\\host.log', start: '133000000000000000' });
  assert.strictEqual(seen.length, 1);
  const [exe, args] = seen[0];
  assert.strictEqual(exe, process.execPath);
  assert.deepStrictEqual(args, [WATCHDOG, '77', '1234', 'C:\\x\\host.log', '133000000000000000']);
});

test('armWatchdog: no log file and no start time are passed as empty strings, never as text the watchdog would act on', () => {
  const { seen } = arm({ boundMs: 5, pid: 8 });
  assert.deepStrictEqual(seen[0][1].slice(1), ['8', '5', '', '']);
  const { seen: s2 } = arm({ boundMs: 5, pid: 8, logFile: '', start: '' });
  assert.deepStrictEqual(s2[0][1].slice(1), ['8', '5', '', '']);
});

test('armWatchdog: the defaults are this process and SHUTDOWN_BOUND_MS', () => {
  const seen = [];
  const { armWatchdog, SHUTDOWN_BOUND_MS } = loadWith((...a) => { seen.push(a); return fakeChild(); });
  armWatchdog({ killTree: () => {} });
  assert.deepStrictEqual(seen[0][1].slice(1), [String(process.pid), String(SHUTDOWN_BOUND_MS), '', '']);
});

test('armWatchdog: the watchdog is detached, hidden, has no stdio, and runs as plain node even under Electron', () => {
  const { seen } = arm({ pid: 9 });
  const opts = seen[0][2];
  assert.deepStrictEqual(Object.keys(opts).sort(), ['detached', 'env', 'stdio', 'windowsHide']);
  assert.strictEqual(opts.stdio, 'ignore');
  assert.strictEqual(opts.windowsHide, true);
  assert.strictEqual(opts.detached, true);
  assert.strictEqual(opts.env.ELECTRON_RUN_AS_NODE, '1');
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== 'ELECTRON_RUN_AS_NODE') assert.strictEqual(opts.env[k], v, `env ${k} is inherited`);
  }
});

test('armWatchdog: a spawn error is listened for (an unheard one would crash the host) and the child is unref\'d', () => {
  const { child, disarm } = arm({ pid: 9 });
  assert.deepStrictEqual(child.calls, [['on', 'error', 'function'], ['unref']]);
  assert.strictEqual(disarm.pid, 4321);
});

test('armWatchdog: if spawn or its wiring throws, there is no watchdog: no pid, not running, disarm touches nothing', () => {
  const { armWatchdog } = loadWith(() => { throw new Error('EMFILE'); });
  const killed = [];
  const d1 = armWatchdog({ killTree: (p) => killed.push(p) });
  assert.strictEqual(d1.pid, null);
  assert.strictEqual(d1.running(), false);
  d1();
  const { child, killed: k2, disarm: d2 } = arm({}, { onThrows: true });
  assert.strictEqual(d2.pid, null, 'a child whose wiring threw is not kept');
  assert.strictEqual(d2.running(), false);
  d2();
  assert.deepStrictEqual([killed, k2], [[], []]);
  assert.ok(!child.calls.some((c) => c[0] === 'kill'), 'the half-wired child is not killed by a handle that dropped it');
});

test('disarm: a running watchdog has its tree killed by pid, then its own handle', () => {
  const { child, killed, disarm } = arm({});
  assert.strictEqual(disarm.running(), true);
  disarm();
  assert.deepStrictEqual(killed, [4321]);
  assert.deepStrictEqual(child.calls.slice(2), [['kill']]);
});

test('disarm: a watchdog that has exited (by code or by signal) is not killed: its pid may be a stranger\'s now', () => {
  for (const childOpts of [{ exitCode: 0 }, { exitCode: 1 }, { signalCode: 'SIGTERM' }, { exitCode: 0, signalCode: 'SIGKILL' }]) {
    const { child, killed, disarm } = arm({}, childOpts);
    assert.strictEqual(disarm.running(), false, JSON.stringify(childOpts));
    disarm();
    assert.deepStrictEqual(killed, [], JSON.stringify(childOpts));
    assert.ok(!child.calls.some((c) => c[0] === 'kill'), JSON.stringify(childOpts));
  }
});

test('disarm: a tree kill that throws still kills the handle, and a handle kill that throws never escapes', () => {
  const child = fakeChild({ killThrows: true });
  const { armWatchdog } = loadWith(() => child);
  const disarm = armWatchdog({ killTree: () => { throw new Error('gone'); } });
  assert.doesNotThrow(() => disarm());
  assert.deepStrictEqual(child.calls.slice(2), [['kill']]);
});

test('runShutdown: the default arm is armWatchdog with the bound, log file and start given', () => {
  const seen = [];
  const child = fakeChild();
  const { runShutdown } = loadWith((...a) => { seen.push(a); return child; });
  const order = [];
  defaultKills.length = 0;
  runShutdown({ boundMs: 321, logFile: 'L', start: 'S', steps: [() => order.push(seen.length)] });
  assert.deepStrictEqual(seen[0][1].slice(2), ['321', 'L', 'S']);
  assert.deepStrictEqual(order, [1], 'armed before the first step');
  assert.deepStrictEqual(defaultKills, [4321], 'disarmed after the last, through the default tree kill');
  assert.deepStrictEqual(child.calls.slice(2), [['kill']]);
});

test('the default killTree is kill-tree\'s killPidTree', () => {
  const { armWatchdog } = loadWith(() => fakeChild({ pid: 999 }));
  defaultKills.length = 0;
  armWatchdog({ pid: 1 })();
  assert.deepStrictEqual(defaultKills, [999]);
});
