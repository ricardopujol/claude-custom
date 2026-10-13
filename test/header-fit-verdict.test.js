'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { headerFitVerdict } = require('../verify/lib/header-fit-verdict');

const W = [1000, 1200, 1600];
const text = (v) => v.lines.join('\n');

test('headerFitVerdict: every width measured, nothing failed: clean, exit 0', () => {
  const v = headerFitVerdict({ widths: W, measured: W, failures: 0, error: null, baseline: false });
  assert.equal(v.exitCode, 0);
  assert.match(text(v), /no clipping/);
});

test('headerFitVerdict: a real clip on measured widths says so and exits 1', () => {
  const v = headerFitVerdict({ widths: W, measured: W, failures: 2, error: null, baseline: false });
  assert.equal(v.exitCode, 1);
  assert.match(text(v), /2 check\(s\) failed/);
  assert.match(text(v), /clip/);
});

test('headerFitVerdict: a baseline run that measured everything records clips and exits 0', () => {
  const v = headerFitVerdict({ widths: W, measured: W, failures: 3, error: null, baseline: true });
  assert.equal(v.exitCode, 0);
  assert.match(text(v), /baseline/);
});

test('headerFitVerdict: an error before any width was measured never says "clip" or "no clipping"; exit 2', () => {
  const v = headerFitVerdict({ widths: W, measured: [], failures: 1, error: 'ReferenceError: renderUsage is not defined', baseline: false });
  assert.equal(v.exitCode, 2);
  const t = text(v);
  assert.match(t, /could not measure width 1000: ReferenceError: renderUsage is not defined/);
  assert.match(t, /could not measure width 1600/);
  assert.doesNotMatch(t, /width\(s\) clip/);
  assert.doesNotMatch(t, /no clipping/);
});

test('headerFitVerdict: only the widths that were not reached are named as unmeasured', () => {
  const v = headerFitVerdict({ widths: W, measured: [1000], failures: 0, error: 'page load failed after 3 attempts: x', baseline: false });
  assert.equal(v.exitCode, 2);
  const t = text(v);
  assert.doesNotMatch(t, /could not measure width 1000/);
  assert.match(t, /could not measure width 1200: page load failed/);
  assert.match(t, /could not measure width 1600/);
});

test('headerFitVerdict: BASELINE=1 with nothing measured is not clean: exit 2, no "no clipping"', () => {
  const v = headerFitVerdict({ widths: W, measured: [], failures: 1, error: 'capture of x stayed empty', baseline: true });
  assert.equal(v.exitCode, 2);
  assert.doesNotMatch(text(v), /no clipping/);
  assert.match(text(v), /could not measure width 1200: capture of x stayed empty/);
});

test('headerFitVerdict: unmeasured widths with no error text still fail, and say why unknown', () => {
  const v = headerFitVerdict({ widths: W, measured: [1000, 1200], failures: 0, error: null, baseline: false });
  assert.equal(v.exitCode, 2);
  assert.match(text(v), /could not measure width 1600: unknown error/);
});

test('headerFitVerdict: clips on measured widths plus an unmeasured one reports both, exit 2', () => {
  const v = headerFitVerdict({ widths: W, measured: [1000, 1200], failures: 1, error: 'boom', baseline: false });
  assert.equal(v.exitCode, 2);
  assert.match(text(v), /1 check\(s\) failed/);
  assert.match(text(v), /could not measure width 1600: boom/);
});
