'use strict';
/**
 * verify/lib/launch-electron.js (BACKLOG #74 B): the one way a probe starts an Electron. Pinned here without
 * starting one: the environment it hands over, the ledger entry it writes, and the order it stops in
 * (polite first, wait, then kill by PID -- never by name).
 */
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanElectronEnv, launchElectron, stopElectron } = require('../verify/lib/launch-electron');
const ledger = require('../host/pid-ledger');

test('the environment: ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* are gone, the rest is kept', () => {
  const env = cleanElectronEnv({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CUSTOM_PORT: '7', CLAUDE_CUSTOM_X: 'y', KEEP: 'k' });
  assert.deepStrictEqual(env, { PATH: 'p', KEEP: 'k' });
});

test('the environment: what the probe sets explicitly is added AFTER the strip (it may be a CLAUDE_CUSTOM_ var)', () => {
  const env = cleanElectronEnv({ CLAUDE_CUSTOM_PORT: '7', ELECTRON_RUN_AS_NODE: '1' }, { CLAUDE_CUSTOM_BIN: 'cmd.exe', ELECTRON_RUN_AS_NODE: undefined });
  assert.strictEqual(env.CLAUDE_CUSTOM_BIN, 'cmd.exe');
  assert.ok(!('CLAUDE_CUSTOM_PORT' in env));
  assert.ok(!('ELECTRON_RUN_AS_NODE' in env), 'an extra of undefined does not re-add the variable');
});

test('the environment: the caller\'s object is not modified', () => {
  const src = { CLAUDE_CUSTOM_A: '1' };
  cleanElectronEnv(src);
  assert.deepStrictEqual(src, { CLAUDE_CUSTOM_A: '1' });
});

function fakes({ exitsOnPolite = true } = {}) {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  const alive = { v: true };
  const die = () => { alive.v = false; child.exitCode = 0; child.emit('exit', 0); };
  return {
    calls, child, alive, die,
    spawnFn: (exe, args, opts) => { calls.push(['spawn', exe, args, opts]); return child; },
    startTimes: async (pids) => new Map(pids.map(p => [p, p === 4242 ? '777' : '555'])),
    kill: (pid) => { calls.push(['kill', pid]); die(); },
    polite: () => { calls.push(['polite']); if (exitsOnPolite) setTimeout(die, 5); },
  };
}

test('launch: spawns with the cleaned env, writes a ledger entry proven by start time, naming this process as the launcher', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launch-test-'));
  try {
    const f = fakes();
    const file = path.join(dir, 'l.jsonl');
    const h = await launchElectron({
      electronPath: 'E.exe', args: ['app'], env: { ELECTRON_RUN_AS_NODE: '1', A: 'a' }, extraEnv: { B: 'b' }, label: 'probe-x',
      ledgerFile: file, spawnFn: f.spawnFn, startTimes: f.startTimes, selfStart: async () => '555', install: false,
    });
    const [, exe, args, opts] = f.calls[0];
    assert.strictEqual(exe, 'E.exe');
    assert.deepStrictEqual(args, ['app']);
    assert.deepStrictEqual(opts.env, { A: 'a', B: 'b' });
    assert.strictEqual(h.pid, 4242);
    const [e] = ledger.readLedger(file);
    assert.strictEqual(e.pid, 4242);
    assert.strictEqual(e.start, '777');
    assert.strictEqual(e.kind, 'probe-window');
    assert.strictEqual(e.label, 'probe-x');
    assert.deepStrictEqual(e.launcher, { pid: process.pid, start: '555' });
    assert.ok(Number.isFinite(e.createdAt));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('launch: when the start time cannot be read the process is killed at once and the launch fails (no unproven process is left)', async () => {
  const f = fakes();
  await assert.rejects(launchElectron({
    electronPath: 'E.exe', args: [], env: {}, label: 'x', ledgerFile: path.join(os.tmpdir(), 'cc-never.jsonl'),
    spawnFn: f.spawnFn, startTimes: async () => null, selfStart: async () => '555', install: false, killFn: f.kill,
  }), /start time/);
  assert.deepStrictEqual(f.calls.filter(c => c[0] === 'kill'), [['kill', 4242]]);
});

test('stop: polite first, waits for the exit, and does NOT kill a process that left by itself', async () => {
  const f = fakes({ exitsOnPolite: true });
  const r = await stopElectron({ child: f.child, pid: 4242 }, { polite: f.polite, killFn: f.kill, politeMs: 2000 });
  assert.deepStrictEqual(f.calls.map(c => c[0]), ['polite']);
  assert.strictEqual(r.how, 'polite');
});

test('stop: when it does not leave in time it is killed BY PID, once', async () => {
  const f = fakes({ exitsOnPolite: false });
  const r = await stopElectron({ child: f.child, pid: 4242 }, { polite: f.polite, killFn: f.kill, politeMs: 30 });
  assert.deepStrictEqual(f.calls, [['polite'], ['kill', 4242]]);
  assert.strictEqual(r.how, 'killed');
});

test('stop: a polite step that throws still ends in the kill', async () => {
  const f = fakes({ exitsOnPolite: false });
  await stopElectron({ child: f.child, pid: 4242 }, { polite: () => { throw new Error('socket gone'); }, killFn: f.kill, politeMs: 30 });
  assert.deepStrictEqual(f.calls, [['kill', 4242]]);
});

test('stop: removes the ledger entry once the process is gone, and leaves it if the kill did not take', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launch-test-'));
  try {
    const file = path.join(dir, 'l.jsonl');
    ledger.appendEntry(file, { pid: 4242, start: '777', launcher: null, label: 'x' });
    const f = fakes({ exitsOnPolite: true });
    await stopElectron({ child: f.child, pid: 4242 }, { polite: f.polite, killFn: f.kill, politeMs: 2000, ledgerFile: file });
    assert.deepStrictEqual(ledger.readLedger(file), []);

    ledger.appendEntry(file, { pid: 4242, start: '777', launcher: null, label: 'x' });
    const g = fakes({ exitsOnPolite: false });
    const r = await stopElectron({ child: g.child, pid: 4242 }, { polite: g.polite, killFn: () => {}, politeMs: 20, graceMs: 20, ledgerFile: file });
    assert.strictEqual(r.how, 'stuck');
    assert.strictEqual(ledger.readLedger(file).length, 1, 'a process that would not die stays in the ledger for the reaper');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- spawnElectron: the synchronous drop-in for `spawn(electron, args, opts)` the probes call --------------------

const { probeEnv, spawnElectron } = require('../verify/lib/launch-electron');

test('probeEnv: ELECTRON_RUN_AS_NODE always goes; a CLAUDE_CUSTOM_* equal to the parent\'s (inherited from a tab) goes', () => {
  const parent = { CLAUDE_CUSTOM_PORT: '7', CLAUDE_CUSTOM_PIPE: '\\\\.\\pipe\\tab', ELECTRON_RUN_AS_NODE: '1', PATH: 'p' };
  const child = { ...parent, KEEP: 'k' };
  assert.deepStrictEqual(probeEnv(child, parent), { PATH: 'p', KEEP: 'k' });
});

test('probeEnv: a CLAUDE_CUSTOM_* the probe set itself (new, or a different value) is kept', () => {
  const parent = { CLAUDE_CUSTOM_PIPE: 'tab-pipe', CLAUDE_CUSTOM_PORT: '7' };
  const child = { ...parent, CLAUDE_CUSTOM_PIPE: 'probe-pipe', CLAUDE_CUSTOM_BIN: 'cmd.exe' };
  assert.deepStrictEqual(probeEnv(child, parent), { CLAUDE_CUSTOM_PIPE: 'probe-pipe', CLAUDE_CUSTOM_BIN: 'cmd.exe' });
});

test('probeEnv: no env given means the parent\'s, cleaned; neither object is modified', () => {
  const parent = { CLAUDE_CUSTOM_PORT: '7', ELECTRON_RUN_AS_NODE: '1', A: 'a' };
  assert.deepStrictEqual(probeEnv(undefined, parent), { A: 'a' });
  assert.deepStrictEqual(parent, { CLAUDE_CUSTOM_PORT: '7', ELECTRON_RUN_AS_NODE: '1', A: 'a' });
});

function spawnFakes({ start = '777' } = {}) {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 5151;
  child.exitCode = null;
  const die = () => { child.exitCode = 0; child.emit('exit', 0); };
  return {
    calls, child, die,
    spawnFn: (exe, args, opts) => { calls.push(['spawn', exe, args, opts]); return child; },
    startTimes: async (pids) => { calls.push(['startTimes', pids]); return start === null ? null : new Map(pids.map(p => [p, start])); },
    kill: (pid) => { calls.push(['kill', pid]); },
  };
}

test('spawnElectron: returns the child at once, with exe, args and the other options passed through and the env cleaned', () => {
  const f = spawnFakes();
  const child = spawnElectron('E.exe', ['app', '--x'], { cwd: 'C:/r', stdio: 'pipe', env: { ELECTRON_RUN_AS_NODE: '1', A: 'a' } },
    { spawnFn: f.spawnFn, startTimes: f.startTimes, selfStart: async () => '555', ledgerFile: null, install: false, parentEnv: {} });
  assert.strictEqual(child, f.child);
  const [, exe, args, opts] = f.calls[0];
  assert.strictEqual(exe, 'E.exe');
  assert.deepStrictEqual(args, ['app', '--x']);
  assert.strictEqual(opts.cwd, 'C:/r');
  assert.strictEqual(opts.stdio, 'pipe');
  assert.deepStrictEqual(opts.env, { A: 'a' });
});

test('spawnElectron: writes a ledger entry proven by start time, and removes it when the child exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launch-test-'));
  try {
    const file = path.join(dir, 'l.jsonl');
    const f = spawnFakes();
    const child = spawnElectron('E.exe', [], {}, { spawnFn: f.spawnFn, startTimes: f.startTimes, selfStart: async () => '555',
      ledgerFile: file, install: false, label: 'probe-y', parentEnv: {} });
    assert.strictEqual(await child.ledgered, true);
    const [e] = ledger.readLedger(file);
    assert.strictEqual(e.pid, 5151);
    assert.strictEqual(e.start, '777');
    assert.strictEqual(e.label, 'probe-y');
    assert.deepStrictEqual(e.launcher, { pid: process.pid, start: '555' });
    f.die();
    assert.deepStrictEqual(ledger.readLedger(file), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('spawnElectron: an unreadable start time kills the child by pid and writes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launch-test-'));
  try {
    const file = path.join(dir, 'l.jsonl');
    const f = spawnFakes({ start: null });
    const child = spawnElectron('E.exe', [], {}, { spawnFn: f.spawnFn, startTimes: f.startTimes, selfStart: async () => '555',
      ledgerFile: file, install: false, killFn: f.kill, parentEnv: {} });
    assert.strictEqual(await child.ledgered, false);
    assert.deepStrictEqual(f.calls.filter(c => c[0] === 'kill'), [['kill', 5151]]);
    assert.deepStrictEqual(ledger.readLedger(file), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('spawnElectron: a child that exited before its start time was read is neither killed (its pid may be reused) nor recorded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launch-test-'));
  try {
    const file = path.join(dir, 'l.jsonl');
    const f = spawnFakes({ start: null });
    const child = spawnElectron('E.exe', [], {}, { spawnFn: f.spawnFn, startTimes: f.startTimes, selfStart: async () => '555',
      ledgerFile: file, install: false, killFn: f.kill, parentEnv: {} });
    f.die();
    assert.strictEqual(await child.ledgered, false);
    assert.deepStrictEqual(f.calls.filter(c => c[0] === 'kill'), []);
    assert.deepStrictEqual(ledger.readLedger(file), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('launch: a child that exited before its start time was read is not killed by pid (its pid may be reused)', async () => {
  const f = fakes();
  await assert.rejects(launchElectron({
    electronPath: 'E.exe', args: [], env: {}, label: 'x', ledgerFile: path.join(os.tmpdir(), 'cc-never.jsonl'),
    spawnFn: f.spawnFn, startTimes: async () => { f.die(); return null; }, selfStart: async () => '555', install: false, killFn: f.kill,
  }), /exited/);
  assert.deepStrictEqual(f.calls.filter(c => c[0] === 'kill'), []);
});

test('the exit sweep kills, by pid, only the children still running', async () => {
  const { sweepLive } = require('../verify/lib/launch-electron');
  const a = spawnFakes(); a.child.pid = 6001;
  const b = spawnFakes(); b.child.pid = 6002;
  const kills = [];
  const opts = (f) => ({ spawnFn: f.spawnFn, startTimes: f.startTimes, selfStart: async () => '555', ledgerFile: null,
    install: false, killFn: (pid) => kills.push(pid), parentEnv: {} });
  const ca = spawnElectron('E.exe', [], {}, opts(a));
  const cb = spawnElectron('E.exe', [], {}, opts(b));
  await ca.ledgered; await cb.ledgered;
  a.die();
  sweepLive();
  assert.deepStrictEqual(kills, [6002]);
});

test('stop: a child that has already exited is not killed by pid (its pid may be reused), and its ledger entry goes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launch-test-'));
  try {
    const file = path.join(dir, 'l.jsonl');
    ledger.appendEntry(file, { pid: 4242, start: '777', launcher: null, label: 'x' });
    const f = fakes();
    f.die();
    const r = await stopElectron({ child: f.child, pid: 4242 }, { killFn: f.kill, politeMs: 0, graceMs: 20, ledgerFile: file });
    assert.deepStrictEqual(f.calls.filter(c => c[0] === 'kill'), []);
    assert.strictEqual(r.how, 'gone');
    assert.deepStrictEqual(ledger.readLedger(file), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
