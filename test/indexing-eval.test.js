'use strict';
/**
 * The accuracy gate's arithmetic (verify/lib/indexing-eval.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Accuracy
 * gate"): a note is right when its kind AND its target are both right; a swap is a history answer for a backlog note,
 * or a backlog answer for a history note, and any swap fails the gate; the bar is 85%.
 */
const test = require('node:test');
const assert = require('node:assert');

const ev = require('../verify/lib/indexing-eval');

const C = (kind, target) => ({ kind, target });

test('backlogFor: the title lines, minus the item a "new" note created', () => {
  const titles = ['## 1. a', '## 2. b', '## 3. c'];
  assert.strictEqual(ev.backlogFor(titles, { exclude: 2 }), '# Backlog\n\n## 1. a\n## 3. c\n');
  assert.strictEqual(ev.backlogFor(titles, {}), '# Backlog\n\n## 1. a\n## 2. b\n## 3. c\n');
});

test('judge: right only when kind and target both match', () => {
  assert.strictEqual(ev.judge(C('idea', 'new'), C('idea', 'new')).right, true);
  assert.strictEqual(ev.judge(C('idea', 'new'), C('bug', 'new')).right, false);
  assert.strictEqual(ev.judge(C('idea', 61), C('idea', 63)).right, false);
  assert.strictEqual(ev.judge(C('learning', 'history'), C('decision', 'history')).right, false);
  assert.strictEqual(ev.judge(C('idea', 'new'), C(null, null)).right, false);
});

test('judge: a swap is history for a backlog note or the backlog for a history note; nothing else is', () => {
  assert.strictEqual(ev.judge(C('decision', 'history'), C('decision', 61)).swap, true);
  assert.strictEqual(ev.judge(C('decision', 'history'), C('idea', 'new')).swap, true);
  assert.strictEqual(ev.judge(C('idea', 61), C('learning', 'history')).swap, true);
  assert.strictEqual(ev.judge(C('idea', 61), C('idea', 'new')).swap, false);
  assert.strictEqual(ev.judge(C('idea', 61), C(null, null)).swap, false, 'no answer is wrong, but not a swap');
  assert.strictEqual(ev.judge(C('learning', 'history'), C('decision', 'history')).swap, false);
});

test('summarize: score, percent, swaps and the gate (>= 85% and no swap)', () => {
  const rows = (rights, swaps, total) => Array.from({ length: total }, (_, i) => ({ right: i < rights, swap: i >= total - swaps }));
  const pass = ev.summarize(rows(17, 0, 20));
  assert.deepStrictEqual({ right: pass.right, total: pass.total, pct: pass.pct, swaps: pass.swaps, passed: pass.passed },
    { right: 17, total: 20, pct: 85, swaps: 0, passed: true });
  assert.strictEqual(ev.summarize(rows(16, 0, 20)).passed, false, '80% is under the bar');
  assert.strictEqual(ev.summarize(rows(19, 1, 20)).passed, false, 'one swap fails the gate');
  assert.strictEqual(ev.summarize([]).passed, false, 'nothing measured passes nothing');
});
