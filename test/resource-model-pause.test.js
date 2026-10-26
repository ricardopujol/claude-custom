'use strict';
/**
 * host/resource-model.js (BACKLOG #19): a child row says whether it is paused (with the time), whether Pause is offered, and a
 * paused row is always shown (a suspended process uses no CPU, so by the CPU order it would sink into "more" and a paused
 * thing would silently leave the panel).
 */
const test = require('node:test');
const assert = require('node:assert');
const M = require('../host/resource-model');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
const T0 = 134000000000000000n;
const SEC = 10000000n;
const proc = (pid, ppid, name, cmd, start) => ({ pid, ppid, name, cmd: cmd || null, priv: 1e6, start: String(start) });
function procs() {
  return [
    proc(10, 1, 'electron.exe', `${EXE} ${INSTALL}`, 1000),
    proc(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`, 1010),
    proc(22, 20, 'claude.exe', 'claude.exe', 1030),
    proc(23, 22, 'bash.exe', 'bash -c serve', 5000),
    proc(24, 23, 'node.exe', 'node serve.js', 5100),
    proc(25, 22, 'node.exe', 'node a.js', 5200),
    proc(26, 22, 'node.exe', 'node b.js', 5300),
    proc(27, 22, 'node.exe', 'node c.js', 5400),
    proc(28, 22, 'node.exe', 'node d.js', 5500),
  ];
}
const sampleOf = (list, cpu) => ({
  at: 0, procs: list,
  perf: new Map(list.map(p => [p.pid, { cpu: BigInt(cpu[p.pid] || 0), ts: T0, ws: p.priv }])),
  cpuTotal: { idle: 1000n, ts: T0 }, os: { totalBytes: 32e9, freeBytes: 10e9 },
});
const base = { cores: 4, tabs: [{ key: 'k', label: 'main', hostPid: 20 }], hosts: [{ pid: 20, cwd: 'C:\\r\\dev' }], installDirs: [INSTALL], ownPid: 10, labelOf: c => c.split('\\').pop() };
const entry = (pid, start, pids, since = 123) => ({ key: `${pid}:${start}`, pid, start: String(start), name: 'x', since, pids: pids.map(([p, s]) => ({ pid: p, start: String(s) })) });
const build = (extra = {}, list = procs(), cpu = {}) => {
  const prev = sampleOf(list, {});
  const next = { ...sampleOf(list, cpu), perf: new Map(list.map(p => [p.pid, { cpu: BigInt(cpu[p.pid] || 0), ts: T0 + 10n * SEC, ws: p.priv }])), cpuTotal: { idle: 5n * SEC, ts: T0 + 10n * SEC } };
  return M.buildModel({ ...base, sample: next, prev, ...extra }).project.rows[0];
};
const child = (row, pid) => row.children.find(c => c.pid === pid);

test('nothing paused: every row says paused: null and Pause is offered exactly where Stop is', () => {
  const row = build();
  assert.ok(row.children.length > 0);
  for (const c of row.children) {
    assert.strictEqual(c.paused, null);
    assert.strictEqual(c.canPause, c.canStop);
  }
});

test('a paused process says so, with the time it was paused; Pause is not offered on it, Stop still is', () => {
  const row = build({ paused: [entry(23, 5000, [[23, 5000], [24, 5100]], 777)] }, procs(), { 25: 4e8, 26: 3e8, 27: 2e8, 28: 1e8 });
  const c = child(row, 23);
  assert.deepStrictEqual(c.paused, { since: 777 });
  assert.strictEqual(c.canPause, false);
  assert.strictEqual(c.canStop, true);
});

test('what is suspended with a paused process cannot be paused again; neither can its ancestor', () => {
  const row = build({ paused: [entry(24, 5100, [[24, 5100]])] }, procs(), { 23: 9e8, 24: 5e8, 25: 4e8 });
  assert.strictEqual(child(row, 24).canPause, false, 'it is the paused one');
  assert.strictEqual(child(row, 23).canPause, false, 'its subtree holds a paused process: a second suspend would need a second resume');
  assert.strictEqual(child(row, 25).canPause, true, 'an unrelated sibling is still pausable');
});

test('a paused row is always shown, even though a suspended process has no CPU and would sort last', () => {
  const row = build({ paused: [entry(28, 5500, [[28, 5500]])] }, procs(), { 23: 9e8, 24: 8e8, 25: 7e8, 26: 6e8, 27: 5e8 });
  assert.ok(child(row, 28), 'the paused row is in the shown children');
  assert.strictEqual(row.children[0].pid, 28, 'and first');
  assert.strictEqual(row.children.length, 3, 'the usual three: the paused one plus the two busiest');
});

test('several paused rows are all shown, even beyond three', () => {
  const row = build({ paused: [25, 26, 27, 28].map((pid, i) => entry(pid, 5200 + i * 100, [[pid, 5200 + i * 100]])) });
  assert.deepStrictEqual(row.children.filter(c => c.paused).map(c => c.pid).sort(), [25, 26, 27, 28]);
  assert.strictEqual(row.children.length, 4);
  assert.strictEqual(row.more.count, 2, 'what is not shown (23 and 24) is counted in more');
});

test('an entry for a process that is not in this session (or whose start differs) marks nothing', () => {
  const row = build({ paused: [entry(23, 5000000000, [[23, 5000000000]]), entry(99, 5000, [[99, 5000]])] });
  assert.strictEqual(child(row, 23).paused, null);
  assert.strictEqual(child(row, 23).canPause, true);
});

test('a start that differs by the one-tick source difference still counts as the same process', () => {
  const row = build({ paused: [entry(23, 5001, [[23, 5001]])] });
  assert.notStrictEqual(child(row, 23).paused, null);
});

test('no paused argument at all (an older caller) behaves as nothing paused', () => {
  const row = build({ paused: undefined });
  assert.strictEqual(child(row, 23).paused, null);
});

test('childrenOf called the old way (no pause view) still answers, with Pause not offered', () => {
  const list = procs();
  const out = M.childrenOf(list, [23], null, 22);
  assert.strictEqual(out.children[0].paused, null);
  assert.strictEqual(out.children[0].canPause, false);
});
