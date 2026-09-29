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
