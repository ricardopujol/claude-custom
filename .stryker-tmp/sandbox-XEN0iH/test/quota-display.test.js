// @ts-nocheck
'use strict';
/**
 * How a quota meter should be DRAWN, given how well it is known.
 *
 * Extracted from renderer.js for the reason app/usage-display.js and
 * app/career-display.js were: a decision living inside a browser script is a
 * decision nothing can test.
 */
const test = require('node:test');
const assert = require('node:assert');

const { quotaDisplay, formatCountdown, toneFor, UNKNOWN } = require('../app/quota-display');

const NOW = Date.parse('2026-09-15T16:00:00Z');
const win = (over = {}) => ({
  key: 'session', label: '5h', percent: 24, severity: 'normal',
  resetsAt: '2026-09-15T17:37:00Z', isActive: true, lockedReason: null, ...over,
});
const ready = (windows) => ({ ok: true, state: 'fresh', windows });

// --- absence is not zero -------------------------------------------------------

test('before the first read the meters say they are reading, not 0%', () => {
  const d = quotaDisplay(null, NOW);
  assert.strictEqual(d.state, 'reading');
  assert.deepStrictEqual(d.meters, []);
});

test('a failed read is ABSENT and draws no bars at all', () => {
  // A bar at 0% reads as "you have used nothing", which is the opposite of
  // "we could not find out".
  const d = quotaDisplay({ ok: false, state: 'absent', windows: [], error: 'usage endpoint returned 401' }, NOW);
  assert.strictEqual(d.state, 'absent');
  assert.deepStrictEqual(d.meters, []);
  assert.match(d.note, /401|could not/i);
});

test('a good read draws one meter per window', () => {
  const d = quotaDisplay(ready([win(), win({ key: 'weekly_all', label: 'week', percent: 24, isActive: false })]), NOW);
  assert.strictEqual(d.state, 'ready');
  assert.strictEqual(d.meters.length, 2);
  assert.strictEqual(d.meters[0].label, '5h');
  assert.strictEqual(d.meters[0].percent, 24);
});

test('a window with an unknown percent is drawn as unknown, not as zero', () => {
  const d = quotaDisplay(ready([win({ percent: null })]), NOW);
  assert.strictEqual(d.meters[0].percent, null);
  assert.strictEqual(d.meters[0].text, '—');
});

// --- tone ----------------------------------------------------------------------

test("the API's own severity wins when it is not normal", () => {
  // The account knows things we do not -- a scoped window can be throttled at
  // a percentage that looks harmless from here.
  assert.strictEqual(toneFor({ severity: 'warning', percent: 10 }), 'warn');
  assert.strictEqual(toneFor({ severity: 'critical', percent: 10 }), 'critical');
});

test('with normal severity the tone follows the percentage', () => {
  assert.strictEqual(toneFor({ severity: 'normal', percent: 10 }), 'normal');
  assert.strictEqual(toneFor({ severity: 'normal', percent: 85 }), 'warn');
  assert.strictEqual(toneFor({ severity: 'normal', percent: 96 }), 'critical');
});

test('a locked window is critical whatever the numbers say', () => {
  assert.strictEqual(toneFor({ severity: 'normal', percent: 12, lockedReason: 'limit_reached' }), 'critical');
});

test('an unknown percent has no tone to claim', () => {
  assert.strictEqual(toneFor({ severity: 'normal', percent: null }), 'unknown');
});

// --- the countdown -------------------------------------------------------------

test('the countdown is the time until reset, not the timestamp', () => {
  // "resets 17:37Z" makes you do arithmetic while watching a bar fill up.
  assert.strictEqual(formatCountdown('2026-09-15T17:37:00Z', NOW), '1h37m');
  assert.strictEqual(formatCountdown('2026-09-15T16:45:00Z', NOW), '45m');
  assert.strictEqual(formatCountdown('2026-09-21T18:00:00Z', NOW), '6d2h');
});

test('a reset in the past reads as due, never as a negative countdown', () => {
  assert.strictEqual(formatCountdown('2026-09-15T15:00:00Z', NOW), 'due');
});

test('a missing or unparseable reset is unknown, not zero', () => {
  assert.strictEqual(formatCountdown(null, NOW), '—');
  assert.strictEqual(formatCountdown('not a date', NOW), '—');
});

// --- the tooltip ---------------------------------------------------------------

test('the tooltip says which window, how much, and when it resets', () => {
  const d = quotaDisplay(ready([win()]), NOW);
  const title = d.meters[0].title;
  assert.match(title, /5h/);
  assert.match(title, /24%/);
  assert.match(title, /1h37m/);
});

test('the tooltip names the active window as the binding one', () => {
  const d = quotaDisplay(ready([win({ isActive: true })]), NOW);
  assert.match(d.meters[0].title, /currently the binding limit/i);
});

test('a percentage is never described as tokens or dollars', () => {
  // This plan reports no money and no token counts -- only percent. Inventing
  // either would be the fabrication the display audit exists to catch.
  const d = quotaDisplay(ready([win()]), NOW);
  assert.ok(!/token|\$|dollar/i.test(d.meters[0].title), d.meters[0].title);
});

// --- boundaries, pinned literally (Stryker survivors + Dexter F7) ---------------

test('real usage below half a percent is "<1%", not the one sentence this file bans', () => {
  // Dexter, 2026-09-17: percent 0.4 drew "0% used" -- "a meter at 0% says you
  // have used nothing. That is a CLAIM, and a false one." The twin module
  // already solved this exact problem with "<1m" for the same reason.
  const at = (p) => quotaDisplay(ready([win({ percent: p })]), NOW).meters[0].text;
  assert.strictEqual(at(0.4), '<1%');
  assert.strictEqual(at(0.01), '<1%');
  assert.strictEqual(at(0), '0%', 'a genuine zero stays honest');
});

test('usage just short of the limit is ">99%", not a false 100%', () => {
  const at = (p) => quotaDisplay(ready([win({ percent: p })]), NOW).meters[0].text;
  assert.strictEqual(at(99.6), '>99%');
  assert.strictEqual(at(100), '100%', 'actually full stays full');
});

test('a negative percent is unknown, not a confident measurement', () => {
  const m = quotaDisplay(ready([win({ percent: -5 })]), NOW).meters[0];
  assert.strictEqual(m.percent, null);
  assert.strictEqual(m.text, UNKNOWN);
  assert.strictEqual(m.tone, 'unknown');
});

test('the tone thresholds are pinned AT the boundary, not near it', () => {
  // Stryker killed nothing here: `>=` mutated to `>` survived, because no test
  // sat exactly on 80 or 95. These are the assertions a mutant demands.
  assert.strictEqual(toneFor({ severity: 'normal', percent: 79.9 }), 'normal');
  assert.strictEqual(toneFor({ severity: 'normal', percent: 80 }), 'warn');
  assert.strictEqual(toneFor({ severity: 'normal', percent: 94.9 }), 'warn');
  assert.strictEqual(toneFor({ severity: 'normal', percent: 95 }), 'critical');
});

test('a reset under a minute away is not "0m"', () => {
  assert.strictEqual(formatCountdown('2026-09-15T16:00:59Z', NOW), '<1m');
  assert.strictEqual(formatCountdown('2026-09-15T16:01:00Z', NOW), '1m');
});
