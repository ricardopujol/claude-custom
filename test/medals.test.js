'use strict';
/**
 * BACKLOG #80: medals Ricardo gives an agent. The pure rules (app/medals-display.js) and the install-wide store
 * (host/medals.js). The card shows a count; the shelf on the log page shows each medal with its reason and date.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { tmpDir } = require('./tmp-dir');
const { createStore } = require('../host/store');
const { createMedals } = require('../host/medals');
const md = require('../app/medals-display');

function setup() {
  const dir = tmpDir('medals');
  const store = createStore({ dir });
  let n = 0;
  const make = () => createMedals({ store, now: () => 1_700_000_000_000, newId: () => 'id' + (n++) });
  return { dir, store, make };
}

// --- the kinds and the validation ----------------------------------------------------------------

test('there are exactly the six kinds Ricardo picked, each with an icon and a label', () => {
  assert.deepStrictEqual(md.KINDS.map(k => k.icon), ['🏅', '🐛', '⚡', '🧠', '🛡️', '🎯']);
  assert.deepStrictEqual(md.KINDS.map(k => k.label),
    ['Great work', 'Bug hunter', 'Fast', 'Sharp call', 'Saved the day', 'Spot on']);
  assert.strictEqual(new Set(md.KINDS.map(k => k.kind)).size, 6);
});

test('cleanReason keeps one trimmed line, drops control characters and caps the length', () => {
  assert.strictEqual(md.cleanReason('  found\nthe\tleak  '), 'found the leak');
  assert.strictEqual(md.cleanReason('a\u0000b\u001bc'), 'abc');
  assert.strictEqual(md.cleanReason(undefined), '');
  assert.strictEqual(md.cleanReason(42), '');
  assert.strictEqual([...md.cleanReason('x'.repeat(500))].length, md.REASON_MAX);
});

test('cleanReason never cuts a surrogate pair in half', () => {
  const out = md.cleanReason('🏅'.repeat(md.REASON_MAX + 5));
  assert.strictEqual([...out].length, md.REASON_MAX);
  assert.ok(!/[\uD800-\uDBFF]$/.test(out));
});

test('validGive accepts a known kind and a usable name, and an absent reason is empty', () => {
  assert.deepStrictEqual(md.validGive({ type: 'medal', action: 'give', agent: 'miguel', kind: 'fast' }),
    { agent: 'miguel', kind: 'fast', reason: '' });
  assert.deepStrictEqual(md.validGive({ agent: 'miguel', kind: 'fast', reason: ' ok ' }),
    { agent: 'miguel', kind: 'fast', reason: 'ok' });
});

test('validGive refuses an unknown kind, an empty or oversized name, and non-objects', () => {
  assert.strictEqual(md.validGive({ agent: 'miguel', kind: 'gold' }), null);
  assert.strictEqual(md.validGive({ agent: '', kind: 'fast' }), null);
  assert.strictEqual(md.validGive({ agent: 'a'.repeat(md.AGENT_MAX + 1), kind: 'fast' }), null);
  assert.strictEqual(md.validGive({ agent: 7, kind: 'fast' }), null);
  assert.strictEqual(md.validGive(null), null);
  assert.strictEqual(md.validGive('x'), null);
});

test('validRemove needs a name and a string id', () => {
  assert.deepStrictEqual(md.validRemove({ agent: 'miguel', id: 'abc' }), { agent: 'miguel', id: 'abc' });
  assert.strictEqual(md.validRemove({ agent: 'miguel' }), null);
  assert.strictEqual(md.validRemove({ agent: 'miguel', id: '' }), null);
  assert.strictEqual(md.validRemove({ id: 'abc' }), null);
});

// --- the count and the shelf ---------------------------------------------------------------------

test('countOf is the number of medals, and an agent with none (or an odd name) is 0', () => {
  const list = [{ agent: 'miguel', medals: [{}, {}] }, { agent: '__proto__', medals: [{}] }];
  assert.strictEqual(md.countOf(list, 'miguel'), 2);
  assert.strictEqual(md.countOf(list, '__proto__'), 1);
  assert.strictEqual(md.countOf(list, 'toString'), 0);
  assert.strictEqual(md.countOf(null, 'miguel'), 0);
});

test('the chip shows only a count, and nothing at all for zero', () => {
  assert.strictEqual(md.chipHtml(0), '');
  assert.match(md.chipHtml(3), /class="medal-chip"/);
  assert.match(md.chipHtml(3), />🏅 3</);
  assert.ok(!md.chipHtml(3).includes('reason'));
});

test('the shelf escapes the reason and the name, and each medal carries its remove button', () => {
  const html = md.shelfHtml('<b>x</b>', [
    { id: 'm1', kind: 'bug-hunter', reason: '<script>alert(1)</script>', at: Date.UTC(2026, 9, 9, 12, 0) },
  ]);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>x</b>'));
  assert.match(html, /data-medal-remove="m1"/);
  assert.match(html, /🐛/);
  assert.match(html, /2026-10-09/);
});

test('the shelf says so when there are no medals, and drops entries whose kind it does not know', () => {
  assert.match(md.shelfHtml('miguel', []), /No medals yet/);
  const html = md.shelfHtml('miguel', [{ id: 'm1', kind: 'nope', reason: 'x', at: 0 }]);
  assert.match(html, /No medals yet/);
});

// --- the store -----------------------------------------------------------------------------------

test('giving a medal persists it install-wide and survives a fresh store object', () => {
  const { dir, make } = setup();
  const out = make().give('miguel', 'fast', 'beat the clock');
  assert.strictEqual(out.ok, true);
  const again = createMedals({ store: createStore({ dir }) });
  const all = again.all();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].agent, 'miguel');
  assert.strictEqual(all[0].medals[0].reason, 'beat the clock');
  assert.strictEqual(all[0].medals[0].kind, 'fast');
});

test('a medal records its date', () => {
  const { make } = setup();
  const out = make().give('miguel', 'fast', '');
  assert.strictEqual(out.medals.find(a => a.agent === 'miguel').medals[0].at, 1_700_000_000_000);
});

test('removing a medal takes only that one, and an unknown id is refused without a write', () => {
  const { make } = setup();
  const m = make();
  m.give('miguel', 'fast', 'a');
  const second = m.give('miguel', 'spot-on', 'b');
  const id = second.medals[0].medals[1].id;
  const out = m.remove('miguel', id);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(m.all()[0].medals.map(x => x.reason), ['a']);
  const bad = m.remove('miguel', 'nope');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, 'no-such-medal');
});

test('removing the last medal drops the agent entry', () => {
  const { make } = setup();
  const m = make();
  const given = m.give('miguel', 'fast', '');
  m.remove('miguel', given.medals[0].medals[0].id);
  assert.deepStrictEqual(m.all(), []);
});

test('a corrupt file is never written over: the give is refused and the file is untouched', () => {
  const { dir, store, make } = setup();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(store.pathOf('medals'), '{ not json');
  const out = make().give('miguel', 'fast', '');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'unreadable');
  assert.strictEqual(fs.readFileSync(store.pathOf('medals'), 'utf8'), '{ not json');
});

test('a file of the wrong shape is refused, not replaced', () => {
  const { dir, store, make } = setup();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(store.pathOf('medals'), JSON.stringify({ version: 1, agents: 'oops' }));
  const out = make().give('miguel', 'fast', '');
  assert.strictEqual(out.ok, false);
});

test('a write that fails is reported, not swallowed', () => {
  const { store, make } = setup();
  const broken = { ...store, write: () => { throw new Error('disk full'); }, readState: store.readState, withLock: store.withLock };
  const m = createMedals({ store: broken, newId: () => 'x' });
  const out = m.give('miguel', 'fast', '');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'write-failed');
  void make;
});

test('an agent holds at most PER_AGENT_MAX medals; the next one is refused', () => {
  const { make } = setup();
  const m = make();
  for (let i = 0; i < md.PER_AGENT_MAX; i++) assert.strictEqual(m.give('miguel', 'fast', '').ok, true);
  const out = m.give('miguel', 'fast', '');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'full');
});

test('an agent named like a prototype key is an ordinary agent', () => {
  const { make } = setup();
  const m = make();
  assert.strictEqual(m.give('__proto__', 'fast', 'x').ok, true);
  assert.strictEqual(m.give('constructor', 'fast', 'y').ok, true);
  assert.deepStrictEqual(m.all().map(a => a.agent).sort(), ['__proto__', 'constructor']);
  assert.strictEqual(md.countOf(m.all(), '__proto__'), 1);
});

test('PROPERTY: after any sequence of gives and removes, the count per agent equals gives minus successful removes', () => {
  const op = fc.oneof(
    fc.record({ t: fc.constant('give'), a: fc.constantFrom('a', 'b', 'c'), k: fc.constantFrom(...md.KINDS.map(k => k.kind)) }),
    fc.record({ t: fc.constant('rm'), a: fc.constantFrom('a', 'b', 'c'), i: fc.nat(5) }),
  );
  fc.assert(fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
    const { make } = setup();
    const m = make();
    const expect = { a: 0, b: 0, c: 0 };
    for (const o of ops) {
      if (o.t === 'give') { assert.strictEqual(m.give(o.a, o.k, '').ok, true); expect[o.a]++; }
      else {
        const entry = m.all().find(e => e.agent === o.a);
        const target = entry && entry.medals[o.i % entry.medals.length];
        const out = m.remove(o.a, target ? target.id : 'none');
        assert.strictEqual(out.ok, !!target);
        if (target) expect[o.a]--;
      }
    }
    for (const k of Object.keys(expect)) assert.strictEqual(md.countOf(m.all(), k), expect[k]);
    // ids are unique across the whole store
    const ids = m.all().flatMap(e => e.medals.map(x => x.id));
    assert.strictEqual(new Set(ids).size, ids.length);
  }), { numRuns: 40 });
});

test('the store file sits beside the others, as medals.json', () => {
  const { store } = setup();
  assert.strictEqual(path.basename(store.pathOf('medals')), 'medals.json');
});

// --- the menu ------------------------------------------------------------------------------------

test('the menu lists the six kinds, a reason field limited to REASON_MAX, and Give is off until a kind is picked', () => {
  const html = md.menuHtml('miguel', null);
  for (const k of md.KINDS) assert.ok(html.includes(`data-medal-kind="${k.kind}"`), k.kind);
  assert.match(html, new RegExp(`maxlength="${md.REASON_MAX}"`));
  assert.match(html, /data-medal-give disabled/);
  const picked = md.menuHtml('miguel', 'fast');
  assert.ok(!/data-medal-give disabled/.test(picked));
  assert.match(picked, /class="medal-kind on" data-medal-kind="fast"/);
});

test('the menu and the card button escape the agent name', () => {
  assert.ok(!md.menuHtml('<i>x</i>', null).includes('<i>x</i>'));
  assert.ok(!md.cardButtonHtml('"><script>').includes('<script>'));
  assert.match(md.cardButtonHtml('miguel'), /data-medal-open/);
});
