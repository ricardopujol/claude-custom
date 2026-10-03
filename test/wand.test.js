'use strict';
/**
 * The wand's pure core (BACKLOG #51): the favourites, their validation and their edits.
 * The invariants (round-trip, a corrupt file is never empty, ids stay unique) are in
 * test/wand-properties.test.js; these are the worked examples.
 */
const test = require('node:test');
const assert = require('node:assert');

const wand = require('../host/wand');
const { SKILL_NAME } = require('../host/wand-skills');

const fav = (id, emoji, skill, args = '') => ({ id, emoji, skill, args });

test('the default set is the four the design names, in order, with unique ids', () => {
  const d = wand.defaultFavourites();
  assert.deepStrictEqual(d.map(f => [f.emoji, f.skill]),
    [['🌙', 'bedtime'], ['✅', 'checkpoint'], ['🔀', 'merged'], ['💡', 'brainstorming']]);
  assert.strictEqual(new Set(d.map(f => f.id)).size, 4);
  assert.ok(d.every(f => f.args === ''));
  // a fresh copy each call: editing one must never edit the next
  d[0].emoji = 'X';
  assert.strictEqual(wand.defaultFavourites()[0].emoji, '🌙');
});

test('every default skill name is one the typing path accepts', () => {
  for (const f of wand.defaultFavourites()) assert.ok(SKILL_NAME.test(f.skill), f.skill);
});

test('isOneEmoji: one pictograph, a ZWJ family, a flag and a keycap are one; text and two are not', () => {
  for (const ok of ['🌙', '✅', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', '🇵🇹', '1️⃣', '⚡', '❤️', '👍🏽']) assert.ok(wand.isOneEmoji(ok), ok);
  for (const bad of ['', 'a', 'ab', '🌙🌙', '🌙 ', ' 🌙', '1', '#', 'é', '\n', null, undefined, 5, '🌙x']) {
    assert.ok(!wand.isOneEmoji(bad), JSON.stringify(bad));
  }
});

test('cleanArgs: whitespace is collapsed and trimmed (the box read-back compares collapsed text)', () => {
  assert.strictEqual(wand.cleanArgs('  --fast   now  '), '--fast now');
  assert.strictEqual(wand.cleanArgs(''), '');
  assert.strictEqual(wand.cleanArgs(undefined), '');
  assert.strictEqual(wand.cleanArgs(null), '');
});

test('cleanArgs: a newline, a control key, a non-string or an over-long value is refused (null)', () => {
  for (const bad of ['a\nb', 'a\rb', 'a\x15b', 'a\x1bb', 'a\x7fb', 5, {}, [], 'x'.repeat(wand.MAX_ARGS + 1)]) {
    assert.strictEqual(wand.cleanArgs(bad), null, JSON.stringify(bad));
  }
  assert.strictEqual(wand.cleanArgs('x'.repeat(wand.MAX_ARGS)).length, wand.MAX_ARGS);
});

test('commandOf: /skill, plus the args after one space only when there are some', () => {
  assert.strictEqual(wand.commandOf(fav('f1', '✅', 'checkpoint')), '/checkpoint');
  assert.strictEqual(wand.commandOf(fav('f1', '✅', 'checkpoint', 'wrap it up')), '/checkpoint wrap it up');
  assert.strictEqual(wand.commandOf(null), null);
  assert.strictEqual(wand.commandOf({ skill: 5 }), null);
});

// --- load: the three outcomes, and a corrupt file is never empty -------------------------------

test('load: a MISSING file is the default set, status missing', () => {
  const r = wand.load({ status: 'missing', value: null });
  assert.strictEqual(r.status, 'missing');
  assert.deepStrictEqual(r.favourites, wand.defaultFavourites());
  assert.strictEqual(r.reason, null);
});

test('load: corrupt and unreadable are UNAVAILABLE with a reason, and no favourites at all (null, not [])', () => {
  const corrupt = wand.load({ status: 'corrupt', value: null, error: new Error('Unexpected token') });
  assert.strictEqual(corrupt.status, 'unavailable');
  assert.strictEqual(corrupt.favourites, null);
  assert.match(corrupt.reason, /not valid JSON/i);
  const unreadable = wand.load({ status: 'unreadable', value: null, error: Object.assign(new Error('x'), { code: 'EPERM' }) });
  assert.strictEqual(unreadable.status, 'unavailable');
  assert.strictEqual(unreadable.favourites, null);
  assert.match(unreadable.reason, /EPERM/);
});

test('load: a readable file of the wrong SHAPE is unavailable too, never an empty grid', () => {
  for (const value of [{}, [], 'x', 5, null, true, { version: 1 }, { version: 1, favourites: {} }, { favourites: [] }]) {
    const r = wand.load({ status: 'ok', value });
    assert.strictEqual(r.status, 'unavailable', JSON.stringify(value));
    assert.strictEqual(r.favourites, null);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  }
});

test('load: a NEWER version is unavailable (and says so), not read as if it were v1', () => {
  const r = wand.load({ status: 'ok', value: { version: 2, favourites: [fav('f1', '✅', 'checkpoint')] } });
  assert.strictEqual(r.status, 'unavailable');
  assert.match(r.reason, /version 2/);
});

test('load: a deliberately empty list is OK and empty: that is the user\'s choice, and different from unavailable', () => {
  const r = wand.load({ status: 'ok', value: { version: 1, favourites: [] } });
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(r.favourites, []);
});

test('load: an item that is not a valid favourite is dropped and COUNTED, the rest keep their order', () => {
  const r = wand.load({ status: 'ok', value: { version: 1, favourites: [
    fav('a', '🌙', 'bedtime'),
    { id: 'b', emoji: 'no', skill: 'x', args: '' },          // not an emoji
    { id: 'c', emoji: '✅', skill: 'bad name', args: '' },    // untypable
    { id: 'd', emoji: '✅', skill: 'ok', args: 'a\nb' },      // newline in args
    7, null, 'str',
    fav('e', '💡', 'brainstorming', 'idea'),
  ] } });
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(r.favourites.map(f => f.id), ['a', 'e']);
  assert.strictEqual(r.dropped, 6);
});

test('load: a missing or repeated id is repaired with a fresh one, never a dropped favourite', () => {
  const r = wand.load({ status: 'ok', value: { version: 1, favourites: [
    fav('x', '🌙', 'bedtime'), fav('x', '✅', 'checkpoint'), { emoji: '🔀', skill: 'merged', args: '' }, fav(5, '💡', 'brainstorming'),
  ] } });
  assert.strictEqual(r.favourites.length, 4);
  assert.strictEqual(new Set(r.favourites.map(f => f.id)).size, 4);
  assert.strictEqual(r.favourites[0].id, 'x', 'the first claim on an id keeps it');
  assert.strictEqual(r.dropped, 0);
});

test('load: args are cleaned on the way in, and a missing args is ""', () => {
  const r = wand.load({ status: 'ok', value: { version: 1, favourites: [
    { id: 'a', emoji: '🌙', skill: 'bedtime' }, { id: 'b', emoji: '✅', skill: 'checkpoint', args: '  a   b ' },
  ] } });
  assert.deepStrictEqual(r.favourites.map(f => f.args), ['', 'a b']);
});

test('load: an unknown field on a favourite is not carried into the in-memory favourite', () => {
  const r = wand.load({ status: 'ok', value: { version: 1, favourites: [{ id: 'a', emoji: '🌙', skill: 'bedtime', args: '', evil: 1 }] } });
  assert.deepStrictEqual(Object.keys(r.favourites[0]).sort(), ['args', 'emoji', 'id', 'skill']);
});

test('serialize: the on-disk shape is { version: 1, favourites }', () => {
  const favs = [fav('a', '🌙', 'bedtime')];
  assert.deepStrictEqual(wand.serialize(favs), { version: 1, favourites: favs });
});

// --- edits -------------------------------------------------------------------------------------

test('add: appends one with a fresh id, and returns the id', () => {
  const start = [fav('f1', '🌙', 'bedtime'), fav('f7', '✅', 'checkpoint')];
  const r = wand.add(start, { emoji: '🔀', skill: 'merged', args: ' now ' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.favourites.length, 3);
  assert.deepStrictEqual(r.favourites[2], { id: 'f8', emoji: '🔀', skill: 'merged', args: 'now' });
  assert.strictEqual(r.id, 'f8');
  assert.strictEqual(start.length, 2, 'the input is never mutated');
});

test('add: refuses a bad emoji, a bad skill, bad args, with the reason the editor shows', () => {
  const start = [fav('f1', '🌙', 'bedtime')];
  for (const [patch, re] of [
    [{ emoji: 'x', skill: 'a' }, /emoji/i],
    [{ emoji: '🌙🌙', skill: 'a' }, /emoji/i],
    [{ emoji: '🌙', skill: 'a b' }, /skill/i],
    [{ emoji: '🌙', skill: '' }, /skill/i],
    [{ emoji: '🌙', skill: 'a', args: 'x\ny' }, /argument/i],
  ]) {
    const r = wand.add(start, patch);
    assert.strictEqual(r.ok, false, JSON.stringify(patch));
    assert.match(r.reason, re);
    assert.deepStrictEqual(r.favourites, start, 'a refusal leaves the list as it was');
  }
});

test('add: refuses past the cap, and says so', () => {
  let favs = [];
  for (let i = 0; i < wand.MAX_FAVOURITES; i++) favs = wand.add(favs, { emoji: '🌙', skill: `s${i}` }).favourites;
  assert.strictEqual(favs.length, wand.MAX_FAVOURITES);
  const r = wand.add(favs, { emoji: '🌙', skill: 'one-more' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, new RegExp(String(wand.MAX_FAVOURITES)));
});

test('update: changes the named fields only, in place, keeping id and position', () => {
  const start = [fav('a', '🌙', 'bedtime'), fav('b', '✅', 'checkpoint', 'x'), fav('c', '🔀', 'merged')];
  const r = wand.update(start, 'b', { emoji: '🚀' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.favourites[1], { id: 'b', emoji: '🚀', skill: 'checkpoint', args: 'x' });
  assert.deepStrictEqual(r.favourites.map(f => f.id), ['a', 'b', 'c']);
  const r2 = wand.update(start, 'b', { args: '' });
  assert.strictEqual(r2.favourites[1].args, '', 'clearing the args is a real edit');
});

test('update: an unknown id or a bad value is refused, list unchanged', () => {
  const start = [fav('a', '🌙', 'bedtime')];
  assert.strictEqual(wand.update(start, 'zzz', { emoji: '🚀' }).ok, false);
  assert.strictEqual(wand.update(start, 'a', { emoji: 'no' }).ok, false);
  assert.strictEqual(wand.update(start, 'a', { skill: 'a b' }).ok, false);
  assert.deepStrictEqual(wand.update(start, 'a', { emoji: 'no' }).favourites, start);
});

test('update: an own property named like a prototype key is not an id', () => {
  const start = [fav('a', '🌙', 'bedtime')];
  for (const id of ['__proto__', 'constructor', 'toString', undefined, null, 5]) {
    assert.strictEqual(wand.update(start, id, { emoji: '🚀' }).ok, false, String(id));
  }
});

test('remove: drops that one; unknown id is a refusal', () => {
  const start = [fav('a', '🌙', 'bedtime'), fav('b', '✅', 'checkpoint')];
  const r = wand.remove(start, 'a');
  assert.deepStrictEqual(r.favourites.map(f => f.id), ['b']);
  assert.strictEqual(wand.remove(start, 'zzz').ok, false);
  assert.deepStrictEqual(wand.remove([fav('a', '🌙', 'bedtime')], 'a').favourites, [], 'removing the last one leaves a real empty list');
});

test('moveTo: the item takes that index, the others shift, in both directions', () => {
  const start = ['a', 'b', 'c', 'd'].map(id => fav(id, '🌙', 'bedtime'));
  const ids = (r) => r.favourites.map(f => f.id).join('');
  assert.strictEqual(ids(wand.moveTo(start, 'a', 2)), 'bcad');
  assert.strictEqual(ids(wand.moveTo(start, 'd', 0)), 'dabc');
  assert.strictEqual(ids(wand.moveTo(start, 'b', 1)), 'abcd');
  assert.strictEqual(ids(wand.moveTo(start, 'a', 3)), 'bcda');
});

test('moveTo: an out-of-range or non-integer index is refused; an unknown id too', () => {
  const start = ['a', 'b'].map(id => fav(id, '🌙', 'bedtime'));
  for (const to of [-1, 2, 1.5, NaN, Infinity, '1', null, undefined]) assert.strictEqual(wand.moveTo(start, 'a', to).ok, false, String(to));
  assert.strictEqual(wand.moveTo(start, 'zzz', 0).ok, false);
});

test('nextId: one past the largest f<number>, ignoring other ids; "f1" on an empty list', () => {
  assert.strictEqual(wand.nextId([]), 'f1');
  assert.strictEqual(wand.nextId([fav('f3', 'a', 'b'), fav('f10', 'a', 'b'), fav('custom', 'a', 'b')]), 'f11');
  assert.strictEqual(wand.nextId([fav('f9999999999999999999999', 'a', 'b')]).startsWith('f'), true);
});

// --- Dexter D11: a newer file is "version N", whatever shape it has ---------------------------------

test('D11: a newer-version file of a DIFFERENT shape still says "version N", not "not a wand store"', () => {
  const r = wand.load({ status: 'ok', value: { version: 2, favourites: { order: ['a'] } } });
  assert.strictEqual(r.status, 'unavailable');
  assert.match(r.reason, /version 2/);
  assert.match(wand.load({ status: 'ok', value: { version: 7 } }).reason, /version 7/);
  // a v1 file with the wrong shape is still "not a wand store"
  assert.match(wand.load({ status: 'ok', value: { version: 1, favourites: {} } }).reason, /not a wand store/);
});

// --- Dexter D7: C1 and other non-printing characters are control characters too ---------------------------

test('D7: C1 controls, line separators and zero-width characters in args are refused', () => {
  for (const bad of ['a\u0085b', 'x\u009b2J', 'a\u2028b', 'a\u2029b', 'a\u200db', 'a\u00adb', 'a\ufeffb', '\u009f']) {
    assert.strictEqual(wand.cleanArgs(bad), null, JSON.stringify(bad));
  }
  assert.strictEqual(wand.cleanArgs('caf\u00e9 \u65e5\u672c'), 'caf\u00e9 \u65e5\u672c', 'ordinary text, accents and CJK still pass');
  assert.strictEqual(wand.cleanArgs('a\tb'), 'a b', 'a tab still collapses');
  assert.strictEqual(wand.add([], { emoji: '\u{1F319}', skill: 'x', args: 'a\u0085b' }).ok, false);
});
