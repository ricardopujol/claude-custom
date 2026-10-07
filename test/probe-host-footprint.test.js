'use strict';
/**
 * The pure parts of verify/probe-host-footprint.js (BACKLOG #74 D): turning a series of
 * (time, private bytes, CPU seconds) samples into MB, CPU-s/hour and a leak-vs-churn verdict.
 *
 * The verdict must come from the FLOOR of the series, not its last point: the main host was seen
 * swinging 743 -> 317 MB inside a minute, which is garbage collection (churn), and one high sample
 * is not a leak. A leak is a floor that keeps rising.
 */
const test = require('node:test');
const assert = require('node:assert');
const { summarise, parseHosts, floorSlope } = require('../verify/probe-host-footprint.js');

const MB = 1048576;
const MIN = 60000;
const s = (tMin, mb, cpu) => ({ t: tMin * MIN, priv: mb * MB, ws: mb * MB, cpu, handles: 300, threads: 15 });

test('CPU-s/hour is the CPU delta scaled to an hour, not the lifetime total', () => {
  const r = summarise([s(0, 100, 1000), s(30, 100, 1030)]);
  assert.strictEqual(r.cpuPerHour, 60);
});

test('a flat series is stable', () => {
  const series = [];
  for (let i = 0; i <= 60; i += 5) series.push(s(i, 100, i));
  const r = summarise(series);
  assert.strictEqual(r.verdict, 'stable');
  assert.strictEqual(r.minMB, 100);
  assert.strictEqual(r.maxMB, 100);
});

test('a sawtooth that returns to the same floor is churn, not a leak', () => {
  const series = [];
  for (let i = 0; i <= 60; i += 2) series.push(s(i, i % 10 === 0 ? 100 : 400, i));
  const r = summarise(series);
  assert.strictEqual(r.verdict, 'churn');
  assert.ok(Math.abs(r.floorSlopeMBPerHour) < 5, `floor slope ${r.floorSlopeMBPerHour}`);
});

test('a floor that keeps rising is a leak even when it sawtooths', () => {
  const series = [];
  for (let i = 0; i <= 60; i += 2) series.push(s(i, 100 + i * 2 + (i % 4 === 0 ? 0 : 150), i));
  const r = summarise(series);
  assert.strictEqual(r.verdict, 'leak');
  assert.ok(r.floorSlopeMBPerHour > 100, `floor slope ${r.floorSlopeMBPerHour}`);
});

test('fewer than two samples is "unknown", never a confident zero', () => {
  assert.strictEqual(summarise([]).verdict, 'unknown');
  assert.strictEqual(summarise([s(0, 100, 1)]).verdict, 'unknown');
  assert.strictEqual(summarise([s(0, 100, 1)]).cpuPerHour, null);
});

test('samples whose time does not advance do not divide by zero', () => {
  const r = summarise([s(0, 100, 1), s(0, 100, 2)]);
  assert.strictEqual(r.verdict, 'unknown');
  assert.strictEqual(r.cpuPerHour, null);
});

test('floorSlope ignores a single early spike', () => {
  const series = [s(0, 900, 0)];
  for (let i = 5; i <= 60; i += 5) series.push(s(i, 100, i));
  assert.ok(floorSlope(series) <= 0);
});

test('parseHosts keeps only electron processes whose command line ends in host/host.js', () => {
  const rows = [
    { ProcessId: 1, Name: 'electron.exe', CommandLine: 'C:\\x\\electron.exe C:\\x\\host\\host.js' },
    { ProcessId: 2, Name: 'electron.exe', CommandLine: 'C:\\x\\electron.exe C:\\x\\app\\main.js' },
    { ProcessId: 3, Name: 'electron.exe', CommandLine: 'C:\\x\\electron.exe C:\\x\\host\\host.js.bak' },
    { ProcessId: 4, Name: 'node.exe', CommandLine: 'node C:\\x\\host\\host.js' },
    { ProcessId: 5, Name: 'electron.exe', CommandLine: '"C:\\x\\electron.exe" "C:\\x\\host\\host.js"' },
    { ProcessId: 6, Name: 'electron.exe', CommandLine: null },
  ];
  assert.deepStrictEqual(parseHosts(rows).map(r => r.ProcessId), [1, 5]);
});

test('a run shorter than ten minutes never claims a leak (a 6 s climb is a burst, not a trend)', () => {
  const r = summarise([s(0, 100, 0), s(0.1, 700, 5)]);
  assert.strictEqual(r.verdict, 'too-short');
  assert.strictEqual(typeof r.maxMB, 'number');
});

test('parseQuery turns garbage or truncated PowerShell output into "no rows", never a crash', () => {
  const { parseQuery } = require('../verify/probe-host-footprint.js');
  assert.deepStrictEqual(parseQuery(''), []);
  assert.deepStrictEqual(parseQuery('{"ProcessId":1,"CommandLine":"abc'), []);
  assert.deepStrictEqual(parseQuery('{"ProcessId":1}'), [{ ProcessId: 1 }]);
  assert.deepStrictEqual(parseQuery('[{"ProcessId":1},{"ProcessId":2}]').length, 2);
});
