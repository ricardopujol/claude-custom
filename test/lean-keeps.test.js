'use strict';
/**
 * Lean mode keeps the Schedules panel mounted (PR #200, Ricardo 2026-10-21): its content is the night itself, so it must stay
 * live while a /bedtime night runs. Every other panel is unmounted exactly as before.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../app/lean-display');

test('LEAN_KEEPS names the Schedules panel and nothing else', () => {
  assert.deepStrictEqual([...L.LEAN_KEEPS], ['schedules']);
});

test('leanShown: lean keeps schedules mounted and unmounts every other panel', () => {
  const shown = new Set(['git', 'schedules', 'vault', 'agents']);
  assert.deepStrictEqual([...L.leanShown(shown, true)], ['schedules']);
});

test('leanShown: lean with schedules not on the dock mounts nothing (the exemption never adds a panel)', () => {
  assert.deepStrictEqual([...L.leanShown(new Set(['git', 'vault']), true)], []);
});

test('leanShown: not lean is the plan untouched', () => {
  const shown = new Set(['git', 'schedules']);
  assert.deepStrictEqual([...L.leanShown(shown, false)], ['git', 'schedules']);
});

test('leanShown: only a real true is lean (absence is not lean)', () => {
  const shown = new Set(['git']);
  assert.deepStrictEqual([...L.leanShown(shown, undefined)], ['git']);
  assert.deepStrictEqual([...L.leanShown(shown, 'yes')], ['git']);
});

test('renderLayout takes its shown set from leanShown, so Schedules stays mounted under lean', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  assert.match(src, /const now = leanDisplay\.leanShown\(plan\.shown, leanOn\)/);
});
