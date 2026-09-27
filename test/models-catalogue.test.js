'use strict';
/**
 * Reconciling a `models` reply with what the panel already shows.
 * Dexter, PR #60 review, Findings 1 and 4.
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

test('shouldClearPending: an older in-flight reply (from BEFORE the click) does not clear', () => {
  // Dexter F4's counterexample: R1 (non-forced, in flight) answers from an
  // older cache entry while R2 (the forced click) is still running.
  assert.strictEqual(shouldClearPending(5000, { models: rows(9), fetchedAt: 1000 }), false);
});

test('shouldClearPending: a reply at or after the click clears', () => {
  assert.strictEqual(shouldClearPending(5000, { models: rows(9), fetchedAt: 5000 }), true);
  assert.strictEqual(shouldClearPending(5000, { models: rows(9), fetchedAt: 6000 }), true);
});

test('shouldClearPending: a non-finite fetchedAt on a non-empty reply is treated as resolving the attempt', () => {
  assert.strictEqual(shouldClearPending(5000, { models: rows(9), fetchedAt: undefined }), true);
});
