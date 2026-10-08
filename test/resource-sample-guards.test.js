'use strict';
// host/resource-sample.js parseSample / machineMemory: each guard hit by ONE bad field in an otherwise good row, because a
// row with two defects lets its neighbour mask the clause. Release #117 Mortimer survivor 5.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../host/resource-sample');

const BOM = String.fromCharCode(0xfeff);
const good = () => ({ pid: 5, ppid: 2, name: 'node.exe', cmd: 'node a.js', start: '133000000000000000', priv: 1024 });
const parse = (procs, extra = {}) => S.parseSample(JSON.stringify({ procs, perf: [], cpu: null, os: null, ...extra }) + 'END', 0);
const one = (over) => parse([{ ...good(), ...over }]).procs;

test('parseSample: the good row is accepted exactly as written (the control)', () => {
  assert.deepStrictEqual(one({}), [{ pid: 5, ppid: 2, name: 'node.exe', cmd: 'node a.js', start: '133000000000000000', priv: 1024, threads: null, handles: null }]);
});

test('proc pid: only a positive integer is a process', () => {
  for (const pid of [0, -1, 1.5, '5', null, undefined, NaN]) assert.deepStrictEqual(one({ pid }), [], String(pid));
  assert.strictEqual(one({ pid: 1 }).length, 1);
  assert.deepStrictEqual(parse([null, 'x', [], 7]).procs, []);
});

test('proc ppid: a non-negative integer is kept, anything else becomes 0', () => {
  assert.strictEqual(one({ ppid: 0 })[0].ppid, 0);
  assert.strictEqual(one({ ppid: 1 })[0].ppid, 1);
  for (const ppid of [-1, 1.5, '2', null, undefined]) assert.strictEqual(one({ ppid })[0].ppid, 0, String(ppid));
});

test('proc name: a string is kept (empty included), anything else is the empty string', () => {
  assert.strictEqual(one({ name: '' })[0].name, '');
  for (const name of [5, null, undefined, {}]) assert.strictEqual(one({ name })[0].name, '', String(name));
});

test('proc cmd: a non-empty string is kept, an empty or non-string one is null', () => {
  assert.strictEqual(one({ cmd: 'x' })[0].cmd, 'x');
  for (const cmd of ['', 5, null, undefined]) assert.strictEqual(one({ cmd })[0].cmd, null, String(cmd));
});

test('proc start: digits (a string, or a safe non-negative integer) become a string; anything else is null', () => {
  assert.strictEqual(one({ start: '0' })[0].start, '0');
  assert.strictEqual(one({ start: 0 })[0].start, '0');
  assert.strictEqual(one({ start: 12 })[0].start, '12');
  for (const start of ['x1', '1x', '', '-1', '1.5', ' 1', '1\n', -1, 1.5, 2 ** 60, null, undefined, {}]) {
    assert.strictEqual(one({ start })[0].start, null, String(start));
  }
});

test('proc priv: a finite non-negative number is kept, anything else is null', () => {
  assert.strictEqual(one({ priv: 0 })[0].priv, 0);
  for (const priv of [-1, NaN, '5', null, undefined, Infinity]) assert.strictEqual(one({ priv })[0].priv, null, String(priv));
});

test('perf rows: pid 0 is accepted (the idle process), a negative or fractional pid is not', () => {
  const perf = (r) => S.parseSample(JSON.stringify({ procs: [], perf: [r], cpu: null, os: null }) + 'END', 0).perf;
  const ok = { pid: 0, cpu: '10', ts: '20', wsp: 7 };
  assert.deepStrictEqual([...perf(ok)], [[0, { cpu: 10n, ts: 20n, ws: 7 }]]);
  for (const bad of [{ ...ok, pid: -1 }, { ...ok, pid: 1.5 }, { ...ok, cpu: '-1' }, { ...ok, cpu: 'x1' }, { ...ok, cpu: '1x' }, { ...ok, ts: 'x1' }, { ...ok, ts: '1x' }, { ...ok, ts: -1 }, { ...ok, cpu: null }, null]) {
    assert.strictEqual(perf(bad).size, 0, JSON.stringify(bad));
  }
  assert.strictEqual(perf({ ...ok, wsp: 'x1' }).get(0).ws, null);
  assert.strictEqual(perf({ ...ok, wsp: '1x' }).get(0).ws, null);
  assert.strictEqual(perf({ ...ok, wsp: -1 }).get(0).ws, null);
  assert.strictEqual(perf({ ...ok, wsp: '0' }).get(0).ws, 0);
  assert.strictEqual(perf({ ...ok, wsp: 0 }).get(0).ws, 0);
});

test('cpu total: idle and ts must both be digits', () => {
  const total = (c) => S.parseSample(JSON.stringify({ procs: [], perf: [], cpu: c, os: null }) + 'END', 0).cpuTotal;
  assert.deepStrictEqual(total({ idle: '5', ts: '6' }), { idle: 5n, ts: 6n });
  assert.deepStrictEqual(total({ idle: 0, ts: 0 }), { idle: 0n, ts: 0n });
  for (const bad of [{ idle: 'x1', ts: '6' }, { idle: '1x', ts: '6' }, { idle: '5', ts: 'x1' }, { idle: '5', ts: '6x' }, { idle: -1, ts: '6' }, { idle: '5' }, null, [], 'x']) {
    assert.strictEqual(total(bad), null, JSON.stringify(bad));
  }
});

test('os: total must be positive and free non-negative, both finite numbers', () => {
  const os = (o) => S.parseSample(JSON.stringify({ procs: [], perf: [], cpu: null, os: o }) + 'END', 0).os;
  assert.deepStrictEqual(os({ totalKb: 2, freeKb: 1 }), { totalBytes: 2048, freeBytes: 1024 });
  assert.deepStrictEqual(os({ totalKb: 2, freeKb: 0 }), { totalBytes: 2048, freeBytes: 0 }, 'zero free is a real reading');
  for (const bad of [{ totalKb: 0, freeKb: 0 }, { totalKb: -1, freeKb: 0 }, { totalKb: 2, freeKb: -1 }, { totalKb: '2', freeKb: 1 }, { totalKb: 2, freeKb: '1' }, { totalKb: 2 }, { freeKb: 1 }, null, []]) {
    assert.strictEqual(os(bad), null, JSON.stringify(bad));
  }
});

test('parseSample: a sample that is not the script\'s output is null', () => {
  assert.strictEqual(S.parseSample(null, 0), null);
  assert.strictEqual(S.parseSample('{"procs":[],"perf":[]}', 0), null, 'no END');
  assert.strictEqual(S.parseSample('{"procs":[]}END', 0), null);
  assert.strictEqual(S.parseSample('{"perf":[]}END', 0), null);
  assert.strictEqual(S.parseSample('[]END', 0), null);
  assert.strictEqual(S.parseSample('{"procs":[],"perf":[]}END', 0).at, 0);
  const bom = `${BOM}{"procs":[],"perf":[]}END\r\n`;
  assert.ok(S.parseSample(bom, 0), 'a leading BOM is stripped');
  assert.strictEqual(S.parseSample(`x${BOM}{"procs":[],"perf":[]}END`, 0), null, 'a BOM that is not at the start is not');
});

test('machineMemory: used is total minus free; the boundaries free === total and free === 0 are accepted, one over is refused', () => {
  assert.deepStrictEqual(S.machineMemory({ os: { totalBytes: 1000, freeBytes: 1000 } }), { usedBytes: 0, totalBytes: 1000 });
  assert.deepStrictEqual(S.machineMemory({ os: { totalBytes: 1000, freeBytes: 0 } }), { usedBytes: 1000, totalBytes: 1000 });
  assert.deepStrictEqual(S.machineMemory({ os: { totalBytes: 1000, freeBytes: 400 } }), { usedBytes: 600, totalBytes: 1000 });
  assert.strictEqual(S.machineMemory({ os: { totalBytes: 1000, freeBytes: 1001 } }), null);
  assert.strictEqual(S.machineMemory({ os: { totalBytes: 0, freeBytes: 0 } }), null);
  assert.strictEqual(S.machineMemory({ os: { totalBytes: -1, freeBytes: 0 } }), null);
  assert.strictEqual(S.machineMemory({ os: { totalBytes: 1000, freeBytes: -1 } }), null);
  assert.strictEqual(S.machineMemory({ os: { totalBytes: 1000 } }), null);
  assert.strictEqual(S.machineMemory({ os: { freeBytes: 1 } }), null);
  assert.strictEqual(S.machineMemory({}), null);
  assert.strictEqual(S.machineMemory(null), null);
});

test('proc priv: a number too big for a double (1e999 parses to Infinity) is not a measured figure', () => {
  const text = '{"procs":[{"pid":5,"priv":1e999},{"pid":6,"priv":2}],"perf":[]}END';
  assert.deepStrictEqual(S.parseSample(text, 0).procs.map(p => p.priv), [null, 2]);
});
