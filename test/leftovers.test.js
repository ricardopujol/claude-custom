'use strict';
/**
 * host/leftovers.js (BACKLOG #74 item 6): what the Resources panel's "Leftovers" section lists, which rows the app can
 * PROVE are its own, and which of those the 15-minute auto-stop may end. The rule under test: a pid alone proves
 * nothing, so a row is provable only when its start time matches the ledger's AND its launcher's pid is gone; doubt keeps.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const L = require('../host/leftovers');
const tree = require('../host/resource-tree');

const MIN = 60_000;
const MB = 1024 * 1024;
const NOW = 1_800_000_000_000;
// FILETIME for a wall-clock ms (the CIM CreationDate form the sample carries)
const ft = ms => String(BigInt(ms) * 10000n + 116444736000000000n);
const ago = ms => ft(NOW - ms);
const HOST_CMD = 'electron.exe C:\\r\\dev\\host\\host.js';

const proc = (pid, ppid, name, over = {}) => ({ pid, ppid, name, cmd: name, start: ago(60 * MIN), threads: 8, handles: 100, priv: null, ...over });
const entry = (pid, over = {}) => ({
  pid, start: ago(60 * MIN), launcher: { pid: 9000, start: ago(61 * MIN) }, kind: 'probe-window', label: 'probe-x', createdAt: NOW - 30 * MIN, ...over,
});
const find = (procs, ledger = [], extra = {}) => L.find({
  procs, mem: new Map(procs.map(p => [p.pid, 1_000_000])), ledger, attribution: tree.attribute(procs, {}), ownPid: 1, now: NOW, ...extra,
});
// a session: host 20 -> claude 22, old enough that its children can be hours old
const session = () => [
  proc(20, 1, 'electron.exe', { cmd: HOST_CMD, start: ago(400 * MIN) }),
  proc(22, 20, 'claude.exe', { start: ago(300 * MIN) }),
];
const findIn = (procs, ledger = [], extra = {}) => L.find({
  procs, mem: new Map(procs.map(p => [p.pid, 1_000_000])), ledger, attribution: tree.attribute(procs, { hosts: [{ pid: 20 }] }), ownPid: 1, now: NOW, ...extra,
});

// ---- stuck closing -------------------------------------------------------------------------------------

test('stuck closing: an Electron with 1 thread and 0 handles; shown, never provable', () => {
  const procs = [
    proc(10, 1, 'electron.exe', { threads: 1, handles: 0, cmd: null }),
    proc(11, 1, 'electron.exe', { threads: 1, handles: 5 }),
    proc(12, 1, 'electron.exe', { threads: 12, handles: 0 }),
    proc(13, 1, 'electron.exe', { threads: null, handles: null }),
    proc(14, 1, 'node.exe', { threads: 1, handles: 0 }),
  ];
  const r = find(procs);
  assert.deepStrictEqual(r.stuck.map(x => x.pid), [10]);
  assert.strictEqual(r.stuck[0].provable, false);
  assert.strictEqual(r.stuck[0].reapable, false);
  assert.strictEqual(r.stuck[0].ageMs, 60 * MIN);
});

test('F5: a ledgered probe Electron that is itself stuck closing is a stuck row, not a probe that "stops" forever', () => {
  const procs = [proc(100, 1, 'electron.exe', { threads: 1, handles: 0 })];
  const r = find(procs, [entry(100)]);
  assert.deepStrictEqual(r.probes, []);
  assert.deepStrictEqual(r.stuck.map(x => x.pid), [100]);
  assert.deepStrictEqual(L.reapSet(L.createTracker({ now: () => NOW }).stamp(r), { now: NOW + 99 * MIN }), []);
});

// ---- probe windows and the launcher ---------------------------------------------------------------------

test('a probe window is a leftover when the ledger names it, its start matches and its launcher is gone', () => {
  const procs = [proc(100, 1, 'electron.exe'), proc(101, 100, 'electron.exe')];
  const r = find(procs, [entry(100)]);
  assert.deepStrictEqual(r.probes.map(x => x.pid), [100]);
  assert.strictEqual(r.probes[0].provable, true);
  assert.strictEqual(r.probes[0].reapable, true);
  assert.strictEqual(r.probes[0].bytes, 2_000_000, 'the whole tree');
  assert.strictEqual(r.probes[0].what, 'probe-x');
});

test('F1: ANY listed launcher pid keeps the row, whatever its start says (a CIM vs Get-Process offset must never read as "gone")', () => {
  const launcherStart = ago(61 * MIN);
  for (const listed of [launcherStart, String(BigInt(launcherStart) + 1n), String(BigInt(launcherStart) + 36_000_000_000n), ago(2 * MIN), null]) {
    const procs = [proc(100, 1, 'electron.exe'), proc(9000, 1, 'node.exe', { start: listed })];
    assert.deepStrictEqual(find(procs, [entry(100, { launcher: { pid: 9000, start: launcherStart } })]).probes, [], `launcher start ${listed}`);
  }
});

test('doubt keeps: no launcher recorded is alive', () => {
  assert.deepStrictEqual(find([proc(100, 1, 'electron.exe')], [entry(100, { launcher: null })]).probes, []);
});

test('an entry whose pid now belongs to another process (start differs) is not listed at all, nor one whose start is unreadable', () => {
  assert.deepStrictEqual(find([proc(100, 1, 'electron.exe', { start: ago(2 * MIN) })], [entry(100)]).probes, []);
  assert.deepStrictEqual(find([proc(100, 1, 'electron.exe', { start: null })], [entry(100)]).probes, []);
});

test('the root\'s start is compared within a tick (CIM and Get-Process differ by up to 9 ticks, measured)', () => {
  const procs = [proc(100, 1, 'electron.exe', { start: String(BigInt(ago(60 * MIN)) + 9n) })];
  assert.deepStrictEqual(find(procs, [entry(100)]).probes.map(x => x.pid), [100]);
});

test('this app\'s own process, an ancestor of it, or anything holding one of its tab hosts is never listed, even with a ledger entry', () => {
  const procs = [proc(100, 1, 'electron.exe'), proc(101, 100, 'electron.exe'), proc(102, 101, 'node.exe')];
  assert.deepStrictEqual(find(procs, [entry(100)], { ownPid: 101 }).probes, []);
  assert.deepStrictEqual(find(procs, [entry(100)], { ownPid: 100 }).probes, []);
  assert.deepStrictEqual(find(procs, [entry(100)], { protect: [102] }).probes, [], 'F4: a tab host of this window below the root');
  assert.deepStrictEqual(find(procs, [entry(100)], { protect: [555] }).probes.map(x => x.pid), [100]);
});

// ---- shells ------------------------------------------------------------------------------------------------

test('F3: a ledger agent-shell is provable (a Stop button) but is NEVER auto-stopped', () => {
  const procs = [proc(40, 1, 'bash.exe', { start: ago(200 * MIN) })];
  const r = find(procs, [entry(40, { kind: 'agent-shell', label: 'agent task', start: ago(200 * MIN), createdAt: NOW - 300 * MIN })]);
  assert.strictEqual(r.shells[0].provable, true);
  assert.strictEqual(r.shells[0].reapable, false);
  const t = L.createTracker({ now: () => NOW });
  assert.deepStrictEqual(L.reapSet(t.stamp(r), { now: NOW + 600 * MIN }), []);
});

test('a shell under a session older than the floor is only shown; nested shells are part of their ancestor\'s row, however deep', () => {
  const procs = [
    ...session(),
    proc(30, 22, 'bash.exe', { start: ago(90 * MIN) }),
    proc(31, 22, 'bash.exe', { start: ago(5 * MIN) }),
    proc(32, 30, 'bash.exe', { start: ago(89 * MIN) }),
    proc(33, 30, 'make.exe', { start: ago(89 * MIN) }),
    proc(34, 33, 'sh.exe', { start: ago(88 * MIN) }),
  ];
  const r = findIn(procs);
  assert.deepStrictEqual(r.shells.map(x => x.pid), [30], 'F7: not the young one, not 32, not 34 below a make');
  assert.strictEqual(r.shells[0].provable, false);
  assert.strictEqual(r.shells[0].ageMs, 90 * MIN);
  assert.strictEqual(r.shells[0].session, 'session:20');
});

// ---- MCP ------------------------------------------------------------------------------------------------------

test('MCP: the topmost mcp process, however many non-mcp processes sit above its helper; memory is its subtree\'s; never provable', () => {
  const procs = [
    ...session(),
    proc(50, 22, 'node.exe', { cmd: 'node C:\\x\\node_modules\\chrome-devtools-mcp\\build\\index.js' }),
    proc(51, 50, 'cmd.exe', { cmd: 'cmd.exe /c wrapper' }),
    proc(52, 51, 'node.exe', { cmd: 'node C:\\x\\node_modules\\chrome-devtools-mcp\\watchdog.js' }),
    proc(53, 22, 'node.exe', { cmd: 'node server.js' }),
  ];
  const r = findIn(procs, [], { mem: new Map(procs.map(p => [p.pid, 60 * MB])) });
  assert.deepStrictEqual(r.mcp.map(x => x.pid), [50]);
  assert.strictEqual(r.mcp[0].bytes, 180 * MB);
  assert.strictEqual(r.mcp[0].provable, false);
  assert.strictEqual(r.mcp[0].session, 'session:20');
});

test('MCP (the size fallback, C): a server under the threshold, or with no memory figure, is not listed', () => {
  const procs = [...session(), proc(50, 22, 'python.exe', { cmd: 'python -m reaper_mcp.server' }), proc(51, 22, 'node.exe', { cmd: 'node a-mcp.js' })];
  const small = findIn(procs, [], { mem: new Map(procs.map(p => [p.pid, 58 * MB])) });
  assert.deepStrictEqual(small.mcp, []);
  const exact = findIn(procs, [], { mem: new Map([[50, L.MCP_MIN_BYTES]]) });
  assert.deepStrictEqual(exact.mcp.map(x => x.pid), [50]);
  assert.deepStrictEqual(findIn(procs, [], { mem: new Map() }).mcp, []);
});

test('rows say what they are: an MCP server by its package name, a ledger row by its label, a stuck Electron as Electron', () => {
  const procs = [
    ...session(),
    proc(50, 22, 'node.exe', { cmd: 'node C:\\x\\node_modules\\chrome-devtools-mcp\\build\\index.js' }),
    proc(60, 22, 'python.exe', { cmd: 'python -m reaper_mcp.server' }),
    proc(10, 1, 'electron.exe', { threads: 1, handles: 0, cmd: null }),
    proc(100, 1, 'electron.exe'),
  ];
  const r = findIn(procs, [entry(100)], { mem: new Map(procs.map(p => [p.pid, 150 * MB])) });
  assert.deepStrictEqual(r.mcp.map(x => x.what).sort(), ['chrome-devtools-mcp', 'reaper_mcp']);
  assert.strictEqual(r.probes[0].what, 'probe-x');
  assert.strictEqual(r.stuck[0].what, 'Electron');
});

test('memory that was not measured stays null, never 0', () => {
  const procs = [proc(10, 1, 'electron.exe', { threads: 1, handles: 0 })];
  const r = L.find({ procs, mem: new Map(), ledger: [], attribution: tree.attribute(procs, {}), ownPid: 1, now: NOW });
  assert.strictEqual(r.stuck[0].bytes, null);
});

// ---- counting once ---------------------------------------------------------------------------------------------

test('F7: a stuck renderer inside a probe window is flagged nested, and the total counts its memory once', () => {
  const procs = [proc(100, 1, 'electron.exe'), proc(101, 100, 'electron.exe', { threads: 1, handles: 0 }), proc(102, 1, 'electron.exe', { threads: 1, handles: 0 })];
  const r = find(procs, [entry(100)]);
  const rows = Object.values(r).flat();
  assert.deepStrictEqual(rows.filter(x => x.nested).map(x => x.pid), [101]);
  assert.deepStrictEqual(L.totalBytes(rows), { bytes: 3_000_000, complete: true });
});

test('F7: a total over rows with a missing figure says it is not complete; with none measured it is null', () => {
  assert.deepStrictEqual(L.totalBytes([{ bytes: 5 }, { bytes: null }]), { bytes: 5, complete: false });
  assert.deepStrictEqual(L.totalBytes([{ bytes: null }]), { bytes: null, complete: false });
  assert.deepStrictEqual(L.totalBytes([]), { bytes: null, complete: true });
});

test('PROPERTY: no pid is counted in two un-nested rows', () => {
  fc.assert(fc.property(fc.array(fc.record({ pid: fc.integer({ min: 10, max: 30 }), ppid: fc.integer({ min: 9, max: 30 }), stuck: fc.boolean(), led: fc.boolean() }), { maxLength: 16 }), (ps) => {
    const seen = new Set();
    const procs = ps.filter(p => !seen.has(p.pid) && p.pid !== p.ppid && seen.add(p.pid))
      .map(p => proc(p.pid, p.ppid, 'electron.exe', p.stuck ? { threads: 1, handles: 0 } : {}));
    const ledger = ps.filter(p => p.led).map(p => entry(p.pid));
    const rows = Object.values(find(procs, ledger, { ownPid: 999 })).flat();
    const counted = new Set();
    for (const r of rows.filter(x => !x.nested)) {
      for (const d of tree.descendants(procs, r.pid)) {
        assert.ok(!counted.has(d.pid), `pid ${d.pid} counted twice`);
        counted.add(d.pid);
      }
    }
  }), { numRuns: 200 });
});

// ---- the tracker (E, S2) -----------------------------------------------------------------------------------------

test('E: the 15 minutes start when the launcher is first seen gone, not at the window\'s creation', () => {
  let t = NOW;
  const tracker = L.createTracker({ now: () => t });
  const procs = [proc(100, 1, 'electron.exe')];
  const ledger = [entry(100, { createdAt: NOW - 3 * 60 * MIN })];     // created three hours ago
  let r = tracker.stamp(find(procs, ledger));
  assert.deepStrictEqual(L.reapSet(r, { now: t }), [], 'old window, but the launcher only just went');
  t = NOW + 14 * MIN;
  r = tracker.stamp(find(procs, ledger));
  assert.deepStrictEqual(L.reapSet(r, { now: t }), []);
  assert.strictEqual(L.present(r, [], { now: t }).probes[0].reapInMs, MIN);
  t = NOW + 15 * MIN;
  r = tracker.stamp(find(procs, ledger));
  assert.deepStrictEqual(L.reapSet(r, { now: t }).map(x => x.pid), [100]);
  assert.strictEqual(L.present(r, [], { now: t }).probes[0].reapInMs, 0);
});

test('E: a row that leaves the table and comes back starts its 15 minutes again; an unstamped row never qualifies', () => {
  let t = NOW;
  const tracker = L.createTracker({ now: () => t });
  const procs = [proc(100, 1, 'electron.exe')];
  tracker.stamp(find(procs, [entry(100)]));
  t = NOW + 10 * MIN;
  tracker.stamp(find([], [entry(100)]));
  t = NOW + 20 * MIN;
  const r = tracker.stamp(find(procs, [entry(100)]));
  assert.deepStrictEqual(L.reapSet(r, { now: t }), []);
  assert.deepStrictEqual(L.reapSet(find(procs, [entry(100)]), { now: NOW + 999 * MIN }), [], 'never stamped');
});

test('S2: a stuck Electron needs two samples in a row before it is shown, and one that vanishes starts over', () => {
  const tracker = L.createTracker({ now: () => NOW });
  const procs = [proc(10, 1, 'electron.exe', { threads: 1, handles: 0 })];
  assert.deepStrictEqual(tracker.stamp(find(procs)).stuck, []);
  assert.deepStrictEqual(tracker.stamp(find(procs)).stuck.map(x => x.pid), [10]);
  tracker.stamp(find([]));
  assert.deepStrictEqual(tracker.stamp(find(procs)).stuck, []);
  assert.strictEqual(L.STUCK_MIN_SAMPLES, 2);
});

// ---- the auto-stop set ------------------------------------------------------------------------------------------

test('reapSet: probe windows past 15 minutes since the launcher was first seen gone (the boundary is in)', () => {
  let t = NOW;
  const tracker = L.createTracker({ now: () => t });
  const procs = [100, 101].map(pid => proc(pid, 1, 'electron.exe'));
  tracker.stamp(find([procs[0]], [entry(100)]));
  t = NOW + MIN;
  const r = tracker.stamp(find(procs, [entry(100), entry(101)]));
  assert.deepStrictEqual(L.reapSet(r, { now: NOW + 15 * MIN }).map(x => x.pid), [100]);
  assert.deepStrictEqual(L.reapSet(r, { now: NOW + 15 * MIN - 1 }), []);
  assert.strictEqual(L.REAP_AFTER_MS, 15 * MIN);
});

test('reapSet never returns a row that is not reapable (stuck, MCP, any shell)', () => {
  const procs = [...session(), proc(10, 1, 'electron.exe', { threads: 1, handles: 0, start: ago(300 * MIN) }), proc(30, 22, 'bash.exe', { start: ago(200 * MIN) })];
  const found = L.createTracker({ now: () => NOW }).stamp(findIn(procs));
  assert.deepStrictEqual(L.reapSet(found, { now: NOW + 600 * MIN }), []);
});

test('reapSet rows carry the exact (pid, start) of the LEDGER entry, which the kill re-proves on a held handle', () => {
  const e = entry(100, { start: ago(60 * MIN) });
  const r = L.createTracker({ now: () => NOW }).stamp(find([proc(100, 1, 'electron.exe')], [e]));
  const [row] = L.reapSet(r, { now: NOW + 15 * MIN });
  assert.strictEqual(row.start, e.start);
  assert.strictEqual(row.entry.pid, 100);
});

test('PROPERTY: the auto-stop set never holds a row whose start does not match its proof, whose launcher pid is listed, or that is not a probe window', () => {
  const startArb = fc.integer({ min: 0, max: 3 });
  const startOf = i => ft(NOW - (100 + i) * MIN);
  const procArb = fc.record({ pid: fc.integer({ min: 100, max: 112 }), s: fc.option(startArb, { nil: null }), stuck: fc.boolean() });
  const entryArb = fc.record({
    pid: fc.integer({ min: 100, max: 112 }), s: startArb, shell: fc.boolean(),
    launcher: fc.option(fc.record({ pid: fc.integer({ min: 100, max: 112 }), s: fc.option(startArb, { nil: null }) }), { nil: null }),
  });
  fc.assert(fc.property(fc.array(procArb, { maxLength: 14 }), fc.array(entryArb, { maxLength: 8 }), fc.integer({ min: 100, max: 112 }), (ps, es, own) => {
    const seen = new Set();
    const procs = ps.filter(p => !seen.has(p.pid) && seen.add(p.pid))
      .map(p => proc(p.pid, 1, 'electron.exe', { start: p.s === null ? null : startOf(p.s), ...(p.stuck ? { threads: 1, handles: 0 } : {}) }));
    const ledger = es.map(e => entry(e.pid, {
      start: startOf(e.s), kind: e.shell ? 'agent-shell' : 'probe-window',
      launcher: e.launcher ? { pid: e.launcher.pid, start: e.launcher.s === null ? null : startOf(e.launcher.s) } : null,
    }));
    const found = L.createTracker({ now: () => NOW }).stamp(find(procs, ledger, { ownPid: own }));
    for (const row of L.reapSet(found, { now: NOW + 15 * MIN })) {
      const live = procs.find(p => p.pid === row.pid);
      assert.ok(live, 'the process is in the table');
      assert.ok(tree.sameStart(live.start, row.entry.start), 'start matches the ledger');
      assert.notStrictEqual(row.pid, own);
      assert.strictEqual(row.entry.kind, 'probe-window');
      assert.ok(!(live.threads === 1 && live.handles === 0), 'not a stuck exit');
      assert.ok(row.entry.launcher && !procs.some(p => p.pid === row.entry.launcher.pid), 'the launcher pid is not in the table at all');
    }
  }), { numRuns: 300 });
});

// ---- what the panel gets -----------------------------------------------------------------------------------

const row = (pid, over = {}) => ({ kind: 'probe-window', pid, start: ago(60 * MIN), name: 'electron.exe', what: 'probe-x', label: 'probe-x', bytes: 5_000_000, entry: entry(pid), provable: true, reapable: true, goneSince: NOW - 20 * MIN, ...over });

test('present: the entry and the clock never travel, an auto-stop row says when it goes, the others say null', () => {
  const found = {
    stuck: [{ kind: 'stuck', pid: 10, start: '5', name: 'electron.exe', what: 'Electron', label: '', bytes: 9, ageMs: 7, provable: false, reapable: false }],
    probes: [row(100, { goneSince: NOW - 10 * MIN, entry: entry(100, { launcher: { pid: 1, start: 'secret' } }) })],
    shells: [row(40, { kind: 'agent-shell', reapable: false })], mcp: [],
  };
  const p = L.present(found, [{ kind: 'probe-window', pid: 7, name: 'electron.exe', label: 'old', bytes: 3, at: NOW - MIN }], { now: NOW });
  assert.strictEqual(p.probes[0].reapInMs, 5 * MIN);
  assert.strictEqual(p.stuck[0].reapInMs, null);
  assert.strictEqual(p.shells[0].reapInMs, null, 'an agent shell is never auto-stopped');
  assert.strictEqual(p.shells[0].provable, true);
  assert.ok(!('entry' in p.probes[0]) && !('goneSince' in p.probes[0]));
  assert.ok(!JSON.stringify(p).includes('secret'));
  assert.deepStrictEqual(p.stopped.map(s => [s.pid, s.label]), [[7, 'old']]);
  assert.strictEqual(p.reapAfterMs, 15 * MIN);
  assert.strictEqual(L.present({ stuck: [], probes: [], shells: [], mcp: [] }, [], { now: NOW }), null, 'nothing to say is null, so the section is not drawn');
});

test('present: a row past its 15 minutes reads 0 (stopping on the next sample), never negative', () => {
  const found = { stuck: [], shells: [], mcp: [], probes: [row(100, { goneSince: NOW - 60 * MIN })] };
  assert.strictEqual(L.present(found, [], { now: NOW }).probes[0].reapInMs, 0);
});

// ---- the stopper ------------------------------------------------------------------------------------------------

const found1 = (...rows) => ({ stuck: [], mcp: [], shells: [], probes: rows });
const rig = (over = {}) => {
  const calls = { kill: [], removed: [], logs: [] };
  let t = NOW;
  const reaper = L.createReaper({
    kill: (pid, start) => { calls.kill.push([pid, start]); return 'killed'; },
    launcherGone: async () => true,
    isRunning: async () => false,
    removeEntries: (es) => { calls.removed.push(...es.map(e => e.pid)); return { ok: true }; },
    now: () => t, log: (...a) => calls.logs.push(a.join(' ')),
    ...over,
  });
  return { reaper, calls, advance: (ms) => { t += ms; } };
};

test('stopper: kills each proven row once through the injected kill, tombstones what ended, remembers it as stopped', async () => {
  const { reaper, calls } = rig();
  const young = row(101, { goneSince: NOW - 5 * MIN });
  const found = found1(row(100), young);
  const out = await reaper.run(found);
  assert.deepStrictEqual(calls.kill, [[100, row(100).start]]);
  assert.deepStrictEqual(calls.removed, [100]);
  assert.deepStrictEqual(out.map(s => s.pid), [100]);
  assert.deepStrictEqual(reaper.stopped().map(s => [s.pid, s.status, s.bytes, s.by]), [[100, 'killed', 5_000_000, 'auto']]);
  await reaper.run(found);
  assert.strictEqual(calls.kill.length, 1, 'the same (pid, start) is never killed twice');
});

test('F2: a kill never runs inside the caller\'s own turn, and each kill waits a macrotask', async () => {
  let inTurn = true;
  const order = [];
  const { reaper } = rig({ kill: (pid) => { order.push(inTurn ? `kill ${pid} IN TURN` : `kill ${pid}`); return 'killed'; } });
  const p = reaper.run(found1(row(100), row(101)));
  assert.deepStrictEqual(order, [], 'nothing ran synchronously');
  await Promise.resolve(); await Promise.resolve();
  assert.deepStrictEqual(order, [], 'nor in the microtasks that follow');
  inTurn = false;
  setImmediate(() => order.push('other macrotask'));
  await p;
  assert.deepStrictEqual(order, ['kill 100', 'other macrotask', 'kill 101'], 'the event loop turned between the two kills');
});

test('stopper: the launcher is re-proved right before the kill, and anything but a proof keeps the row', async () => {
  for (const verdict of [false, null, undefined, 'yes']) {
    const { reaper, calls } = rig({ launcherGone: async () => verdict });
    await reaper.run(found1(row(100)));
    assert.deepStrictEqual(calls.kill, [], `verdict ${verdict}`);
    assert.deepStrictEqual(calls.removed, []);
  }
  const { reaper, calls } = rig({ launcherGone: async () => { throw new Error('ps failed'); } });
  await reaper.run(found1(row(100)));
  assert.deepStrictEqual(calls.kill, []);
  assert.ok(calls.logs.some(l => /ps failed/.test(l)));
});

test('stopper: without a launcherGone seam nothing is ever killed (the default is the safe one)', async () => {
  const kills = [];
  const reaper = L.createReaper({ kill: (pid) => { kills.push(pid); return 'killed'; }, now: () => NOW });
  await reaper.run(found1(row(100)));
  assert.deepStrictEqual(kills, []);
});

test('F6: a "gone" from the kill is tombstoned only if the process is confirmed not running; mismatch is tombstoned; failed and unknown are kept', async () => {
  const outcomes = { 1: 'gone', 2: 'mismatch', 3: 'unknown', 4: 'failed', 5: 'gone', 6: 'gone' };
  const running = { 1: false, 5: true, 6: null };
  const { reaper, calls } = rig({ kill: pid => outcomes[pid], isRunning: async pid => running[pid] });
  await reaper.run(found1(...[1, 2, 3, 4, 5, 6].map(pid => row(pid))));
  assert.deepStrictEqual(calls.removed.sort(), [1, 2]);
  assert.deepStrictEqual(reaper.stopped().map(s => s.pid), [], 'only a real kill is listed as stopped');
});

test('stopper: failed rows are not retried inside the retry window, then are', async () => {
  let calls = 0;
  const { reaper, advance } = rig({ kill: () => { calls++; return 'failed'; }, retryAfterMs: 5 * MIN });
  const found = found1(row(9));
  await reaper.run(found);
  advance(4 * MIN); await reaper.run(found);
  assert.strictEqual(calls, 1);
  advance(2 * MIN); await reaper.run(found);
  assert.strictEqual(calls, 2);
});

test('stopper: a kill that throws is logged, does not stop the next row, and a run in flight is not doubled', async () => {
  const killed = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const { reaper, calls } = rig({ kill: async (pid) => { if (pid === 1) throw new Error('boom'); await gate; killed.push(pid); return 'killed'; } });
  const found = found1(row(1), row(2));
  const first = reaper.run(found);
  const second = await reaper.run(found);
  assert.deepStrictEqual(second, [], 'overlapping run does nothing');
  release();
  await first;
  assert.deepStrictEqual(killed, [2]);
  assert.ok(calls.logs.some(l => /boom/.test(l)));
});

test('stopper: stopped entries are kept for an hour at most and ten at most', async () => {
  const { reaper, advance } = rig();
  for (let i = 0; i < 12; i++) await reaper.run(found1(row(200 + i)));
  assert.strictEqual(reaper.stopped().length, 10);
  advance(61 * MIN);
  assert.strictEqual(reaper.stopped().length, 0);
});

test('S4: the retry memory forgets rows that are no longer in the table', async () => {
  const kills = [];
  const { reaper, advance } = rig({ kill: (pid) => { kills.push(pid); return 'failed'; }, retryAfterMs: 5 * MIN });
  await reaper.run(found1(row(9)));
  await reaper.run(found1());
  advance(MIN);
  await reaper.run(found1(row(9)));
  assert.deepStrictEqual(kills, [9, 9], 'a row that vanished and came back is a new one');
});

test('B: a manual stop kills provable rows now (no 15 minutes), says it was by the person, and never touches an unprovable row', async () => {
  const { reaper, calls } = rig();
  const shell = row(40, { kind: 'agent-shell', reapable: false, goneSince: NOW });
  const res = await reaper.stop([shell, row(101, { goneSince: NOW }), { ...row(50), provable: false }]);
  assert.deepStrictEqual(calls.kill.map(k => k[0]), [40, 101]);
  assert.deepStrictEqual(reaper.stopped().map(s => [s.pid, s.by]), [[40, 'you'], [101, 'you']]);
  assert.deepStrictEqual(res.results.map(r => [r.pid, r.stopped]), [[40, true], [101, true]]);
  assert.deepStrictEqual(calls.removed, [40, 101]);
});

test('B: a manual stop waits for an automatic run in flight instead of racing it', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const order = [];
  const { reaper } = rig({ kill: async (pid) => { order.push(`start ${pid}`); if (pid === 1) await gate; order.push(`end ${pid}`); return 'killed'; } });
  const auto = reaper.run(found1(row(1)));
  const manual = reaper.stop([row(2)]);
  await new Promise(r => setTimeout(r, 20));
  assert.deepStrictEqual(order, ['start 1']);
  release();
  await Promise.all([auto, manual]);
  assert.deepStrictEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
});

test('S2: a sample taken off the cadence (advance: false) does not count as one more stuck sample', () => {
  const tracker = L.createTracker({ now: () => NOW });
  const procs = [proc(10, 1, 'electron.exe', { threads: 1, handles: 0 })];
  tracker.stamp(find(procs));
  assert.deepStrictEqual(tracker.stamp(find(procs), { advance: false }).stuck, []);
  assert.deepStrictEqual(tracker.stamp(find(procs)).stuck.map(x => x.pid), [10]);
});

// PR release S9-1 (Dexter): hasAncestorIn handed a malformed start to BigInt, which throws -- `find` must never throw.
test('find: a malformed start string on a process that HAS a parent does not throw', () => {
  const procs = [proc(1, 0, 'services.exe', { start: ago(60 * MIN) }), proc(2, 1, 'bash.exe', { start: 'abc' })];
  const attribution = { pidBucket: new Map([[2, 'session:9']]) };
  assert.doesNotThrow(() => L.find({ procs, mem: new Map(), ledger: [], attribution, ownPid: 99, now: NOW }));
  // The outcome, not just "no throw" (Miguel S1): a process whose start cannot be read gets NO row -- never a confident one.
  assert.deepStrictEqual(L.find({ procs, mem: new Map(), ledger: [], attribution, ownPid: 99, now: NOW }), { stuck: [], probes: [], shells: [], mcp: [] });
});
