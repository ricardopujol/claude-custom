'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  styleDisplay, STYLE_SECTIONS, formatSetAt, describeSource, toPercent,
} = require('../app/style-display');

// --- the registry itself ------------------------------------------------------

test('the registry lists colours, background and inactive windows, in that order', () => {
  // The container-that-grows design: a new section is one entry here.
  assert.deepStrictEqual(STYLE_SECTIONS.map(s => s.id), ['colours', 'background', 'inactive']);
  for (const s of STYLE_SECTIONS) assert.ok(s.title, s.id);
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

const section = (state, id = 'background') => styleDisplay(state).find(s => s.id === id);

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
  const bg = section({ background: { source: 'generated' } });
  assert.strictEqual(bg.view.isOverride, false);
  assert.strictEqual(bg.view.description, 'generated for this project');
  assert.strictEqual(bg.view.error, null);
});

test('the background section IS resettable once an override is set', () => {
  const bg = section({ background: { source: 'override', setAt: null } });
  assert.strictEqual(bg.view.isOverride, true);
});

test('a refusal from the host surfaces as an error string, not silently dropped', () => {
  const bg = section({ background: { source: 'generated', error: 'that file is too large' } });
  assert.strictEqual(bg.view.error, 'that file is too large');
});

test('an empty-string error is treated as no error, not an empty message shown to the user', () => {
  const bg = section({ background: { source: 'generated', error: '' } });
  assert.strictEqual(bg.view.error, null);
});

// --- toPercent -------------------------------------------------------------------

test('toPercent rounds a real fraction and is null for anything else, never 0', () => {
  assert.strictEqual(toPercent(0.456), 46);
  assert.strictEqual(toPercent(0), 0);
  for (const bad of [null, undefined, '0.5', NaN, Infinity]) assert.strictEqual(toPercent(bad), null, String(bad));
});

// --- background darkness ------------------------------------------------------------

test('the background section carries its darkness as a percent', () => {
  const bg = section({ background: { source: 'override', darkness: 0.6 } });
  assert.strictEqual(bg.view.darknessPercent, 60);
});

test('an unknown darkness is null, not a confident 0%', () => {
  assert.strictEqual(section({ background: { source: 'override' } }).view.darknessPercent, null);
});

// --- colours ----------------------------------------------------------------------

test('a colour the project has not set shows the theme value and says it is the default', () => {
  const c = section({ colours: { appColor: null, textColor: null, baseBg: '#0b1018', baseText: '#c3d2e4' } }, 'colours');
  assert.deepStrictEqual(c.view.app, { value: '#0b1018', isSet: false });
  assert.deepStrictEqual(c.view.text, { value: '#c3d2e4', isSet: false });
});

test('a colour the project HAS set is shown and marked resettable', () => {
  const c = section({ colours: { appColor: '#402020', textColor: '#eeeeee', baseBg: '#0b1018', baseText: '#c3d2e4' } }, 'colours');
  assert.deepStrictEqual(c.view.app, { value: '#402020', isSet: true });
  assert.deepStrictEqual(c.view.text, { value: '#eeeeee', isSet: true });
});

test('a colour input always gets a valid #rrggbb, even before anything is known', () => {
  // <input type=color> silently shows black for anything else, which would
  // read as "your app colour is black".
  const c = section({}, 'colours');
  assert.match(c.view.app.value, /^#[0-9a-f]{6}$/);
  assert.match(c.view.text.value, /^#[0-9a-f]{6}$/);
  assert.strictEqual(c.view.known, false);
});

test('a colours error is surfaced, and an empty one is not', () => {
  assert.strictEqual(section({ colours: { error: 'could not save' } }, 'colours').view.error, 'could not save');
  assert.strictEqual(section({ colours: { error: '' } }, 'colours').view.error, null);
});

// --- inactive windows ------------------------------------------------------------

test('the inactive section shows the dim as a percent, or "reading…" before it is known', () => {
  assert.strictEqual(section({ inactive: { dim: 0.45 } }, 'inactive').view.dimPercent, 45);
  const unknown = section({}, 'inactive').view;
  assert.strictEqual(unknown.dimPercent, null);
  assert.strictEqual(unknown.description, 'reading…');
});
