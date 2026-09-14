'use strict';
/**
 * The token counter, gamified.
 *
 * A COUNTER, NEVER A LIMIT. Ricardo was explicit about that, and it decides the
 * whole shape: progress runs TOWARD the next milestone, it never depletes an
 * allowance. Nothing here can go red, warn, or run out — a bar that fills as
 * you work reads as an achievement, and the identical bar labelled "remaining"
 * reads as a leash.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  MILESTONES, milestoneFor, nextMilestone, progressTo, crossed, describeSpend,
} = require('../host/milestones');

// --- the ladder --------------------------------------------------------------

test('every milestone has a threshold, a name and an emoji', () => {
  // Emoji per the project's art placeholder rule: stored as DATA beside the
  // thing it marks, so replacing it with generated art later is one field.
  for (const m of MILESTONES) {
    assert.ok(Number.isFinite(m.at) && m.at > 0, JSON.stringify(m));
    assert.ok(m.name, JSON.stringify(m));
    assert.ok(m.icon, JSON.stringify(m));
  }
});

test('the ladder is strictly ascending', () => {
  // Out of order, milestoneFor would return whichever happened to be last.
  for (let i = 1; i < MILESTONES.length; i++) {
    assert.ok(MILESTONES[i].at > MILESTONES[i - 1].at,
      `${MILESTONES[i].name} is not above ${MILESTONES[i - 1].name}`);
  }
});

test('the ladder reaches past this project, which is already at ~1B', () => {
  // A ladder whose top rung is below where you already stand has nothing left
  // to say. Measured: this project sits near a billion tokens.
  assert.ok(MILESTONES[MILESTONES.length - 1].at > 1e9);
});

// --- where you are -----------------------------------------------------------

test('below the first milestone, none has been reached', () => {
  assert.strictEqual(milestoneFor(0), null);
  assert.strictEqual(milestoneFor(MILESTONES[0].at - 1), null);
});

test('landing exactly on a threshold counts as reaching it', () => {
  const first = MILESTONES[0];
  assert.strictEqual(milestoneFor(first.at).name, first.name);
});

test('the milestone reached is the HIGHEST passed, not the first', () => {
  const third = MILESTONES[2];
  assert.strictEqual(milestoneFor(third.at + 1).name, third.name);
});

test('past the top rung, the top rung is where you stand', () => {
  const top = MILESTONES[MILESTONES.length - 1];
  assert.strictEqual(milestoneFor(top.at * 10).name, top.name);
});

test('the next milestone is the one above you', () => {
  assert.strictEqual(nextMilestone(0).name, MILESTONES[0].name);
  assert.strictEqual(nextMilestone(MILESTONES[0].at).name, MILESTONES[1].name);
});

test('past the top there is no next, and that is not an error', () => {
  const top = MILESTONES[MILESTONES.length - 1];
  assert.strictEqual(nextMilestone(top.at * 10), null);
});

// --- progress, which fills rather than drains --------------------------------

test('progress runs from the milestone reached to the next one', () => {
  const a = MILESTONES[0].at;
  const b = MILESTONES[1].at;
  assert.strictEqual(progressTo(a), 0);
  assert.ok(Math.abs(progressTo((a + b) / 2) - 0.5) < 0.01);
  assert.strictEqual(progressTo(b), 0);        // a new segment starts
});

test('progress before the first milestone is measured from zero', () => {
  assert.ok(Math.abs(progressTo(MILESTONES[0].at / 2) - 0.5) < 0.01);
});

test('progress is always a drawable fraction', () => {
  for (const n of [0, 1, 999, 1e6, 1e9, 1e15, -5, NaN, Infinity]) {
    const p = progressTo(n);
    assert.ok(p >= 0 && p <= 1, `${n} gave ${p}`);
  }
});

test('past the top rung the bar LAPS rather than pinning at full', () => {
  // Changed deliberately. Pinned at exactly 1 forever is the visual signature
  // of a meter that is FULL, which is the one shape "a counter, never a limit"
  // rules out -- the only state where the display stops responding to work.
  // Each further top-rung span is another lap.
  const top = MILESTONES[MILESTONES.length - 1];
  assert.strictEqual(progressTo(top.at * 3), 0);
  assert.ok(progressTo(top.at * 3.5) > 0);
});

// --- the flourish ------------------------------------------------------------

test('crossing a milestone is reported once', () => {
  const first = MILESTONES[0];
  const hit = crossed(first.at - 1, first.at);
  assert.ok(hit);
  assert.strictEqual(hit.name, first.name);
});

test('not crossing anything reports nothing', () => {
  assert.strictEqual(crossed(10, 11), null);
  assert.strictEqual(crossed(MILESTONES[0].at, MILESTONES[0].at + 1), null);
});

test('a jump over several milestones reports the HIGHEST reached', () => {
  // One turn can move a long way. Announcing the lowest crossed would be a
  // stale celebration, and announcing all of them is a parade.
  const hit = crossed(0, MILESTONES[3].at);
  assert.strictEqual(hit.name, MILESTONES[3].name);
});

test('a total that goes backwards celebrates nothing', () => {
  // Transcripts are re-read from disk, and a session file can vanish. Counting
  // down must never fire a flourish.
  assert.strictEqual(crossed(MILESTONES[2].at, 0), null);
});

test('a first reading is not a crossing', () => {
  // On launch the previous total is unknown. Treating that as "0 -> 900M"
  // would throw a party for work done weeks ago, every single launch.
  assert.strictEqual(crossed(null, MILESTONES[3].at), null);
  assert.strictEqual(crossed(undefined, MILESTONES[3].at), null);
});

// --- framing by provider -----------------------------------------------------
// Same data, different truth. On a subscription the marginal cost inside quota
// is zero, so a playful counter is honest. On a metered provider every token is
// real money and pretending otherwise would be cheerful about someone's bill.

test('a subscription is framed as a counter', () => {
  const s = describeSpend({ total: 5e6 }, { metered: false });
  assert.strictEqual(s.metered, false);
  assert.ok(!/\$/.test(s.label), s.label);
});

test('a metered provider is not described with a playful counter', () => {
  const s = describeSpend({ total: 5e6 }, { metered: true });
  assert.strictEqual(s.metered, true);
});

test('metered spend is NOT invented when no price is known', () => {
  // Showing a dollar figure derived from a guessed rate would be worse than
  // showing none: it is the number someone would repeat. The model price table
  // is feature #15 and does not exist yet.
  const s = describeSpend({ total: 5e6 }, { metered: true });
  assert.strictEqual(s.costUsd, null);
  assert.ok(!/\$\d/.test(s.label), s.label);
});

test('a known rate does produce a real figure', () => {
  const s = describeSpend({ total: 1e6 }, { metered: true, usdPerMillion: 3 });
  assert.strictEqual(s.costUsd, 3);
  assert.ok(/\$/.test(s.label), s.label);
});

// --- the breakdown, which must survive ---------------------------------------

test('fresh tokens are separated from cache reads', () => {
  // Measured on this project: ~97M of 119M was cache reads. A single headline
  // number badly misrepresents spend, so the split is not optional decoration.
  const usage = { input: 10, output: 5, cacheWrite: 2, cacheRead: 1000, total: 1017 };
  const s = describeSpend(usage, { metered: false });
  // 17, not 15: cache WRITES are newly processed tokens that metered providers
  // bill at a premium. This fixture's own total proves it -- 10+5+1000 is 1015,
  // and the missing 2 were cache writes the old assertion left unattributed.
  assert.strictEqual(s.fresh, 17);
  assert.strictEqual(s.cacheRead, 1000);
  assert.strictEqual(s.fresh + s.cacheRead, s.total);
});

test('the cache share is reported, since it is most of the total', () => {
  const s = describeSpend({ input: 1, output: 1, cacheRead: 98, total: 100 }, { metered: false });
  assert.ok(s.cacheShare > 0.9, String(s.cacheShare));
});

test('an empty usage does not divide by zero', () => {
  const s = describeSpend({ total: 0 }, { metered: false });
  assert.strictEqual(s.cacheShare, 0);
  assert.strictEqual(s.fresh, 0);
});

test('nothing here can express a limit', () => {
  // The guard against scope drift. If a future field called remaining, quota,
  // budget or cap appears, this fails and someone has to justify it.
  const s = describeSpend({ total: 1e6 }, { metered: false });
  for (const banned of ['remaining', 'quota', 'budget', 'cap', 'limit']) {
    assert.ok(!(banned in s), `describeSpend must not report a ${banned}`);
  }
});
