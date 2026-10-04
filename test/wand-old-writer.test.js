'use strict';
/**
 * Dexter F2 (PR #106): a host started BEFORE BACKLOG #61 keeps running its old host/wand.js (hosts outlive the
 * app), and shares the install-wide .harness/state/wand.json with a host that knows `typeOnly`. The old module's
 * serialize() writes { id, emoji, skill, args } only, so with `version` still 1 any reorder or edit made in an old
 * tab silently strips every typeOnly flag, and a "type only" favourite then submits.
 *
 * THE MECHANISM: the file is version 2. The old module refuses a newer version outright ("unavailable", favourites
 * null, every edit blocked by its control: host/wand-control.js on develop returns `blocked` for an unavailable
 * wand), so it can neither read the flags as false nor write the file back without them. Nothing is moved aside
 * or reset on its own: that needs the person to click Reset in the old tab, which is the pre-existing way out of
 * a newer-version file (and keeps the bytes in wand.json.bad-<time>).
 *
 * test/wand-pre61.fixture.js is host/wand.js exactly as on develop 1dbd4af.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const oldWand = require('./wand-pre61.fixture');
const wand = require('../host/wand');

const EMOJI = ['🌙', '✅', '🔀', '💡', '🚀'];
const favArb = fc.record({
  emoji: fc.constantFrom(...EMOJI),
  skill: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,20}$/),
  args: fc.constant(''),
  typeOnly: fc.boolean(),
});
const listArb = fc.array(favArb, { maxLength: 15 }).map((items) => {
  let favs = [];
  for (const it of items) { const r = wand.add(favs, it); if (r.ok) favs = r.favourites; }
  return favs;
});
const onDisk = (favs) => JSON.parse(JSON.stringify(wand.serialize(favs)));

test('F2 sanity: the fixture really is the old writer (it drops typeOnly from a v1 list)', () => {
  const r = oldWand.load({ status: 'ok', value: { version: 1, favourites: [{ id: 'a', emoji: '🌙', skill: 'x', args: '', typeOnly: true }] } });
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(oldWand.serialize(r.favourites).favourites[0], { id: 'a', emoji: '🌙', skill: 'x', args: '' });
});

test('F2: the file the NEW module writes is one the OLD module refuses: unavailable, no favourites, "version N"', () => {
  const file = onDisk([{ id: 'f1', emoji: '🌙', skill: 'commit', args: '', typeOnly: true }]);
  assert.notStrictEqual(file.version, 1, 'a version an old host does not read');
  const seenByOld = oldWand.load({ status: 'ok', value: file });
  assert.strictEqual(seenByOld.status, 'unavailable');
  assert.strictEqual(seenByOld.favourites, null, 'never an empty grid, never favourites without the flag');
  assert.match(seenByOld.reason, new RegExp(`version ${file.version}`));
  assert.strictEqual(seenByOld.transient, false);
});

test('F2 property: for ANY list, the old host cannot read what the new host wrote, so it cannot write it back stripped', () => {
  fc.assert(fc.property(listArb, (favs) => {
    const seenByOld = oldWand.load({ status: 'ok', value: onDisk(favs) });
    assert.strictEqual(seenByOld.status, 'unavailable');
    assert.strictEqual(seenByOld.favourites, null);
  }), { numRuns: 300 });
});

test('F2 property: the new host reads its own file back with every typeOnly intact', () => {
  fc.assert(fc.property(listArb, (favs) => {
    const back = wand.load({ status: 'ok', value: onDisk(favs) });
    assert.strictEqual(back.status, 'ok');
    assert.deepStrictEqual(back.favourites.map(f => f.typeOnly), favs.map(f => f.typeOnly));
  }), { numRuns: 300 });
});

test('F2: the new host still reads a v1 file (written by an old host, or before the update): typeOnly false, nothing dropped', () => {
  const v1 = oldWand.serialize(oldWand.defaultFavourites());
  assert.strictEqual(v1.version, 1);
  const r = wand.load({ status: 'ok', value: JSON.parse(JSON.stringify(v1)) });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.dropped, 0);
  assert.ok(r.favourites.every(f => f.typeOnly === false));
  assert.strictEqual(r.favourites.length, 4);
});

test('F2: a version the new host does not know (3) is unavailable too, naming that version', () => {
  const r = wand.load({ status: 'ok', value: { version: wand.VERSION + 1, favourites: [] } });
  assert.strictEqual(r.status, 'unavailable');
  assert.match(r.reason, new RegExp(`version ${wand.VERSION + 1}`));
  assert.strictEqual(wand.load({ status: 'ok', value: { version: 0, favourites: [] } }).status, 'unavailable');
});
