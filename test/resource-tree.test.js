'use strict';
/**
 * host/resource-tree.js (BACKLOG #63): who owns which process. The pure half of the attribution the panel shows.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const T = require('../host/resource-tree');

const INSTALL = 'C:\\Users\\r\\claude-custom\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;

// A tiny table builder: start times rise with the order a process is added, so a child added after its parent
// starts after it unless a test says otherwise.
function table(rows) {
  let t = 1000;
  return rows.map(([pid, ppid, name, cmd, start]) => ({
    pid, ppid, name, cmd: cmd || null, start: String(start === undefined ? (t += 10) : start), priv: 100,
  }));
}
const win = (pid, ppid = 1) => [pid, ppid, 'electron.exe', `${EXE} ${INSTALL}`];
const renderer = (pid, ppid) => [pid, ppid, 'electron.exe', `${EXE} --type=renderer --x`];
const host = (pid, ppid) => [pid, ppid, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`];
const conhost = (pid, ppid) => [pid, ppid, 'conhost.exe', '\\\\?\\C:\\WINDOWS\\system32\\conhost.exe --headless'];
const claude = (pid, ppid) => [pid, ppid, 'claude.exe', 'C:\\x\\claude.exe --flag'];
const kid = (pid, ppid, name = 'node.exe') => [pid, ppid, name, `${name} x`];

const opts = (hosts, extra = {}) => ({ hosts: hosts.map(pid => ({ pid })), installDirs: [INSTALL], ...extra });

test('roleOf names the processes the panel treats differently', () => {
  const r = (row) => T.roleOf(table([row])[0]);
  assert.strictEqual(r(host(5, 1)), 'host');
  assert.strictEqual(r(claude(5, 1)), 'claude');
  assert.strictEqual(r(conhost(5, 1)), 'conpty');
  assert.strictEqual(r([5, 1, 'OpenConsole.exe', null]), 'conpty');
  assert.strictEqual(r(win(5)), 'electron:main');
  assert.strictEqual(r(renderer(5, 1)), 'electron:renderer');
  assert.strictEqual(r(kid(5, 1, 'git.exe')), 'other');
  assert.strictEqual(r([5, 1, 'Electron.EXE', null]), 'electron:main', 'case-insensitive, no command line at all');
});

test('descendants walks the parent links, root first, and each pid once', () => {
  const p = table([win(10), host(11, 10), claude(12, 11), kid(13, 12), kid(14, 13)]);
  assert.deepStrictEqual(T.descendants(p, 11).map(x => x.pid), [11, 12, 13, 14]);
  assert.deepStrictEqual(T.descendants(p, 99), []);
});

test('descendants: a reused pid cannot adopt a process that started before it (start-time guard)', () => {
  // pid 20 died; Windows gave 20 to something that started LATER. Process 21 still names ppid 20 but started earlier.
  const p = table([[20, 1, 'new.exe', null, 5000], [21, 20, 'old-child.exe', null, 4000], [22, 20, 'real-child.exe', null, 5100]]);
  assert.deepStrictEqual(T.descendants(p, 20).map(x => x.pid), [20, 22]);
});

test('descendants: a child whose start time is unknown is not attributed', () => {
  const p = table([[20, 1, 'a.exe', null, 5000], [21, 20, 'b.exe', null, 5100]]);
  p[1].start = null;
  assert.deepStrictEqual(T.descendants(p, 20).map(x => x.pid), [20]);
});

test('descendants: a cycle in a corrupt table terminates', () => {
  const p = table([[1, 3, 'a', null, 100], [2, 1, 'b', null, 100], [3, 2, 'c', null, 100]]);
  const d = T.descendants(p, 1).map(x => x.pid);
  assert.deepStrictEqual([...d].sort(), [1, 2, 3]);
});

test('attribute: a session is claude and what it started; the host and its ConPTY are claude-custom itself', () => {
  const p = table([win(10), renderer(11, 10), host(20, 10), conhost(21, 20), claude(22, 20), kid(23, 22), kid(24, 23, 'bash.exe')]);
  const a = T.attribute(p, opts([20]));
  assert.deepStrictEqual(a.buckets.get('session:20').sort(), [22, 23, 24]);
  assert.deepStrictEqual(a.buckets.get('win:10:hosts').sort(), [20, 21]);
  assert.deepStrictEqual(a.buckets.get('win:10:renderers'), [11]);
  assert.deepStrictEqual(a.buckets.get('win:10:main'), [10]);
  assert.deepStrictEqual(a.sessions, [{ hostPid: 20, owner: 10, claudePid: 22 }]);
  assert.deepStrictEqual(a.windows, [{ rootPid: 10 }]);
});

test('attribute: a host nobody owns (its window closed) is a background session with its own host bucket', () => {
  const p = table([host(20, 999), conhost(21, 20), claude(22, 20), kid(23, 22)]);
  const a = T.attribute(p, opts([20]));
  assert.deepStrictEqual(a.buckets.get('session:20').sort(), [22, 23]);
  assert.deepStrictEqual(a.buckets.get('background:hosts').sort(), [20, 21]);
  assert.deepStrictEqual(a.sessions, [{ hostPid: 20, owner: null, claudePid: 22 }]);
  assert.deepStrictEqual(a.windows, []);
});

test('attribute: two windows each keep their own sessions, and a window launched from a session is its own window', () => {
  // window 10 owns host 20 -> claude 22 -> a probe's window 40 (launched from that session) -> its own host 50.
  const p = table([win(10), host(20, 10), claude(22, 20), kid(30, 22), win(40, 30), host(50, 40), claude(52, 50)]);
  const a = T.attribute(p, opts([20, 50]));
  assert.deepStrictEqual(a.windows.map(w => w.rootPid).sort((x, y) => x - y), [10, 40]);
  assert.deepStrictEqual(a.sessions.find(s => s.hostPid === 50), { hostPid: 50, owner: 40, claudePid: 52 });
  assert.deepStrictEqual(a.sessions.find(s => s.hostPid === 20), { hostPid: 20, owner: 10, claudePid: 22 });
  assert.deepStrictEqual(a.buckets.get('session:20').sort((x, y) => x - y), [22, 30]);
  assert.deepStrictEqual(a.buckets.get('win:40:main'), [40]);
});

test('attribute: an electron.exe that is not claude-custom is not a window; the named own pid always is', () => {
  const other = [60, 1, 'electron.exe', 'C:\\Other\\electron.exe C:\\Other\\app'];
  const p = table([other, [61, 60, 'electron.exe', 'x --type=gpu-process']]);
  assert.deepStrictEqual(T.attribute(p, opts([])).windows, []);
  const withOwn = T.attribute(p, opts([], { ownPids: [60] }));
  assert.deepStrictEqual(withOwn.windows, [{ rootPid: 60 }]);
  assert.deepStrictEqual(withOwn.buckets.get('win:60:renderers'), [61]);
});

test('attribute: an install dir that only starts the same way is not matched (dev vs dev2)', () => {
  const p = table([[70, 1, 'electron.exe', `${EXE} ${INSTALL}2`]]);
  assert.deepStrictEqual(T.attribute(p, opts([])).windows, []);
  const slashes = table([[71, 1, 'electron.exe', `"${EXE}" "${INSTALL.replace(/\\/g, '/')}"`]]);
  assert.deepStrictEqual(T.attribute(slashes, opts([])).windows, [{ rootPid: 71 }]);
});

test('attribute: a claimed host that is not a host process in the table is ignored', () => {
  const p = table([win(10), kid(20, 10)]);
  const a = T.attribute(p, opts([20, 777]));
  assert.deepStrictEqual(a.sessions, []);
  assert.strictEqual(a.buckets.has('session:20'), false);
});

test('attribute: work done by claude-custom itself (a git call, the sampler\'s powershell) counts under the window', () => {
  const p = table([win(10), kid(11, 10, 'git.exe'), kid(12, 10, 'powershell.exe')]);
  assert.deepStrictEqual(T.attribute(p, opts([])).buckets.get('win:10:main').sort(), [10, 11, 12]);
});

// ---- the property the design asks for ----
const NAMES = [['electron.exe', null], ['electron.exe', `${EXE} ${INSTALL}`], ['electron.exe', `${EXE} --type=renderer`],
  ['electron.exe', `${EXE} ${INSTALL}\\host\\host.js`], ['claude.exe', 'claude.exe'], ['conhost.exe', 'conhost.exe --headless'],
  ['node.exe', 'node x'], ['git.exe', 'git status']];

const tableArb = fc.integer({ min: 1, max: 40 }).chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => fc.record({
  pid: fc.constant(i + 1),
  ppid: fc.integer({ min: 0, max: 45 }),         // may name itself, a later pid, a missing one: a corrupt table
  kind: fc.integer({ min: 0, max: NAMES.length - 1 }),
  start: fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }),
}))));

test('property: every pid lands in at most one bucket, and the buckets add up to what was attributed', () => {
  fc.assert(fc.property(tableArb, fc.array(fc.integer({ min: 1, max: 45 }), { maxLength: 6 }), (rows, hostPids) => {
    const procs = rows.map(r => ({ pid: r.pid, ppid: r.ppid, name: NAMES[r.kind][0], cmd: NAMES[r.kind][1], start: r.start === null ? null : String(r.start), priv: 1 }));
    const a = T.attribute(procs, { hosts: hostPids.map(pid => ({ pid })), installDirs: [INSTALL] });
    const seen = new Map();
    let total = 0;
    for (const [id, pids] of a.buckets) {
      for (const pid of pids) {
        assert.ok(!seen.has(pid), `pid ${pid} is in ${seen.get(pid)} and ${id}`);
        seen.set(pid, id);
        total++;
      }
    }
    assert.strictEqual(total, seen.size);
    assert.strictEqual(a.pidBucket.size, total, 'pidBucket is the same attribution, by pid');
    for (const [pid, id] of seen) assert.strictEqual(a.pidBucket.get(pid), id);
    // only pids that are in the table are attributed
    const live = new Set(procs.map(p => p.pid));
    for (const pid of seen.keys()) assert.ok(live.has(pid));
  }));
});
