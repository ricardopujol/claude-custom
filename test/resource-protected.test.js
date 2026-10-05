'use strict';
// The "protected process" rule: one row per role, each a lone defect in an otherwise stoppable tree, because the clauses
// of host/resource-tree.js isProtectedRole / stopBlock mask one another in a single fixture.
// Release #117 Mortimer survivor 3.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../host/resource-tree');
const M = require('../host/resource-model');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
let clock;
const row = (pid, ppid, name, cmd) => ({ pid, ppid, name, cmd, start: String(clock += 10), priv: 1 });

// window 10 > host 20 > cmd.exe 23 (what the pty launched) > the row under test
const base = () => {
  clock = 1000;
  return [
    row(10, 1, 'electron.exe', `${EXE} ${INSTALL}`),
    row(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`),
    row(23, 20, 'cmd.exe', 'cmd.exe /k'),
  ];
};
const block = (extra, pid, hosts = [20]) => T.stopBlock([...base(), ...extra], pid, hosts);

test('protected role: claude.exe, deep in a session, is protected by its image alone', () => {
  assert.strictEqual(block([row(24, 23, 'claude.exe', 'claude.exe')], 24), 'protected');
  assert.strictEqual(block([row(24, 23, 'Claude.EXE', 'claude')], 24), 'protected', 'the image is matched case-insensitively');
});

test('protected role: an Electron renderer and a second Electron main are protected', () => {
  assert.strictEqual(block([row(24, 23, 'electron.exe', `${EXE} --type=renderer`)], 24), 'protected');
  assert.strictEqual(block([row(24, 23, 'electron.exe', `${EXE} ${INSTALL}`)], 24), 'protected');
});

test('protected role: a process running host/host.js is protected whatever its image, in either slash', () => {
  assert.strictEqual(block([row(24, 23, 'node.exe', 'node C:\\r\\dev\\host\\host.js')], 24, [20]), 'protected');
  assert.strictEqual(block([row(24, 23, 'node.exe', 'node C:/r/dev/host/host.js')], 24, [20]), 'protected');
});

test('protected role: a session host is protected, not merely "not ours"', () => {
  assert.strictEqual(T.stopBlock(base(), 20, [20]), 'protected');
  assert.strictEqual(T.stopBlock(base(), 20, []), 'protected');
});

test('protected role: a ConPTY (conhost or OpenConsole) is protected by its image', () => {
  assert.strictEqual(block([row(24, 23, 'conhost.exe', 'conhost.exe')], 24), 'protected');
  assert.strictEqual(block([row(24, 23, 'OpenConsole.exe', 'OpenConsole.exe')], 24), 'protected');
});

test('protected role: a direct child of a session host is protected, with nothing protected below it', () => {
  assert.strictEqual(block([], 23), 'protected');
  assert.strictEqual(block([row(24, 23, 'node.exe', 'node a')], 23), 'protected');
});

test('protected role: a process with a protected descendant is protected, whichever role it is', () => {
  const mid = row(24, 23, 'node.exe', 'npm start');
  assert.strictEqual(block([mid, row(25, 24, 'claude.exe', 'claude.exe')], 24), 'protected');
  assert.strictEqual(block([mid, row(25, 24, 'electron.exe', `${EXE} ${INSTALL}`)], 24), 'protected');
  assert.strictEqual(block([mid, row(25, 24, 'node.exe', 'node C:\\r\\dev\\host\\host.js')], 24), 'protected');
  assert.strictEqual(block([mid, row(25, 24, 'node.exe', 'x'), row(26, 25, 'electron.exe', `${EXE} --type=gpu-process`)], 24), 'protected', 'two levels down');
});

test('protected role: a second session host below the target makes it protected even when its image is not host-like', () => {
  const mid = row(24, 23, 'node.exe', 'npm start');
  assert.strictEqual(block([mid, row(25, 24, 'node.exe', 'plain')], 24, [20, 25]), 'protected');
});

test('control: an ordinary process under the pty launcher, and its ordinary children, are stoppable', () => {
  const mid = row(24, 23, 'node.exe', 'node server.js');
  assert.strictEqual(block([mid], 24), null);
  assert.strictEqual(block([mid, row(25, 24, 'git.exe', 'git status')], 24), null);
  assert.strictEqual(block([mid, row(25, 24, 'git.exe', 'git status')], 25), null);
});

test('control: a console host BELOW the target is just its hidden console and does not protect it', () => {
  const mid = row(24, 23, 'node.exe', 'node server.js');
  assert.strictEqual(block([mid, row(25, 24, 'conhost.exe', 'conhost.exe --headless')], 24), null);
  assert.strictEqual(block([mid, row(25, 24, 'OpenConsole.exe', 'OpenConsole.exe')], 24), null);
});

test('stopBlock: gone, not-ours, and an unknown or absent host list', () => {
  const mid = row(24, 23, 'node.exe', 'node server.js');
  assert.strictEqual(block([mid], 999), 'gone');
  assert.strictEqual(block([mid], 24, []), 'not-ours');
  assert.strictEqual(T.stopBlock([...base(), mid], 24, undefined), 'not-ours');
  assert.strictEqual(block([mid], 24, [777]), 'not-ours', 'a host pid that is not in the table owns nothing');
  assert.strictEqual(block([mid], 24, [777, 20]), null, 'an unknown host beside a real one changes nothing');
  assert.strictEqual(block([mid, row(30, 1, 'node.exe', 'elsewhere')], 30), 'not-ours');
});

test('stopBlock: a target under only ONE of two hosts is judged against the right host', () => {
  clock = 1000;
  const procs = [
    row(10, 1, 'electron.exe', `${EXE} ${INSTALL}`),
    row(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`),
    row(21, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`),
    row(23, 21, 'cmd.exe', 'cmd.exe'),
    row(24, 23, 'node.exe', 'node a'),
  ];
  assert.strictEqual(T.stopBlock(procs, 24, [20, 21]), null);
  assert.strictEqual(T.stopBlock(procs, 23, [20, 21]), 'protected', 'a direct child of the SECOND host');
  assert.strictEqual(T.stopBlock(procs, 23, [20]), 'not-ours');
});

test('provenHosts: a claim whose pid is a live process that is NOT a host is not proven', () => {
  clock = 1000;
  const procs = [row(50, 1, 'node.exe', 'node server.js'), row(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`)];
  const claims = [
    { pid: 50, port: 1, cwd: 'a', processStartedAt: procs[0].start },
    { pid: 20, port: 2, cwd: 'b', processStartedAt: procs[1].start },
  ];
  assert.deepStrictEqual(T.provenHosts(procs, claims), [{ pid: 20, port: 2, cwd: 'b' }]);
});

// resource-model childrenOf with its DEFAULT canStop (production always passes one, so this is the only way to see it)
test('childrenOf default canStop: claude, a ConPTY, an Electron process and a host are not stoppable; an ordinary child is', () => {
  clock = 1000;
  const list = [
    row(31, 1, 'claude.exe', 'claude.exe'),
    row(32, 1, 'conhost.exe', 'conhost.exe'),
    row(33, 1, 'electron.exe', `${EXE} --type=renderer`),
    row(34, 1, 'node.exe', 'node C:\\r\\dev\\host\\host.js'),
    row(35, 1, 'node.exe', 'node server.js'),
  ];
  const { children } = M.childrenOf(list, [31, 32, 33, 34, 35], null, 999);
  const can = Object.fromEntries(children.map(c => [c.pid, c.canStop]));
  // 3 are shown at most; ask for each separately so none is cut off
  for (const [pid, expect] of [[31, false], [32, false], [33, false], [34, false], [35, true]]) {
    const one = M.childrenOf(list, [pid], null, 999).children;
    assert.strictEqual(one.length, 1);
    assert.strictEqual(one[0].canStop, expect, `pid ${pid}`);
  }
  assert.ok(can);
});

// buildModel: Stop is offered only on a tab's own session, and only where stopBlock allows it
function modelFor(tabs) {
  clock = 1000;
  const list = [
    row(10, 1, 'electron.exe', `${EXE} ${INSTALL}`),
    row(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`),
    row(22, 20, 'claude.exe', 'claude.exe'),
    row(23, 22, 'node.exe', 'node server.js'),
    row(24, 23, 'bash.exe', 'bash'),
  ];
  const perf = new Map(list.map(p => [p.pid, { cpu: 0n, ts: 1n, ws: 1e6 }]));
  const sample = { at: 0, procs: list, perf, cpuTotal: { idle: 1n, ts: 1n }, os: { totalBytes: 32e9, freeBytes: 10e9 } };
  return M.buildModel({ sample, prev: null, cores: 4, tabs, hosts: [{ pid: 20, cwd: 'C:\\r\\dev' }], installDirs: [INSTALL], ownPid: 10 });
}

test('buildModel: a tab\'s own session offers Stop on its ordinary children', () => {
  const row0 = modelFor([{ key: 'k', label: 'main', hostPid: 20 }]).project.rows[0];
  assert.strictEqual(row0.key, 'k');
  assert.ok(row0.children.length > 0);
  assert.ok(row0.children.every(c => c.canStop === true), JSON.stringify(row0.children));
});

test('buildModel: a session with no tab offers Stop on none of its children', () => {
  const row0 = modelFor([]).project.rows[0];
  assert.strictEqual(row0.key, 'host:20');
  assert.ok(row0.children.length > 0);
  assert.ok(row0.children.every(c => c.canStop === false), JSON.stringify(row0.children));
});
