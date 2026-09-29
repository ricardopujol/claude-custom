'use strict';
/**
 * The Style tab's "Agent pictures" section (BACKLOG C #3, #18): the global
 * default picture row and, from #18, the "show agent images" toggle.
 *
 * The rule this section exists to keep: the row NEVER goes blank. Not-yet-read,
 * nothing set, and set are three different sentences.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  styleDisplay, emptyStyleState, reduceStyle, reduceAvatars, avatarsSectionView,
} = require('../app/style-display');

const view = (avatars) => styleDisplay({ ...emptyStyleState(), avatars }).find(s => s.id === 'avatars').view;

test('the Agent pictures section is registered', () => {
  const s = styleDisplay(emptyStyleState()).find(x => x.id === 'avatars');
  assert.ok(s);
  assert.strictEqual(s.title, 'Agent pictures');
});

test('before the host has answered the row says it is reading, not "none set"', () => {
  assert.match(view(emptyStyleState().avatars).globalDescription, /reading/);
  assert.strictEqual(view(emptyStyleState().avatars).globalSet, false);
});

test('nothing set says so in words, and Reset is not offered', () => {
  const v = view({ global: { set: false, file: null, media: null }, imagesEnabled: null, error: null });
  assert.strictEqual(v.globalDescription, 'none set (built-in placeholder)');
  assert.strictEqual(v.globalSet, false);
});

test('a set default names the file and its tier', () => {
  const v = view({ global: { set: true, file: 'me.webm', media: 'video' }, imagesEnabled: null, error: null });
  assert.match(v.globalDescription, /me\.webm/);
  assert.match(v.globalDescription, /global default/);
  assert.strictEqual(v.globalSet, true);
});

test('a "set" claim with no file name is not drawn as a confident answer', () => {
  const v = view({ global: { set: true, file: null }, imagesEnabled: null, error: null });
  assert.doesNotMatch(v.globalDescription, /null|undefined/);
});

test('garbage in the global slot reads as "reading", never as a set picture', () => {
  for (const bad of ['yes', 1, [], { set: 'true' }, { set: 1, file: 'x.png' }]) {
    assert.strictEqual(view({ global: bad, imagesEnabled: null, error: null }).globalSet, false, JSON.stringify(bad));
    assert.match(view({ global: bad, imagesEnabled: null, error: null }).globalDescription, /reading/);
  }
});

test('an error is surfaced', () => {
  assert.strictEqual(view({ global: { set: false }, imagesEnabled: null, error: 'too big' }).error, 'too big');
  assert.strictEqual(view({ global: { set: false }, imagesEnabled: null, error: '' }).error, null);
});

test('the images toggle is strict: only a real boolean is known, anything else is "not read yet"', () => {
  assert.strictEqual(view({ global: null, imagesEnabled: true, error: null }).imagesEnabled, true);
  assert.strictEqual(view({ global: null, imagesEnabled: false, error: null }).imagesEnabled, false);
  for (const bad of [null, undefined, 0, 'false']) {
    assert.strictEqual(view({ global: null, imagesEnabled: bad, error: null }).imagesEnabled, null, String(bad));
  }
});

test('the images description says what the toggle does in each state', () => {
  assert.match(view({ global: null, imagesEnabled: true, error: null }).imagesDescription, /shown/);
  assert.match(view({ global: null, imagesEnabled: false, error: null }).imagesDescription, /off/);
  assert.match(view({ global: null, imagesEnabled: null, error: null }).imagesDescription, /reading/);
});

test('avatarsSectionView tolerates a missing state', () => {
  assert.match(avatarsSectionView(undefined).globalDescription, /reading/);
  assert.strictEqual(avatarsSectionView(null).imagesEnabled, null);
});

// --- reduceAvatars ------------------------------------------------------------------

test('hello carries the current global default into the state', () => {
  const next = reduceAvatars(emptyStyleState(), { type: 'hello', globalPortrait: { set: true, file: 'a.png', media: 'image' } });
  assert.deepStrictEqual(next.avatars.global, { set: true, file: 'a.png', media: 'image' });
});

test('a successful global portrait reply updates the row and clears the error', () => {
  const start = { ...emptyStyleState(), avatars: { global: null, imagesEnabled: true, error: 'old' } };
  const next = reduceAvatars(start, { type: 'portrait', global: true, ok: true, globalPortrait: { set: false, file: null, media: null } });
  assert.deepStrictEqual(next.avatars.global, { set: false, file: null, media: null });
  assert.strictEqual(next.avatars.error, null);
  assert.strictEqual(next.avatars.imagesEnabled, true);
});

test('a refused global portrait keeps the old value and shows the reason', () => {
  const start = { ...emptyStyleState(), avatars: { global: { set: true, file: 'a.png', media: 'image' }, imagesEnabled: null, error: null } };
  const next = reduceAvatars(start, { type: 'portrait', global: true, ok: false, reason: 'too big', globalPortrait: { set: true, file: 'a.png', media: 'image' } });
  assert.strictEqual(next.avatars.error, 'too big');
  assert.strictEqual(next.avatars.global.file, 'a.png');
});

test('a refusal with no reason still says something', () => {
  const next = reduceAvatars(emptyStyleState(), { type: 'portrait', global: true, ok: false });
  assert.ok(next.avatars.error && next.avatars.error.length > 0);
});

test('a per-agent portrait message does not touch the global row', () => {
  const start = emptyStyleState();
  const next = reduceAvatars(start, { type: 'portrait', ok: true, agent: 'x', state: 'working' });
  assert.strictEqual(next, start);
});

test('a malformed globalPortrait in a message is ignored rather than stored', () => {
  const start = emptyStyleState();
  const next = reduceAvatars(start, { type: 'hello', globalPortrait: 'nonsense' });
  assert.strictEqual(next.avatars.global, null);
});

test('reduceStyle carries the avatars section through a style message untouched', () => {
  const prev = { ...emptyStyleState(), avatars: { global: { set: true, file: 'a.png', media: 'image' }, imagesEnabled: false, error: null } };
  const next = reduceStyle(prev, { style: { look: {} }, theme: { chrome: {} } });
  assert.deepStrictEqual(next.avatars, prev.avatars);
});

test('a style refusal keeps the avatars section as it was', () => {
  const prev = { ...emptyStyleState(), avatars: { global: { set: true, file: 'a.png', media: 'image' }, imagesEnabled: false, error: null } };
  const next = reduceStyle(prev, { error: 'nope', ask: 'background' });
  assert.deepStrictEqual(next.avatars, prev.avatars);
});

test('the images setter records the desired toggle state and ignores non-booleans', () => {
  const { reduceImagesEnabled } = require('../app/style-display');
  assert.strictEqual(reduceImagesEnabled(emptyStyleState(), false).avatars.imagesEnabled, false);
  assert.strictEqual(reduceImagesEnabled(emptyStyleState(), true).avatars.imagesEnabled, true);
  const start = reduceImagesEnabled(emptyStyleState(), false);
  assert.strictEqual(reduceImagesEnabled(start, 'true').avatars.imagesEnabled, false);
  assert.strictEqual(reduceImagesEnabled(start, null).avatars.imagesEnabled, false);
});
