'use strict';
/**
 * The roster width policy. Miguel, PR #33 review, A1.
 *
 * Three tuned numbers — MIN 120, FLOOR 420, SHARE 0.55 — none of which was
 * asserted anywhere while the clamp lived inline in renderer.js, and none of
 * which any mutation score can reach, because StrykerJS generates no mutants
 * for numeric literals. Explicit boundaries are the only instrument here.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  rosterWidth, rosterMax, faceSize, ROSTER_MIN, ROSTER_FLOOR, ROSTER_SHARE,
} = require('../app/roster-width');

test('a width that fits is returned unchanged', () => {
  assert.strictEqual(rosterWidth(300, 1200), 300);
});

test('THE REGRESSION: a stored width wider than the window is clamped to it', () => {
  // The bug A1 reports. Drag to 1892px on a 3440px monitor, then open the same
  // window at 1366px: before this, nothing re-clamped and the panel was wider
  // than the window, eating the terminal entirely.
  const wide = rosterWidth(1892, 3440);
  assert.strictEqual(wide, 1892, 'precondition: it fits on the big monitor');
  assert.ok(rosterWidth(wide, 1366) < 1366,
    'the panel must never be wider than the window it lives in');
  // 55% of 1366 is 751, which is above the 420 floor, so the proportion
  // governs here rather than the floor. Asserted against the cap rather than
  // against a literal, so the two constants cannot disagree with this test.
  assert.strictEqual(rosterWidth(wide, 1366), rosterMax(1366));
});

test('the cap is proportional to the window above the floor', () => {
  assert.strictEqual(rosterMax(3440), Math.round(3440 * ROSTER_SHARE));
  assert.strictEqual(rosterWidth(99999, 3440), Math.round(3440 * ROSTER_SHARE));
});

test('the cap never falls below the old flat 420, however small the window', () => {
  // A lower bound on the CAP, so a small screen is no worse off than it was
  // before FF5 made the cap proportional.
  assert.strictEqual(rosterMax(100), ROSTER_FLOOR);
  assert.strictEqual(rosterMax(0), ROSTER_FLOOR);
  assert.strictEqual(rosterWidth(99999, 100), ROSTER_FLOOR);
});

test('the floor and the share meet exactly where they should', () => {
  // The boundary between the two regimes: below this window width the flat
  // floor governs, above it the proportion does. Asserted because it is the
  // one value where changing either constant is invisible from either side.
  const crossover = Math.round(ROSTER_FLOOR / ROSTER_SHARE);
  assert.strictEqual(rosterMax(crossover), Math.round(crossover * ROSTER_SHARE));
  assert.ok(rosterMax(crossover - 100) === ROSTER_FLOOR);
});

test('a width below the minimum is raised to it', () => {
  assert.strictEqual(rosterWidth(10, 1200), ROSTER_MIN);
  assert.strictEqual(rosterWidth(ROSTER_MIN - 1, 1200), ROSTER_MIN);
  assert.strictEqual(rosterWidth(ROSTER_MIN, 1200), ROSTER_MIN);
});

test('a corrupt stored width yields the minimum, never NaN', () => {
  // `width:NaNpx` is a declaration the browser drops, and the panel then takes
  // its auto width — a broken value rendering as a deliberate one. localStorage
  // holds strings and can hold anything at all.
  for (const bad of [NaN, Infinity, -Infinity, null, undefined, '300', {}, []]) {
    const w = rosterWidth(bad, 1200);
    assert.ok(Number.isFinite(w), `rosterWidth(${JSON.stringify(bad)}) must be finite, got ${w}`);
    assert.strictEqual(w, ROSTER_MIN);
  }
});

test('an unknown window size still yields a usable width', () => {
  // innerWidth is absent in some contexts and 0 during teardown.
  assert.strictEqual(rosterWidth(300, undefined), 300);
  assert.ok(Number.isFinite(rosterWidth(300, NaN)));
});

test('the face grows with the panel and stays a portrait', () => {
  assert.strictEqual(faceSize(ROSTER_MIN), 28, 'the minimum panel gives the minimum face');
  assert.ok(faceSize(180) > 35 && faceSize(180) < 50, 'the default panel gives a readable face');
  assert.ok(faceSize(300) > faceSize(180), 'wider panel buys a bigger portrait');
  assert.strictEqual(faceSize(99999), 150, 'capped: a portrait, not a poster');
  assert.strictEqual(faceSize(NaN), 28);
});
