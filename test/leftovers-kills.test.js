'use strict';
/**
 * Kill tests for the release-gate survivors S9 and S17 in host/leftovers.js (Mortimer, 2026-10-09): "unknown" must never be read as a
 * number, a bad process table must not hang or throw, and the rows the app cannot prove must never be offered as stoppable.
 */
const test = require('node:test');
const assert = require('node:assert');

const L = require('../host/leftovers');

const MIN = 60_000;
const MB = 1024 * 1024;
const NOW = 1_800_000_000_000;
const ft = ms => String(BigInt(ms) * 10000n + 116444736000000000n);
const ago = ms => ft(NOW - ms);

const proc = (pid, ppid, name, over = {}) => ({ pid, ppid, name, cmd: name, start: ago(120 * MIN), threads: 8, handles: 100, priv: null, ...over });
const bucketOf = (...pids) => ({ pidBucket: new Map(pids.map(p => [p, 'session:20'])) });
const find = (procs, { mem = new Map(), attribution = null, ledger = [], ...extra } = {}) => L.find({ procs, mem, ledger, attribution, ownPid: 1, now: NOW, ...extra });

test('S9: ftToMs reads only an all-digit FILETIME; anything else is null and never throws', () => {
  assert.strictEqual(L.ftToMs('116444736000000000'), 0);
  assert.strictEqual(L.ftToMs(ft(NOW)), NOW);
  for (const bad of ['abc', '12x', 'x12', '', ' 12', '1.5', '-5', null, undefined, 12345, {}]) assert.strictEqual(L.ftToMs(bad), null, JSON.stringify(bad));
});

test('S9: a process whose start cannot be read has an age of null, not of "now"; a stuck row reads the same way', () => {
  for (const start of [null, undefined, 'abc', '', 5]) {
    const r = find([proc(10, 1, 'electron.exe', { threads: 1, handles: 0, start })]);
    assert.strictEqual(r.stuck.length, 1);
    assert.strictEqual(r.stuck[0].ageMs, null, `start ${JSON.stringify(start)}`);
  }
  assert.strictEqual(find([proc(10, 1, 'electron.exe', { threads: 1, handles: 0, start: ago(7 * MIN) })]).stuck[0].ageMs, 7 * MIN);
  assert.strictEqual(find([proc(10, 1, 'electron.exe', { threads: 1, handles: 0, start: ft(NOW + 5 * MIN) })]).stuck[0].ageMs, 0, 'a start in the future is 0, not negative');
});

test('S9: a shell with an unreadable start is not shown (its age is unknown, so it is not "old")', () => {
  const procs = [proc(30, 22, 'bash.exe', { start: null }), proc(31, 22, 'bash.exe', { start: 'abc' })];
  assert.deepStrictEqual(find(procs, { attribution: bucketOf(30, 31) }).shells, []);
});

test('S9: the shell floor is 60 minutes by default: 59 min is hidden, exactly 60 is shown', () => {
  const at = (min) => find([proc(30, 22, 'bash.exe', { start: ago(min * MIN) })], { attribution: bucketOf(30) }).shells.map(s => s.pid);
  assert.deepStrictEqual(at(59), []);
  assert.deepStrictEqual(at(60), [30]);
  assert.deepStrictEqual(at(61), [30]);
  assert.deepStrictEqual(find([proc(30, 22, 'bash.exe', { start: ago(10 * MIN) })], { attribution: bucketOf(30), shellShownAfterMs: 5 * MIN }).shells.map(s => s.pid), [30], 'the floor is a seam');
  assert.strictEqual(L.SHELL_SHOWN_AFTER_MS, 3_600_000);
});

test('S9: a subtree with no memory figure reports bytes null, not 0; a real 0 is 0; NaN and Infinity are not figures', () => {
  const entry = (pid) => ({ pid, start: ago(60 * MIN), launcher: { pid: 9000, start: ago(61 * MIN) }, kind: 'probe-window', label: 'p', createdAt: NOW - 30 * MIN });
  const probe = (mem) => find([proc(100, 1, 'electron.exe', { start: ago(60 * MIN) }), proc(101, 100, 'electron.exe', { start: ago(30 * MIN) })], { mem, ledger: [entry(100)] }).probes[0].bytes;
  assert.strictEqual(probe(new Map()), null);
  assert.strictEqual(probe(new Map([[100, 0]])), 0);
  assert.strictEqual(probe(new Map([[100, 5], [101, 7]])), 12);
  assert.strictEqual(probe(new Map([[100, NaN], [101, Infinity]])), null);
  assert.strictEqual(probe(new Map([[100, '5']])), null, 'a string is not a figure');
  assert.strictEqual(probe(new Map([[100, null]])), null);
  const stuck = (mem) => find([proc(10, 1, 'electron.exe', { threads: 1, handles: 0 })], { mem }).stuck[0].bytes;
  assert.strictEqual(stuck(new Map()), null);
  assert.strictEqual(stuck(new Map([[10, 0]])), 0);
  assert.strictEqual(stuck(new Map([[10, 9]])), 9);
});

test('S9: a parent-pid cycle above a shell does not hang the readout', () => {
  // shell 30 sits under cmd 40, which sits under cmd 41, which names 40 as its parent: a table made of stale parent pids
  const procs = [proc(30, 40, 'bash.exe'), proc(40, 41, 'cmd.exe'), proc(41, 40, 'cmd.exe')];
  const r = find(procs, { attribution: bucketOf(30) });
  assert.deepStrictEqual(r.shells.map(s => s.pid), [30]);
  const mcp = [proc(30, 40, 'node.exe', { cmd: 'node server-mcp.js' }), proc(40, 41, 'cmd.exe'), proc(41, 40, 'cmd.exe')];
  assert.deepStrictEqual(find(mcp, { attribution: bucketOf(30), mem: new Map([[30, 150 * MB]]) }).mcp.map(s => s.pid), [30]);
});

test('S9: a parent that started AFTER its child is not its ancestor (a reused pid), so the child still gets its own row', () => {
  const procs = [proc(30, 31, 'bash.exe', { start: ago(90 * MIN) }), proc(31, 1, 'bash.exe', { start: ago(10 * MIN) })];
  assert.deepStrictEqual(find(procs, { attribution: bucketOf(30, 31) }).shells.map(s => s.pid), [30]);
  const nested = [proc(30, 31, 'bash.exe', { start: ago(90 * MIN) }), proc(31, 1, 'bash.exe', { start: ago(95 * MIN) })];
  assert.deepStrictEqual(find(nested, { attribution: bucketOf(30, 31) }).shells.map(s => s.pid), [31], 'a real older parent swallows the child');
});

test('S9: a row nothing can prove is never provable or reapable: stuck, MCP and session shells', () => {
  const procs = [
    proc(10, 1, 'electron.exe', { threads: 1, handles: 0 }),
    proc(30, 22, 'bash.exe', { start: ago(120 * MIN) }),
    proc(50, 22, 'node.exe', { cmd: 'node x-mcp.js' }),
  ];
  const r = find(procs, { attribution: bucketOf(30, 50), mem: new Map([[50, 200 * MB]]) });
  const rows = [...r.stuck, ...r.shells, ...r.mcp];
  assert.deepStrictEqual(rows.map(x => x.kind).sort(), ['mcp', 'shell', 'stuck']);
  for (const x of rows) { assert.strictEqual(x.provable, false, x.kind); assert.strictEqual(x.reapable, false, x.kind); }
  assert.deepStrictEqual(L.reapSet({ probes: rows }, { now: NOW + 600 * MIN }), []);
});

test('S17: rows come out biggest first, equal sizes by pid, rows with no figure last', () => {
  const procs = [10, 11, 12, 13, 14].map(pid => proc(pid, 1, 'electron.exe', { threads: 1, handles: 0 }));
  const r = find(procs, { mem: new Map([[10, 5], [11, 9], [12, 9], [13, 7]]) });
  assert.deepStrictEqual(r.stuck.map(x => [x.pid, x.bytes]), [[11, 9], [12, 9], [13, 7], [10, 5], [14, null]]);
});

test('S17: a process is listed once, whichever way it qualifies', () => {
  // a ledger agent-shell that is also an old session shell: one row, the provable one
  const e = { pid: 30, start: ago(120 * MIN), launcher: { pid: 9000, start: ago(121 * MIN) }, kind: 'agent-shell', label: 'agent task', createdAt: NOW - 100 * MIN };
  const a = find([proc(30, 22, 'bash.exe')], { attribution: bucketOf(30), ledger: [e] });
  assert.deepStrictEqual(a.shells.map(s => [s.pid, s.provable]), [[30, true]]);
  // a stuck Electron whose command line names an MCP server and which sits in a session: stuck only
  const b = find([proc(10, 22, 'electron.exe', { threads: 1, handles: 0, cmd: 'electron x-mcp.js' })], { attribution: bucketOf(10), mem: new Map([[10, 200 * MB]]) });
  assert.deepStrictEqual([b.stuck.length, b.mcp.length, b.shells.length], [1, 0, 0]);
  // an MCP server that is also a shell image is an MCP row only
  const c = find([proc(50, 22, 'bash.exe', { cmd: 'bash x-mcp.sh' })], { attribution: bucketOf(50), mem: new Map([[50, 200 * MB]]) });
  assert.deepStrictEqual([c.mcp.length, c.shells.length], [1, 0]);
  // a ledger probe that is also an old shell in a session: one row, not two
  const d = find([proc(30, 22, 'bash.exe')], { attribution: bucketOf(30), ledger: [{ ...e, kind: 'probe-window' }] });
  assert.deepStrictEqual([d.probes.length, d.shells.length], [1, 0]);
});

test('S17: only a session bucket attributes a shell or an MCP server to a session', () => {
  const procs = [proc(30, 22, 'bash.exe'), proc(50, 22, 'node.exe', { cmd: 'node x-mcp.js' })];
  const mem = new Map([[50, 200 * MB]]);
  for (const id of ['host:20', 'other', 'app', 'xsession:20', '']) {
    const r = find(procs, { attribution: { pidBucket: new Map([[30, id], [50, id]]) }, mem });
    assert.deepStrictEqual([r.shells.length, r.mcp.length], [0, 0], JSON.stringify(id));
  }
  assert.deepStrictEqual([find(procs, { attribution: null, mem }).shells.length, find(procs, { attribution: {}, mem }).mcp.length], [0, 0]);
  const yes = find(procs, { attribution: bucketOf(30, 50), mem });
  assert.deepStrictEqual([yes.shells.length, yes.mcp.length], [1, 1]);
});

test('S17: which command lines count as an MCP server', () => {
  const listed = (cmd) => find([proc(50, 22, 'node.exe', { cmd })], { attribution: bucketOf(50), mem: new Map([[50, 200 * MB]]) }).mcp.length;
  for (const cmd of ['node mcp', 'mcp', 'node mcp.js', 'node @org/mcp-server', 'python -m reaper_mcp', 'node x\\mcp\\index.js', 'node "mcp"', 'node ModelContextProtocol', 'node @modelcontextprotocol/server']) {
    assert.strictEqual(listed(cmd), 1, cmd);
  }
  for (const cmd of ['node mcpfoo.js', 'node amcp', 'node xmcp.js', 'node server.js', '', null]) assert.strictEqual(listed(cmd), 0, String(cmd));
});

// ---- the stopper's defaults ---------------------------------------------------------------------------------------------------------

const entry = (pid) => ({ pid, start: ago(60 * MIN), launcher: { pid: 9000, start: ago(61 * MIN) }, kind: 'probe-window', label: 'probe-x', createdAt: NOW - 30 * MIN });
const row = (pid, over = {}) => ({ kind: 'probe-window', pid, start: ago(60 * MIN), name: 'electron.exe', what: 'probe-x', label: 'probe-x', bytes: 5, entry: entry(pid), provable: true, reapable: true, goneSince: NOW - 20 * MIN, ...over });
const found1 = (...rows) => ({ stuck: [], mcp: [], shells: [], probes: rows });
function rig(over = {}) {
  const calls = { kill: [] };
  let t = NOW;
  const reaper = L.createReaper({ kill: (pid) => { calls.kill.push(pid); return 'failed'; }, launcherGone: async () => true, isRunning: async () => false, now: () => t, ...over });
  return { reaper, calls, advance: (ms) => { t += ms; } };
}

test('S9: with the default retry window a failed row is not killed again inside 5 minutes, and is at 5', async () => {
  const { reaper, calls, advance } = rig();
  const found = found1(row(9));
  await reaper.run(found);
  advance(5 * MIN - 1); await reaper.run(found);
  assert.strictEqual(calls.kill.length, 1);
  advance(1); await reaper.run(found);
  assert.strictEqual(calls.kill.length, 2);
});

test('S17: a stopped entry is forgotten after exactly an hour', async () => {
  const { reaper, advance } = rig({ kill: () => 'killed' });
  await reaper.run(found1(row(9)));
  assert.strictEqual(reaper.stopped().length, 1);
  advance(60 * MIN - 1);
  assert.strictEqual(reaper.stopped().length, 1);
  advance(1);
  assert.strictEqual(reaper.stopped().length, 0);
});
