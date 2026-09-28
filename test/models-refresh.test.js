'use strict';
/**
 * The Refresh button's state -- pure decision, see app/models-refresh.js's
 * header for why the DOM write and the click handler live in renderer.js
 * instead.
 */
const test = require('node:test');
const assert = require('node:assert');

const { refreshButtonState } = require('../app/models-refresh');

test('with no request in flight and no catalogue yet, the button is a plain Refresh', () => {
  const s = refreshButtonState({ pending: false, catalogueMeta: null });
  assert.strictEqual(s.disabled, false);
  assert.strictEqual(s.label, 'Refresh');
});

test('a request in flight disables the button and says so', () => {
  const s = refreshButtonState({ pending: true, catalogueMeta: null });
  assert.strictEqual(s.disabled, true);
  assert.match(s.label, /Refreshing/);
});

test('pending wins even over a stale catalogue -- never both messages at once', () => {
  const s = refreshButtonState({ pending: true, catalogueMeta: { stale: true, error: 'offline' } });
  assert.strictEqual(s.disabled, true);
  assert.match(s.label, /Refreshing/);
});

test('a fresh catalogue leaves the button enabled with a plain title', () => {
  const s = refreshButtonState({ pending: false, catalogueMeta: { stale: false, source: 'cache' } });
  assert.strictEqual(s.disabled, false);
  assert.doesNotMatch(s.title, /out of date/);
});

test('a stale catalogue leaves the button ENABLED (never stuck) and names the reason', () => {
  const s = refreshButtonState({ pending: false, catalogueMeta: { stale: true, error: 'ENOTFOUND' } });
  assert.strictEqual(s.disabled, false, 'staleness must never lock the only way to try again');
  assert.match(s.title, /ENOTFOUND/);
});

test('a stale catalogue with no error message still names something, not "undefined"', () => {
  const s = refreshButtonState({ pending: false, catalogueMeta: { stale: true, error: null } });
  assert.doesNotMatch(s.title, /undefined/);
  assert.match(s.title, /offline/);
});

test('garbage catalogueMeta (not an object) is treated as absent, not as stale', () => {
  for (const bad of [undefined, 'stale', 42, []]) {
    const s = refreshButtonState({ pending: false, catalogueMeta: bad });
    assert.strictEqual(s.disabled, false);
    assert.doesNotMatch(s.title, /out of date/);
  }
});

test('missing input entirely is the plain enabled state, never a throw', () => {
  assert.doesNotThrow(() => refreshButtonState());
  assert.strictEqual(refreshButtonState().disabled, false);
});
