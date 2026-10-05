'use strict';
/**
 * host/resource-sample.js (BACKLOG #63): the CIM sample parsed and turned into percentages. The rule under test
 * is the one CLAUDE.md names: a figure that was not measured is `null`, never 0.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const S = require('../host/resource-sample');

const BASE = '134356416231909701';
const plus = (ts, n) => String(BigInt(ts) + BigInt(n));

function raw({ procs = [], perf = [], cpu = null, os = null, end = true, bom = false } = {}) {
  const body = JSON.stringify({ procs, perf, cpu, os });
  return (bom ? '﻿' : '') + body + (end ? '\nEND' : '');
}

const proc = (pid, ppid, start, extra = {}) => ({ pid, ppid, name: 'x.exe', cmd: null, start: String(start), priv: 1000, ...extra });

test('parseSample reads a good sample, BOM and all, with 100 ns counters as BigInt', () => {
  const s = S.parseSample(raw({
    bom: true,
    procs: [proc(4, 0, 100)],
    perf: [{ pid: 4, cpu: '30000000', ts: BASE }],
    cpu: { idle: '344115722656', ts: BASE },
    os: { totalKb: 1000, freeKb: 250 },
  }), 5);
  assert.strictEqual(s.at, 5);
  assert.strictEqual(s.procs.length, 1);
  assert.strictEqual(s.procs[0].pid, 4);
  assert.strictEqual(s.perf.get(4).ts, BigInt(BASE));
  assert.strictEqual(s.perf.get(4).cpu, 30000000n);
  assert.strictEqual(s.cpuTotal.idle, 344115722656n);
  assert.deepStrictEqual(s.os, { totalBytes: 1000 * 1024, freeBytes: 250 * 1024 });
});

test('parseSample refuses a sample that did not run to its end sentinel or is not JSON', () => {
  assert.strictEqual(S.parseSample(raw({ end: false }), 1), null);
  assert.strictEqual(S.parseSample('END', 1), null);
  assert.strictEqual(S.parseSample('{nope\nEND', 1), null);
  assert.strictEqual(S.parseSample(undefined, 1), null);
  assert.strictEqual(S.parseSample(raw({ procs: 'x' }).replace('"procs":"x"', '"procs":7'), 1), null);
});

test('parseSample keeps a process with an unknown start as null, and a bad row is dropped, not guessed', () => {
  const s = S.parseSample(raw({
    procs: [proc(1, 0, 5), { pid: 2, ppid: 1, name: 'a', cmd: null, start: null, priv: null }, { pid: 'x' }, null, proc(-3, 0, 5)],
  }), 1);
  assert.deepStrictEqual(s.procs.map(p => p.pid), [1, 2]);
  assert.strictEqual(s.procs[1].start, null);
  assert.strictEqual(s.procs[1].priv, null);
});

test('parseSample: a missing machine part is null, never an empty object that reads as zero', () => {
  const s = S.parseSample(raw({ procs: [], perf: [] }), 1);
  assert.strictEqual(s.cpuTotal, null);
  assert.strictEqual(s.os, null);
  const bad = S.parseSample(raw({ cpu: { idle: 'abc', ts: BASE }, os: { totalKb: 0, freeKb: 5 } }), 1);
  assert.strictEqual(bad.cpuTotal, null);
  assert.strictEqual(bad.os, null);
  const nulls = S.parseSample(raw({ os: { totalKb: null, freeKb: null } }), 1);
  assert.strictEqual(nulls.os, null);
});

const sample = (perf, procs = []) => ({ at: 0, procs, perf: new Map(perf.map(p => [p.pid, { cpu: BigInt(p.cpu), ts: BigInt(p.ts) }])), cpuTotal: null, os: null });

test('cpuPercents: delta of processor time over wall time and cores', () => {
  // 10 s wall = 100_000_000 ticks. One core busy the whole time on 16 cores is 6.25%.
  const prev = sample([{ pid: 7, cpu: 0, ts: BASE }]);
  const next = sample([{ pid: 7, cpu: 100000000, ts: plus(BASE, 100000000) }]);
  assert.strictEqual(S.cpuPercents(prev, next, 16).get(7), 6.25);
  assert.strictEqual(S.cpuPercents(prev, next, 1).get(7), 100);
});

test('cpuPercents: a first sample, a zero or backwards clock, a counter that went down: null', () => {
  const a = sample([{ pid: 7, cpu: 500, ts: BASE }]);
  const b = sample([{ pid: 7, cpu: 900, ts: plus(BASE, 100) }]);
  assert.strictEqual(S.cpuPercents(null, b, 4).get(7), null, 'first sample');
  assert.strictEqual(S.cpuPercents(a, a, 4).get(7), null, 'zero delta wall');
  assert.strictEqual(S.cpuPercents(b, a, 4).get(7), null, 'clock went back');
  const wrapped = sample([{ pid: 7, cpu: 100, ts: plus(BASE, 200) }]);
  assert.strictEqual(S.cpuPercents(b, wrapped, 4).get(7), null, 'counter went down');
  assert.strictEqual(S.cpuPercents(a, b, 0).get(7), null, 'no cores known');
  assert.strictEqual(S.cpuPercents(a, b, NaN).get(7), null);
});

test('cpuPercents: a pid that is new in the second sample has no delta, not zero', () => {
  const a = sample([{ pid: 1, cpu: 0, ts: BASE }]);
  const b = sample([{ pid: 1, cpu: 10, ts: plus(BASE, 100) }, { pid: 2, cpu: 50, ts: plus(BASE, 100) }]);
  const m = S.cpuPercents(a, b, 1);
  assert.strictEqual(m.get(2), null);
  assert.strictEqual(typeof m.get(1), 'number');
});

test('cpuPercents: a reused pid (its start time changed between samples) is null', () => {
  const a = sample([{ pid: 9, cpu: 0, ts: BASE }], [proc(9, 1, 111)]);
  const b = sample([{ pid: 9, cpu: 90, ts: plus(BASE, 100) }], [proc(9, 1, 222)]);
  assert.strictEqual(S.cpuPercents(a, b, 1).get(9), null);
  const same = sample([{ pid: 9, cpu: 90, ts: plus(BASE, 100) }], [proc(9, 1, 111)]);
  assert.strictEqual(S.cpuPercents(a, same, 1).get(9), 90);
});

test('machineCpu: 100 x (1 - idle delta / wall delta), clamped, null when it cannot be told', () => {
  const t0 = { idle: 1000n, ts: BigInt(BASE) };
  const half = { idle: 1500n, ts: BigInt(BASE) + 1000n };
  assert.strictEqual(S.machineCpu({ cpuTotal: t0 }, { cpuTotal: half }), 50);
  const idleAll = { idle: 2000n, ts: BigInt(BASE) + 1000n };
  assert.strictEqual(S.machineCpu({ cpuTotal: t0 }, { cpuTotal: idleAll }), 0);
  const over = { idle: 900n, ts: BigInt(BASE) + 1000n };       // idle counter went down
  assert.strictEqual(S.machineCpu({ cpuTotal: t0 }, { cpuTotal: over }), null, 'a counter that went down is not a measurement');
  const tooIdle = { idle: 5000n, ts: BigInt(BASE) + 1000n };   // more idle than wall: clamp, don't go negative
  assert.strictEqual(S.machineCpu({ cpuTotal: t0 }, { cpuTotal: tooIdle }), 0);
  assert.strictEqual(S.machineCpu(null, { cpuTotal: half }), null);
  assert.strictEqual(S.machineCpu({ cpuTotal: null }, { cpuTotal: half }), null);
  assert.strictEqual(S.machineCpu({ cpuTotal: t0 }, { cpuTotal: t0 }), null, 'zero wall delta');
});

test('machineMemory: used is total minus free; null when the OS part is absent or nonsense', () => {
  assert.deepStrictEqual(S.machineMemory({ os: { totalBytes: 1000, freeBytes: 250 } }), { usedBytes: 750, totalBytes: 1000 });
  assert.strictEqual(S.machineMemory({ os: null }), null);
  assert.strictEqual(S.machineMemory(null), null);
  assert.strictEqual(S.machineMemory({ os: { totalBytes: 100, freeBytes: 200 } }), null, 'free over total is not a reading');
});

test('property: a process percentage is null or finite and not negative, and an absent previous sample never yields a number', () => {
  const rowArb = fc.record({ pid: fc.integer({ min: 1, max: 20 }), cpu: fc.bigInt({ min: 0n, max: 10n ** 12n }), ts: fc.bigInt({ min: 1n, max: 10n ** 12n }) });
  const sampleArb = fc.array(rowArb, { maxLength: 15 }).map(rows => ({
    at: 0, procs: [], cpuTotal: null, os: null, perf: new Map(rows.map(r => [r.pid, { cpu: r.cpu, ts: r.ts }])),
  }));
  fc.assert(fc.property(sampleArb, sampleArb, fc.integer({ min: 1, max: 64 }), (a, b, cores) => {
    for (const v of S.cpuPercents(a, b, cores).values()) {
      assert.ok(v === null || (Number.isFinite(v) && v >= 0), String(v));
    }
    for (const v of S.cpuPercents(null, b, cores).values()) assert.strictEqual(v, null);
  }));
});
