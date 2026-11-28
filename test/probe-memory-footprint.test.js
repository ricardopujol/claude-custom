'use strict';
/**
 * The pure parts of verify/probe-memory-footprint.js.
 *
 * pipeForHost is the load-bearing one (Miguel B1, PR #53): .harness/host.log is
 * shared by every host on the repo, including the real claude-custom window the
 * probe may run inside. Taking the first "hook bridge listening" line would send
 * 24 fake agents into that real session and still report PASS.
 */
const test = require('node:test');
const assert = require('node:assert');
const { descendants, role, pipeForHost, summarize } = require('../verify/probe-memory-footprint.js');

const proc = (ProcessId, ParentProcessId, Name, CommandLine = '', PrivatePageCount = 0) =>
  ({ ProcessId, ParentProcessId, Name, CommandLine, PrivatePageCount, WorkingSetSize: 0 });

test('pipeForHost skips another host\'s line that comes first', () => {
  const log = [
    '[host] hook bridge listening on \\\\.\\pipe\\claude-custom-1111',
    '[host] hook bridge listening on \\\\.\\pipe\\claude-custom-2222',
  ].join('\n');
  assert.strictEqual(pipeForHost(log, 2222), '\\\\.\\pipe\\claude-custom-2222');
});

test('pipeForHost returns null when only other hosts logged a pipe', () => {
  const log = '[host] hook bridge listening on \\\\.\\pipe\\claude-custom-1111\n';
  assert.strictEqual(pipeForHost(log, 2222), null);
});

test('pipeForHost does not match a PID that merely ends with ours', () => {
  const log = '[host] hook bridge listening on \\\\.\\pipe\\claude-custom-12222\n';
  assert.strictEqual(pipeForHost(log, 2222), null);
});

test('descendants walks the whole tree and survives a PID-reuse cycle', () => {
  const procs = [proc(1, 3, 'electron.exe'), proc(2, 1, 'electron.exe'), proc(3, 2, 'node.exe'),
    proc(9, 8, 'unrelated.exe')];
  assert.deepStrictEqual(descendants(procs, 1).map((p) => p.ProcessId), [1, 2, 3]);
  assert.deepStrictEqual(descendants(procs, 42), []);
});

test('role classifies the harness processes', () => {
  assert.strictEqual(role(proc(1, 0, 'electron.exe', 'electron.exe C:\\r\\host\\host.js')), 'host');
  assert.strictEqual(role(proc(1, 0, 'electron.exe', 'electron.exe --type=renderer')), 'electron:renderer');
  assert.strictEqual(role(proc(1, 0, 'electron.exe', 'electron.exe C:\\r')), 'electron:main');
  assert.strictEqual(role(proc(1, 0, 'claude.exe')), 'claude');
  assert.strictEqual(role(proc(1, 0, 'OpenConsole.exe')), 'conpty');
});

test('summarize charges claude and its children to the CLI, the rest to the harness', () => {
  const procs = [
    proc(1, 0, 'electron.exe', 'electron.exe C:\\r', 100),
    proc(2, 1, 'electron.exe', 'electron.exe C:\\r\\host\\host.js', 50),
    proc(3, 2, 'claude.exe', '', 400),
    proc(4, 3, 'node.exe', 'mcp-server', 30),
  ];
  const { summary } = summarize(procs, 1);
  assert.strictEqual(summary.harnessPrivateBytes, 150);
  assert.strictEqual(summary.cliPrivateBytes, 430);
  assert.strictEqual(summary.privateBytes, 580);
  assert.ok(summary.byRole['cli:node.exe']);
});

// ---- the single-instance measure (DESIGN_SINGLE_INSTANCE.md §6) ----
const { summarizeRoots, perExtraProject } = require('../verify/probe-memory-footprint.js');

test('summarize: a stand-in binary is charged to the CLI side, its children too; without the option it is harness', () => {
  const procs = [
    proc(1, 0, 'electron.exe', 'electron.exe C:\\r',100),
    proc(2, 1, 'electron.exe', 'electron.exe C:\\r\\host\\host.js', 50),
    proc(3, 2, 'OpenConsole.exe', '', 7),
    proc(4, 2, 'cmd.exe', 'C:\\Windows\\System32\\cmd.exe', 4),
    proc(5, 4, 'node.exe', 'node x', 9),
  ];
  const on = summarize(procs, 1, { standIn: 'CMD.EXE' }).summary;
  assert.strictEqual(on.harnessPrivateBytes, 157);
  assert.strictEqual(on.cliPrivateBytes, 13);
  assert.deepStrictEqual(on.byRole['cli-stand-in:cmd.exe'], { count: 1, privateBytes: 4, workingSet: 0 });
  assert.ok(on.byRole['cli:node.exe']);
  const off = summarize(procs, 1).summary;
  assert.strictEqual(off.harnessPrivateBytes, 170);
  assert.strictEqual(off.cliPrivateBytes, 0);
  assert.ok(off.byRole['other:cmd.exe']);
});

test('summarizeRoots sums separate trees, role by role, and counts each root', () => {
  const procs = [
    proc(1, 0, 'electron.exe', 'electron.exe C:\\r',100),
    proc(2, 1, 'electron.exe', 'electron.exe C:\\r\\host\\host.js', 50),
    proc(11, 0, 'electron.exe', 'electron.exe C:\\r',120),
    proc(12, 11, 'electron.exe', 'electron.exe --type=renderer', 60),
    proc(99, 0, 'unrelated.exe', '', 1000),
  ];
  const { tree, summary } = summarizeRoots(procs, [1, 11]);
  assert.deepStrictEqual(tree.map((p) => p.ProcessId).sort((a, b) => a - b), [1, 2, 11, 12]);
  assert.strictEqual(summary.roots, 2);
  assert.strictEqual(summary.processes, 4);
  assert.strictEqual(summary.harnessPrivateBytes, 330);
  assert.strictEqual(summary.byRole['electron:main'].count, 2);
  assert.strictEqual(summary.byRole['electron:main'].privateBytes, 220);
  assert.strictEqual(summary.byRole.host.count, 1);
});

test('summarizeRoots counts a process once when two roots reach it (one root inside the other\'s tree)', () => {
  const procs = [proc(1, 0, 'electron.exe', 'electron.exe C:\\r',100), proc(2, 1, 'electron.exe', 'electron.exe C:\\r',40)];
  const { summary } = summarizeRoots(procs, [1, 2]);
  assert.strictEqual(summary.processes, 2);
  assert.strictEqual(summary.privateBytes, 140);
});

test('summarizeRoots with a root that is gone adds nothing for it', () => {
  const { summary } = summarizeRoots([proc(1, 0, 'electron.exe', 'electron.exe C:\\r',100)], [1, 777]);
  assert.strictEqual(summary.processes, 1);
  assert.strictEqual(summary.privateBytes, 100);
});

test('steadyHarness: only processes in every sample count, each at its median; a one-shot one and the CLI are left out', () => {
  const { steadyHarness } = require('../verify/probe-memory-footprint.js');
  const s = (mainBytes, extra) => {
    const procs = [proc(1, 0, 'electron.exe', 'electron.exe C:\\r', mainBytes), proc(3, 1, 'claude.exe', '', 500), ...extra];
    return summarize(procs, 1);
  };
  const shell = proc(7, 1, 'powershell.exe', 'powershell -Command x', 90);
  const reused = proc(1, 0, 'electron.exe', 'electron.exe C:\\other', 5);   // same pid, another command line: not the same process
  const r = steadyHarness([s(100, []), s(300, [shell]), s(200, [])]);
  assert.strictEqual(r.bytes, 200);
  assert.deepStrictEqual(r.byRole, { 'electron:main': { count: 1, privateBytes: 200 } });
  assert.deepStrictEqual(r.transient, { count: 1, maxBytes: 90, roles: { 'other:powershell.exe': 1 } });
  const r2 = steadyHarness([s(100, []), { tree: [reused], cliPids: new Set() }]);
  assert.strictEqual(r2.bytes, 0);
  assert.strictEqual(r2.transient.count, 2);
});

test('perExtraProject: (n-project - 1-project) / (n - 1); a missing reading is null, never a zero', () => {
  assert.strictEqual(perExtraProject(100, 500, 3), 200);
  assert.strictEqual(perExtraProject(100, 100, 3), 0);
  assert.strictEqual(perExtraProject(300, 100, 3), -100);
  assert.strictEqual(perExtraProject(null, 500, 3), null);
  assert.strictEqual(perExtraProject(100, undefined, 3), null);
  assert.strictEqual(perExtraProject(100, NaN, 3), null);
  assert.strictEqual(perExtraProject(100, 500, 1), null);
  assert.strictEqual(perExtraProject(100, 500, 2.5), null);
});
