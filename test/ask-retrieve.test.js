'use strict';
/** Hybrid retrieval for "ask the repo" (BACKLOG #33): keyword + vector ranks fused by reciprocal rank. */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { tokenize, cosine, hybridRank } = require('../host/ask-retrieve');

test('tokenize splits camelCase, snake_case and paths, lowercases, drops stop words and one-letter bits', () => {
  assert.deepStrictEqual(tokenize('Where is withFileLock defined in host/file_lock.js?'), ['with', 'file', 'lock', 'defined', 'host', 'file', 'lock', 'js']);
});

test('cosine: identical is 1, orthogonal is 0, a zero vector is 0 (not NaN)', () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.strictEqual(cosine([1, 0], [0, 1]), 0);
  assert.strictEqual(cosine([0, 0], [1, 1]), 0);
  assert.strictEqual(cosine([1, 2], [1]), 0, 'a length mismatch is no match, not a guess');
});

const entries = [
  { id: 0, tokens: tokenize('function withFileLock(path) acquires a lock'), vec: [1, 0, 0] },
  { id: 1, tokens: tokenize('renders the toolbar buttons'), vec: [0, 1, 0] },
  { id: 2, tokens: tokenize('release the session lock on exit'), vec: [0, 0, 1] },
];

test('a chunk that wins on keywords alone still surfaces', () => {
  const r = hybridRank({ question: 'withFileLock', queryVec: [0, 1, 0], entries, k: 2 });
  assert.ok(r.includes(0), 'the keyword-only winner was crowded out');
});

test('a chunk that wins on the vector alone still surfaces', () => {
  const r = hybridRank({ question: 'zzz qqq', queryVec: [0, 1, 0], entries, k: 1 });
  assert.deepStrictEqual(r, [1]);
});

test('with no query vector (embedder down) it falls back to keywords', () => {
  assert.deepStrictEqual(hybridRank({ question: 'release session lock', queryVec: null, entries, k: 2 })[0], 2);
});

test('P the result is at most k distinct ids, all from the index, for any input', () => {
  const entryArb = fc.array(fc.record({ tokens: fc.array(fc.constantFrom('a', 'bb', 'lock', 'file'), { maxLength: 8 }), vec: fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 3 }) }), { maxLength: 30 });
  fc.assert(fc.property(entryArb, fc.string({ maxLength: 30 }), fc.integer({ min: 0, max: 12 }), fc.boolean(), (es, q, k, withVec) => {
    const withIds = es.map((e, id) => ({ ...e, id }));
    const out = hybridRank({ question: q, queryVec: withVec ? [0.3, -0.2, 0.9] : null, entries: withIds, k });
    assert.ok(out.length <= k);
    assert.strictEqual(new Set(out).size, out.length);
    assert.ok(out.every(id => id >= 0 && id < withIds.length));
  }));
});
