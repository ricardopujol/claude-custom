'use strict';
/**
 * Active/Inactive roster tabs (BACKLOG D #16): pure decisions, so the split and
 * the sort can be tested without a DOM. Kept separate from
 * app/career-display.js on purpose -- that module draws a PER-PROJECT career
 * for one row against `stats.agents`; this one sorts the WHOLE roster (every
 * agent that has ever existed anywhere) by lifetime tokens ACROSS PROJECTS,
 * which is a different payload shape with a different absence rule: a
 * never-used agent has no row at all, not a zero one.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  splitActiveInactive, sortRosterRows, rosterTokenState, AT_LEAST,
} = require('../app/roster-tabs-display');

// --- splitActiveInactive -------------------------------------------------------

test('Active is exactly the agents on the live roster', () => {
  const { active } = splitActiveInactive(['paris', 'miguel', 'dexter'], ['paris', 'dexter']);
  assert.deepStrictEqual(active.sort(), ['dexter', 'paris']);
});

test('Inactive is the whole roster minus Active', () => {
  const { inactive } = splitActiveInactive(['paris', 'miguel', 'dexter'], ['paris']);
  assert.deepStrictEqual(inactive.sort(), ['dexter', 'miguel']);
});

test('an active agent absent from the whole-roster list still counts as active, not lost', () => {
  // The live roster is authoritative for "is this agent working right now" --
  // a whole-roster scan that has not caught up yet (a brand new custom agent,
  // or a background scan mid-pass) must never make a currently-running agent
  // disappear from Active.
  const { active, inactive } = splitActiveInactive(['paris'], ['paris', 'brand-new']);
  assert.deepStrictEqual(active.sort(), ['brand-new', 'paris']);
  assert.deepStrictEqual(inactive, []);
});

test('splitActiveInactive tolerates a non-array whole roster or active list', () => {
  const r = splitActiveInactive(null, undefined);
  assert.deepStrictEqual(r, { active: [], inactive: [] });
});

// --- rosterTokenState: reusing career-display's lower-bound/none states --------

test('rosterTokenState: never-used (null tokens) shows nothing, not a zero', () => {
  const s = rosterTokenState(null, true);
  assert.strictEqual(s.show, false);
});

test('rosterTokenState: zero is absence too -- Number(null) is 0 and must not read as "spent zero"', () => {
  // Same trap CLAUDE.md names for this repo: a coercing check turns "no value"
  // into a confident zero. `tokens: 0` from a resolved-but-empty row must draw
  // the same as `tokens: null`.
  assert.strictEqual(rosterTokenState(0, true).show, false);
  assert.strictEqual(rosterTokenState(undefined, true).show, false);
});

test('rosterTokenState: a run that genuinely spent 0 tokens still draws as "never used" (Dexter F9, deliberate)', () => {
  // Pinned rather than assumed: host/agent-stats-cache.js CAN produce a
  // genuine `total: 0` for a run that really happened (an aborted spawn with
  // no API response yet, or a transcript that vanished between listing and
  // read). This module draws that identically to "never ran" -- a deliberate
  // simplification, not because the two are the same fact.
  assert.strictEqual(rosterTokenState(0, true).show, false);
});

test('rosterTokenState: a real total, scan complete, shows with no prefix', () => {
  const s = rosterTokenState(4200, true);
  assert.strictEqual(s.show, true);
  assert.strictEqual(s.prefix, '');
});

test('rosterTokenState: a real total, scan still in progress, is a LOWER BOUND', () => {
  const s = rosterTokenState(4200, false);
  assert.strictEqual(s.show, true);
  assert.strictEqual(s.prefix, AT_LEAST);
});

test('rosterTokenState rejects a non-finite total the same way as absence', () => {
  assert.strictEqual(rosterTokenState(NaN, true).show, false);
  assert.strictEqual(rosterTokenState('120', true).show, false, 'a string must not coerce into a number');
});

// --- sortRosterRows -------------------------------------------------------------

test('sortRosterRows orders by lifetime tokens, most first', () => {
  const rows = [
    { agent: 'a', tokens: 10 },
    { agent: 'b', tokens: 1000 },
    { agent: 'c', tokens: 500 },
  ];
  assert.deepStrictEqual(sortRosterRows(rows).map(r => r.agent), ['b', 'c', 'a']);
});

test('sortRosterRows puts never-used (null tokens) LAST, never through a numeric comparison', () => {
  const rows = [
    { agent: 'never', tokens: null },
    { agent: 'small', tokens: 1 },
    { agent: 'also-never', tokens: null },
  ];
  const order = sortRosterRows(rows).map(r => r.agent);
  assert.strictEqual(order[0], 'small');
  assert.deepStrictEqual(order.slice(1).sort(), ['also-never', 'never']);
});

test('sortRosterRows treats undefined and non-finite tokens the same as null', () => {
  const rows = [
    { agent: 'real', tokens: 5 },
    { agent: 'undef' },
    { agent: 'nan', tokens: NaN },
  ];
  const order = sortRosterRows(rows).map(r => r.agent);
  assert.strictEqual(order[0], 'real');
  assert.deepStrictEqual(order.slice(1).sort(), ['nan', 'undef']);
});

test('sortRosterRows breaks a tie alphabetically, for a stable, predictable order', () => {
  const rows = [
    { agent: 'zeta', tokens: 100 },
    { agent: 'alpha', tokens: 100 },
  ];
  assert.deepStrictEqual(sortRosterRows(rows).map(r => r.agent), ['alpha', 'zeta']);
});

test('sortRosterRows does not mutate its input', () => {
  const rows = [{ agent: 'b', tokens: 1 }, { agent: 'a', tokens: 2 }];
  const copy = rows.map(r => ({ ...r }));
  sortRosterRows(rows);
  assert.deepStrictEqual(rows, copy);
});

// --- Dexter N2 (Medium), PR #59 R2: "ran, unreadable" is a THIRD tier ---------

test('sortRosterRows puts a "ran but unreadable" row ABOVE a genuinely never-used one', () => {
  const rows = [
    { agent: 'never', tokens: null },
    { agent: 'bar', tokens: null, unreadable: true },
  ];
  assert.deepStrictEqual(sortRosterRows(rows).map(r => r.agent), ['bar', 'never']);
});

test('sortRosterRows still puts any counted total above an unreadable row', () => {
  const rows = [
    { agent: 'bar', tokens: null, unreadable: true },
    { agent: 'counted', tokens: 5 },
  ];
  assert.deepStrictEqual(sortRosterRows(rows).map(r => r.agent), ['counted', 'bar']);
});

test('sortRosterRows breaks a tie among unreadable rows alphabetically', () => {
  const rows = [
    { agent: 'zeta', tokens: null, unreadable: true },
    { agent: 'alpha', tokens: null, unreadable: true },
  ];
  assert.deepStrictEqual(sortRosterRows(rows).map(r => r.agent), ['alpha', 'zeta']);
});
