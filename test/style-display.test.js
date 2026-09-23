'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { styleDisplay, STYLE_SECTIONS, formatSetAt, describeSource } = require('../app/style-display');

// --- the registry itself ------------------------------------------------------

test('the registry has exactly one section today: background', () => {
  // The whole point of the container-that-grows design: this is the ONE line
  // that changes when a second section is added.
  assert.strictEqual(STYLE_SECTIONS.length, 1);
  assert.strictEqual(STYLE_SECTIONS[0].id, 'background');
  assert.ok(STYLE_SECTIONS[0].title);
});

test('styleDisplay returns one entry per registered section, in order', () => {
  const out = styleDisplay({});
  assert.strictEqual(out.length, STYLE_SECTIONS.length);
  assert.deepStrictEqual(out.map(s => s.id), STYLE_SECTIONS.map(s => s.id));
});

test('styleDisplay never throws when handed nothing at all', () => {
  assert.doesNotThrow(() => styleDisplay());
  assert.doesNotThrow(() => styleDisplay(null));
  assert.doesNotThrow(() => styleDisplay({}));
});

// --- formatSetAt --------------------------------------------------------------

test('formatSetAt is absence, not a coerced date, for anything that is not a real timestamp', () => {
  // Number(null) is 0, this codebase's named trap, restated for dates: an
  // absent or malformed timestamp must never format into "some time".
  for (const bad of [null, undefined, '', 'not a date', 123, {}, []]) {
    assert.strictEqual(formatSetAt(bad), null, JSON.stringify(bad));
  }
});

test('formatSetAt formats a real ISO timestamp into something non-empty', () => {
  const out = formatSetAt(new Date('2026-01-02T03:04:05.000Z').toISOString());
  assert.strictEqual(typeof out, 'string');
  assert.ok(out.length > 0);
});

// --- describeSource ------------------------------------------------------------

test('describeSource reads as "reading…" before anything is known', () => {
  assert.strictEqual(describeSource(null), 'reading…');
  assert.strictEqual(describeSource({}), 'reading…');
});

test('describeSource names the generated background plainly', () => {
  assert.strictEqual(describeSource({ source: 'generated' }), 'generated for this project');
});

test('describeSource says "your image, set <when>" for an override with a known time', () => {
  const iso = new Date('2026-01-02T03:04:05.000Z').toISOString();
  const out = describeSource({ source: 'override', setAt: iso });
  assert.ok(out.startsWith('your image, set '), out);
  assert.notStrictEqual(out, 'your image, set ', 'the formatted time must actually be present');
});

test('describeSource degrades to "your image" when the override has no known time', () => {
  // Absence, not a fabricated or blank time -- the "set <when>" bit is only
  // shown when there is something real to show.
  assert.strictEqual(describeSource({ source: 'override' }), 'your image');
  assert.strictEqual(describeSource({ source: 'override', setAt: 'garbage' }), 'your image');
});

// --- backgroundSectionView, via the registry ------------------------------------

test('the background section is not resettable when nothing has been overridden', () => {
  const [bg] = styleDisplay({ background: { source: 'generated' } });
  assert.strictEqual(bg.view.isOverride, false);
  assert.strictEqual(bg.view.description, 'generated for this project');
  assert.strictEqual(bg.view.error, null);
});

test('the background section IS resettable once an override is set', () => {
  const [bg] = styleDisplay({ background: { source: 'override', setAt: null } });
  assert.strictEqual(bg.view.isOverride, true);
});

test('a refusal from the host surfaces as an error string, not silently dropped', () => {
  const [bg] = styleDisplay({ background: { source: 'generated', error: 'that file is too large' } });
  assert.strictEqual(bg.view.error, 'that file is too large');
});

test('an empty-string error is treated as no error, not an empty message shown to the user', () => {
  const [bg] = styleDisplay({ background: { source: 'generated', error: '' } });
  assert.strictEqual(bg.view.error, null);
});
