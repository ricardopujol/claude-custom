'use strict';
/** BACKLOG #88 + #92 in the Style tab's pure half. */
const test = require('node:test');
const assert = require('node:assert');
const sd = require('../app/style-display');

test('the Style tab has a Fonts section right after Colours', () => {
  const ids = sd.STYLE_SECTIONS.map((s) => s.id);
  assert.ok(ids.includes('fonts'));
  assert.strictEqual(ids.indexOf('fonts'), ids.indexOf('colours') + 1);
  assert.strictEqual(sd.styleDisplay(sd.emptyStyleState()).find((s) => s.id === 'fonts').title, 'Fonts');
});

test('reduceStyle carries the background mode, defaulting to the picture', () => {
  const plain = sd.reduceStyle(null, { type: 'hello', style: { source: 'override', look: { backgroundMode: 'colour', darkness: 0.3 } } });
  assert.strictEqual(plain.background.backgroundMode, 'colour');
  const pic = sd.reduceStyle(null, { type: 'hello', style: { source: 'generated', look: { darkness: 0.3 } } });
  assert.strictEqual(pic.background.backgroundMode, null);
  assert.strictEqual(sd.emptyStyleState().background.backgroundMode, null);
});

test('in Plain colour the darkness slider is offered without a picture, and Match colours is not', () => {
  const v = sd.backgroundSectionView({ source: 'override', kind: 'image', setAt: 'x', darkness: 0.4, mode: 'dark', backgroundMode: 'colour' });
  assert.strictEqual(v.plainColour, true);
  assert.strictEqual(v.showVeil, true);
  assert.strictEqual(v.canMatch, false, 'there is no picture to read colours from');
  assert.strictEqual(v.isOverride, true, 'the picture is still on disk, so its reset stays available');
  assert.match(v.description, /plain colour/i);
  const none = sd.backgroundSectionView({ source: 'generated', darkness: 0.4, mode: 'dark', backgroundMode: 'colour' });
  assert.strictEqual(none.showVeil, true);
  assert.strictEqual(none.isOverride, false);
});

test('with the picture showing, the slider needs your own picture, as before', () => {
  const gen = sd.backgroundSectionView({ source: 'generated', darkness: 0.5, mode: 'dark', backgroundMode: null });
  assert.strictEqual(gen.plainColour, false);
  assert.strictEqual(gen.showVeil, false);
  const own = sd.backgroundSectionView({ source: 'override', kind: 'image', darkness: 0.5, mode: 'dark', backgroundMode: null });
  assert.strictEqual(own.showVeil, true);
  assert.strictEqual(own.canMatch, true);
});

test('an unknown background state is neither plain colour nor a picture', () => {
  const v = sd.backgroundSectionView(null);
  assert.strictEqual(v.plainColour, false);
  assert.strictEqual(v.showVeil, false);
});
