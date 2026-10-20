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

// --- the call site, which is where the PR's actual fixes live -------------------
// Dexter and Miguel, merge-gate 2026-09-17: the module was careful and the
// SCREEN still told two of the old lies, because the decisions that draw pixels
// sat in renderer.js where nothing runs.

const { mergeAgentStats, rosterEmptyState } = require('../app/career-display');

test('a PARTIAL failed read keeps the rows it did not see', () => {
  // THE common failure, and the one the shipped guard missed. `ok:false` with a
  // NON-EMPTY agents list is what one unreadable transcript directory produces
  // -- the guard required `agents.length === 0`, which only happens when the
  // whole project folder is unreadable. So a partial read replaced the map and
  // any agent whose transcripts lived in the locked directory silently vanished.
  const prev = new Map([['a', { agent: 'a', runs: 5, tokens: 10 }],
                        ['b', { agent: 'b', runs: 3, tokens: 20 }]]);
  const merged = mergeAgentStats(prev, { ok: false, agents: [{ agent: 'a', runs: 6, tokens: 12 }] });
  assert.strictEqual(merged.size, 2, 'b must survive a partial read');
  assert.strictEqual(merged.get('a').runs, 6, 'and a takes the fresher figure');
});

test('a TOTAL failed read keeps everything', () => {
  const prev = new Map([['a', { agent: 'a', runs: 5 }]]);
  const merged = mergeAgentStats(prev, { ok: false, agents: [] });
  assert.strictEqual(merged.size, 1);
});

test('a SUCCESSFUL read is authoritative and may drop a row', () => {
  // Careers are cumulative, so they never legitimately shrink -- but a complete
  // read is the one thing allowed to say an agent is gone.
  const prev = new Map([['a', { agent: 'a', runs: 5 }], ['b', { agent: 'b', runs: 3 }]]);
  const merged = mergeAgentStats(prev, { ok: true, agents: [{ agent: 'a', runs: 5 }] });
  assert.deepStrictEqual([...merged.keys()], ['a']);
});

test('the empty state does not claim "no agents" when the read FAILED', () => {
  // On a cold window with an unreadable projects folder, the panel said
  // "No agents yet - portraits light up when one runs." That is a positive
  // claim about history, produced by a read that failed.
  const failed = rosterEmptyState(0, new Map(), { ok: false, agents: [] });
  assert.doesNotMatch(failed, /no agents yet/i);
  assert.match(failed, /could not|unknown/i);
});

test('the empty state still says "no agents yet" when the read SUCCEEDED', () => {
  assert.match(rosterEmptyState(0, new Map(), { ok: true, agents: [] }), /no agents yet/i);
});

test('the empty state reports known history when the roster is merely idle', () => {
  const known = new Map([['a', { agent: 'a', runs: 2 }], ['b', { agent: 'b', runs: 1 }]]);
  const s = rosterEmptyState(0, known, { ok: true, agents: [...known.values()] });
  assert.match(s, /2 agents/);
  assert.doesNotMatch(s, /no agents yet/i);
});

test('an unknown career is visibly different from no career at all', () => {
  // Both draw no figures -- but the module computed a `note` saying which, and
  // the renderer discarded it, so they were pixel-identical. That is the exact
  // conflation this whole PR exists to end.
  const unknown = careerDisplay(undefined, { ok: false, agents: [] });
  const none = careerDisplay(undefined, { ok: true, agents: [] });
  assert.notStrictEqual(unknown.state, none.state);
  assert.ok(unknown.note, 'the unknown state must carry something sayable');
  assert.strictEqual(none.note, null);
});

test('an unknown duration is not described as approximate', () => {
  // "approximately unknown" -- the prefix qualified a non-claim.
  const d = careerDisplay(row({ ms: null }), ok);
  assert.strictEqual(d.minutesPrefix, '', 'no ~ on an em dash');
});

// --- account profiles (BACKLOG #119 A1): a fresh profile has an empty roster, and says so in one dim line ----------------------
test('rosterEmptyState: under a non-default profile with no history, it says the profile has no agents yet', () => {
  const s = rosterEmptyState(0, new Map(), { ok: true, agents: [] }, { isDefault: false });
  assert.match(s, /no agents in this profile yet/i);
});

test('rosterEmptyState: the default profile, or a profile with history, or a failed read, keep their own sentences', () => {
  assert.match(rosterEmptyState(0, new Map(), { ok: true, agents: [] }, { isDefault: true }), /^No agents yet/);
  assert.match(rosterEmptyState(0, new Map(), { ok: true, agents: [] }), /^No agents yet/);
  const known = new Map([['a', { agent: 'a' }]]);
  assert.match(rosterEmptyState(0, known, { ok: true, agents: [] }, { isDefault: false }), /1 agent has run/);
  assert.match(rosterEmptyState(0, new Map(), { ok: false, agents: [] }, { isDefault: false }), /unknown, not zero/);
});
