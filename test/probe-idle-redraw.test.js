'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { median, spread, electronType, cpuByType, gpuPercent, summarise, table } = require('../verify/probe-idle-redraw');

test('median: odd, even, empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('spread: ignores non-numbers and says nothing when there are none', () => {
  assert.deepEqual(spread([1, 5, 3, null, NaN, undefined]), { median: 3, min: 1, max: 5, n: 3 });
  assert.equal(spread([null, undefined]), null);
});

test('electronType reads --type, and a bare electron.exe is the main process; other programs are null', () => {
  assert.equal(electronType({ Name: 'electron.exe', CommandLine: 'electron.exe --type=gpu-process --x' }), 'gpu-process');
  assert.equal(electronType({ Name: 'electron.exe', CommandLine: 'electron.exe . --user-data-dir=x' }), 'main');
  assert.equal(electronType({ Name: 'node.exe', CommandLine: 'node --type=renderer' }), null);
});

test('cpuByType: a delta per type, a reused pid does not count, non-Electron is skipped', () => {
  const row = (id, cmd, ticks, name = 'electron.exe') => ({ ProcessId: id, Name: name, CommandLine: cmd, UserModeTime: ticks, KernelModeTime: 0 });
  const before = [row(1, 'electron.exe --type=gpu-process', 0), row(2, 'electron.exe --type=renderer', 0)];
  const after = [row(1, 'electron.exe --type=gpu-process', 5e7), row(2, 'electron.exe --type=utility', 9e9), row(3, 'electron.exe --type=renderer', 9e9), row(4, 'node.exe', 9e9, 'node.exe')];
  const out = cpuByType(before, after, 10);
  assert.equal(out['gpu-process'].cpu, 50);      // 5 s of CPU in 10 s = 50% of a core
  assert.equal(out.utility.cpu, 0);              // pid 2 changed its command line: not the same process
  assert.equal(out.renderer.cpu, 0);             // pid 3 is new: no baseline
  assert.equal(out.node, undefined);
});

test('gpuPercent: median over time of the sum for the wanted pids only', () => {
  const rows = [
    { at: 1, name: 'pid_10_engtype_3D', value: 4 }, { at: 1, name: 'pid_10_engtype_Copy', value: 1 }, { at: 1, name: 'pid_99_engtype_3D', value: 50 },
    { at: 2, name: 'pid_10_engtype_3D', value: 9 },
  ];
  assert.equal(gpuPercent(rows, [10]), 7);       // times sum to 5 and 9
  assert.equal(gpuPercent(null, [10]), 0);
});

test('summarise groups by scenario and mode and keeps min..max; table prints one row each', () => {
  const rs = summarise([
    { scenario: 'idle', mode: 'normal', cpu: { 'gpu-process': 10, renderer: 2 }, gpu: 5 },
    { scenario: 'idle', mode: 'normal', cpu: { 'gpu-process': 30, renderer: 4 }, gpu: 7 },
  ]);
  assert.equal(rs.length, 1);
  assert.deepEqual(rs[0].cpu['gpu-process'], { median: 20, min: 10, max: 30, n: 2 });
  assert.equal(rs[0].cpu.total.median, 23);
  assert.match(table(rs), /\| idle \| normal \| 2 \| 20\.0 \(10\.0\.\.30\.0\) \|/);
});

// PR #192 Miguel M1: the hosts the probe starts must die on EVERY exit path, not only on a signal.
test('every exit path of the probe reaches killEverything before process.exit', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'verify', 'probe-idle-redraw.js'), 'utf8');
  const entry = src.slice(src.indexOf('if (require.main === module)'));
  assert.match(entry, /\.catch\(/, 'a thrown error must be turned into an exit code');
  assert.match(entry, /\.finally\(|cleanup\(\)/, 'the cleanup must run after both outcomes');
  assert.ok(entry.indexOf('cleanup()') >= 0 && entry.indexOf('cleanup()') < entry.indexOf('process.exit'), 'cleanup runs before process.exit');
  assert.match(src, /cleanup = killEverything/, 'main hands its killEverything to the entry point');
});

test('summarise leaves out rounds whose scenario state was not reached, and says how many (PR #192 M3)', () => {
  const rs = summarise([
    { scenario: 'cue', mode: 'normal', cpu: { 'gpu-process': 20 }, gpu: 1, scenarioReached: true },
    { scenario: 'cue', mode: 'normal', cpu: { 'gpu-process': 0 }, gpu: 0, scenarioReached: false },
  ]);
  assert.equal(rs[0].rounds, 1);
  assert.equal(rs[0].excluded, 1);
  assert.equal(rs[0].cpu['gpu-process'].median, 20);
  assert.match(table(rs), /\| cue \| normal \| 1 \(\+1 excluded: state not reached\) \|/);
});

test('the GPU engine query keeps zero samples, so an idle median is not inflated (PR #192 M2)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'verify', 'probe-idle-redraw.js'), 'utf8');
  assert.ok(!/CookedValue\s+-gt\s+0/.test(src));
  assert.equal(gpuPercent([{ at: 1, name: 'pid_10_x', value: 0 }, { at: 2, name: 'pid_10_x', value: 0 }, { at: 3, name: 'pid_10_x', value: 6 }], [10]), 0);
});

test('the probe names the machine it measured on (PR #192 M4)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'verify', 'probe-idle-redraw.js'), 'utf8');
  assert.match(src, /machine: os\.hostname\(\)/);
});

test('electronType: a type-less electron.exe is main only when it is the root, otherwise a host (PR #192 Dexter 2)', () => {
  const row = (id) => ({ ProcessId: id, Name: 'electron.exe', CommandLine: 'electron.exe host.js' });
  assert.equal(electronType(row(1), 1), 'main');
  assert.equal(electronType(row(2), 1), 'host');
  const out = cpuByType([row(1), row(2)], [{ ...row(1), UserModeTime: 1e7 }, { ...row(2), UserModeTime: 5e7 }], 1, 1);
  assert.equal(out.main.cpu, 100);
  assert.equal(out.host.cpu, 500);
});

test('the probe checks the lean switch and the cue state of every scenario before it measures (PR #192 Dexter 3)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'verify', 'probe-idle-redraw.js'), 'utf8');
  assert.match(src, /!await setLean\(true\)\) \{ ok = false/, 'a failed lean switch must mark the round unreached');
  assert.match(src, /anim\.cue === CUE_EXPECTED\.has\(name\)/, 'cue presence AND absence are asserted per scenario');
});
