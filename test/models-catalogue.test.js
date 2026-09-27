'use strict';
/**
 * Reconciling a `models` reply with what the panel already shows.
 * Dexter, PR #60 review round 1 (Findings 1/4) and round 2 (N1/N2).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { mergeCatalogueReply, shouldClearPending } = require('../app/models-catalogue');

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `p/model-${i}` }));

// --- Finding 1: a failed refresh must never blank an on-screen list -----------

test('F1: a successful reply, then a failed one with no rows -- the old rows survive, marked stale', () => {
  const state = mergeCatalogueReply({ rows: [], meta: null },
    { models: rows(445), source: 'network', fetchedAt: 1000, stale: false });
  assert.strictEqual(state.rows.length, 445);
  assert.strictEqual(state.meta.stale, false);

  const next = mergeCatalogueReply(state, { models: [], source: 'none', stale: true, error: 'offline' });
  assert.strictEqual(next.rows.length, 445, 'the 445 rows the user was looking at must survive');
  assert.strictEqual(next.meta.stale, true, 'never shown as current after a failed refresh');
  assert.strictEqual(next.meta.error, 'offline');
});

test('F1: the very FIRST reply ever, even if empty, is shown -- nothing to fall back to', () => {
  const next = mergeCatalogueReply({ rows: [], meta: null }, { models: [], source: 'none', stale: true, error: 'offline' });
  assert.deepStrictEqual(next.rows, []);
  assert.strictEqual(next.meta.stale, true);
  assert.strictEqual(next.meta.error, 'offline');
});

test('F1: an empty reply keeps the ORIGINAL rows-fetch timestamp, not the failed attempt', () => {
  const state = { rows: rows(3), meta: { source: 'network', fetchedAt: 1000, stale: false, error: null } };
  const next = mergeCatalogueReply(state, { models: [], source: 'none', stale: true, error: 'x', fetchedAt: 9999 });
  assert.strictEqual(next.meta.fetchedAt, 1000, 'the age shown must be the age of the rows actually on screen');
});

// --- Finding 4: replies can arrive out of order --------------------------------

test('F4: a fresh reply, then an OLDER one (even with real rows) -- the fresh one is kept', () => {
  const state = { rows: rows(3), meta: { source: 'network', fetchedAt: 2000, stale: false, error: null } };
  const next = mergeCatalogueReply(state, { models: rows(9), source: 'cache', fetchedAt: 1000, stale: true, error: 'x' });
  assert.strictEqual(next.rows.length, 3, 'the older reply must not clobber the fresher one already shown');
  assert.strictEqual(next.meta.fetchedAt, 2000);
});

test('F4: a fresh reply, then a NEWER one -- the newer one wins normally', () => {
  const state = { rows: rows(3), meta: { source: 'network', fetchedAt: 1000, stale: false, error: null } };
  const next = mergeCatalogueReply(state, { models: rows(9), source: 'network', fetchedAt: 2000, stale: false, error: null });
  assert.strictEqual(next.rows.length, 9);
  assert.strictEqual(next.meta.fetchedAt, 2000);
});

test('F4: equal fetchedAt is accepted (a same-age cache re-answer is not a regression)', () => {
  const state = { rows: rows(3), meta: { source: 'network', fetchedAt: 1000, stale: false, error: null } };
  const next = mergeCatalogueReply(state, { models: rows(3), source: 'cache', fetchedAt: 1000, stale: false, error: null });
  assert.strictEqual(next.rows.length, 3);
  assert.strictEqual(next.meta.source, 'cache');
});

// --- N2 (round 2): seq-based ordering, once both sides carry one ---------------

test('N2(b): an OLDER reply BY SEQ, even empty, is a full no-op -- never flips a fresher list to stale', () => {
  // The boot warm-up / a stale tab-open (seq=1) fails AFTER a Refresh click
  // (seq=2) already succeeded. Its fetchedAt would make it look "current" by
  // the round-1 heuristic alone, which is exactly why seq has to win.
  const afterSuccess = mergeCatalogueReply({ rows: [], meta: null },
    { models: rows(9), source: 'network', fetchedAt: 6000, stale: false, seq: 2 });
  const next = mergeCatalogueReply(afterSuccess, { models: [], source: 'none', stale: true, error: 'x', seq: 1 });
  assert.strictEqual(next.rows.length, 9);
  assert.strictEqual(next.meta.stale, false, 'an older-by-seq failure must not flip a fresher list to stale');
  assert.strictEqual(next.meta.seq, 2, 'the state must still be attributed to the request that actually produced it');
});

test('N2: an empty reply at an EQUAL-OR-NEWER seq still marks the shown rows stale (F1 still holds)', () => {
  const afterSuccess = mergeCatalogueReply({ rows: [], meta: null },
    { models: rows(9), source: 'network', fetchedAt: 6000, stale: false, seq: 1 });
  const next = mergeCatalogueReply(afterSuccess, { models: [], source: 'none', stale: true, error: 'x', seq: 2 });
  assert.strictEqual(next.rows.length, 9);
  assert.strictEqual(next.meta.stale, true);
});

test('N2: seq ordering beats a misleading fetchedAt in either direction', () => {
  // A "fresher-looking" fetchedAt on an OLDER-by-seq reply must still lose.
  const state = { rows: rows(3), meta: { fetchedAt: 1000, stale: false, seq: 5 } };
  const olderBySeq = mergeCatalogueReply(state, { models: rows(9), fetchedAt: 999999, stale: false, seq: 4 });
  assert.strictEqual(olderBySeq.rows.length, 3, 'seq=4 is older than seq=5, whatever fetchedAt claims');

  const newerBySeq = mergeCatalogueReply(state, { models: rows(9), fetchedAt: 1, stale: false, seq: 6 });
  assert.strictEqual(newerBySeq.rows.length, 9, 'seq=6 is newer than seq=5, even with a tiny fetchedAt');
});

// --- totality / garbage input ---------------------------------------------------

test('mergeCatalogueReply tolerates garbage state and reply without throwing', () => {
  for (const bad of [undefined, null, 42, 'x', []]) {
    assert.doesNotThrow(() => mergeCatalogueReply(bad, bad));
  }
  const next = mergeCatalogueReply(undefined, undefined);
  assert.deepStrictEqual(next.rows, []);
});

test('property: a non-empty reply at least as fresh as the current state is always applied', () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 1e9 }), fc.integer({ min: 1, max: 20 }),
    fc.integer({ min: 0, max: 1e9 }), fc.integer({ min: 1, max: 20 }),
    (t1, n1, delta, n2) => {
      const state = mergeCatalogueReply({ rows: [], meta: null },
        { models: rows(n1), source: 'network', fetchedAt: t1, stale: false });
      const t2 = t1 + delta;
      const next = mergeCatalogueReply(state, { models: rows(n2), source: 'network', fetchedAt: t2, stale: false });
      assert.strictEqual(next.rows.length, n2);
      assert.strictEqual(next.meta.fetchedAt, t2);
    },
  ));
});

test('property: an empty reply never reduces a non-empty row count', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 0, max: 1e9 }), (n, t) => {
    const state = mergeCatalogueReply({ rows: [], meta: null }, { models: rows(n), source: 'network', fetchedAt: t, stale: false });
    const next = mergeCatalogueReply(state, { models: [], source: 'none', stale: true, error: 'x' });
    assert.strictEqual(next.rows.length, n);
    assert.strictEqual(next.meta.stale, true);
  }));
});

// --- shouldClearPending ----------------------------------------------------------

test('shouldClearPending: nothing pending tracked always clears (harmless default)', () => {
  assert.strictEqual(shouldClearPending(null, { models: rows(3), fetchedAt: 1 }), true);
  assert.strictEqual(shouldClearPending(undefined, { models: [] }), true);
});

test('shouldClearPending: a definitive failure (no rows) always clears, whatever fetchedAt says', () => {
  assert.strictEqual(shouldClearPending(5000, { models: [], source: 'none', fetchedAt: 0 }), true);
  assert.strictEqual(shouldClearPending(5000, { models: [], source: 'none' }), true);
});

test('shouldClearPending: a plain older, non-stale reply (no seq to go on) does not clear', () => {
  // The round-1 fallback: a benign cache hit from an OLDER, unrelated
  // in-flight request, with no `stale`/`error` and an old `fetchedAt`, is not
  // treated as this click's answer.
  assert.strictEqual(shouldClearPending(5000, { models: rows(9), fetchedAt: 1000 }), false);
});

// Dexter, round 2, N1 -- THE regression: this exact shape used to fall
// through to the fetchedAt comparison (1000 >= 5000 is false) and left an
// offline Refresh's button stuck on "Refreshing..." forever, because a
// FAILED forced request that fell back to a disk cache reports the CACHE's
// age, not the age of the attempt that just ran. Pinned exactly as R2 gave
// it -- no `seq` on this reply, so this exercises the fallback heuristic.
test('N1: a FAILED forced reply (stale + error) always clears pending, whatever its cached fetchedAt says', () => {
  assert.strictEqual(
    shouldClearPending(5000, { models: rows(9), fetchedAt: 1000, stale: true, error: 'offline' }),
    true,
  );
});

test('shouldClearPending: a reply at or after the click clears', () => {
  assert.strictEqual(shouldClearPending(5000, { models: rows(9), fetchedAt: 5000 }), true);
  assert.strictEqual(shouldClearPending(5000, { models: rows(9), fetchedAt: 6000 }), true);
});

test('shouldClearPending: a non-finite fetchedAt on a non-empty reply is treated as resolving the attempt', () => {
  assert.strictEqual(shouldClearPending(5000, { models: rows(9), fetchedAt: undefined }), true);
});

// --- shouldClearPending WITH seq (the real, fully-wired mechanism) ---------------

test('seq: an exact match clears pending, however stale or empty the reply looks', () => {
  assert.strictEqual(
    shouldClearPending(2, { models: rows(9), fetchedAt: 1000, stale: true, error: 'offline', seq: 2 }),
    true,
  );
});

// Dexter, round 2, N2(a): the boot warm-up (or a stale tab-open) resolving or
// failing AFTER a click was made must NOT clear that click's pending, even
// though its reply is empty/stale -- exactly the shape shouldClearPending's
// no-seq fallback cannot tell apart from N1. `seq` is what actually
// distinguishes them.
test('seq: an UNRELATED older request answering (even empty/stale) does not clear a different pending seq', () => {
  assert.strictEqual(
    shouldClearPending(2, { models: [], source: 'none', stale: true, error: 'x', seq: 1 }),
    false,
  );
});

test('seq: a mismatched non-empty reply does not clear, even with a fresh fetchedAt', () => {
  assert.strictEqual(
    shouldClearPending(2, { models: rows(9), fetchedAt: 999999, stale: false, seq: 1 }),
    false,
  );
});

test('property: with seq present on both sides, only an exact match ever clears', () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }),
    fc.boolean(), fc.integer({ min: 0, max: 20 }),
    (pendingSeq, replySeq, stale, n) => {
      const cleared = shouldClearPending(pendingSeq, { models: rows(n), stale, error: stale ? 'x' : null, seq: replySeq });
      assert.strictEqual(cleared, replySeq === pendingSeq);
    },
  ));
});
