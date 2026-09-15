'use strict';
/**
 * The catalogue loader — cached, and honest about provenance.
 *
 * The property that matters most is not speed, it is that a STALE PRICE IS
 * NEVER PRESENTED AS CURRENT. A model that was free last month and is not any
 * more would otherwise keep reading as free forever, and that is the failure
 * mode that costs somebody money rather than merely looking wrong.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadCatalogue, FRESH_MS } = require('../host/openrouter');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-or-')), 'catalogue.json');
const rows = n => Array.from({ length: n }, (_, i) => ({ id: `p/model-${i}` }));

// --- the happy path -----------------------------------------------------------

test('a successful fetch is reported as live and written to the cache', async () => {
  const file = tmp();
  const r = await loadCatalogue({ cacheFile: file, now: 1000, fetchImpl: async () => rows(3) });
  assert.strictEqual(r.source, 'network');
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.rows.length, 3);
  assert.ok(fs.existsSync(file), 'the cache should have been written');
});

test('a fresh cache is used without touching the network', async () => {
  const file = tmp();
  await loadCatalogue({ cacheFile: file, now: 1000, fetchImpl: async () => rows(3) });

  let called = 0;
  const r = await loadCatalogue({
    cacheFile: file, now: 1000 + FRESH_MS - 1,
    fetchImpl: async () => { called++; return rows(99); },
  });
  assert.strictEqual(called, 0, 'the network was consulted for a fresh cache');
  assert.strictEqual(r.source, 'cache');
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.rows.length, 3);
});

test('an expired cache is refreshed', async () => {
  const file = tmp();
  await loadCatalogue({ cacheFile: file, now: 1000, fetchImpl: async () => rows(3) });
  const r = await loadCatalogue({
    cacheFile: file, now: 1000 + FRESH_MS + 1, fetchImpl: async () => rows(7),
  });
  assert.strictEqual(r.source, 'network');
  assert.strictEqual(r.rows.length, 7);
});

test('force refetches even a fresh cache', async () => {
  const file = tmp();
  await loadCatalogue({ cacheFile: file, now: 1000, fetchImpl: async () => rows(3) });
  const r = await loadCatalogue({ cacheFile: file, now: 1001, force: true, fetchImpl: async () => rows(9) });
  assert.strictEqual(r.source, 'network');
  assert.strictEqual(r.rows.length, 9);
});

// --- the part that must never lie ---------------------------------------------

test('a network failure falls back to the cache and MARKS IT STALE', async () => {
  // Stale beats empty -- but only if it says so. A month-old price presented as
  // current is the failure that costs money.
  const file = tmp();
  await loadCatalogue({ cacheFile: file, now: 1000, fetchImpl: async () => rows(3) });

  const r = await loadCatalogue({
    cacheFile: file, now: 1000 + FRESH_MS + 1,
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.strictEqual(r.source, 'cache');
  assert.strictEqual(r.stale, true, 'a fallback that does not admit it is stale is the whole defect');
  assert.strictEqual(r.rows.length, 3, 'the cached rows are still usable');
  assert.match(r.error, /ENOTFOUND/);
  assert.strictEqual(r.fetchedAt, 1000, 'the age must be the CACHE age, not now');
});

test('a network failure with NO cache is an empty list AND an error', async () => {
  // "OpenRouter offers no models" and "I could not ask" look identical on
  // screen unless the error travels with the data.
  const r = await loadCatalogue({
    cacheFile: tmp(), now: 1000, fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.deepStrictEqual(r.rows, []);
  assert.strictEqual(r.source, 'none');
  assert.strictEqual(r.stale, true);
  assert.match(r.error, /offline/);
});

test('a successful fetch clears a previous staleness', async () => {
  const file = tmp();
  await loadCatalogue({ cacheFile: file, now: 1000, fetchImpl: async () => rows(3) });
  const bad = await loadCatalogue({
    cacheFile: file, now: 1000 + FRESH_MS + 1, fetchImpl: async () => { throw new Error('x'); },
  });
  assert.strictEqual(bad.stale, true);

  const good = await loadCatalogue({
    cacheFile: file, now: 1000 + FRESH_MS + 2, fetchImpl: async () => rows(5),
  });
  assert.strictEqual(good.stale, false);
  assert.strictEqual(good.error, null);
});

// --- a cache is a file, and files go wrong ------------------------------------

test('a corrupt cache is ignored rather than crashing the panel', async () => {
  const file = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const r = await loadCatalogue({ cacheFile: file, now: 1000, fetchImpl: async () => rows(2) });
  assert.strictEqual(r.source, 'network');
  assert.strictEqual(r.rows.length, 2);
});

test('an EMPTY cached catalogue is not treated as a valid answer', async () => {
  // An empty array parses fine and would otherwise be served as a fresh,
  // authoritative "there are no models".
  const file = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: 1000, rows: [] }));
  const r = await loadCatalogue({ cacheFile: file, now: 1001, fetchImpl: async () => rows(4) });
  assert.strictEqual(r.source, 'network');
  assert.strictEqual(r.rows.length, 4);
});

test('a cache with no timestamp is treated as ancient, not as fresh', async () => {
  // Read as 0 this only looks expired because the epoch is far away, which
  // makes the rule depend on an accident of arithmetic. It must be stated:
  // unknown age is never fresh, whatever the clock happens to say.
  const file = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ rows: rows(3) }));
  let called = 0;
  await loadCatalogue({ cacheFile: file, now: 5000, fetchImpl: async () => { called++; return rows(1); } });
  assert.strictEqual(called, 1, 'a timestamp-less cache must not be trusted as fresh');
});

test('no cache file configured still works, it just cannot cache', async () => {
  const r = await loadCatalogue({ now: 1000, fetchImpl: async () => rows(3) });
  assert.strictEqual(r.source, 'network');
  assert.strictEqual(r.rows.length, 3);
});

test('a fetch that returns junk is an error, not an empty catalogue', async () => {
  const r = await loadCatalogue({
    cacheFile: tmp(), now: 1000, fetchImpl: async () => { throw new Error('catalogue response had no data array'); },
  });
  assert.strictEqual(r.source, 'none');
  assert.match(r.error, /data array/);
});
