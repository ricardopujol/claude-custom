'use strict';
/**
 * The in-flight dedupe around loadCatalogue. Dexter/Miguel, PR #60 review,
 * F5/S1: a `.finally` on a superseded promise used to clear the shared slot
 * out from under a still-running fetch, letting a third caller start a THIRD
 * concurrent request.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createCatalogueCache } = require('../host/catalogue-cache');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('a second call while the first is in flight (not forced) joins it -- one loadCatalogue call', () => {
  let calls = 0;
  const d = deferred();
  const cache = createCatalogueCache({ loadCatalogue: () => { calls++; return d.promise; }, cacheFile: 'x' });

  const p1 = cache.current();
  const p2 = cache.current();
  assert.strictEqual(p1, p2, 'the second call must reuse the first promise');
  assert.strictEqual(calls, 1);
  d.resolve({ rows: [], source: 'network', fetchedAt: 1, stale: false, error: null });
});

test('THE FIX: an earlier call settling does not drop a later, still-running forced call', async () => {
  // Dexter's exact counterexample: call A (non-forced), then B (force) while
  // A is still in flight, resolve A, then call C. C must get B's promise, not
  // start a third fetch.
  let calls = 0;
  const loaders = [];
  const cache = createCatalogueCache({
    loadCatalogue: () => {
      calls++;
      const d = deferred();
      loaders.push(d);
      return d.promise;
    },
    cacheFile: 'x',
  });

  const pA = cache.current();                 // call A: starts fetch #1
  const pB = cache.current({ force: true });   // call B: starts fetch #2 (force always starts its own)
  assert.strictEqual(calls, 2);

  loaders[0].resolve({ rows: [1], source: 'network', fetchedAt: 1, stale: false, error: null });
  await pA;

  const pC = cache.current();                  // call C, after A settled but while B still runs
  assert.strictEqual(pC, pB, 'C must join B -- the still-running forced fetch -- not start a third');
  assert.strictEqual(calls, 2, 'no third fetch must have started');

  loaders[1].resolve({ rows: [1, 2], source: 'network', fetchedAt: 2, stale: false, error: null });
  await pB;
});

test('once the in-flight promise settles, a later call starts a fresh one', async () => {
  let calls = 0;
  const cache = createCatalogueCache({
    loadCatalogue: () => {
      calls++;
      return Promise.resolve({ rows: [], source: 'network', fetchedAt: calls, stale: false, error: null });
    },
    cacheFile: 'x',
  });

  await cache.current();
  await cache.current();
  assert.strictEqual(calls, 2, 'a call after the previous one settled must start its own fetch');
});

test('force always starts its own fetch, never joining an in-flight non-forced one', () => {
  let calls = 0;
  const d = deferred();
  const cache = createCatalogueCache({ loadCatalogue: () => { calls++; return calls === 1 ? d.promise : Promise.resolve({ rows: [], source: 'network', fetchedAt: 2, stale: false, error: null }); }, cacheFile: 'x' });

  const p1 = cache.current();                  // in flight, non-forced
  const p2 = cache.current({ force: true });    // must NOT join p1
  assert.notStrictEqual(p1, p2);
  assert.strictEqual(calls, 2);
  d.resolve({ rows: [], source: 'cache', fetchedAt: 1, stale: false, error: null });
});

test('the rows are normalized and never leak the raw `rows` key', async () => {
  const cache = createCatalogueCache({
    loadCatalogue: () => Promise.resolve({ rows: [{ id: 'a/b' }], source: 'network', fetchedAt: 1, stale: false, error: null }),
    cacheFile: 'x',
    normalize: (rows) => rows.map((r) => ({ ...r, normalized: true })),
  });
  const r = await cache.current();
  assert.deepStrictEqual(r.models, [{ id: 'a/b', normalized: true }]);
  assert.strictEqual(r.rows, undefined);
});
