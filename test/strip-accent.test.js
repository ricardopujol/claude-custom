'use strict';
/**
 * Which accent the strip shows (backlog #64, Miguel F2): the SELECTED tab's own,
 * and never another tab's while it has not reported yet.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStripAccent } = require('../app/strip-accent');

test('a tab that has not reported shows null, not the previous tab\'s accent (F2)', () => {
  const s = createStripAccent();
  const a = {};
  const b = {};
  s.report(a, '#00ff88');
  assert.strictEqual(s.show(a), '#00ff88');
  assert.strictEqual(s.show(b), null, 'B is selected and silent: the strip must not keep A\'s green');
  s.report(b, '#ff00aa');
  assert.strictEqual(s.show(b), '#ff00aa');
  assert.strictEqual(s.show(a), '#00ff88', 'going back to A restores A\'s own');
});

test('a later report replaces the tab\'s own accent', () => {
  const s = createStripAccent();
  const a = {};
  s.report(a, '#00ff88');
  s.report(a, '#112233');
  assert.strictEqual(s.show(a), '#112233');
});

test('only a #rrggbb is kept; nothing else reaches the strip', () => {
  const s = createStripAccent();
  const a = {};
  for (const bad of ['red', '#fff', '#00ff8800', '#00ff88\n', 'url(x)', null, undefined, 5, {}]) {
    assert.strictEqual(s.report(a, bad), false, String(bad));
  }
  assert.strictEqual(s.show(a), null);
  assert.strictEqual(s.report(null, '#00ff88'), false);
  assert.strictEqual(s.report('tab', '#00ff88'), false);
});

test('no selected view shows null', () => {
  const s = createStripAccent();
  assert.strictEqual(s.show(null), null);
  assert.strictEqual(s.show(undefined), null);
  assert.strictEqual(s.show('x'), null);
});
