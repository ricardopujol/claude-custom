'use strict';
/**
 * How an agent's career figures should be DRAWN, given how well they are known.
 *
 * Vera (display-integrity-auditor), 2026-09-14, auditing the career panel:
 * host/agent-stats.js computes `ok` and `unresolved` with care and the only
 * consumer that draws pixels read neither. A failed read of the projects
 * folder rendered pixel-identically to "this agent has no record", and a
 * capped, estimated minutes figure was printed as a flat measured fact.
 */
const test = require('node:test');
const assert = require('node:assert');

const { careerDisplay, formatMinutes, UNKNOWN, AT_LEAST, ABOUT } =
  require('../app/career-display');

const row = (over = {}) => ({ agent: 'code-reviewer', runs: 2, tokens: 1500, ms: 120000,
  resolved: true, ...over });
const ok = { ok: true, agents: [], unresolved: 0 };

// --- absence is not zero -------------------------------------------------------

test('a failed roster read is UNKNOWN, never a confident zero', () => {
  const d = careerDisplay(undefined, { ok: false, agents: [], unresolved: 0 });
  assert.strictEqual(d.state, 'unknown');
  assert.strictEqual(d.draw, false, 'nothing is known, so nothing is claimed');
});

test('no record for this agent is distinct from a failed read', () => {
  const d = careerDisplay(undefined, ok);
  assert.strictEqual(d.state, 'none');
  assert.strictEqual(d.draw, false);
});

test('an agent with a row but a failed overall read is a LOWER BOUND, not a fact', () => {
  // Some transcript could not be read, so the true figure is higher than this.
  // Throwing the partial away would be its own dishonesty -- it is real, it is
  // just not all of it. Same treatment usage-display.js gives the token header.
  const d = careerDisplay(row(), { ok: false, agents: [], unresolved: 0 });
  assert.strictEqual(d.state, 'lower-bound');
  assert.strictEqual(d.draw, true);
  assert.strictEqual(d.prefix, AT_LEAST);
  assert.match(d.note, /lower bound/i);
});

test('a complete read of a real career draws with no caveat prefix', () => {
  const d = careerDisplay(row(), ok);
  assert.strictEqual(d.state, 'complete');
  assert.strictEqual(d.draw, true);
  assert.strictEqual(d.prefix, '');
});

test('a row with zero runs is no record, not a zero career', () => {
  assert.strictEqual(careerDisplay(row({ runs: 0 }), ok).draw, false);
});

test('an unresolved identity is surfaced as a label, not a type', () => {
  const d = careerDisplay(row({ resolved: false }), ok);
  assert.strictEqual(d.unresolved, true);
  assert.match(d.detail, /label/i);
});

// --- minutes are an ESTIMATE, and must say so ----------------------------------

test('minutes carry the approximately-equal marker, because the figure is capped per gap', () => {
  // host/agent-stats.js caps each inter-turn gap at IDLE_GAP_MS (5 min), so an
  // overnight wait contributes 5 minutes and a genuinely long tool call also
  // contributes 5. The module is candid about this; the pixel was not.
  const d = careerDisplay(row({ ms: 21 * 60000 }), ok);
  assert.strictEqual(d.minutesPrefix, ABOUT);
  assert.match(d.detail, /estimated from transcript timestamps/i);
});

test('real work under half a minute is "<1m", never a self-contradicting 0m', () => {
  // "981k / 0m" reads as "spent tokens, did no work", which is false on its
  // face. Vera, 2026-09-14.
  assert.strictEqual(formatMinutes(20000), '<1m');
  assert.strictEqual(formatMinutes(1), '<1m');
});

test('genuinely zero elapsed time is 0m, which is the honest answer', () => {
  // A single-entry transcript really is 0ms of measurable work.
  assert.strictEqual(formatMinutes(0), '0m');
});

test('a missing or non-finite duration is UNKNOWN, not a confident 0m', () => {
  assert.strictEqual(formatMinutes(undefined), UNKNOWN);
  assert.strictEqual(formatMinutes(null), UNKNOWN);
  assert.strictEqual(formatMinutes(NaN), UNKNOWN);
  assert.strictEqual(formatMinutes(-5), UNKNOWN);
});

test('minutes round to hours the way the panel already did', () => {
  assert.strictEqual(formatMinutes(30 * 60000), '30m');
  assert.strictEqual(formatMinutes(90 * 60000), '1h30m');
  assert.strictEqual(formatMinutes(120 * 60000), '2h');
});
