'use strict';
/**
 * Kill tests for Mortimer's release-gate survivor S22 (2026-10-09): app/resources-service.js Stop selection and delete
 * bookkeeping. The Stop request is validated into process rows that get KILLED, so each guard is asserted by what it
 * refuses; the "seen alive" memory and the deleted-files list decide when a file is deleted and what the page says.
 */
const test = require('node:test');
const assert = require('node:assert');

const S = require('../app/resources-service');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
const T0 = 134000000000000000n;
const SEC = 10000000n;
const NOWMS = 1_800_000_000_000;
const MINUTE = 60_000;
const MBYTES = 1024 * 1024;
const ftOf = ms => String(BigInt(ms) * 10000n + 116444736000000000n);

function world() {
  let c = 1000;
  const p = (pid, ppid, name, cmd, priv) => ({ pid, ppid, name, cmd, priv, start: String(c += 10) });
  return [
    p(10, 1, 'electron.exe', `${EXE} ${INSTALL}`, 100),
    p(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`, 50),
    p(22, 20, 'claude.exe', 'claude.exe', 300),
    p(23, 22, 'node.exe', 'node server.js', 400),
  ];
}
const sampleAt = (procs, n) => ({
  at: 0, procs,
  perf: new Map(procs.map(p => [p.pid, { cpu: 0n, ts: T0 + BigInt(n) * 10n * SEC, ws: p.priv }])),
  cpuTotal: { idle: BigInt(n) * 5n * SEC, ts: T0 + BigInt(n) * 10n * SEC }, os: { totalBytes: 1000, freeBytes: 400 },
});
const snap = (over = {}) => ({ mode: 'full', sample: null, prev: null, machine: { last: null, prev: null }, failures: 0, lastGoodAt: 4000, stale: false, expired: false, ...over });
const fullSnap = (n, procs = world()) => snap({
  sample: sampleAt(procs, n), prev: n > 1 ? sampleAt(procs, n - 1) : null,
  machine: { last: sampleAt(procs, n), prev: n > 1 ? sampleAt(procs, n - 1) : null },
});

function rig(extra = {}) {
  const sent = [];
  const procs = world();
  const claims = [{ pid: 20, port: 7701, cwd: 'C:\\r\\dev', processStartedAt: procs[1].start }];
  let reread = procs;
  const svc = S.createResourcesService({
    sampler: { setWanted: () => {}, sampleNow: async () => reread, snapshot: () => null },
    tabs: () => [{ key: 'k', cwd: 'C:\\r\\dev', branch: 'main', port: 7701 }],
    claims: () => claims, installDirs: () => [INSTALL], ownPid: 10, cores: 4, labelOf: c => c.split('\\').pop(),
    send: payload => sent.push(payload),
    kill: async (targets) => targets.map(t => ({ pid: t.pid, status: 'killed' })),
    refreshStrip: () => {}, now: () => NOWMS, ...extra,
  });
  return { svc, sent, procs, setReread: (x) => { reread = x; } };
}

const macrotask = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await macrotask(); };

// ---- the Stop request -> rows validator ---------------------------------------------------------------------------

function leftoverWorld() {
  const procs = world();
  procs.push({ pid: 90, ppid: 1, name: 'electron.exe', cmd: 'electron.exe probe', priv: 700, start: ftOf(NOWMS - 60 * MINUTE), threads: 9, handles: 80 });
  return procs;
}
const probeEntry = over => ({ pid: 90, start: ftOf(NOWMS - 60 * MINUTE), launcher: { pid: 91, start: ftOf(NOWMS - 61 * MINUTE) }, kind: 'probe-window', label: 'probe-x', createdAt: NOWMS - 30 * MINUTE, ...over });

function leftRig(extra = {}) {
  const calls = { kill: [], removed: [] };
  const reap = {
    kill: (pid, start) => { calls.kill.push([pid, start]); return 'killed'; },
    launcherGone: async () => true, isRunning: async () => false,
    removeEntries: (es) => { calls.removed.push(...es.map(e => e.pid)); return { ok: true }; },
  };
  const r = rig({ ledger: () => [probeEntry()], reap, ...extra });
  r.svc.onUpdate(fullSnap(2, leftoverWorld()));
  return { ...r, calls };
}

test('S22: a Stop that names pid P with ANOTHER start stops nothing, even next to a valid row', async () => {
  const r = leftRig();
  const good = { pid: 90, start: probeEntry().start };
  for (const rows of [[{ pid: 90, start: ftOf(NOWMS - 59 * MINUTE) }], [good, { pid: 90, start: '1' }]]) {
    const res = await r.svc.stopLeftovers({ rows });
    assert.strictEqual(res.ok, false, JSON.stringify(rows));
  }
  assert.deepStrictEqual(r.calls.kill, []);
});

test('S22: a Stop whose start is not a string, or whose pid is not an integer, stops nothing', async () => {
  const r = leftRig();
  const start = probeEntry().start;
  for (const q of [{ pid: 90, start: Number(start) }, { pid: 90, start: null }, { pid: 90 }, { pid: 90.5, start }, { pid: NaN, start }, { pid: '90', start }, { start }]) {
    const res = await r.svc.stopLeftovers({ rows: [q] });
    assert.strictEqual(res.ok, false, JSON.stringify(q));
  }
  assert.deepStrictEqual(r.calls.kill, []);
});

test('S22: a null or non-object row in the list is refused (not thrown), and nothing is stopped', async () => {
  const r = leftRig();
  const good = { pid: 90, start: probeEntry().start };
  for (const rows of [[null], [undefined], [good, null], [null, good], [5], ['90']]) {
    const res = await r.svc.stopLeftovers({ rows });
    assert.strictEqual(res.ok, false, JSON.stringify(rows));
  }
  assert.deepStrictEqual(r.calls.kill, []);
});

test('S22: an empty list, a list that is not an array, and an over-long list (51) are refused; 50 is the most it takes', async () => {
  const r = leftRig();
  const good = { pid: 90, start: probeEntry().start };
  for (const rows of [[], 'x', { length: 1, 0: good }, Array(51).fill(good)]) {
    const res = await r.svc.stopLeftovers({ rows });
    assert.strictEqual(res.ok, false, `${typeof rows} ${Array.isArray(rows) ? rows.length : ''}`);
  }
  assert.deepStrictEqual(r.calls.kill, [], 'nothing was killed by a refused request');
  const fifty = await r.svc.stopLeftovers({ rows: Array(50).fill(good) });
  assert.strictEqual(fifty.ok, true, 'exactly 50 rows is inside the bound');
  assert.ok(r.calls.kill.length >= 1 && r.calls.kill.every(k => k[0] === 90));
});

test('S22: a group with nothing provable in it says there is nothing to stop; a Stop before any sample refuses too', async () => {
  const early = leftRig();
  const res = await early.svc.stopLeftovers({ group: 'shells' });
  assert.strictEqual(res.ok, false);
  assert.match(res.text, /nothing left over/);
  assert.deepStrictEqual(early.calls.kill, []);

  const fresh = rig({ ledger: () => [probeEntry()], reap: { kill: () => 'killed', launcherGone: async () => true, isRunning: async () => false, removeEntries: () => ({ ok: true }) } });
  const none = await fresh.svc.stopLeftovers({ group: 'probes' });
  assert.strictEqual(none.ok, false);
  assert.match(none.text, /nothing left over/);
});

test('S22: a request naming a group wins over rows; rows that are not objects fall to the refusal', async () => {
  const r = leftRig();
  const res = await r.svc.stopLeftovers({ group: 'probes', rows: [{ pid: 1, start: 'x' }] });
  assert.deepStrictEqual(res, { ok: true, stopped: 1, failed: 0 });
  const bad = await r.svc.stopLeftovers('probes');
  assert.strictEqual(bad.ok, false);
  assert.match(bad.text, /not a leftover this panel can stop/);
});

// ---- task-output files: the "seen alive" memory and the deleted list ------------------------------------------------

const taskFile = (over = {}) => ({
  path: `C:\\t\\claude\\p\\${over.session || 'sess-1'}\\tasks\\a1.output`, project: 'p', session: 'sess-1', name: 'a1.output',
  bytes: 300 * MBYTES, mtimeMs: NOWMS - 40 * MINUTE, dev: '1', ino: '10', nlink: 1, ...over,
});

function taskRig(extra = {}, files = [taskFile()]) {
  const clock = { t: NOWMS };
  const calls = { removed: [], logs: [] };
  const alive = { 4242: true };
  const extraProcs = [];
  let regNow = null;
  const taskLogs = {
    everyMs: 60_000,
    scan: async () => files,
    registry: async () => regNow || ({ ok: true, entries: [{ pid: 5555, sessionId: 'tab' }, ...(alive[4242] ? [{ pid: 4242, sessionId: 'sess-1' }] : [])] }),
    remove: async (row) => { calls.removed.push(row.key); return { deleted: row.paths.length, failed: 0, kept: 0, freed: row.bytes }; },
    ...extra.taskLogs,
  };
  const r = rig({ now: () => clock.t, ledger: () => [], taskLogs, log: (...a) => calls.logs.push(a.join(' ')), ...extra.rig });
  const procsWith = () => {
    const p = world();
    p.push({ pid: 5555, ppid: 1, name: 'claude.exe', cmd: 'claude.exe', priv: 10, start: '1' });
    if (alive[4242]) p.push({ pid: 4242, ppid: 1, name: 'claude.exe', cmd: 'claude.exe', priv: 10, start: '2' });
    return [...p, ...extraProcs];
  };
  let n = 1;
  const tick = async () => { r.svc.onUpdate(fullSnap(++n, procsWith())); await settle(); };
  const judge = async () => { await tick(); await tick(); await tick(); };
  return { ...r, clock, calls, alive, tick, judge, extraProcs, setRegistry: (x) => { regNow = x; } };
}

const lastLeft = r => r.sent.at(-1).leftovers;

test('S22: a session seen under a SECOND process is not deleted while the FIRST is still running (each start is remembered, none replaces another)', async () => {
  const r = taskRig();
  await r.judge();                                     // sess-1 seen alive under pid 4242 (start '2')
  r.extraProcs.push({ pid: 4343, ppid: 1, name: 'claude.exe', cmd: 'claude.exe', priv: 10, start: '3' });
  r.setRegistry({ ok: true, entries: [{ pid: 5555, sessionId: 'tab' }, { pid: 4343, sessionId: 'sess-1' }] });
  r.clock.t += 61_000;
  await r.judge();                                     // sess-1 seen alive under pid 4343 too
  r.extraProcs.length = 0;                             // 4343 ends...
  r.setRegistry({ ok: true, entries: [{ pid: 5555, sessionId: 'tab' }] });   // ...and the registry no longer lists the session; 4242 still runs
  r.clock.t += 61_000;
  await r.judge();
  assert.deepStrictEqual(r.calls.removed, [], 'pid 4242 (its first process) is still in the table');
  r.alive[4242] = false;
  r.clock.t += 61_000;
  await r.judge();
  assert.deepStrictEqual(r.calls.removed, ['1:10'], 'both processes are gone: now it goes');
});

test('S22: the same pid and start seen on two judged reads is one memory: its end is still observed', async () => {
  const r = taskRig();
  await r.judge();
  r.clock.t += 61_000;
  await r.judge();                                     // the same (4242, '2') seen again
  r.alive[4242] = false;
  r.clock.t += 61_000;
  await r.judge();
  assert.deepStrictEqual(r.calls.removed, ['1:10']);
});

const cleanResult = (row, over = {}) => ({ deleted: row.paths.length, gone: 0, locked: 0, failed: 0, kept: 0, freed: row.bytes, held: false, deletedPaths: row.paths, ...over });

async function endedRig(remove, files) {
  const r = taskRig({ taskLogs: { remove: async (row) => { r.calls.removed.push(row.key); return remove(row); } } }, files);
  await r.judge();
  r.alive[4242] = false;
  r.clock.t += 61_000;
  return r;
}

test('S22: only a WHOLE delete is listed as deleted: kept, failed, locked, or nothing deleted at all is not', async () => {
  for (const [label, over] of [
    ['kept one', { kept: 1 }],
    ['failed one', { failed: 1 }],
    ['locked one', { locked: 1 }],
    ['nothing deleted, nothing gone', { deleted: 0, gone: 0, freed: 0, deletedPaths: [] }],
  ]) {
    const r = await endedRig(row => cleanResult(row, over));
    await r.judge();
    await r.tick();
    assert.deepStrictEqual(r.calls.removed, ['1:10'], `${label}: tried once, then backed off`);
    const left = lastLeft(r);
    assert.strictEqual(left ? left.deleted.length : 0, 0, `${label}: nothing is reported as freed`);
    assert.ok(r.calls.logs.some(l => /not deleted/.test(l)), `${label}: the failure is logged`);
  }
});

test('S22: a delete that went through lists the file with its freed bytes (the control for the refusals above)', async () => {
  const r = await endedRig(row => cleanResult(row, { freed: 123 }));
  await r.judge();
  await r.tick();
  assert.deepStrictEqual(lastLeft(r).deleted.map(d => [d.name, d.bytes, d.held]), [['a1.output', 123, false]]);
});

test('S22: the deleted list expires after an hour: a record 59 minutes old is kept, one exactly 60 minutes old is dropped', async () => {
  const kept = await endedRig(row => cleanResult(row));
  await kept.judge();
  await kept.tick();
  assert.strictEqual(lastLeft(kept).deleted.length, 1);
  kept.clock.t += 59 * MINUTE;
  await kept.tick();
  assert.strictEqual(lastLeft(kept).deleted.length, 1, '59 minutes: still listed');

  const gone = await endedRig(row => cleanResult(row));
  await gone.judge();
  await gone.tick();
  const deletedAt = gone.clock.t;
  assert.strictEqual(lastLeft(gone).deleted.length, 1);
  gone.clock.t = deletedAt + 60 * MINUTE;
  await gone.tick();
  const after = lastLeft(gone);
  assert.strictEqual(after === null ? 0 : after.deleted.length, 0, 'exactly 60 minutes: dropped');
});

test('S22: the deleted list shows the ten most recent; the eleventh pushes the oldest out', async () => {
  const files = Array.from({ length: 11 }, (_, i) => taskFile({
    ino: String(100 + i), name: `f${String(i).padStart(2, '0')}.output`,
    path: `C:\\t\\claude\\p\\sess-1\\tasks\\f${String(i).padStart(2, '0')}.output`, bytes: (400 - i) * MBYTES,
  }));
  const r = await endedRig(row => cleanResult(row), files);
  await r.judge();
  await r.tick();
  assert.strictEqual(r.calls.removed.length, 11, 'all eleven were deleted');
  const names = lastLeft(r).deleted.map(d => d.name);
  assert.strictEqual(names.length, 10);
  const first = files.find(f => `1:${f.ino}` === r.calls.removed[0]).name;
  assert.ok(!names.includes(first), `the first-deleted ${first} is the one dropped: ${names.join(',')}`);
});

test('S22: a partial delete drops from the list only the links that were deleted, so the remainder is not judged as a whole file', async () => {
  const files = [
    taskFile({ nlink: 2 }),
    taskFile({ nlink: 2, name: 'a2.output', path: 'C:\\t\\claude\\p\\sess-1\\tasks\\a2.output' }),
  ];
  const r = await endedRig(row => ({ deleted: 1, gone: 0, locked: 1, failed: 0, kept: 0, freed: 0, held: false, deletedPaths: [row.paths[0]] }), files);
  await r.judge();
  await r.tick();
  assert.deepStrictEqual(r.calls.removed, ['1:10'], 'tried once');
  const row = lastLeft(r).taskLogs[0];
  // One link is gone from the list, so "every link was found" no longer holds: doubt keeps the file ('unknown'),
  // not the back-off's 'locked' that an intact two-link row would show.
  assert.strictEqual(row.why, 'unknown');
  assert.strictEqual(lastLeft(r).deleted.length, 0);
});
