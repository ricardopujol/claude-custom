'use strict';
/**
 * Kill tests for the accent code of backlog #64, from Mortimer's gate on release PR #109 (survivor 13): the colour reaches a
 * CSS custom property, so every entry point takes only a whole #rrggbb string. The anchors matter: with a start or end
 * anchor gone, 'x#00ff88' (a valid hex EMBEDDED in a string) gets through. And report() has to say whether it kept it.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createStripAccent } = require('../app/strip-accent');
const { previewChrome } = require('../app/accent-preview');
const { chosenAccent, withChosenAccent } = require('../app/top-bar-display');

const EMBEDDED = ['x#00ff88', '#00ff88 ', ' #00ff88', '#00ff88\n', '#00ff8800', '#00ff8', '00ff88', '', 'red'];
const NOT_STRINGS = [5, null, undefined, {}, [], { toString: () => '#00ff88' }, ['#00ff88']];

test('strip-accent report(): true for a kept colour (either case), false for anything else, and nothing bad is shown', () => {
  const s = createStripAccent();
  const a = {};
  assert.strictEqual(s.report(a, '#00ff88'), true);
  assert.strictEqual(s.report(a, '#00FF88'), true);
  assert.strictEqual(s.show(a), '#00FF88');
  for (const bad of [...EMBEDDED, ...NOT_STRINGS]) {
    assert.strictEqual(s.report(a, bad), false, JSON.stringify(String(bad)));
    assert.strictEqual(s.show(a), '#00FF88', 'a refused report leaves the last good one');
  }
  const fresh = {};
  assert.strictEqual(s.report(fresh, 'x#00ff88'), false);
  assert.strictEqual(s.show(fresh), null);
});

test('accent-preview previewChrome: only a whole #rrggbb previews; a valid hex embedded in a string is nothing to preview', () => {
  const chrome = { bg: '#11131a', panel: '#171a23' };
  assert.notStrictEqual(previewChrome('#00ff88', chrome), null);
  assert.strictEqual(previewChrome('#00FF88', chrome).accent, '#00ff88', 'lower-cased');
  for (const bad of [...EMBEDDED, ...NOT_STRINGS]) assert.strictEqual(previewChrome(bad, chrome), null, JSON.stringify(String(bad)));
});

test('accent-preview previewChrome: a surface that is not a whole #rrggbb is ignored, not read as a colour', () => {
  const plain = previewChrome('#00ff88', { bg: '#11131a', panel: '#171a23' });
  assert.deepStrictEqual(previewChrome('#00ff88', { bg: '#11131a', panel: 'x#171a23' }), previewChrome('#00ff88', { bg: '#11131a' }));
  assert.doesNotThrow(() => previewChrome('#00ff88', { bg: 'x#11131a', panel: 5 }));
  assert.doesNotThrow(() => previewChrome('#00ff88', { bg: '#11131a ', panel: null }));
  assert.ok(plain.accent);
});

test('top-bar withChosenAccent: a hex embedded in a string is no colour, and the theme comes back as it was', () => {
  const theme = { chrome: { accent: '#d08c4a', onAccent: '#111111' } };
  for (const bad of [...EMBEDDED, ...NOT_STRINGS]) assert.strictEqual(withChosenAccent(theme, bad), theme, JSON.stringify(String(bad)));
  assert.strictEqual(withChosenAccent(theme, '#00ff88').chrome.accent, '#00ff88');
  assert.strictEqual(withChosenAccent(theme, '#00FF88').chrome.accent, '#00FF88');
});

test('top-bar withChosenAccent: the label colour is the preview\'s only when it is a non-empty string, else the look\'s own', () => {
  const theme = { chrome: { accent: '#d08c4a', onAccent: '#111111' } };
  assert.strictEqual(withChosenAccent(theme, '#00ff88', '#abcdef').chrome.onAccent, '#abcdef');
  for (const none of ['', 5, null, undefined, {}]) {
    assert.strictEqual(withChosenAccent(theme, '#00ff88', none).chrome.onAccent, '#111111', JSON.stringify(none));
    assert.strictEqual(withChosenAccent({ chrome: {} }, '#00ff88', none).chrome.onAccent, '#12141c', 'and a default when the look has none');
  }
});

test('top-bar withChosenAccent: a theme that is not an object is treated as no theme, and the others are copied, not changed', () => {
  for (const notTheme of ['abc', 7, null, undefined, true]) {
    assert.deepStrictEqual(withChosenAccent(notTheme, '#00ff88'), { chrome: { accent: '#00ff88', onAccent: '#12141c' } });
  }
  const theme = { name: 't', chrome: { bg: '#000000' } };
  const out = withChosenAccent(theme, '#00ff88');
  assert.deepStrictEqual(out, { name: 't', chrome: { bg: '#000000', accent: '#00ff88', onAccent: '#12141c' } });
  assert.deepStrictEqual(theme, { name: 't', chrome: { bg: '#000000' } });
});

test('top-bar chosenAccent: a choice needs a non-empty string accent AND a label colour', () => {
  assert.strictEqual(chosenAccent({ chrome: { accent: '#d08c4a', onAccent: '#111111' } }), '#d08c4a');
  assert.strictEqual(chosenAccent({ chrome: { accent: '#d08c4a' } }), null);
  assert.strictEqual(chosenAccent({ chrome: { accent: '', onAccent: '#111111' } }), null);
  assert.strictEqual(chosenAccent({ chrome: { accent: 5, onAccent: '#111111' } }), null);
  assert.strictEqual(chosenAccent({ chrome: { onAccent: '#111111' } }), null);
  assert.strictEqual(chosenAccent({ chrome: null }), null);
  assert.strictEqual(chosenAccent({}), null);
  assert.strictEqual(chosenAccent(null), null);
});
