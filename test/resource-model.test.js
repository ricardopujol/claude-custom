'use strict';
/**
 * host/resource-model.js (BACKLOG #63): the panel's view model, joined from a sample, the CPU deltas, the
 * attribution and this window's tabs. Memory shows at once; CPU is null until the second sample.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const M = require('../host/resource-model');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
const T0 = 134000000000000000n;
const SEC = 10000000n;          // 1 s in 100 ns ticks

let clock;
const proc = (pid, ppid, name, cmd, priv, start) => ({ pid, ppid, name, cmd: cmd || null, priv, start: String(start === undefined ? (clock += 10) : start) });

// Window 10 (this one): renderer 11, host 20 (tab "main") -> claude 22 -> node 23 -> 4 small kids; host 30 (tab "feat") -> claude 32.
// Window 50 (another project): host 60 -> claude 62. Host 70 has no window (background).
function procs() {
  clock = 1000;
  const list = [
    proc(10, 1, 'electron.exe', `${EXE} ${INSTALL}`, 100e6),
    proc(11, 10, 'electron.exe', `${EXE} --type=renderer`, 200e6),
    proc(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`, 50e6),
    proc(21, 20, 'conhost.exe', 'conhost.exe --headless', 5e6),
    proc(22, 20, 'claude.exe', 'claude.exe --x', 300e6),
    proc(23, 22, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\work\\server.js --port 80', 400e6),
    proc(24, 23, 'bash.exe', 'bash', 1e6), proc(25, 23, 'bash.exe', 'bash', 1e6), proc(26, 23, 'bash.exe', 'bash', 1e6), proc(27, 23, 'bash.exe', 'bash', 1e6),
    proc(30, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`, 50e6),
    proc(32, 30, 'claude.exe', 'claude.exe', 250e6),
    proc(50, 1, 'electron.exe', `${EXE} ${INSTALL}`, 90e6),
    proc(60, 50, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`, 40e6),
    proc(62, 60, 'claude.exe', 'claude.exe', 260e6),
    proc(70, 999, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`, 40e6),
    proc(72, 70, 'claude.exe', 'claude.exe', 270e6),
  ];
  return list;
}
const sampleOf = (list, cpuByPid, ts, extra = {}) => ({
  at: 0, procs: list,
  perf: new Map(Object.entries(cpuByPid).map(([pid, cpu]) => [Number(pid), { cpu: BigInt(cpu), ts }])),
  cpuTotal: { idle: 1000n, ts }, os: { totalBytes: 32e9, freeBytes: 10e9 }, ...extra,
});
// cores = 4; a process that burned `pct`% of the machine over 10 s used pct/100 * 4 * 10 s of processor time.
const ticks = pct => BigInt(Math.round((pct / 100) * 4 * 10 * 1e7));
const every = (list, f) => Object.fromEntries(list.map(p => [p.pid, f(p.pid)]));

const base = {
  cores: 4,
  tabs: [{ key: 'k-main', label: 'main', hostPid: 20 }, { key: 'k-feat', label: 'feat', hostPid: 30 }],
  hosts: [{ pid: 20, cwd: 'C:\\r\\dev' }, { pid: 30, cwd: 'C:\\r\\feat' }, { pid: 60, cwd: 'C:\\other\\proj' }, { pid: 70, cwd: 'C:\\bg\\dev' }],
  installDirs: [INSTALL], ownPid: 10,
  labelOf: cwd => cwd.split('\\').pop(),
};

function twoSamples(cpuAt2) {
  const list = procs();
  const prev = sampleOf(list, every(list, () => 0), T0, { cpuTotal: { idle: 0n, ts: T0 } });
  const next = sampleOf(list, every(list, pid => ticks(cpuAt2[pid] || 0)), T0 + 10n * SEC, { cpuTotal: { idle: 5n * SEC, ts: T0 + 10n * SEC } });
  return { prev, next };
}

test('first sample: memory is there at once, every CPU figure is null (measuring), never 0', () => {
  const list = procs();
  const m = M.buildModel({ ...base, sample: sampleOf(list, every(list, () => 0), T0), prev: null });
  assert.strictEqual(m.measuring, true);
  assert.strictEqual(m.machine.cpu, null);
  assert.deepStrictEqual(m.machine.mem, { usedBytes: 22e9, totalBytes: 32e9 });
  const main = m.project.rows.find(r => r.key === 'k-main');
  assert.strictEqual(main.cpu, null);
  assert.strictEqual(main.bytes, 300e6 + 400e6 + 4e6);
  assert.strictEqual(m.project.cpu, null);
  for (const c of main.children) assert.strictEqual(c.cpu, null);
});

test('second sample: session CPU is the sum of its tree, machine CPU comes from the idle counter', () => {
  const { prev, next } = twoSamples({ 22: 5, 23: 30, 24: 2, 32: 1, 62: 8, 11: 3, 10: 1 });
  const m = M.buildModel({ ...base, sample: next, prev });
  assert.strictEqual(m.measuring, false);
  assert.ok(Math.abs(m.machine.cpu - 50) < 1e-9, String(m.machine.cpu));
  const main = m.project.rows.find(r => r.key === 'k-main');
  assert.ok(Math.abs(main.cpu - 37) < 1e-6, String(main.cpu));
  const feat = m.project.rows.find(r => r.key === 'k-feat');
  assert.ok(Math.abs(feat.cpu - 1) < 1e-6);
});

test('a session row lists its top 3 children by CPU, never claude itself, with the rest counted', () => {
  const { prev, next } = twoSamples({ 22: 50, 23: 30, 24: 2, 25: 1.5, 26: 0.2, 27: 0.1 });
  const main = M.buildModel({ ...base, sample: next, prev }).project.rows.find(r => r.key === 'k-main');
  assert.deepStrictEqual(main.children.map(c => c.pid), [23, 24, 25]);
  assert.deepStrictEqual(main.more, { count: 2, underOnePct: true });
  assert.strictEqual(main.children[0].name, 'node.exe');
  assert.strictEqual(main.children[0].cmd, 'C:\\work\\server.js --port 80', 'the executable path is cut, the arguments stay');
  assert.strictEqual(main.children[0].bytes, 400e6);
  assert.strictEqual(main.children[0].start, procs()[5].start);
  assert.strictEqual(main.children[0].canStop, true);
  assert.strictEqual(main.claude.cpu !== null, true, 'claude itself is shown on the row, not as a child');
});

test('the "+N more" note only claims "under 1% each" when it is true', () => {
  const { prev, next } = twoSamples({ 23: 30, 24: 5, 25: 4, 26: 3, 27: 2 });
  const main = M.buildModel({ ...base, sample: next, prev }).project.rows.find(r => r.key === 'k-main');
  assert.strictEqual(main.children.length, 3);
  assert.deepStrictEqual(main.more, { count: 2, underOnePct: false });
});

test('children with no CPU figure sort after those with one, then by memory', () => {
  const list = procs();
  const prev = sampleOf(list, every(list, () => 0), T0);
  const next = sampleOf(list.filter(p => ![24, 26, 27].includes(p.pid)), every(list, () => 0), T0 + 10n * SEC);
  next.perf.delete(25);
  const main = M.buildModel({ ...base, sample: next, prev }).project.rows.find(r => r.key === 'k-main');
  assert.strictEqual(main.children[0].pid, 23);
  assert.strictEqual(main.children.find(c => c.pid === 25).cpu, null);
});

test('claude-custom itself: main, renderers and session hosts, summed, with the hosts and ConPTYs in the last part', () => {
  const { prev, next } = twoSamples({ 10: 1, 11: 3, 20: 0.5, 21: 0.25, 30: 0.25 });
  const self = M.buildModel({ ...base, sample: next, prev }).project.self;
  assert.deepStrictEqual(self.parts.map(p => p.id), ['main', 'renderers', 'hosts']);
  assert.strictEqual(self.parts[0].bytes, 100e6);
  assert.strictEqual(self.parts[1].bytes, 200e6);
  assert.strictEqual(self.parts[2].bytes, 50e6 + 5e6 + 50e6);
  assert.ok(Math.abs(self.cpu - 5) < 1e-6);
  assert.strictEqual(self.bytes, 100e6 + 200e6 + 105e6);
});

test('the project header is the sum of this window: its sessions and itself', () => {
  const { prev, next } = twoSamples({ 22: 5, 23: 30, 32: 1, 11: 3, 10: 1 });
  const m = M.buildModel({ ...base, sample: next, prev });
  assert.ok(Math.abs(m.project.cpu - (35 + 1 + 4)) < 1e-6);
  const bytes = m.project.rows.reduce((a, r) => a + r.bytes, 0) + m.project.self.bytes;
  assert.strictEqual(m.project.bytes, bytes);
});

test('other windows: one summed row each, named by the project of their hosts; background sessions get their own row', () => {
  const { prev, next } = twoSamples({ 62: 8, 60: 1, 50: 1, 72: 6 });
  const m = M.buildModel({ ...base, sample: next, prev });
  assert.strictEqual(m.windows.length, 1);
  const w = m.windows[0];
  assert.strictEqual(w.rootPid, 50);
  assert.strictEqual(w.label, 'proj');
  assert.ok(Math.abs(w.cpu - 10) < 1e-6);
  assert.strictEqual(w.bytes, 90e6 + 40e6 + 260e6);
  assert.strictEqual(w.sessions, 1);
  assert.ok(m.background);
  assert.strictEqual(m.background.sessions, 1);
  assert.ok(Math.abs(m.background.cpu - 6) < 1e-6);
  assert.strictEqual(m.background.bytes, 40e6 + 270e6);
});

test('a window with no host to name it is "claude-custom (pid N)"', () => {
  const list = procs().filter(p => ![60, 62].includes(p.pid));
  const s = sampleOf(list, every(list, () => 0), T0);
  const m = M.buildModel({ ...base, hosts: base.hosts.filter(h => h.pid !== 60), sample: s, prev: null });
  assert.strictEqual(m.windows[0].label, 'claude-custom (pid 50)');
});

test('no background row when there are no background sessions', () => {
  const list = procs().filter(p => ![70, 72].includes(p.pid));
  const m = M.buildModel({ ...base, sample: sampleOf(list, every(list, () => 0), T0), prev: null });
  assert.strictEqual(m.background, null);
});

test('machine: the claude-custom share is every window plus background, the rest is everything else', () => {
  const { prev, next } = twoSamples({ 22: 10, 62: 10, 72: 10, 4: 20 });
  const m = M.buildModel({ ...base, sample: next, prev });
  assert.ok(Math.abs(m.machine.ours.cpu - 30) < 1e-6);
  const ourBytes = procs().filter(p => p.pid !== 4).reduce((a, p) => a + p.priv, 0);
  assert.strictEqual(m.machine.ours.bytes, ourBytes);
});

test('a tab with no host in the table has no row; a host of this window with no tab still gets one', () => {
  const list = procs();
  const m = M.buildModel({ ...base, tabs: [{ key: 'k-main', label: 'main', hostPid: 20 }, { key: 'k-gone', label: 'gone', hostPid: 999 }, { key: 'k-new', label: 'new', hostPid: null }],
    sample: sampleOf(list, every(list, () => 0), T0), prev: null });
  assert.deepStrictEqual(m.project.rows.map(r => r.key), ['k-main', 'host:30']);
  assert.strictEqual(m.project.rows[1].label, 'feat', 'named by its folder');
});

test('shortCmd cuts the executable and keeps the arguments, quoted or not, and clips a long line', () => {
  assert.strictEqual(M.shortCmd('"C:\\Program Files\\nodejs\\node.exe" C:\\w\\a.js -x', 'node.exe'), 'C:\\w\\a.js -x');
  assert.strictEqual(M.shortCmd('C:\\w\\node.exe a.js', 'node.exe'), 'a.js');
  assert.strictEqual(M.shortCmd('node.exe', 'node.exe'), 'node.exe', 'no arguments: the name');
  assert.strictEqual(M.shortCmd(null, 'git.exe'), 'git.exe');
  assert.strictEqual(M.shortCmd('x.exe ' + 'a'.repeat(200), 'x.exe').length, 60);
  assert.ok(M.shortCmd('x.exe ' + 'a'.repeat(200), 'x.exe').endsWith('…'));
});

test('shortCmd: a line too long for the row keeps the FILE NAME of its first path, which is what tells processes apart', () => {
  const long = 'node  "C:\\Users\\ricar\\AppData\\Local\\Temp\\cc-probe-res-gB5rwB\\burn.js" 8 "C:\\x\\burn.pid" 100';
  assert.strictEqual(M.shortCmd(long, 'node.exe'), '…\\burn.js 8 "C:\\x\\burn.pid" 100');
  assert.match(M.shortCmd('node C:\\Users\\ricar\\AppData\\Local\\Temp\\cc-probe-res-gB5rwB\\server\\burn.js --port 80', 'node.exe'), /^…\\burn\.js --port 80$/);
  // short enough: untouched, folders and all
  assert.strictEqual(M.shortCmd('node C:\\w\\a.js -x', 'node.exe'), 'C:\\w\\a.js -x');
  // only the FIRST argument is shortened, and one with no folder in it is left alone
  assert.ok(M.shortCmd(`node ${'a'.repeat(70)} C:\\deep\\er\\file.js`, 'node.exe').startsWith('aaaa'));
  assert.ok(M.shortCmd('node C:/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/long.js', 'node.exe').startsWith('…\\long.js'));
});

test('stop is offered for ordinary children and not for Electron, a host, a ConPTY or claude', () => {
  const list = procs();
  list.push(proc(28, 23, 'electron.exe', `${EXE} --type=renderer`, 1e6));
  const s = sampleOf(list, every(list, () => 0), T0);
  const main = M.buildModel({ ...base, sample: s, prev: null }).project.rows.find(r => r.key === 'k-main');
  const all = [...main.children];
  assert.ok(all.every(c => c.pid !== 22), 'claude is not a child');
  const electron = M.childrenOf(list, [28], null, 99).children[0];
  assert.strictEqual(electron.canStop, false);
});

test('property: nothing the model sums is counted twice, and no figure is ever NaN', () => {
  const pctArb = fc.integer({ min: 0, max: 100 });
  fc.assert(fc.property(fc.array(pctArb, { minLength: 17, maxLength: 17 }), (pcts) => {
    const list = procs();
    const cpu = Object.fromEntries(list.map((p, i) => [p.pid, pcts[i] / 17]));
    const { prev, next } = twoSamples(cpu);
    const m = M.buildModel({ ...base, sample: next, prev });
    const rows = [...m.project.rows, m.project.self, ...m.windows, ...(m.background ? [m.background] : [])];
    const bytes = rows.reduce((a, r) => a + r.bytes, 0);
    assert.strictEqual(bytes, m.machine.ours.bytes);
    for (const r of rows) assert.ok(Number.isFinite(r.bytes) && (r.cpu === null || Number.isFinite(r.cpu)));
  }));
});
