'use strict';
/**
 * Token milestones — the defects two reviewers found, each pinned by a test.
 *
 * THE PATTERN: every existing `crossed` test was a SINGLE CALL, so the word
 * "once" in the test name `crossing a milestone is reported once` was asserted
 * by nobody. All three of the worst findings are SEQUENCE properties — a
 * milestone announced twice, a baseline reset by a failed read, a partition
 * that does not sum — and none of them is visible to an example test that
 * calls the function one time.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  MILESTONES, milestoneFor, progressTo, crossed, describeSpend, compact,
} = require('../host/milestones');

// A standalone copy of the host's announce rule, so the SEQUENCE behaviour is
// testable without booting a pty. It must mirror host.js checkMilestone.
function announcer() {
  let lastTotal = null;
  let highest = null;
  return function see(total) {
    // The first reading seeds where we already stand rather than announcing it.
    if (lastTotal === null) {
      lastTotal = total;
      highest = milestoneFor(total);
      return null;
    }
    const hit = crossed(lastTotal, total);
    lastTotal = total;
    if (!hit) return null;
    if (highest && highest.at >= hit.at) return null;
    highest = hit;
    return hit;
  };
}

// --- the sequence properties -------------------------------------------------

test('a failed transcript read does not replay the whole history as a crossing', () => {
  // readUsage returns total 0 on ANY readdir failure -- EBUSY or EPERM from an
  // indexer or AV touching ~/.claude/projects, which is ordinary on Windows.
  // That reset the baseline to 0, and the next good read looked like a jump
  // from nothing to 1.06B: a full-screen party for work done weeks ago, which
  // is precisely what the null initialiser was written to prevent.
  const see = announcer();
  assert.strictEqual(see(900e6), null, 'first reading is not a crossing');
  assert.strictEqual(see(0), null, 'a failed read must not celebrate');
  assert.strictEqual(see(900000050), null, 'recovery must not replay history');
});

test('the same milestone is never announced twice, however the total moves', () => {
  // The dip-and-return. Claude Code expires old transcripts and a partially
  // written final line is skipped, so the project total legitimately jitters --
  // and every up-crossing fired again, once per 5s tick, indefinitely.
  const rung = MILESTONES[3].at;
  const see = announcer();
  see(rung - 1000);
  assert.ok(see(rung + 500), 'the genuine crossing should announce');
  assert.strictEqual(see(rung - 1000), null, 'a dip announces nothing');
  assert.strictEqual(see(rung + 1000), null, 'the return must NOT re-announce');
});

test('an oscillating total does not announce on every tick', () => {
  const rung = MILESTONES[2].at;
  const see = announcer();
  see(rung - 10);
  let announced = 0;
  for (let i = 0; i < 20; i++) {
    if (see(i % 2 ? rung + 10 : rung - 10)) announced++;
  }
  assert.strictEqual(announced, 1, `announced ${announced} times`);
});

test('climbing the whole ladder announces each rung exactly once', () => {
  const see = announcer();
  see(0);
  const seen = [];
  for (const m of MILESTONES) {
    const hit = see(m.at);
    if (hit) seen.push(hit.name);
  }
  assert.deepStrictEqual(seen, MILESTONES.map(m => m.name));
  assert.strictEqual(new Set(seen).size, seen.length, 'a rung was announced twice');
});

test('crossing from one rung to a HIGHER rung reports the higher one', () => {
  // The most common real crossing, and it had no test: every existing case
  // started below the first rung. A mutant announcing the OLD milestone
  // survived all 26 tests.
  const hit = crossed(MILESTONES[1].at, MILESTONES[3].at);
  assert.strictEqual(hit.name, MILESTONES[3].name);
});

// --- the partition ------------------------------------------------------------

test('fresh + cache reads account for the whole total', () => {
  // `fresh` omitted cacheWrite while `total` included it, so two million
  // tokens went unattributed. The old fixture demonstrated the gap in its own
  // numbers -- it pinned the defect rather than catching it.
  const usage = { input: 10, output: 5, cacheWrite: 2, cacheRead: 1000, total: 1017 };
  const s = describeSpend(usage, { metered: false });
  assert.strictEqual(s.fresh + s.cacheRead, s.total);
});

test('cache WRITES count as fresh, because metered providers bill them', () => {
  // On this project's real proportions the label said "15k fresh" of 99M when
  // 2.015M were billed as fresh -- understating it 134x on the one path where
  // the number is somebody's money.
  const usage = { input: 10e3, output: 5e3, cacheWrite: 2e6, cacheRead: 97e6, total: 99015000 };
  const s = describeSpend(usage, { metered: true });
  assert.strictEqual(s.fresh, 2015000);
  assert.strictEqual(s.cacheWrite, 2e6);
  assert.ok(/2M fresh/.test(s.label), s.label);
});

// --- the rate guard -----------------------------------------------------------

test('a NaN rate produces no dollar figure', () => {
  // Dropping the finite check printed "$NaN", which is the invented figure the
  // module swears it will never produce.
  const s = describeSpend({ total: 5e6 }, { metered: true, usdPerMillion: NaN });
  assert.strictEqual(s.costUsd, null);
  assert.ok(!/\$/.test(s.label), s.label);
});

test('a SUBSCRIPTION never shows a dollar figure, even if a rate is supplied', () => {
  // The design constraint, previously unasserted: dropping `metered &&` gave a
  // subscription user a bill.
  const s = describeSpend({ total: 5e6 }, { metered: false, usdPerMillion: 3 });
  assert.strictEqual(s.costUsd, null);
  assert.ok(!/\$/.test(s.label), s.label);
});

test('the metered label keeps the split, not just the object fields', () => {
  // "the breakdown is not decoration" was asserted on the returned fields and
  // not on the string, so the label could silently lose it.
  const s = describeSpend({ input: 1e6, output: 0, cacheRead: 9e6, total: 10e6 }, { metered: true });
  assert.ok(/fresh/.test(s.label), s.label);
});

// --- compact ------------------------------------------------------------------
// It renders every number the user sees and had no direct test at all: five
// mutants survived, including one that printed 1.06B as "1.1M".

test('compact does not round across a unit boundary', () => {
  assert.strictEqual(compact(999949), '999.9k');
  assert.strictEqual(compact(999950), '1M');       // was "1000k"
  assert.strictEqual(compact(999999), '1M');
  assert.strictEqual(compact(999999999), '1B');    // was "1000M"
});

test('compact picks the right unit at each threshold', () => {
  assert.strictEqual(compact(0), '0');
  assert.strictEqual(compact(999), '999');
  assert.strictEqual(compact(1000), '1k');
  assert.strictEqual(compact(1e6), '1M');
  assert.strictEqual(compact(1.5e6), '1.5M');
  assert.strictEqual(compact(1e9), '1B');
  assert.strictEqual(compact(1.06e9), '1.1B');
});

test('compact never emits a scaled value of 1000 or more', () => {
  for (let e = 0; e < 13; e++) {
    for (const mult of [0.999949, 0.99995, 1, 1.5, 9.999]) {
      const out = compact(Math.round(Math.pow(10, e) * mult));
      const lead = parseFloat(out);
      assert.ok(lead < 1000, `${out} has a leading part of ${lead}`);
    }
  }
});

// --- the ladder and the bar ---------------------------------------------------

test('the ladder is frozen, since milestoneFor depends on it ascending', () => {
  // It was exported by reference and mutable: one push of a low rung made
  // milestoneFor return it as "the highest reached".
  assert.ok(Object.isFrozen(MILESTONES));
  assert.throws(() => MILESTONES.push({ at: 1, name: 'X', icon: 'x' }));
});

test('the bar keeps moving past the top rung instead of pinning at full', () => {
  // Pinned at exactly 1 forever is the visual signature of a meter that is
  // FULL -- the one shape "a counter, never a limit" rules out.
  const top = MILESTONES[MILESTONES.length - 1].at;
  assert.strictEqual(progressTo(top), 0);
  assert.ok(Math.abs(progressTo(top * 1.25) - 0.25) < 0.001);
  assert.ok(progressTo(top * 1.5) > progressTo(top * 1.25));
});

test('an unusably large total is ABOVE the ladder, not below it', () => {
  // num() floored every non-finite value to 0, reporting Infinity as "no
  // milestone reached, 0% toward First Sparks" -- degrading in the direction
  // opposite to the truth.
  assert.strictEqual(progressTo(Infinity), 1);
  assert.strictEqual(milestoneFor(Infinity).name, MILESTONES[MILESTONES.length - 1].name);
});

test('progress stays drawable for every input, including the laps', () => {
  const top = MILESTONES[MILESTONES.length - 1].at;
  for (const n of [0, 1, 999, 1e6, 1e9, top, top * 1.5, top * 7.3, 1e15, -5, NaN, Infinity]) {
    const p = progressTo(n);
    assert.ok(p >= 0 && p <= 1, `${n} gave ${p}`);
  }
});

test('progress at an exact rung is the start of the new segment', () => {
  // Pinned exactly rather than with a tolerance: a floor-fallback mutant
  // survived because the assertion allowed 0.01 of slack.
  assert.strictEqual(progressTo(MILESTONES[1].at), 0);
  assert.strictEqual(progressTo(MILESTONES[0].at / 2), 0.5);
});
