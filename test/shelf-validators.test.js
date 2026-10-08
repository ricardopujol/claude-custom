'use strict';
/**
 * PR #125 Miguel M4: the shelf validator sits on three trust boundaries (the host's reader, main's copy for the page, the page's own display
 * state) and used to behave three ways. Main uses the host function itself; the page's script carries a copy. The SAME fixtures go through
 * both, and through the source check that main really uses the shared function.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { cleanShelfList, MAX_SHELF } = require('../host/canvas-shelf');
const D = require('../app/canvas-display');

const U = 'https://claude.ai/artifact/abc';
const frame = (shelf) => ({ ok: true, sessionId: 's', status: 'empty', bytes: 0, signature: 'sig', hosts: { approved: [], denied: [] }, shelf, limitBytes: 1, changed: false });
const display = (shelf) => D.shelfOf(D.withFrame(D.emptyState(), frame(shelf)));

const FIXTURES = [
  [],
  [{ title: 'A', url: U, time: 't' }],
  [{ title: '  two\nlines\tand   spaces  ', url: U, time: 't' }],
  [{ title: 'x'.repeat(500), url: U, time: 't' }],
  [{ title: '', url: U, time: 't' }, { title: 'ok', url: U, time: 't' }],
  [{ title: '\u0001\u0002', url: U, time: 't' }],
  [{ title: 'a', url: 'http://claude.ai/artifact/x', time: 't' }, { title: 'b', url: 'javascript:alert(1)', time: 't' }, { title: 'c', url: 'https://u:p@claude.ai/a', time: 't' }],
  [{ title: 'a', url: 'not a url', time: 't' }, { title: 'a', url: U }, { title: 5, url: U, time: 't' }, null, 'x', 7, [], { url: U }],
  [{ title: 'pad', url: '  ' + U + '  ', time: 't' }],
  Array.from({ length: MAX_SHELF + 40 }, (_, i) => ({ title: 'n' + i, url: 'https://claude.ai/artifact/' + i, time: 't' })),
  'not a list', null, undefined, {},
];

test('the host function and the page copy agree on every fixture: caps, title handling, address form', () => {
  for (const f of FIXTURES) assert.deepStrictEqual(display(f), cleanShelfList(f), String(JSON.stringify(f)).slice(0, 80));
});

test('the shared rules: one-line title of at most 120 characters, an empty one becomes "Artifact", at most 200 entries', () => {
  const out = cleanShelfList(FIXTURES[2]);
  assert.strictEqual(out[0].title, 'two lines and spaces');
  assert.strictEqual(cleanShelfList(FIXTURES[3])[0].title.length, 120);
  assert.strictEqual(cleanShelfList(FIXTURES[5])[0].title, 'Artifact');
  assert.strictEqual(cleanShelfList(FIXTURES[9]).length, MAX_SHELF);
  assert.strictEqual(display(FIXTURES[9]).length, MAX_SHELF);
});

test('property: both validators give the same answer for arbitrary entries', () => {
  const entry = fc.record({ title: fc.oneof(fc.string(), fc.constant(''), fc.constant(5)), url: fc.oneof(fc.constantFrom(U, 'http://x.example/a', 'https://a:b@x.example/', ' ' + U), fc.string()), time: fc.oneof(fc.string(), fc.constant(undefined)) }, { requiredKeys: [] });
  fc.assert(fc.property(fc.array(entry, { maxLength: 8 }), (list) => {
    assert.deepStrictEqual(display(list), cleanShelfList(list));
  }), { numRuns: 300 });
});
