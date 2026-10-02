'use strict';
/**
 * The Rings dial's geometry (documentation/PLAN_GIT_TREE.md Task 9; mock v4). Pure: the model's
 * branches -> one spoke per branch on a fixed dial. Time runs clockwise from 12 o'clock; a spoke's
 * length is its spend (square root), its width its commits, its tip its agent runs; unknown spend
 * is a dashed spoke at the minimum length. The dial never grows: more branches, thinner slices.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { layout, weekOf, DIAL } = require('../app/git-rings');

const b = (name, spend, extra = {}) => ({ name, spend, commits: 1, runs: 0, when: '2026-09-20', ...extra });

test('one spoke per branch, in order, clockwise from just past 12 o\'clock', () => {
  const { spokes } = layout([b('a', 10), b('b', 10)]);
  assert.deepStrictEqual(spokes.map(s => s.name), ['a', 'b']);
  assert.ok(spokes[0].angle > -Math.PI / 2 && spokes[0].angle < spokes[1].angle);
});

test('length is spend on a square-root scale: 4x the spend is 2x the reach past the minimum', () => {
  const { spokes } = layout([b('a', 100), b('b', 400)]);
  const reach = s => Math.hypot(s.x1 - DIAL.cx, s.y1 - DIAL.cy) - DIAL.r0;
  const [ra, rb] = spokes.map(reach);
  assert.ok(Math.abs((rb - DIAL.minLen) / (ra - DIAL.minLen) - 2) < 1e-9, `${ra} ${rb}`);
  assert.ok(Math.abs(rb - (DIAL.r1 - DIAL.r0)) < 1e-9, 'the biggest reaches the rim');
});

test('unknown spend is dashed, at the minimum length; known spend is solid', () => {
  const { spokes } = layout([b('a', null), b('b', 50)]);
  assert.strictEqual(spokes[0].dashed, true);
  assert.ok(Math.abs(Math.hypot(spokes[0].x1 - DIAL.cx, spokes[0].y1 - DIAL.cy) - DIAL.r0 - DIAL.minLen) < 1e-9);
  assert.strictEqual(spokes[1].dashed, false);
});

test('a spend of exactly 0 is drawn at the minimum, solid: known and empty, not unknown', () => {
  const { spokes } = layout([b('a', 0), b('b', 50)]);
  assert.strictEqual(spokes[0].dashed, false);
});

test('width grows with commits and stops at 3; no commit count is the thinnest', () => {
  const w = c => layout([b('a', 1, { commits: c })]).spokes[0].width;
  assert.ok(w(1) < w(9));
  assert.strictEqual(w(10000), 3);
  assert.strictEqual(w(null), 1);
});

test('the tip grows with agent runs, within a cap', () => {
  const t = r => layout([b('a', 1, { runs: r })]).spokes[0].tipR;
  assert.ok(t(0) < t(4));
  assert.ok(t(10000) <= DIAL.maxTip);
});

test('weeks: one arc per week, alternating, covering its branches\' angles', () => {
  const { spokes, weeks } = layout([b('a', 1, { when: '2026-09-14' }), b('b', 1, { when: '2026-09-15' }), b('c', 1, { when: '2026-09-22' })]);
  assert.deepStrictEqual(weeks.map(w => [w.week, w.alt]), [['2026-09-14', false], ['2026-09-21', true]]);
  assert.ok(weeks[0].a0 < spokes[0].angle && weeks[0].a1 > spokes[1].angle);
});

test('a branch with no day is in no week', () => {
  assert.deepStrictEqual(layout([b('a', 1, { when: null })]).weeks, []);
});

test('weekOf: the Monday of the week', () => {
  assert.strictEqual(weekOf('2026-10-01'), '2026-09-28');
  assert.strictEqual(weekOf('2026-09-28'), '2026-09-28');
  assert.strictEqual(weekOf('2026-10-04'), '2026-09-28');
  assert.strictEqual(weekOf(null), null);
  assert.strictEqual(weekOf('garbage'), null);
});

test('no branches is no spokes and no weeks', () => {
  assert.deepStrictEqual(layout([]), { spokes: [], weeks: [] });
});

// ---------- properties ----------
const branchArb = fc.record({
  spend: fc.option(fc.nat(10_000_000), { nil: null }),
  commits: fc.option(fc.nat(500), { nil: null }),
  runs: fc.nat(80),
  when: fc.option(fc.constantFrom('2026-09-11', '2026-09-20', '2026-10-01'), { nil: null }),
});
const listArb = fc.array(branchArb, { maxLength: 400 }).map(l => l.map((x, i) => ({ name: `b${i}`, ...x })));

test('property: every spoke and its tip stay inside the panel', () => {
  fc.assert(fc.property(listArb, list => {
    for (const s of layout(list).spokes) {
      for (const [x, y] of [[s.x0, s.y0], [s.x1, s.y1]]) {
        assert.ok(x - s.tipR >= 0 && x + s.tipR <= DIAL.width, `x ${x}`);
        assert.ok(y - s.tipR >= 0 && y + s.tipR <= DIAL.height, `y ${y}`);
      }
    }
  }));
});

test('property: angles strictly increase in branch order and stay out of the 12 o\'clock gap', () => {
  fc.assert(fc.property(listArb, list => {
    const a = layout(list).spokes.map(s => s.angle);
    const lo = -Math.PI / 2 + DIAL.gap / 2;
    const hi = 3 * Math.PI / 2 - DIAL.gap / 2;
    a.forEach((x, i) => {
      assert.ok(x > lo && x < hi);
      if (i) assert.ok(x > a[i - 1]);
    });
  }));
});

test('property: more spend is never a shorter spoke; equal spend is an equal spoke', () => {
  fc.assert(fc.property(listArb, list => {
    const { spokes } = layout(list);
    const len = s => Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const known = list.map((x, i) => [x.spend, len(spokes[i])]).filter(([sp]) => sp !== null);
    for (const [sa, la] of known) for (const [sb, lb] of known) {
      if (sa < sb) assert.ok(la <= lb + 1e-9);
      if (sa === sb) assert.ok(Math.abs(la - lb) < 1e-9);
    }
  }));
});
