'use strict';
/**
 * host/resource-stop.js (BACKLOG #63): the Stop button's guard. It never acts by name (the 2026-10-02
 * `taskkill /IM node.exe` lesson): a pid, re-read, re-proved by its start time, and only a descendant of one of
 * this window's own session hosts that is not claude, a host, a ConPTY or Electron.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const S = require('../host/resource-stop');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
let clock = 1000;
const p = (pid, ppid, name, cmd, start) => ({ pid, ppid, name, cmd: cmd || null, start: String(start === undefined ? (clock += 10) : start), priv: 1 });

function world() {
  clock = 1000;
  return [
    p(10, 1, 'electron.exe', `${EXE} ${INSTALL}`),
    p(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`),
    p(21, 20, 'conhost.exe', 'conhost.exe --headless'),
    p(22, 20, 'claude.exe', 'claude.exe'),
    p(23, 22, 'node.exe', 'node server.js', 5000),
    p(24, 23, 'node.exe', 'node child.js', 5100),
    p(30, 10, 'electron.exe', `${EXE} --type=renderer`),
    p(40, 1, 'node.exe', 'node unrelated.js'),
  ];
}
const ask = (pid, startTime, procs = world(), hostPids = [20]) => S.stopDecision({ pid, startTime }, procs, { sessionHostPids: hostPids });

test('a live child of this window\'s session, with its start time, may be stopped', () => {
  const r = ask(23, '5000');
  assert.deepStrictEqual(r, { ok: true, target: { pid: 23, name: 'node.exe', start: '5000' } });
});

test('a grandchild may be stopped too: anything the session started', () => {
  const procs = world();
  assert.strictEqual(ask(24, procs[5].start, procs).ok, true);
});

test('bad input is refused before anything is read', () => {
  for (const bad of [null, undefined, 'x', 5, {}, { pid: 0, startTime: '1' }, { pid: -4, startTime: '1' }, { pid: 1.5, startTime: '1' },
    { pid: '23', startTime: '5000' }, { pid: 23 }, { pid: 23, startTime: 5000 }, { pid: 23, startTime: '' }, { pid: 23, startTime: '5 000' }]) {
    assert.deepStrictEqual(S.stopDecision(bad, world(), { sessionHostPids: [20] }), { ok: false, reason: 'invalid' }, JSON.stringify(bad));
  }
});

test('a pid that is gone says so: "Already exited"', () => {
  assert.deepStrictEqual(ask(999, '5000'), { ok: false, reason: 'gone' });
  assert.strictEqual(S.reasonText('gone'), 'Already exited');
});

test('a reused pid (the start time differs) is refused', () => {
  assert.deepStrictEqual(ask(23, '4999'), { ok: false, reason: 'reused' });
});

test('a process whose start time is unknown cannot be proved, so it is refused', () => {
  const procs = world();
  procs[4].start = null;
  assert.deepStrictEqual(ask(23, '5000', procs), { ok: false, reason: 'reused' });
});

test('claude, the host, the ConPTY and Electron get no Stop', () => {
  const procs = world();
  for (const pid of [22, 20, 21, 10, 30]) {
    const r = ask(pid, procs.find(x => x.pid === pid).start, procs);
    assert.deepStrictEqual(r, { ok: false, reason: 'protected' }, `pid ${pid}`);
  }
});

test('a process outside every session of this window is refused, even with its right start time', () => {
  const procs = world();
  assert.deepStrictEqual(ask(40, procs.find(x => x.pid === 40).start, procs), { ok: false, reason: 'not-ours' });
});

test('a session of ANOTHER window is not this window\'s to stop', () => {
  const procs = world();
  assert.deepStrictEqual(ask(24, procs[5].start, procs, [999]), { ok: false, reason: 'not-ours' });
  assert.deepStrictEqual(ask(24, procs[5].start, procs, []), { ok: false, reason: 'not-ours' });
});

test('a child that started BEFORE its parent (a reused ppid) is not a descendant', () => {
  const procs = world();
  procs.push(p(50, 23, 'node.exe', 'node impostor.js', 10));
  assert.deepStrictEqual(ask(50, '10', procs), { ok: false, reason: 'not-ours' });
});

test('reasonText words every refusal, and an unknown one still says something', () => {
  for (const r of ['invalid', 'gone', 'reused', 'protected', 'not-ours', 'unreadable']) assert.ok(S.reasonText(r).length > 3, r);
  assert.ok(S.reasonText('???').length > 3);
});

test('stop: re-reads the table, kills exactly that pid through the vetted path, and says what it did', async () => {
  const killed = [];
  const procs = world();
  let reads = 0;
  const r = await S.stop({ pid: 23, startTime: '5000' }, {
    readProcs: async () => { reads++; return procs; }, hostPids: () => [20], kill: pid => killed.push(pid),
  });
  assert.deepStrictEqual(r, { ok: true, pid: 23, name: 'node.exe' });
  assert.deepStrictEqual(killed, [23]);
  assert.strictEqual(reads, 1);
});

test('stop: a refusal kills nothing and names its reason', async () => {
  const killed = [];
  const r = await S.stop({ pid: 22, startTime: world()[3].start }, { readProcs: async () => world(), hostPids: () => [20], kill: pid => killed.push(pid) });
  assert.deepStrictEqual(r, { ok: false, reason: 'protected', text: S.reasonText('protected') });
  assert.deepStrictEqual(killed, []);
});

test('stop: when the table cannot be read nothing is stopped', async () => {
  const killed = [];
  for (const readProcs of [async () => null, async () => { throw new Error('boom'); }]) {
    const r = await S.stop({ pid: 23, startTime: '5000' }, { readProcs, hostPids: () => [20], kill: pid => killed.push(pid) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'unreadable');
  }
  assert.deepStrictEqual(killed, []);
});

test('stop: a kill that throws is reported, not raised', async () => {
  const r = await S.stop({ pid: 23, startTime: '5000' }, { readProcs: async () => world(), hostPids: () => [20], kill: () => { throw new Error('denied'); } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'kill-failed');
  assert.match(r.text, /denied/);
});

// ---- property: the guard's whole promise ----
const NAMES = [['electron.exe', `${EXE} ${INSTALL}`], ['electron.exe', `${EXE} --type=gpu-process`], ['electron.exe', `${EXE} ${INSTALL}\\host\\host.js`],
  ['claude.exe', 'claude.exe'], ['conhost.exe', 'conhost.exe'], ['node.exe', 'node a'], ['git.exe', 'git b'], ['bash.exe', 'bash c']];
test('property: ok is never returned for a protected role, a pid outside the session hosts, or a start time that does not match', () => {
  const rowArb = fc.record({ ppid: fc.integer({ min: 0, max: 25 }), kind: fc.integer({ min: 0, max: NAMES.length - 1 }), start: fc.integer({ min: 1, max: 30 }) });
  fc.assert(fc.property(fc.array(rowArb, { minLength: 1, maxLength: 25 }), fc.array(fc.integer({ min: 1, max: 25 }), { maxLength: 4 }),
    fc.integer({ min: 1, max: 26 }), fc.integer({ min: 1, max: 30 }), (rows, hostPids, pid, startGuess) => {
      const procs = rows.map((r, i) => ({ pid: i + 1, ppid: r.ppid, name: NAMES[r.kind][0], cmd: NAMES[r.kind][1], start: String(r.start), priv: 1 }));
      const d = S.stopDecision({ pid, startTime: String(startGuess) }, procs, { sessionHostPids: hostPids });
      if (!d.ok) return;
      const me = procs.find(x => x.pid === pid);
      assert.ok(me, 'a pid that is not in the table');
      assert.strictEqual(me.start, String(startGuess), 'a start time that does not match');
      assert.ok(!['host', 'claude', 'conpty'].includes(require('../host/resource-tree').roleOf(me)) && !/^electron/.test(require('../host/resource-tree').roleOf(me)));
      const under = hostPids.some(h => h !== pid && require('../host/resource-tree').descendants(procs, h).some(x => x.pid === pid));
      assert.ok(under, 'not under a session host');
    }));
});
