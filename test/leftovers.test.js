'use strict';
/**
 * host/leftovers.js (BACKLOG #74 item 6): what the Resources panel's "Leftovers" section lists, which rows the app can
 * PROVE are its own, and which of those the 15-minute auto-reap may stop. The rule under test: a pid alone proves
 * nothing, so a row is stoppable only when its start time matches the ledger's AND its launcher is gone; doubt keeps.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const L = require('../host/leftovers');
const tree = require('../host/resource-tree');

const MIN = 60_000;
const NOW = 1_800_000_000_000;
// FILETIME for a wall-clock ms (the CIM CreationDate form the sample carries)
const ft = ms => String(BigInt(ms) * 10000n + 116444736000000000n);
const ago = ms => ft(NOW - ms);

const proc = (pid, ppid, name, over = {}) => ({ pid, ppid, name, cmd: name, start: ago(60 * MIN), threads: 8, handles: 100, priv: null, ...over });
const entry = (pid, over = {}) => ({
  pid, start: ago(60 * MIN), launcher: { pid: 9000, start: ago(61 * MIN) }, kind: 'probe-window', label: 'probe-x', createdAt: NOW - 30 * MIN, ...over,
});
const find = (procs, ledger = [], extra = {}) => L.find({
  procs, mem: new Map(procs.map(p => [p.pid, 1_000_000])), ledger, attribution: tree.attribute(procs, {}), ownPid: 1, now: NOW, ...extra,
});

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
  assert.strictEqual(r.stuck[0].reapable, false);
  assert.strictEqual(r.stuck[0].ageMs, 60 * MIN);
});

test('a probe window is a leftover when the ledger names it, its start matches and its launcher is gone', () => {
  const procs = [proc(100, 1, 'electron.exe'), proc(101, 100, 'electron.exe')];
  const r = find(procs, [entry(100)]);
  assert.deepStrictEqual(r.probes.map(x => x.pid), [100]);
  assert.strictEqual(r.probes[0].reapable, true);
  assert.strictEqual(r.probes[0].bytes, 2_000_000, 'the whole tree');
  assert.strictEqual(r.probes[0].label, 'probe-x');
});

test('a probe whose launcher is still running is in use, not a leftover', () => {
  const procs = [proc(100, 9000, 'electron.exe'), proc(9000, 1, 'node.exe', { start: ago(61 * MIN) })];
  assert.deepStrictEqual(find(procs, [entry(100)]).probes, []);
});

test('the launcher\'s start is compared within a tick: CIM and Get-Process differ by one (resource-tree sameStart)', () => {
  const launcherStart = ago(61 * MIN);
  const oneTickOff = String(BigInt(launcherStart) + 1n);
  const procs = [proc(100, 9000, 'electron.exe'), proc(9000, 1, 'node.exe', { start: oneTickOff })];
  assert.deepStrictEqual(find(procs, [entry(100, { launcher: { pid: 9000, start: launcherStart } })]).probes, []);
});

test('a launcher pid that another process now holds means the launcher is gone', () => {
  const procs = [proc(100, 1, 'electron.exe'), proc(9000, 1, 'node.exe', { start: ago(2 * MIN) })];
  assert.deepStrictEqual(find(procs, [entry(100)]).probes.map(x => x.pid), [100]);
});

test('doubt keeps: no launcher recorded, or a launcher whose start was unreadable and whose pid is listed, is alive', () => {
  const procs = [proc(100, 1, 'electron.exe'), proc(9000, 1, 'node.exe')];
  assert.deepStrictEqual(find(procs, [entry(100, { launcher: null })]).probes, []);
  assert.deepStrictEqual(find(procs, [entry(100, { launcher: { pid: 9000, start: null } })]).probes, []);
});

test('an entry whose pid now belongs to another process (start differs) is not listed at all', () => {
  const procs = [proc(100, 1, 'electron.exe', { start: ago(2 * MIN) })];
  assert.deepStrictEqual(find(procs, [entry(100)]).probes, []);
});

test('a running process whose start the table could not read is not provable, so it is not listed', () => {
  const procs = [proc(100, 1, 'electron.exe', { start: null })];
  assert.deepStrictEqual(find(procs, [entry(100)]).probes, []);
});

test('this app\'s own process, or an ancestor of it, is never listed even with a ledger entry', () => {
  const procs = [proc(100, 1, 'electron.exe'), proc(101, 100, 'electron.exe')];
  assert.deepStrictEqual(find(procs, [entry(100)], { ownPid: 101 }).probes, []);
  assert.deepStrictEqual(find(procs, [entry(100)], { ownPid: 100 }).probes, []);
});

test('agent shells: a ledger shell is proven; a shell under a session older than the floor is only shown', () => {
  const procs = [
    proc(20, 1, 'electron.exe', { cmd: 'electron.exe C:\\r\\dev\\host\\host.js', start: ago(400 * MIN) }),
    proc(22, 20, 'claude.exe', { start: ago(300 * MIN) }),
    proc(30, 22, 'bash.exe', { start: ago(90 * MIN) }),
    proc(31, 22, 'bash.exe', { start: ago(5 * MIN) }),
    proc(32, 30, 'bash.exe', { start: ago(89 * MIN) }),
    proc(40, 1, 'bash.exe', { start: ago(200 * MIN) }),
  ];
  const att = tree.attribute(procs, { hosts: [{ pid: 20 }] });
  const r = L.find({ procs, mem: new Map(), ledger: [entry(40, { kind: 'agent-shell', label: 'agent task', start: ago(200 * MIN) })], attribution: att, ownPid: 1, now: NOW });
  const byPid = new Map(r.shells.map(x => [x.pid, x]));
  assert.deepStrictEqual([...byPid.keys()].sort((a, b) => a - b), [30, 40], 'old top-level shell + the ledger shell; no young one, no nested one');
  assert.strictEqual(byPid.get(40).reapable, true);
  assert.strictEqual(byPid.get(30).reapable, false);
  assert.strictEqual(byPid.get(30).ageMs, 90 * MIN);
});

test('MCP servers: the topmost mcp process under a session, with its subtree\'s memory, never reapable', () => {
  const procs = [
    proc(20, 1, 'electron.exe', { cmd: 'electron.exe C:\\r\\dev\\host\\host.js' }),
    proc(22, 20, 'claude.exe'),
    proc(50, 22, 'node.exe', { cmd: 'node C:\\x\\node_modules\\chrome-devtools-mcp\\build\\index.js' }),
    proc(51, 50, 'node.exe', { cmd: 'node C:\\x\\node_modules\\chrome-devtools-mcp\\watchdog.js' }),
    proc(52, 22, 'node.exe', { cmd: 'node server.js' }),
  ];
  const att = tree.attribute(procs, { hosts: [{ pid: 20 }] });
  const r = L.find({ procs, mem: new Map(procs.map(p => [p.pid, 5_000_000])), ledger: [], attribution: att, ownPid: 1, now: NOW });
  assert.deepStrictEqual(r.mcp.map(x => x.pid), [50]);
  assert.strictEqual(r.mcp[0].bytes, 10_000_000);
  assert.strictEqual(r.mcp[0].reapable, false);
  assert.strictEqual(r.mcp[0].session, 'session:20');
});

test('memory that was not measured stays null, never 0', () => {
  const procs = [proc(10, 1, 'electron.exe', { threads: 1, handles: 0 })];
  const r = L.find({ procs, mem: new Map(), ledger: [], attribution: tree.attribute(procs, {}), ownPid: 1, now: NOW });
  assert.strictEqual(r.stuck[0].bytes, null);
});

test('reapSet: proven rows at least 15 minutes old, by the ledger\'s createdAt; an undated entry never qualifies', () => {
  const procs = [100, 101, 102, 103].map(pid => proc(pid, 1, 'electron.exe'));
  const ledger = [
    entry(100, { createdAt: NOW - 15 * MIN }),
    entry(101, { createdAt: NOW - 15 * MIN + 1 }),
    entry(102, { createdAt: null }),
    entry(103, { createdAt: NOW - 3 * 60 * MIN }),
  ];
  const r = find(procs, ledger);
  assert.deepStrictEqual(r.probes.map(x => x.pid).sort(), [100, 101, 102, 103]);
  assert.deepStrictEqual(L.reapSet(r, { now: NOW }).map(x => x.pid).sort(), [100, 103]);
  assert.strictEqual(L.REAP_AFTER_MS, 15 * MIN);
});

test('reapSet never returns a row that is not reapable (stuck, MCP, an unproven shell)', () => {
  const procs = [proc(10, 1, 'electron.exe', { threads: 1, handles: 0, start: ago(300 * MIN) })];
  assert.deepStrictEqual(L.reapSet(find(procs), { now: NOW }), []);
});

test('reapSet rows carry the exact (pid, start) of the LEDGER entry, which the kill re-proves on a held handle', () => {
  const procs = [proc(100, 1, 'electron.exe')];
  const e = entry(100, { start: ago(60 * MIN) });
  const [row] = L.reapSet(find(procs, [e]), { now: NOW });
  assert.strictEqual(row.start, e.start);
  assert.strictEqual(row.entry.pid, 100);
});

test('PROPERTY: the reap set never holds a row whose start does not match its proof, or whose launcher is alive', () => {
  const startArb = fc.integer({ min: 0, max: 3 });                         // 0..3 -> a small pool of start times
  const startOf = i => ft(NOW - (100 + i) * MIN);
  const procArb = fc.record({ pid: fc.integer({ min: 100, max: 112 }), s: fc.option(startArb, { nil: null }) });
  const entryArb = fc.record({
    pid: fc.integer({ min: 100, max: 112 }), s: startArb,
    launcher: fc.option(fc.record({ pid: fc.integer({ min: 100, max: 112 }), s: fc.option(startArb, { nil: null }) }), { nil: null }),
    createdAt: fc.option(fc.integer({ min: 0, max: 60 }), { nil: null }),
  });
  fc.assert(fc.property(fc.array(procArb, { maxLength: 14 }), fc.array(entryArb, { maxLength: 8 }), fc.integer({ min: 100, max: 112 }), (ps, es, own) => {
    const seen = new Set();
    const procs = ps.filter(p => !seen.has(p.pid) && seen.add(p.pid)).map(p => proc(p.pid, 1, 'electron.exe', { start: p.s === null ? null : startOf(p.s) }));
    const ledger = es.map(e => entry(e.pid, {
      start: startOf(e.s), launcher: e.launcher ? { pid: e.launcher.pid, start: e.launcher.s === null ? null : startOf(e.launcher.s) } : null,
      createdAt: e.createdAt === null ? null : NOW - e.createdAt * MIN,
    }));
    const set = L.reapSet(find(procs, ledger, { ownPid: own }), { now: NOW });
    for (const row of set) {
      const live = procs.find(p => p.pid === row.pid);
      assert.ok(live, 'the process is in the table');
      assert.ok(tree.sameStart(live.start, row.entry.start), 'start matches the ledger');
      assert.notStrictEqual(row.pid, own);
      assert.ok(Number.isFinite(row.entry.createdAt) && NOW - row.entry.createdAt >= L.REAP_AFTER_MS, 'old enough');
      const l = row.entry.launcher;
      assert.ok(l, 'a launcher was recorded');
      const lp = procs.find(p => p.pid === l.pid);
      assert.ok(!lp || (l.start !== null && lp.start !== null && !tree.sameStart(lp.start, l.start)), 'the launcher is gone (absent, or another process holds its pid)');
    }
  }), { numRuns: 300 });
});

// ---- the reaper ------------------------------------------------------------------------------------------

const row = (pid, over = {}) => ({ kind: 'probe-window', pid, start: ago(60 * MIN), name: 'electron.exe', label: 'probe-x', bytes: 5_000_000, entry: entry(pid), reapable: true, ...over });

test('reaper: kills each proven row once through the injected kill, tombstones what ended, and remembers it as stopped', async () => {
  const killed = [];
  const removed = [];
  const reaper = L.createReaper({
    kill: (pid, start) => { killed.push([pid, start]); return 'killed'; },
    removeEntries: (es) => { removed.push(es.map(e => e.pid)); return { ok: true }; },
    now: () => NOW,
  });
  const found = { stuck: [], mcp: [], shells: [], probes: [row(100), row(101, { entry: entry(101, { createdAt: NOW - 5 * MIN }) })] };
  const out = await reaper.run(found);
  assert.deepStrictEqual(killed, [[100, row(100).start]]);
  assert.deepStrictEqual(removed, [[100]]);
  assert.deepStrictEqual(out.map(s => s.pid), [100]);
  assert.deepStrictEqual(reaper.stopped().map(s => [s.pid, s.status, s.bytes, s.at]), [[100, 'killed', 5_000_000, NOW]]);
  await reaper.run(found);
  assert.strictEqual(killed.length, 1, 'the same (pid, start) is never killed twice');
});

test('reaper: gone and mismatch are tombstoned too (the entry can never be reaped again); unknown and failed are kept and retried later', async () => {
  const outcomes = { 1: 'gone', 2: 'mismatch', 3: 'unknown', 4: 'failed' };
  const removed = [];
  let t = NOW;
  const reaper = L.createReaper({
    kill: pid => outcomes[pid],
    removeEntries: (es) => { removed.push(...es.map(e => e.pid)); return { ok: true }; },
    now: () => t, retryAfterMs: 5 * MIN,
  });
  const found = { stuck: [], mcp: [], shells: [], probes: [1, 2, 3, 4].map(pid => row(pid)) };
  await reaper.run(found);
  assert.deepStrictEqual(removed.sort(), [1, 2]);
  assert.deepStrictEqual(reaper.stopped().map(s => s.pid), [], 'only a real kill is listed as stopped');
  let calls = 0;
  const again = L.createReaper({ kill: () => { calls++; return 'failed'; }, removeEntries: () => ({ ok: true }), now: () => t, retryAfterMs: 5 * MIN });
  await again.run({ stuck: [], mcp: [], shells: [], probes: [row(9)] });
  t += 4 * MIN; await again.run({ stuck: [], mcp: [], shells: [], probes: [row(9)] });
  assert.strictEqual(calls, 1, 'not retried inside the retry window');
  t += 2 * MIN; await again.run({ stuck: [], mcp: [], shells: [], probes: [row(9)] });
  assert.strictEqual(calls, 2);
});

test('reaper: a kill that throws is reported by log, does not stop the next row, and a run in flight is not doubled', async () => {
  const logs = [];
  const killed = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const reaper = L.createReaper({
    kill: async (pid) => { if (pid === 1) throw new Error('boom'); await gate; killed.push(pid); return 'killed'; },
    removeEntries: () => ({ ok: true }), now: () => NOW, log: (...a) => logs.push(a.join(' ')),
  });
  const found = { stuck: [], mcp: [], shells: [], probes: [row(1), row(2)] };
  const first = reaper.run(found);
  const second = await reaper.run(found);
  assert.deepStrictEqual(second, [], 'overlapping run does nothing');
  release();
  await first;
  assert.deepStrictEqual(killed, [2]);
  assert.ok(logs.some(l => /boom/.test(l)));
});

test('reaper: stopped entries are kept for an hour at most and ten at most', async () => {
  let t = NOW;
  const reaper = L.createReaper({ kill: () => 'killed', removeEntries: () => ({ ok: true }), now: () => t });
  for (let i = 0; i < 12; i++) await reaper.run({ stuck: [], mcp: [], shells: [], probes: [row(200 + i)] });
  assert.strictEqual(reaper.stopped().length, 10);
  t += 61 * MIN;
  assert.strictEqual(reaper.stopped().length, 0);
});

// ---- what the panel gets -----------------------------------------------------------------------------------

test('present: the entry never travels, a proven row says when the auto-reap will stop it, the others say null', () => {
  const found = {
    stuck: [{ kind: 'stuck', pid: 10, start: '5', name: 'electron.exe', label: '', bytes: 9, ageMs: 7, reapable: false }],
    probes: [row(100, { ageMs: 10 * MIN, entry: entry(100, { createdAt: NOW - 10 * MIN, launcher: { pid: 1, start: 'secret' } }) })],
    shells: [], mcp: [],
  };
  const p = L.present(found, [{ kind: 'probe-window', pid: 7, name: 'electron.exe', label: 'old', bytes: 3, at: NOW - MIN }], { now: NOW });
  assert.strictEqual(p.probes[0].reapInMs, 5 * MIN);
  assert.strictEqual(p.stuck[0].reapInMs, null);
  assert.ok(!('entry' in p.probes[0]));
  assert.ok(!JSON.stringify(p).includes('secret'));
  assert.deepStrictEqual(p.stopped.map(s => [s.pid, s.label]), [[7, 'old']]);
  assert.strictEqual(p.reapAfterMs, 15 * MIN);
  assert.strictEqual(L.present({ stuck: [], probes: [], shells: [], mcp: [] }, [], { now: NOW }), null, 'nothing to say is null, so the section is not drawn');
});

test('present: a proven row already past the floor reads 0 (stopping on the next sample), never negative', () => {
  const found = { stuck: [], shells: [], mcp: [], probes: [row(100, { entry: entry(100, { createdAt: NOW - 60 * MIN }) })] };
  assert.strictEqual(L.present(found, [], { now: NOW }).probes[0].reapInMs, 0);
});

test('rows say what they are: an MCP server by its package name, a ledger row by its label, a stuck Electron as Electron', () => {
  const procs = [
    proc(20, 1, 'electron.exe', { cmd: 'electron.exe C:\\r\\dev\\host\\host.js', start: ago(400 * MIN) }),
    proc(22, 20, 'claude.exe', { start: ago(300 * MIN) }),
    proc(50, 22, 'node.exe', { cmd: 'node C:\\x\\node_modules\\chrome-devtools-mcp\\build\\index.js' }),
    proc(60, 22, 'python.exe', { cmd: 'python -m reaper_mcp.server' }),
    proc(10, 1, 'electron.exe', { threads: 1, handles: 0, cmd: null }),
    proc(100, 1, 'electron.exe'),
  ];
  const att = tree.attribute(procs, { hosts: [{ pid: 20 }] });
  const r = L.find({ procs, mem: new Map(), ledger: [entry(100)], attribution: att, ownPid: 1, now: NOW });
  assert.deepStrictEqual(r.mcp.map(x => x.what).sort(), ['chrome-devtools-mcp', 'reaper_mcp']);
  assert.strictEqual(r.probes[0].what, 'probe-x');
  assert.strictEqual(r.stuck[0].what, 'Electron');
});
