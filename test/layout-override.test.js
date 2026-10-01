'use strict';
/**
 * A tab's own layout (layout pass L1, S6). The host keeps it in memory only, so
 * it survives the window closing and reattaching and dies with the session. The
 * host doesn't judge its shape -- every page normalizes what it reads -- it only
 * refuses what could hurt the host itself.
 */
const test = require('node:test');
const assert = require('node:assert');

const { acceptOverride, MAX_OVERRIDE_BYTES } = require('../host/layout-override');

test('null clears the tab\'s own layout', () => {
  assert.deepStrictEqual(acceptOverride(null), { ok: true, value: null });
});

test('a plain object is kept as it is', () => {
  const layout = { version: 1, zones: { right: ['agents'] } };
  assert.deepStrictEqual(acceptOverride(layout), { ok: true, value: layout });
});

test('anything else is refused', () => {
  for (const raw of [undefined, [], 'layout', 7, true, [{ version: 1 }]]) {
    assert.deepStrictEqual(acceptOverride(raw), { ok: false }, JSON.stringify(raw));
  }
});

test('a layout bigger than the cap is refused; one at the cap is kept', () => {
  assert.strictEqual(MAX_OVERRIDE_BYTES, 8192);
  const at = { pad: 'x'.repeat(MAX_OVERRIDE_BYTES - JSON.stringify({ pad: '' }).length) };
  assert.strictEqual(JSON.stringify(at).length, MAX_OVERRIDE_BYTES);
  assert.strictEqual(acceptOverride(at).ok, true);
  assert.deepStrictEqual(acceptOverride({ pad: at.pad + 'x' }), { ok: false });
});
