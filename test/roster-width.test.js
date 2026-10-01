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

test('the roster may take slightly more than half the window, and never two thirds', () => {
  // Miguel, PR #33, R6. Every other assertion about ROSTER_SHARE is written
  // AGAINST ROSTER_SHARE, so it is true for every value of the constant.
  // Measured sabotage: 0.60, 0.75, 0.90 and 0.99 all passed nine tests, with
  // the roster permitted 99% of the window and the terminal reduced to a
  // sliver -- precisely what the constant exists to prevent.
  //
  // That is R3's lesson one file over: the module header named the correct
  // instrument ("explicit boundaries are the only instrument") and then wrote
  // self-referential assertions, which are not boundaries.
  //
  // This pins the RULE rather than the digits. `assert.strictEqual(SHARE, 0.55)`
  // would pin the number without pinning the point, and would have to be
  // edited by anyone changing it -- which is how a constant gets changed and
  // its reason does not.
  assert.ok(ROSTER_SHARE > 0.5,
    'the roster is allowed slightly more than half, so a portrait and a full name fit');
  assert.ok(ROSTER_SHARE <= 0.66,
    'but never two thirds -- the terminal is the thing the harness exists to show');

  // And behaviourally, on a real laptop width, so the bound is not only arithmetic.
  const laptop = 1366;
  assert.ok(rosterMax(laptop) > laptop / 2);
  assert.ok(rosterMax(laptop) < laptop * 0.67,
    `the terminal must keep a third of a ${laptop}px window, got ${laptop - rosterMax(laptop)}px`);
});

test('a resize does not destroy the width the user chose', () => {
  // R5's round trip, asserted on the policy the renderer applies. The renderer
  // half (persist only from the drag path) is what makes this reachable; this
  // pins that the CLAMP itself is non-destructive -- re-widening recovers the
  // original request rather than the clamped one.
  const chosen = 1892;
  assert.strictEqual(rosterWidth(chosen, 3440), chosen);
  const onSmall = rosterWidth(chosen, 1366);
  assert.ok(onSmall < chosen, 'it must clamp on the smaller window');
  assert.strictEqual(rosterWidth(chosen, 3440), chosen,
    'and re-widening must recover the chosen width, not the clamped one');
});

test('persistence fails CLOSED: only an explicit choice is stored', () => {
  // R5's lesson, restated for the dock zones (layout pass L1). A width was once
  // stored from the load path and from every window resize, and a narrow
  // window destroyed the only copy of the user's choice. The rule is the same
  // now that every zone has a grip: a size is SAVED only when a human releases
  // a grip; a load and a window resize only DRAW.
  //
  // This asserts the SOURCE, because the call sites live in renderer.js where
  // nothing renders. Comments stripped first: prose describing the rule must
  // not satisfy the detector for it (test/bridge-contract.test.js's lesson).
  const fs = require('fs');
  const path = require('path');
  const raw = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  const NL = String.fromCharCode(10);
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '')
                 .replace(new RegExp('^\\s*//[^' + NL + ']*', 'gm'), '');

  const grips = src.slice(src.indexOf('(function initZoneGrips() {'), src.indexOf('})();', src.indexOf('(function initZoneGrips() {')));
  assert.ok(grips.length > 100, 'the grip code must be findable for this check to mean anything');

  // COUNT THE SAVES, don't parse the calls (Mortimer, PR #33: a pattern that
  // matched the call's shape waved a second persisting site through).
  const saves = [...grips.matchAll(/commitPlacement\(/g)];
  assert.strictEqual(saves.length, 1, `exactly one grip path may save; found ${saves.length}`);
  const up = grips.indexOf("addEventListener('mouseup'");
  const move = grips.indexOf("addEventListener('mousemove'");
  assert.ok(up !== -1 && move !== -1 && saves[0].index > up,
    'the one save must be on release -- a human choosing a size -- never while moving');

  // And the window resize only draws.
  const at = src.indexOf("window.addEventListener('resize', () => {");
  assert.ok(at !== -1, 'the resize listener must be findable');
  const onResize = src.slice(at, src.indexOf('});', src.indexOf('requestAnimationFrame', at)));
  assert.match(onResize, /renderLayout\(\)/);
  assert.doesNotMatch(onResize, /commitPlacement|layout\.set|localStorage\.setItem/);
});
