'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { median, summariseSamples, gpuPercent, table } = require('../verify/probe-anim-cost');

test('median: the middle of the sorted values, null for none', () => {
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([]), null);
});

test('summariseSamples: per process type, the median CPU and private MB over the samples', () => {
  const s = (cpu, kb) => ({ byType: { renderer: { count: 2, cpu, privateKB: kb } } });
  const r = summariseSamples([s(10, 2048), s(30, 4096), s(20, 3072)]);
  assert.deepStrictEqual(r.renderer, { count: 2, cpu: 20, privateMB: 3 });
});

test('summariseSamples: a type missing from some samples is judged on the samples that have it', () => {
  const r = summariseSamples([{ byType: { gpu: { count: 1, cpu: 5, privateKB: 1024 } } }, { byType: {} }]);
  assert.strictEqual(r.gpu.cpu, 5);
});

test('gpuPercent: sums the wanted pids per sample time, takes the median over time, ignores other pids', () => {
  const c = [
    { at: 1, name: 'pid_10_luid_x_eng_0', value: 4 }, { at: 1, name: 'pid_11_luid_x_eng_1', value: 6 }, { at: 1, name: 'pid_99_luid_x', value: 50 },
    { at: 2, name: 'pid_10_luid_x_eng_0', value: 2 },
    { at: 3, name: 'pid_11_luid_x_eng_0', value: 8 },
  ];
  assert.strictEqual(gpuPercent(c, [10, 11]), 8);
  assert.strictEqual(gpuPercent([], [10]), null);
});

test('table: n/a for a number that was not measured, never a zero', () => {
  const t = table([{ variant: 'gif', byType: { renderer: { cpu: 12.34, privateMB: 100 } }, gpuPercent: null }]);
  assert.match(t, /\| gif \| 12\.3 \|/);
  assert.match(t, /n\/a \|$/m);
});
