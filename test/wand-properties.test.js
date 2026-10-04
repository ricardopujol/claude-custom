'use strict';
/**
 * The wand store's invariants (BACKLOG #51, DESIGN_WAND.md Tests), stated as properties:
 *
 *   1. ROUND-TRIP: serialize -> JSON -> load gives the same favourites, order kept.
 *   2. A CORRUPT FILE IS NEVER EMPTY: whatever else is on disk, if it is not a wand store the load is
 *      `unavailable` with no favourites, never an empty grid that reads as "no favourites".
 *   4. (#61) TYPE-ONLY: typeOnly survives the round trip and an edit that does not name it; a favourite from a
 *      file without it loads as false; a non-boolean in a file is never coerced into either value.
 *   3. IDS STAY UNIQUE after any sequence of add / update / remove / move, and a load repairs a file
 *      whose ids collide.
 *
 * Property tests find wrong premises, which example tests written by the author of the code cannot.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const wand = require('../host/wand');

const EMOJI = ['🌙', '✅', '🔀', '💡', '🚀', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', '🇵🇹', '1️⃣', '⚡', '🧪'];
const emojiArb = fc.constantFrom(...EMOJI);
const skillArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,20}$/);
const argsArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ._=\/-]{0,30}$/).map(s => s.replace(/\s+/g, ' ').trim());
const favArb = fc.record({ emoji: emojiArb, skill: skillArb, args: fc.oneof(fc.constant(''), argsArb), typeOnly: fc.boolean() });

// A valid list built the only legitimate way: through add().
const listArb = fc.array(favArb, { maxLength: 20 }).map((items) => {
  let favs = [];
  for (const it of items) { const r = wand.add(favs, it); if (r.ok) favs = r.favourites; }
  return favs;
});

const ids = (favs) => favs.map(f => f.id);
const unique = (xs) => new Set(xs).size === xs.length;

test('property 1: save -> load round-trips the favourites, order kept, nothing dropped', () => {
  fc.assert(fc.property(listArb, (favs) => {
    const onDisk = JSON.parse(JSON.stringify(wand.serialize(favs)));
    const r = wand.load({ status: 'ok', value: onDisk });
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.favourites, favs);
    assert.strictEqual(r.dropped, 0);
  }), { numRuns: 300 });
});

test('property 1b: load -> serialize -> load is a fixed point for any valid-or-repairable file', () => {
  const messyItem = fc.oneof(
    favArb.map(f => ({ ...f, id: 'x' })),                       // colliding ids
    favArb,                                                      // no id at all
    fc.jsonValue(),                                              // junk
  );
  fc.assert(fc.property(fc.array(messyItem, { maxLength: 15 }), (items) => {
    const first = wand.load({ status: 'ok', value: { version: 1, favourites: items } });
    assert.strictEqual(first.status, 'ok');
    const second = wand.load({ status: 'ok', value: JSON.parse(JSON.stringify(wand.serialize(first.favourites))) });
    assert.deepStrictEqual(second.favourites, first.favourites);
    assert.strictEqual(second.dropped, 0, 'what load keeps is clean');
  }), { numRuns: 300 });
});

test('property 2: a file that is not a wand store is never an empty grid', () => {
  const isStore = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    && v.version === 1 && Array.isArray(v.favourites);
  fc.assert(fc.property(fc.jsonValue().filter(v => !isStore(v)), (value) => {
    const r = wand.load({ status: 'ok', value });
    assert.strictEqual(r.status, 'unavailable');
    assert.strictEqual(r.favourites, null);
    assert.ok(typeof r.reason === 'string' && r.reason !== '');
  }), { numRuns: 500 });
});

test('property 2b: corrupt and unreadable are unavailable whatever error they carry; only missing is the default', () => {
  fc.assert(fc.property(fc.constantFrom('corrupt', 'unreadable'), fc.option(fc.string(), { nil: undefined }), (status, msg) => {
    const error = msg === undefined ? undefined : Object.assign(new Error(msg), { code: msg });
    const r = wand.load({ status, value: null, error });
    assert.strictEqual(r.status, 'unavailable');
    assert.strictEqual(r.favourites, null);
  }));
  assert.strictEqual(wand.load({ status: 'missing' }).status, 'missing');
  // anything not a known status is not "missing" either
  fc.assert(fc.property(fc.string().filter(s => !['ok', 'missing', 'corrupt', 'unreadable'].includes(s)), (status) => {
    assert.strictEqual(wand.load({ status, value: null }).status, 'unavailable');
  }));
  assert.strictEqual(wand.load(undefined).status, 'unavailable');
  assert.strictEqual(wand.load(null).status, 'unavailable');
});

test('property 3: ids stay unique and every edit keeps its promises, across any sequence of edits', () => {
  const opArb = fc.oneof(
    fc.record({ op: fc.constant('add'), item: favArb }),
    fc.record({ op: fc.constant('update'), at: fc.nat(30), patch: fc.record({ emoji: emojiArb, typeOnly: fc.boolean() }, { requiredKeys: [] }) }),
    fc.record({ op: fc.constant('remove'), at: fc.nat(30) }),
    fc.record({ op: fc.constant('move'), at: fc.nat(30), to: fc.nat(30) }),
  );
  fc.assert(fc.property(listArb, fc.array(opArb, { maxLength: 40 }), (start, ops) => {
    let favs = start;
    for (const o of ops) {
      const id = favs.length ? favs[(o.at || 0) % favs.length].id : 'nope';
      let r;
      if (o.op === 'add') r = wand.add(favs, o.item);
      else if (o.op === 'update') r = wand.update(favs, id, o.patch);
      else if (o.op === 'remove') r = wand.remove(favs, id);
      else r = wand.moveTo(favs, id, favs.length ? o.to % favs.length : 0);

      if (!r.ok) { assert.deepStrictEqual(r.favourites, favs, 'a refusal leaves the list as it was'); continue; }
      assert.ok(unique(ids(r.favourites)), `ids: ${ids(r.favourites)}`);
      const before = ids(favs);
      const after = ids(r.favourites);
      if (o.op === 'add') {
        assert.deepStrictEqual(after.slice(0, -1), before);
        assert.ok(!before.includes(after[after.length - 1]), 'the new id is new');
      } else if (o.op === 'update') {
        assert.deepStrictEqual(after, before, 'an edit keeps ids and order');
      } else if (o.op === 'remove') {
        assert.deepStrictEqual(after, before.filter(x => x !== id));
      } else {
        assert.deepStrictEqual([...after].sort(), [...before].sort(), 'a move is a permutation');
        assert.strictEqual(after.indexOf(id), favs.length ? o.to % favs.length : 0);
      }
      favs = r.favourites;
    }
    // and what survives all that is still a valid store
    const again = wand.load({ status: 'ok', value: JSON.parse(JSON.stringify(wand.serialize(favs))) });
    assert.deepStrictEqual(again.favourites, favs);
  }), { numRuns: 300 });
});

test('property 3b: an id freed by a remove is never handed to a favourite that still exists', () => {
  fc.assert(fc.property(listArb, fc.nat(30), favArb, (start, at, item) => {
    fc.pre(start.length > 0);
    const gone = start[at % start.length].id;
    const after = wand.remove(start, gone).favourites;
    const added = wand.add(after, item);
    if (added.ok) assert.ok(unique(ids(added.favourites)));
  }));
});

test('property 4: a valid command is always something the typing path takes', () => {
  const { planTyping } = require('../app/top-bar-display');
  fc.assert(fc.property(favArb, (it) => {
    const r = wand.add([], it);
    assert.ok(r.ok);
    const command = wand.commandOf(r.favourites[0]);
    assert.ok(planTyping({ command, screen: 'ready', connected: true }).ok, command);
  }), { numRuns: 300 });
});

test('D7 property: every string cleanArgs accepts has no control, format or separator character in it', () => {
  fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (s) => {
    const r = wand.cleanArgs(s);
    if (r !== null) assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(r), JSON.stringify(r));
  }), { numRuns: 1000 });
});

test('#61 property 5: typeOnly round-trips, and an update that does not name it never changes it', () => {
  fc.assert(fc.property(listArb, fc.nat(30), emojiArb, (favs, at, emoji) => {
    fc.pre(favs.length > 0);
    const target = favs[at % favs.length];
    const r = wand.update(favs, target.id, { emoji });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.favourites.map(f => f.typeOnly), favs.map(f => f.typeOnly));
    const again = wand.load({ status: 'ok', value: JSON.parse(JSON.stringify(wand.serialize(r.favourites))) });
    assert.deepStrictEqual(again.favourites.map(f => f.typeOnly), favs.map(f => f.typeOnly));
  }), { numRuns: 300 });
});

test('#61 property 6: a v1 favourite with no typeOnly loads as false, and a non-boolean one is dropped, never coerced', () => {
  const notBool = fc.jsonValue().filter(v => typeof v !== 'boolean' && v !== undefined);
  fc.assert(fc.property(favArb, (f) => {
    const { typeOnly, ...old } = f;                              // eslint-disable-line no-unused-vars
    const r = wand.load({ status: 'ok', value: { version: 1, favourites: [{ id: 'a', ...old }] } });
    assert.strictEqual(r.favourites[0].typeOnly, false);
  }), { numRuns: 200 });
  fc.assert(fc.property(favArb, notBool, (f, bad) => {
    const r = wand.load({ status: 'ok', value: { version: 1, favourites: [{ id: 'a', ...f, typeOnly: bad }] } });
    assert.deepStrictEqual(r.favourites, []);
    assert.strictEqual(r.dropped, 1);
    assert.strictEqual(wand.add([], { ...f, typeOnly: bad }).ok, false);
  }), { numRuns: 200 });
});
