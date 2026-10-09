'use strict';
/**
 * host/resource-gpu.js (BACKLOG #82): the GPU counters parsed and turned into busy % and memory. Absence is never zero:
 * every figure that was not measured is null.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const G = require('../host/resource-gpu');
const { parseSample } = require('../host/resource-sample');

const L1 = 'luid_0x00000000_0x000107EC_phys_0';
const L2 = 'luid_0x00000000_0x000119C4_phys_0';
const eng = (pid, n, type, u, t, luid = '0x00000000_0x000107EC') => ({ n: `pid_${pid}_luid_${luid}_phys_0_eng_${n}_engtype_${type}`, u: String(u), t: String(t) });
const pm = (pid, d, l = L1) => ({ n: `pid_${pid}_${l}`, d: String(d) });
const am = (l, d) => ({ n: l, d: String(d) });

const T0 = 134000000000000000n;
const SEC = 10000000n;     // one second in 100 ns ticks

/** A sample as parseSample would hand it over, built from the document's `gpu`. */
const sample = (gpu, procs = []) => {
  const text = `${JSON.stringify({ procs, perf: [], cpu: null, os: null, gpu })}END`;
  return parseSample(text, 0);
};
const proc = (pid, name, start = '1') => ({ pid, ppid: 0, name, cmd: null, start });

test('parseGpu: engines by name, memory summed per pid over its adapters, adapters summed, the total from the registry', () => {
  const g = G.parseGpu({
    eng: [eng(10, 0, '3D', 5, 100), eng(10, 1, 'Copy', 0, 100)],
    pm: [pm(10, 1000), pm(10, 24, L2), pm(11, 5)],
    am: [am(L1, 4000), am(L2, 8)],
    total: '8000',
  });
  assert.strictEqual(g.engines.size, 2);
  assert.deepStrictEqual([...g.procMem], [[10, 1024], [11, 5]]);
  assert.deepStrictEqual(g.mem, { usedBytes: 4008, totalBytes: 8000 });
  const e = [...g.engines.values()][0];
  assert.strictEqual(e.pid, 10);
  assert.strictEqual(e.u, 5n);
  assert.strictEqual(e.ts, 100n);
});

test('parseGpu: nothing readable is null (not an empty GPU), and so is a missing or non-object document', () => {
  assert.strictEqual(G.parseGpu(null), null);
  assert.strictEqual(G.parseGpu(undefined), null);
  assert.strictEqual(G.parseGpu([]), null);
  assert.strictEqual(G.parseGpu('x'), null);
  assert.strictEqual(G.parseGpu({ eng: [], pm: [], am: [], total: null }), null);
  assert.strictEqual(G.parseGpu({ eng: 'no', pm: 1, am: 2 }), null);
});

test('parseGpu: a class that gave no rows leaves that part null, never an empty or zero figure', () => {
  const g = G.parseGpu({ eng: [eng(1, 0, '3D', 1, 1)], pm: [], am: [], total: '100' });
  assert.strictEqual(g.procMem, null);
  assert.strictEqual(g.mem, null);
});

test('parseGpu: rows that are not what the counters print are dropped, one by one', () => {
  const g = G.parseGpu({
    eng: [eng(1, 0, '3D', 1, 1), { n: 'garbage', u: '1', t: '1' }, { n: eng(2, 0, '3D', 1, 1).n, u: 'x', t: '1' }, { n: eng(3, 0, '3D', 1, 1).n, u: '1' }, null, 'row'],
    pm: [pm(1, 5), { n: 'junk', d: '5' }, { n: pm(2, 5).n, d: 'many' }, { n: 7, d: '1' }],
    am: [am(L1, 9), { n: 'luid_x', d: '5' }],
    total: '100',
  });
  assert.deepStrictEqual([...g.engines.values()].map(e => e.pid), [1]);
  assert.deepStrictEqual([...g.procMem], [[1, 5]]);
  assert.strictEqual(g.mem.usedBytes, 9);
});

test('parseGpu: an engine type with spaces or digits still names its group', () => {
  const g = G.parseGpu({ eng: [eng(1, 0, 'Video Codec 0', 1, 1), eng(1, 1, 'Compute_0', 1, 1)] });
  assert.strictEqual(g.engines.size, 2);
  assert.strictEqual(new Set([...g.engines.values()].map(e => e.group)).size, 2);
});

test('parseGpu: the total is unknown when absent, zero, not digits, or smaller than what is in use', () => {
  const base = { eng: [eng(1, 0, '3D', 1, 1)], am: [am(L1, 500)] };
  assert.strictEqual(G.parseGpu({ ...base, total: null }).mem.totalBytes, null);
  assert.strictEqual(G.parseGpu({ ...base, total: '0' }).mem.totalBytes, null);
  assert.strictEqual(G.parseGpu({ ...base, total: 'lots' }).mem.totalBytes, null);
  assert.strictEqual(G.parseGpu({ ...base, total: '499' }).mem.totalBytes, null);
  assert.strictEqual(G.parseGpu({ ...base, total: '500' }).mem.totalBytes, 500);
  assert.strictEqual(G.parseGpu({ ...base, total: 1000 }).mem.totalBytes, 1000);
});

test('parseSample carries the parsed gpu, and null for a document without one', () => {
  assert.strictEqual(sample(null).gpu, null);
  assert.strictEqual(parseSample(`${JSON.stringify({ procs: [], perf: [] })}END`, 0).gpu, null);
  assert.ok(sample({ eng: [eng(1, 0, '3D', 1, 1)] }).gpu.engines instanceof Map);
});

// ---- busy % ----------------------------------------------------------------------------------------------------------

test('gpuBusy: busy time over wall time, per pid (its busiest engine type) and overall (the busiest adapter and type)', () => {
  const prev = sample({ eng: [eng(10, 0, '3D', 0, T0), eng(10, 1, '3D', 0, T0), eng(10, 2, 'Copy', 0, T0), eng(20, 0, '3D', 0, T0)] });
  // over 2 s: pid 10 engine 0 busy 1 s (50%), engine 1 busy 0.5 s (25%), Copy 0.2 s (10%); pid 20 busy 0.4 s (20%)
  const next = sample({ eng: [eng(10, 0, '3D', SEC, T0 + 2n * SEC), eng(10, 1, '3D', SEC / 2n, T0 + 2n * SEC), eng(10, 2, 'Copy', SEC / 5n, T0 + 2n * SEC), eng(20, 0, '3D', (SEC * 2n) / 5n, T0 + 2n * SEC)] });
  const r = G.gpuBusy(prev, next);
  assert.ok(Math.abs(r.byPid.get(10) - 75) < 1e-9, `pid 10 ${r.byPid.get(10)}`);
  assert.ok(Math.abs(r.byPid.get(20) - 20) < 1e-9);
  assert.ok(Math.abs(r.busy - 95) < 1e-9, `overall ${r.busy}`);
});

test('gpuBusy: the same engine type on two adapters is two groups, not one sum', () => {
  const other = '0x00000000_0x000119C4';
  const prev = sample({ eng: [eng(1, 0, '3D', 0, T0), eng(1, 0, '3D', 0, T0, other)] });
  const next = sample({ eng: [eng(1, 0, '3D', SEC, T0 + 2n * SEC), eng(1, 0, '3D', SEC, T0 + 2n * SEC, other)] });
  assert.ok(Math.abs(G.gpuBusy(prev, next).busy - 50) < 1e-9);
});

test('gpuBusy: a real idle GPU is 0, a clamp holds at 100', () => {
  const prev = sample({ eng: [eng(1, 0, '3D', 7, T0)] });
  assert.strictEqual(G.gpuBusy(prev, sample({ eng: [eng(1, 0, '3D', 7, T0 + SEC)] })).busy, 0);
  assert.strictEqual(G.gpuBusy(prev, sample({ eng: [eng(1, 0, '3D', 7n * 1000000000n, T0 + SEC)] })).busy, 100);
});

test('gpuBusy: no usable pair is null, never 0 (first sample, unreadable counters, no clock step, a counter that went down)', () => {
  const good = sample({ eng: [eng(1, 0, '3D', 100, T0)] });
  const later = sample({ eng: [eng(1, 0, '3D', 100, T0 + SEC)] });
  for (const [a, b] of [[null, later], [good, null], [null, null], [sample(null), later], [good, sample(null)], [good, good],
    [later, good], [sample({ eng: [eng(1, 0, '3D', 500, T0)] }), later]]) {
    const r = G.gpuBusy(a, b);
    assert.strictEqual(r.busy, null);
    assert.ok([...r.byPid.values()].every(v => v === null));
  }
});

test('gpuBusy: a pid with an instance that has no delta is null for that pid; the others are still measured', () => {
  const prev = sample({ eng: [eng(1, 0, '3D', 0, T0), eng(2, 0, '3D', 0, T0)] });
  // pid 1 gained an engine instance (no earlier reading); pid 3 is new entirely; pid 2 is whole
  const next = sample({ eng: [eng(1, 0, '3D', SEC, T0 + 2n * SEC), eng(1, 1, '3D', 5, T0 + 2n * SEC), eng(2, 0, '3D', SEC, T0 + 2n * SEC), eng(3, 0, '3D', 5, T0 + 2n * SEC)] });
  const r = G.gpuBusy(prev, next);
  assert.strictEqual(r.byPid.get(1), null);
  assert.strictEqual(r.byPid.get(3), null);
  assert.ok(Math.abs(r.byPid.get(2) - 50) < 1e-9);
  assert.ok(Math.abs(r.busy - 100) < 1e-9, 'the overall figure sums the instances that have a delta (pid 1 engine 0 and pid 2: 50% each)');
});

test('gpuBusy: a pid that was reused between the samples (another start time) has no delta', () => {
  const prev = sample({ eng: [eng(1, 0, '3D', 0, T0)] }, [proc(1, 'a.exe', '100')]);
  const next = sample({ eng: [eng(1, 0, '3D', SEC, T0 + 2n * SEC)] }, [proc(1, 'b.exe', '200')]);
  assert.strictEqual(G.gpuBusy(prev, next).byPid.get(1), null);
  const same = sample({ eng: [eng(1, 0, '3D', SEC, T0 + 2n * SEC)] }, [proc(1, 'a.exe', '100')]);
  assert.ok(Math.abs(G.gpuBusy(prev, same).byPid.get(1) - 50) < 1e-9);
  // a start time that is unknown on either side proves nothing, so it does not veto the delta
  const unknown = sample({ eng: [eng(1, 0, '3D', SEC, T0 + 2n * SEC)] }, [{ pid: 1, name: 'a.exe' }]);
  assert.ok(Math.abs(G.gpuBusy(prev, unknown).byPid.get(1) - 50) < 1e-9);
});

// ---- the process list ----------------------------------------------------------------------------------------------------

test('gpuProcs: biggest first, named from the process table, "PID n" when it has no name, nothing held is not listed', () => {
  const next = sample({ eng: [eng(1, 0, '3D', 1, 1)], pm: [pm(1, 10), pm(2, 300), pm(3, 0), pm(4, 20), pm(5, 20)] }, [proc(1, 'a.exe'), proc(2, 'llama-server.exe')]);
  const byPid = new Map([[2, 12.5], [1, null]]);
  const r = G.gpuProcs(next, byPid);
  assert.deepStrictEqual(r.rows, [
    { pid: 2, name: 'llama-server.exe', bytes: 300, busy: 12.5 },
    { pid: 4, name: 'PID 4', bytes: 20, busy: null },
    { pid: 5, name: 'PID 5', bytes: 20, busy: null },
    { pid: 1, name: 'a.exe', bytes: 10, busy: null },
  ]);
  assert.strictEqual(r.more, 0);
});

test('gpuProcs: the list is capped and says how many more', () => {
  const rows = Array.from({ length: G.PROCS_SHOWN + 3 }, (_, i) => pm(100 + i, 1000 - i));
  const r = G.gpuProcs(sample({ eng: [eng(1, 0, '3D', 1, 1)], pm: rows }), new Map());
  assert.strictEqual(r.rows.length, G.PROCS_SHOWN);
  assert.strictEqual(r.more, 3);
  assert.strictEqual(r.rows[0].pid, 100);
});

test('gpuProcs: no memory rows or no gpu is an empty list', () => {
  assert.deepStrictEqual(G.gpuProcs(sample({ eng: [eng(1, 0, '3D', 1, 1)] }), new Map()), { rows: [], more: 0 });
  assert.deepStrictEqual(G.gpuProcs(sample(null), new Map()), { rows: [], more: 0 });
  assert.deepStrictEqual(G.gpuProcs(null, new Map()), { rows: [], more: 0 });
});

test('buildGpu: busy, memory and the processes, joined; everything unknown is null', () => {
  const prev = sample({ eng: [eng(2, 0, '3D', 0, T0)], pm: [pm(2, 300)], am: [am(L1, 400)], total: '1000' }, [proc(2, 'llama-server.exe')]);
  const next = sample({ eng: [eng(2, 0, '3D', SEC, T0 + 4n * SEC)], pm: [pm(2, 300)], am: [am(L1, 400)], total: '1000' }, [proc(2, 'llama-server.exe')]);
  const g = G.buildGpu(prev, next);
  assert.ok(Math.abs(g.busy - 25) < 1e-9);
  assert.deepStrictEqual(g.mem, { usedBytes: 400, totalBytes: 1000 });
  assert.deepStrictEqual(g.procs.rows.map(r => [r.pid, r.name, r.bytes]), [[2, 'llama-server.exe', 300]]);
  assert.ok(Math.abs(g.procs.rows[0].busy - 25) < 1e-9);
  const first = G.buildGpu(null, next);
  assert.strictEqual(first.busy, null);
  assert.deepStrictEqual(first.mem, { usedBytes: 400, totalBytes: 1000 });
  assert.deepStrictEqual(G.buildGpu(null, null), { busy: null, mem: null, procs: { rows: [], more: 0 } });
  assert.deepStrictEqual(G.buildGpu(prev, sample(null)), { busy: null, mem: null, procs: { rows: [], more: 0 } });
});

// ---- properties ----------------------------------------------------------------------------------------------------------

test('property: a figure is a number only when the counters give a usable pair; any gap is null, never a number', () => {
  const row = fc.record({ pid: fc.integer({ min: 1, max: 6 }), engine: fc.integer({ min: 0, max: 2 }), type: fc.constantFrom('3D', 'Copy'), u: fc.bigInt({ min: 0n, max: 10n ** 12n }), t: fc.bigInt({ min: 0n, max: 10n ** 12n }) });
  fc.assert(fc.property(fc.array(row, { maxLength: 12 }), fc.array(row, { maxLength: 12 }), (a, b) => {
    const mk = rows => sample({ eng: rows.map(r => eng(r.pid, r.engine, r.type, r.u, T0 + r.t)) });
    const prev = mk(a);
    const next = mk(b);
    const r = G.gpuBusy(prev, next);
    for (const [pid, v] of r.byPid) {
      if (v === null) continue;
      assert.ok(v >= 0 && v <= 100);
      // a number means every one of the pid's instances had a counterpart before it, with a forward clock and a counter that did not go down
      for (const [name, e] of next.gpu.engines) {
        if (e.pid !== pid) continue;
        const p = prev.gpu.engines.get(name);
        assert.ok(p && e.ts > p.ts && e.u >= p.u, `${name} gave a figure without a usable pair`);
      }
    }
    if (r.busy !== null) assert.ok(r.busy >= 0 && r.busy <= 100);
    if (prev.gpu === null || next.gpu === null) assert.strictEqual(r.busy, null);
  }), { numRuns: 200 });
});

test('property: a row whose values are unknown never becomes a number in the memory figures', () => {
  const junk = fc.oneof(fc.constant(null), fc.constant(undefined), fc.constant('x'), fc.constant(-5), fc.constant(NaN), fc.constant({}), fc.constant([]));
  fc.assert(fc.property(fc.array(junk, { maxLength: 6 }), junk, (ds, total) => {
    const g = G.parseGpu({ eng: [eng(1, 0, '3D', 1, 1)], pm: ds.map(d => ({ n: pm(1, 1).n, d })), am: ds.map(d => ({ n: L1, d })), total });
    assert.strictEqual(g.procMem, null);
    assert.strictEqual(g.mem, null);
  }), { numRuns: 100 });
});
