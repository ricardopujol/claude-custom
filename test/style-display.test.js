'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  styleDisplay, STYLE_SECTIONS, formatSetAt, describeSource, toPercent,
} = require('../app/style-display');

// --- the registry itself ------------------------------------------------------

test('the registry lists colours, background and inactive windows, in that order', () => {
  // The container-that-grows design: a new section is one entry here.
  assert.deepStrictEqual(STYLE_SECTIONS.map(s => s.id), ['colours', 'background', 'inactive', 'avatars']);
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

// The colour facts of a row, without its reset wording (pinned separately).
const colour = ({ value, isSet, painted }) => (painted === undefined ? { value, isSet } : { value, isSet, painted });

test('a colour the project has not set shows the theme value and says it is the default', () => {
  const c = section({ colours: { appColor: null, textColor: null, baseBg: '#0b1018', baseText: '#c3d2e4' } }, 'colours');
  assert.deepStrictEqual(colour(c.view.app), { value: '#0b1018', isSet: false });
  assert.deepStrictEqual(colour(c.view.text), { value: '#c3d2e4', isSet: false });
});

test('a colour the project HAS set is shown and marked resettable', () => {
  // The merged theme paints what was set, so base* equals the choice here.
  const c = section({ colours: { appColor: '#402020', textColor: '#eeeeee', baseBg: '#402020', baseText: '#eeeeee' } }, 'colours');
  assert.deepStrictEqual(colour(c.view.app), { value: '#402020', isSet: true });
  assert.deepStrictEqual(colour(c.view.text), { value: '#eeeeee', isSet: true });
});

test('a colour input always gets a valid #rrggbb, even before anything is known', () => {
  // <input type=color> silently shows black for anything else, which would
  // read as "your app colour is black".
  const c = section({}, 'colours');
  assert.match(c.view.app.value, /^#[0-9a-f]{6}$/);
  assert.match(c.view.text.value, /^#[0-9a-f]{6}$/);
  assert.strictEqual(c.view.known, false);
});

test('accent and secondary text show the effective colour until set, then the set one', () => {
  const unset = section({ colours: { baseBg: '#0b1018', baseAccent: '#4fa3d9', baseDim: '#6b7d94' } }, 'colours');
  assert.deepStrictEqual(colour(unset.view.accent), { value: '#4fa3d9', isSet: false });
  assert.deepStrictEqual(colour(unset.view.secondary), { value: '#6b7d94', isSet: false });
  const set = section({ colours: { baseBg: '#0b1018', accentColor: '#e0a030', secondaryColor: '#a09070' } }, 'colours');
  assert.deepStrictEqual(colour(set.view.accent), { value: '#e0a030', isSet: true });
  assert.deepStrictEqual(colour(set.view.secondary), { value: '#a09070', isSet: true });
  const none = section({}, 'colours');
  assert.match(none.view.accent.value, /^#[0-9a-f]{6}$/);
  assert.match(none.view.secondary.value, /^#[0-9a-f]{6}$/);
});

test('reduceStyle carries the accent and secondary colours and their effective values', () => {
  const s = reduceStyle(undefined, {
    type: 'style', ask: 'colours', source: 'generated', setAt: null,
    look: { appColor: null, textColor: null, accentColor: '#e0a030', secondaryColor: null, darkness: 0.5 },
    theme: { chrome: { bg: '#0b1018', text: '#c3d2e4', accent: '#e0a030', dim: '#6b7d94' } },
  });
  assert.strictEqual(s.colours.accentColor, '#e0a030');
  assert.strictEqual(s.colours.secondaryColor, null);
  assert.strictEqual(s.colours.baseAccent, '#e0a030');
  assert.strictEqual(s.colours.baseDim, '#6b7d94');
});

// Dexter (accent review) #2: when the readability guard moved a chosen colour,
// the panel says what is actually painted instead of only the choice.
test('a set colour the guard adjusted reports the painted value; an untouched one does not', () => {
  const moved = section({ colours: { baseBg: '#ffffff', accentColor: '#ffff00', baseAccent: '#737300' } }, 'colours');
  assert.strictEqual(moved.view.accent.value, '#ffff00', 'the picker keeps the choice');
  assert.strictEqual(moved.view.accent.painted, '#737300');
  const kept = section({ colours: { baseBg: '#000000', accentColor: '#ffff00', baseAccent: '#ffff00' } }, 'colours');
  assert.strictEqual(kept.view.accent.painted, undefined);
});

// Miguel (accent review) #1: unset secondary text is derived, not the theme's.
test('each colour row says truthfully what its Reset goes back to', () => {
  const v = section({ colours: { baseBg: '#0b1018' } }, 'colours').view;
  assert.match(v.app.resetTitle, /theme/i);
  assert.match(v.accent.resetTitle, /theme/i);
  assert.doesNotMatch(v.secondary.resetTitle, /theme/i);
  assert.match(v.secondary.resetTitle, /Text and App/);
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

// --- reduceStyle: panel state from host messages (Dexter F2/F3) ------------------

const { reduceStyle } = require('../app/style-display');

const hello = {
  type: 'hello', theme: { chrome: { bg: '#0b1018', text: '#c3d2e4' } },
  style: { source: 'generated', setAt: null, look: { appColor: null, textColor: null, darkness: 0.5 } },
};

test('reduceStyle builds the panel state from hello', () => {
  const s = reduceStyle(undefined, hello);
  assert.strictEqual(s.colours.baseBg, '#0b1018');
  assert.strictEqual(s.background.source, 'generated');
  assert.strictEqual(s.background.darkness, 0.5);
  assert.strictEqual(s.colours.error, null);
});

test('F2: a refusal lands under the section it ANSWERS, not the last one asked', () => {
  let s = reduceStyle(undefined, hello);
  s = reduceStyle(s, { type: 'style', error: 'too large', ask: 'background' });
  assert.strictEqual(s.background.error, 'too large');
  assert.strictEqual(s.colours.error, null);
});

test('F2: a success clears only its own section\'s error, so another failure stays visible', () => {
  let s = reduceStyle(undefined, hello);
  s = reduceStyle(s, { type: 'style', error: 'too large', ask: 'background' });
  s = reduceStyle(s, {
    type: 'style', ask: 'colours', source: 'generated', setAt: null,
    look: { appColor: '#402020', textColor: null, darkness: 0.5 }, theme: { chrome: { bg: '#402020' } },
  });
  assert.strictEqual(s.background.error, 'too large', 'the background failure is still shown');
  assert.strictEqual(s.colours.appColor, '#402020');
});

test('F2: an untagged refusal falls back to the background section, never vanishes', () => {
  const s = reduceStyle(reduceStyle(undefined, hello), { type: 'style', error: 'x' });
  assert.strictEqual(s.background.error, 'x');
});

test('F2: an unknown ask tag is not used as a state key', () => {
  const s = reduceStyle(reduceStyle(undefined, hello), { type: 'style', error: 'x', ask: '__proto__' });
  assert.strictEqual(s.background.error, 'x');
  assert.deepStrictEqual(Object.keys(s).sort(), ['avatars', 'background', 'colours', 'inactive']);
});

test('F3: a refusal keeps the STORED darkness, so the preview can be put back', () => {
  let s = reduceStyle(undefined, hello);
  s = reduceStyle(s, { type: 'style', error: 'disk full', ask: 'background' });
  assert.strictEqual(s.background.darkness, 0.5);
});

test('reduceStyle keeps the inactive dim, which the host never reports', () => {
  const prev = { ...reduceStyle(undefined, hello), inactive: { dim: 0.3 } };
  assert.deepStrictEqual(reduceStyle(prev, hello).inactive, { dim: 0.3 });
});

// --- Miguel #3: colours say "reading…" until they are known -----------------------

test('the colours section is marked unknown before hello, and known after', () => {
  assert.strictEqual(section({}, 'colours').view.known, false);
  const s = reduceStyle(undefined, hello);
  assert.strictEqual(styleDisplay(s).find((x) => x.id === 'colours').view.known, true);
});
