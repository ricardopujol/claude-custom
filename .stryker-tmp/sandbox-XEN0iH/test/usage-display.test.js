// @ts-nocheck
'use strict';
/**
 * Dexter's Finding 6 and Miguel's B2, which are the same defect seen twice:
 * `ok`, `absent` and `stale` are computed with great care and consumed by
 * nothing that draws pixels.
 */
const test = require('node:test');
const assert = require('node:assert');

const { usageDisplay, UNKNOWN, AT_LEAST } = require('../app/usage-display');

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
