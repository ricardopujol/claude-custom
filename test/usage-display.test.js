'use strict';
/**
 * Dexter's Finding 6 and Miguel's B2, which are the same defect seen twice:
 * `ok`, `absent` and `stale` are computed with great care and consumed by
 * nothing that draws pixels.
 */
const test = require('node:test');
const assert = require('node:assert');

const { usageDisplay, spendOf, cacheReadOf, UNKNOWN, AT_LEAST } = require('../app/usage-display');
const { describeSpend } = require('../host/milestones');

const EMPTY = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, sessions: 0 };
const real = { input: 10, output: 20, cacheWrite: 0, cacheRead: 0, total: 30, sessions: 3 };

// --- the defect ---------------------------------------------------------------

test('a reading that has not landed is DISTINGUISHABLE from a project at zero', () => {
  // THE defect. Both of these have total 0; one means "we have not looked yet"
  // and the other means "nothing has been spent". The renderer drew them
  // identically, as a confident `session 0 · project 0 · 0 sessions`.
  const notRead = usageDisplay({ ok: false, absent: 1, stale: 0, project: { ...EMPTY }, session: { ...EMPTY } });
  const trulyZero = usageDisplay({ ok: true, absent: 0, stale: 0, project: { ...EMPTY }, session: { ...EMPTY } });

  assert.notStrictEqual(notRead.state, trulyZero.state);
  assert.strictEqual(notRead.placeholder, UNKNOWN);
  assert.strictEqual(trulyZero.placeholder, null, 'a real zero is a number, not a dash');
});

test('a project genuinely at zero tokens is reported as complete', () => {
  // The guard against over-correcting: a brand new project has spent nothing,
  // and drawing a dash there would be its own lie.
  const d = usageDisplay({ ok: true, absent: 0, stale: 0, project: { ...EMPTY }, session: { ...EMPTY } });
  assert.strictEqual(d.state, 'complete');
  assert.strictEqual(d.note, null);
  assert.strictEqual(d.prefix, '');
});

test('no usage at all is "reading", not zero', () => {
  assert.strictEqual(usageDisplay(undefined).state, 'reading');
  assert.strictEqual(usageDisplay(null).placeholder, UNKNOWN);
});

// --- a partial figure is still a figure ---------------------------------------

test('an incomplete reading keeps its partial total, marked as a lower bound', () => {
  // Throwing the partial total away would be its own dishonesty: it is real,
  // it is just not all of it. `≥` says exactly that in one character.
  const d = usageDisplay({ ok: false, absent: 2, stale: 0, project: real, session: real });
  assert.strictEqual(d.state, 'lower-bound');
  assert.strictEqual(d.prefix, AT_LEAST);
  assert.strictEqual(d.placeholder, null, 'the partial total must still be shown');
  assert.match(d.note, /lower bound/);
  assert.match(d.note, /2 transcripts/);
});

test('one unreadable transcript is singular, because the note is read by a person', () => {
  const d = usageDisplay({ ok: false, absent: 1, stale: 0, project: real, session: real });
  assert.match(d.note, /1 transcript could not/);
  assert.ok(!/1 transcripts/.test(d.note), d.note);
});

// --- the frozen number --------------------------------------------------------

test('a held figure says it is being held', () => {
  // Dexter's rider: substitution trades a visible drop for a frozen number, and
  // a frozen number with no signal is the worse of the two. Without this the UI
  // is indistinguishable from "nothing is happening".
  const d = usageDisplay({ ok: true, absent: 0, stale: 1, project: real, session: real });
  assert.strictEqual(d.state, 'held');
  assert.match(d.note, /holding the last figure/);
  assert.strictEqual(d.prefix, '', 'a held figure is accurate, not a bound');
});

test('absence outranks staleness, because it is the one that understates', () => {
  // Both at once is ordinary: one transcript locked and cached, another locked
  // and never read. The lower bound is the more important thing to say.
  const d = usageDisplay({ ok: false, absent: 1, stale: 1, project: real, session: real });
  assert.strictEqual(d.state, 'lower-bound');
});

// --- every state is drawable --------------------------------------------------

test('every state returns a usable shape', () => {
  const cases = [
    { ok: true, absent: 0, stale: 0, project: real },
    { ok: true, absent: 0, stale: 2, project: real },
    { ok: false, absent: 1, stale: 0, project: real },
    { ok: false, absent: 1, stale: 0, project: { ...EMPTY } },
    undefined,
  ];
  for (const c of cases) {
    const d = usageDisplay(c);
    assert.ok(typeof d.state === 'string' && d.state, JSON.stringify(c));
    assert.ok(typeof d.prefix === 'string', JSON.stringify(c));
    assert.ok(d.note === null || typeof d.note === 'string', JSON.stringify(c));
  }
});

test('missing counters do not render as NaN', () => {
  // The fields are new; an older host, or a replayed payload, may not carry
  // them. "NaN transcripts could not be read" is worse than saying nothing.
  const d = usageDisplay({ ok: false, project: real, session: real });
  assert.ok(!/NaN/.test(d.note), d.note);
});

// --- what the headline number actually means ---------------------------------
//
// FF1, from the first real use of the harness on another project. Ricardo:
// "I'm still pretty sure that the token count is just too crazily high, there
// must be something wrong there." He was right, and the measurement is worse
// than the suspicion.
//
// `host/usage.js` computes `total = input + output + cacheWrite + cacheRead`,
// and the renderer drew that as the headline. Measured on this repo:
//
//   input            9,924
//   output       2,933,346
//   cacheWrite  32,325,149
//   cacheRead 1,720,653,994   <- 98.0% of the headline
//   ------------------------
//   displayed 1,755,922,413
//   input+output 2,943,270    <- 0.17% of what was displayed
//
// Not an arithmetic error. A CATEGORY error: `cache_read_input_tokens` is the
// same context counted again on every single turn, and it is billed at roughly
// a tenth of input. Summing four non-commensurable quantities produces a
// figure dominated entirely by the one that is re-counted, so the number read
// as ~600x the work actually done.
//
// The honest split already existed in renderer.js as `fresh = input + output`,
// shown in small text in brackets. This promotes it and demotes the rest --
// and it lives here rather than in renderer.js because which number is the
// headline is a DRAWING DECISION, and a decision inline in renderer.js is one
// nothing can test.

test('the headline is what was actually spent, not the cache re-read every turn', () => {
  // cacheWrite IS spend: cache_creation_input_tokens are tokens processed for
  // the first time, billed at ~1.25x base input -- the most expensive category
  // after output. Dexter, PR #33 review, Finding 1.
  const s = { input: 1000, output: 2000, cacheWrite: 50000, cacheRead: 9000000 };
  assert.strictEqual(spendOf(s), 53000);
});

test('spendOf AGREES with describeSpend.fresh -- one concept, one value', () => {
  // THE FINDING, AND THE INSTRUMENT FOR IT. The first version of spendOf was
  // `input + output`, copied from a local helper in renderer.js. But
  // host/milestones.js:207 had already settled this question the other way --
  // `fresh = input + output + cacheWrite` -- with a comment recording that
  // leaving cacheWrite out understated this project's real proportions 134x,
  // and stating that `fresh + cacheRead` partitions `total`.
  //
  // So two functions in one repo computed the same concept from the same
  // object and disagreed by 32.3 MILLION tokens, and the stale one was the one
  // I copied. This asserts AGREEMENT rather than re-asserting the arithmetic in
  // a second place: re-stating the formula here would let the two drift apart
  // again the moment either changes, which is how they diverged the first time.
  const cases = [
    { input: 9924, output: 2933346, cacheWrite: 32325149, cacheRead: 1720653994 },
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
    { input: 500, output: 0, cacheWrite: 0, cacheRead: 999 },
  ];
  for (const c of cases) {
    assert.strictEqual(spendOf(c), describeSpend({ ...c, total: 0 }).fresh, JSON.stringify(c));
  }
});

test('spend and cache reads PARTITION the total -- nothing is invisible', () => {
  // The property the old headline broke: cacheWrite appeared in neither the
  // headline nor the `(+X cached)` sub-line, so 32.3M billed tokens were on
  // screen nowhere at all, only in a hover tooltip.
  const real = { input: 9924, output: 2933346, cacheWrite: 32325149, cacheRead: 1720653994 };
  const total = real.input + real.output + real.cacheWrite + real.cacheRead;
  assert.strictEqual(spendOf(real) + cacheReadOf(real), total,
    'every token in the payload must be accounted for by the two figures drawn');
});

test('cache reads are reported separately, not folded into the headline', () => {
  const s = { input: 1000, output: 2000, cacheWrite: 50000, cacheRead: 9000000 };
  assert.strictEqual(cacheReadOf(s), 9000000);
});

test('a missing field is 0, never NaN and never a confident guess', () => {
  // `Number(null)` is 0 and `Number(undefined)` is NaN -- the absence-as-zero
  // trap this codebase keeps paying for, and its NaN twin. A headline reading
  // "NaN" is worse than one reading nothing.
  assert.strictEqual(spendOf({}), 0);
  assert.strictEqual(spendOf(null), 0);
  assert.strictEqual(spendOf({ input: null, output: undefined }), 0);
  assert.strictEqual(cacheReadOf({}), 0);
  assert.strictEqual(cacheReadOf(null), 0);
});

test('a string that looks like a number is not counted', () => {
  // The payload crosses a socket. A stringy "1000" must not become 1000 by
  // coercion -- same rule as the strict typeof guards elsewhere in this file.
  assert.strictEqual(spendOf({ input: '1000', output: 5 }), 5);
});

test('the real proportions from this project survive the split', () => {
  // The measured numbers above, asserted as a regression: if these two figures
  // are ever summed back together, this fails with the actual ratio in the
  // message rather than with an abstract complaint.
  const real = { input: 9924, output: 2933346, cacheWrite: 32325149, cacheRead: 1720653994 };
  assert.strictEqual(spendOf(real), 35268419);
  const total = spendOf(real) + real.cacheRead;
  assert.ok(spendOf(real) / total < 0.05,
    `cache reads still dominate: the headline is ${(100 * spendOf(real) / total).toFixed(2)}% of traffic`);
});
