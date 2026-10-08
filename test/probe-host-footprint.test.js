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

// Dexter F3, PR #131: a fitted slope plus a first-minus-last rise can't tell one warm-up step from a ramp. A floor
// that steps 200 -> 300 MB at minute 8 and then stays flat for 52 minutes gave 85.7 MB/h and "leak".
test('a one-time step to a higher flat floor is not a leak (early or mid-run)', () => {
  for (const stepAt of [8, 30]) {
    const series = [];
    for (let i = 0; i <= 60; i += 0.5) series.push(s(i, i < stepAt ? 200 : 300, i));
    const r = summarise(series);
    assert.notStrictEqual(r.verdict, 'leak', `step at minute ${stepAt}: slope ${r.floorSlopeMBPerHour}`);
  }
});

test('a floor that rose and then levelled off for the later windows is not a leak', () => {
  const series = [];
  for (let i = 0; i <= 60; i += 0.5) series.push(s(i, 100 + Math.min(i, 30) * 3, i));
  assert.notStrictEqual(summarise(series).verdict, 'leak');
});

test('a steady clean ramp is still a leak', () => {
  const series = [];
  for (let i = 0; i <= 60; i += 0.5) series.push(s(i, 100 + i * 2, i));
  assert.strictEqual(summarise(series).verdict, 'leak');
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

// Miguel M1, PR #131: `Number('abc')` is NaN, so the run's end was NaN and the loop never broke; `--interval 0`
// respawned PowerShell back to back. Bad values are refused up front with a message.
test('parseArgs refuses a non-numeric, zero, negative or too-small --minutes / --interval', () => {
  const { parseArgs } = require('../verify/probe-host-footprint.js');
  for (const argv of [
    ['--minutes', 'abc'], ['--minutes', '0'], ['--minutes', '-5'], ['--minutes', 'Infinity'], ['--minutes'],
    ['--interval', 'abc'], ['--interval', '0'], ['--interval', '0.5'], ['--interval'],
    ['--pid', 'abc'], ['--pid'],
  ]) {
    const r = parseArgs(argv);
    assert.strictEqual(typeof r.error, 'string', `accepted ${argv.join(' ')}`);
  }
});

test('parseArgs accepts sane values and keeps the defaults', () => {
  const { parseArgs } = require('../verify/probe-host-footprint.js');
  const d = parseArgs([]);
  assert.strictEqual(d.error, undefined);
  assert.strictEqual(d.minutes, 60);
  assert.strictEqual(d.intervalS, 30);
  assert.deepStrictEqual(d.pids, []);
  const r = parseArgs(['--minutes', '8', '--interval', '15', '--pid', '276', '--pid', '12']);
  assert.deepStrictEqual([r.minutes, r.intervalS, r.pids], [8, 15, [276, 12]]);
  assert.strictEqual(parseArgs(['--interval', '1']).intervalS, 1);
});

// Miguel M7, PR #131: an interrupted run (the documented use case for --summarise) can leave a half-written
// last line, and a bare JSON.parse per line threw on it.
test('parseSampleLines skips a half-written or garbled line instead of throwing', () => {
  const { parseSampleLines } = require('../verify/probe-host-footprint.js');
  const text = '{"t":1,"priv":5}\n\n{"t":2,"priv":6}\n{"t":3,"pri';
  assert.deepStrictEqual(parseSampleLines(text), [{ t: 1, priv: 5 }, { t: 2, priv: 6 }]);
});

test('parseArgs gives each run its own default output file, so a previous run is never truncated', () => {
  const { parseArgs } = require('../verify/probe-host-footprint.js');
  const a = parseArgs([], new Date(2026, 9, 8, 13, 5, 7));
  const b = parseArgs([], new Date(2026, 9, 8, 13, 5, 9));
  assert.notStrictEqual(a.out, b.out);
  assert.match(a.out, /host-footprint-20261008-130507\.jsonl$/);
});

test('an explicit --out that already holds samples is refused without --force; empty, missing or forced is fine', () => {
  const { parseArgs, overwriteRefusal } = require('../verify/probe-host-footprint.js');
  const size = (n) => () => n;
  assert.match(overwriteRefusal(parseArgs(['--out', 'x.jsonl']), size(120)), /--force/);
  assert.strictEqual(overwriteRefusal(parseArgs(['--out', 'x.jsonl', '--force']), size(120)), null);
  assert.strictEqual(overwriteRefusal(parseArgs(['--out', 'x.jsonl']), size(0)), null);
  assert.strictEqual(overwriteRefusal(parseArgs(['--out', 'x.jsonl']), size(null)), null);
  assert.strictEqual(overwriteRefusal(parseArgs([]), size(120)), null);   // the per-run default is new each time
});
