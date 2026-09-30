'use strict';
/**
 * host/loadout.js -- the tool belt's pure core (BACKLOG #17).
 *
 * Decisions these tests pin, all Ricardo's (documentation/GAMIFICATION_DESIGN.md
 * "1 . Item inventory"): conflicts are DERIVED from the fields an item writes,
 * never from a hand-kept matrix; an item may only claim an effect the harness
 * enforces; applying is a rewrite of the Agent tool's input and nothing else.
 */
const test = require('node:test');
const assert = require('node:assert');

const L = require('../host/loadout');

// --- the catalogue -----------------------------------------------------------

test('the catalogue has the three Pace and three Method items the scope names', () => {
  const ids = L.ITEMS.map(i => i.id).sort();
  assert.deepStrictEqual(ids, [
    'pace-haiku', 'pace-opus', 'pace-sonnet',
    'review-twice', 'state-assumptions', 'verify-with-test',
  ]);
});

test('Pace writes model with the CLI alias, never a full model id', () => {
  for (const [id, alias] of [['pace-haiku', 'haiku'], ['pace-sonnet', 'sonnet'], ['pace-opus', 'opus']]) {
    const item = L.itemById(id);
    assert.strictEqual(item.kind, 'pace');
    assert.deepStrictEqual([...item.writes], ['model']);
    assert.strictEqual(item.model, alias);
  }
});

test('Method writes prompt, with the fixed instructions from the scope', () => {
  assert.strictEqual(L.itemById('verify-with-test').instruction,
    'Before you finish, add or run the test that fails without your change.');
  assert.strictEqual(L.itemById('review-twice').instruction,
    'Before you report, re-read your own diff once more as a reviewer and fix what you find.');
  assert.strictEqual(L.itemById('state-assumptions').instruction,
    'State every assumption you made, at the end of your report.');
  for (const id of ['verify-with-test', 'review-twice', 'state-assumptions']) {
    assert.strictEqual(L.itemById(id).kind, 'method');
    assert.deepStrictEqual([...L.itemById(id).writes], ['prompt']);
  }
});

test('the catalogue is frozen all the way down', () => {
  assert.ok(Object.isFrozen(L.ITEMS));
  for (const item of L.ITEMS) {
    assert.ok(Object.isFrozen(item), item.id);
    assert.ok(Object.isFrozen(item.writes), item.id);
  }
});

test('every item carries what the belt needs to draw it', () => {
  for (const item of L.ITEMS) {
    assert.strictEqual(typeof item.name, 'string');
    assert.ok(item.name.length > 0);
    assert.strictEqual(typeof item.glyph, 'string');
    assert.ok(item.glyph.length > 0);
    assert.strictEqual(typeof item.description, 'string');
    assert.ok(item.description.length > 0);
  }
});

test('itemById is total: an unknown or inherited id is null, not a throw', () => {
  for (const id of ['nope', '', undefined, null, 7, {}, 'constructor', '__proto__', 'toString']) {
    assert.strictEqual(L.itemById(id), null, String(id));
  }
});

// --- conflicts are derived ---------------------------------------------------

test('two items writing the same field conflict; different fields do not', () => {
  assert.strictEqual(L.conflicts('pace-haiku', 'pace-opus'), true);
  assert.strictEqual(L.conflicts('verify-with-test', 'review-twice'), true);
  assert.strictEqual(L.conflicts('pace-haiku', 'verify-with-test'), false);
  assert.strictEqual(L.conflicts('pace-sonnet', 'state-assumptions'), false);
});

test('conflicts is DERIVED from writes: a hypothetical item conflicts by its fields alone', () => {
  const a = { id: 'x', writes: ['model', 'tools'] };
  const b = { id: 'y', writes: ['tools'] };
  const c = { id: 'z', writes: ['prompt'] };
  assert.strictEqual(L.writesOverlap(a, b), true);
  assert.strictEqual(L.writesOverlap(a, c), false);
});

test('an unknown item conflicts with nothing', () => {
  assert.strictEqual(L.conflicts('nope', 'pace-haiku'), false);
  assert.strictEqual(L.conflicts('pace-haiku', 'nope'), false);
});

// --- equip / unequip ---------------------------------------------------------

test('emptyLoadout is a fresh object every time', () => {
  const a = L.emptyLoadout();
  const b = L.emptyLoadout();
  assert.deepStrictEqual(a, { agents: {} });
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.agents, b.agents);
});

test('equip puts an item on one agent type and leaves the input untouched', () => {
  const before = L.emptyLoadout();
  const r = L.equip(before, 'code-reviewer', 'pace-haiku');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.loadout, { agents: { 'code-reviewer': ['pace-haiku'] } });
  assert.deepStrictEqual(before, { agents: {} }, 'equip must not mutate its input');
});

test('a Pace and a Method item share a belt', () => {
  let r = L.equip(L.emptyLoadout(), 'a', 'pace-haiku');
  r = L.equip(r.loadout, 'a', 'review-twice');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.loadout.agents.a, ['pace-haiku', 'review-twice']);
});

test('equipping a second item for the same field is refused, with a reason naming both', () => {
  const first = L.equip(L.emptyLoadout(), 'a', 'pace-haiku').loadout;
  const r = L.equip(first, 'a', 'pace-opus');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /Pace/);
  assert.match(r.reason, /model/);
  assert.deepStrictEqual(r.loadout, first, 'a refusal leaves the loadout as it was');
});

test('a conflict on one agent does not block the same item on another', () => {
  const first = L.equip(L.emptyLoadout(), 'a', 'pace-haiku').loadout;
  const r = L.equip(first, 'b', 'pace-opus');
  assert.strictEqual(r.ok, true);
});

test('equipping what is already equipped is an ok no-op, not a conflict with itself', () => {
  const first = L.equip(L.emptyLoadout(), 'a', 'pace-haiku').loadout;
  const r = L.equip(first, 'a', 'pace-haiku');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.loadout, first);
});

test('equip refuses an unknown item and a malformed agent type, each with a reason', () => {
  const e = L.emptyLoadout();
  for (const [agent, item] of [['a', 'nope'], ['', 'pace-haiku'], [null, 'pace-haiku'], ['__proto__', 'pace-haiku'],
    ['constructor', 'pace-haiku'], ['has space', 'pace-haiku'], ['x'.repeat(65), 'pace-haiku']]) {
    const r = L.equip(e, agent, item);
    assert.strictEqual(r.ok, false, `${agent}/${item}`);
    assert.strictEqual(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0);
    assert.deepStrictEqual(r.loadout, { agents: {} });
  }
});

test('equip on junk input treats the loadout as empty rather than throwing', () => {
  for (const junk of [null, undefined, 7, 'x', [], { agents: 5 }, { agents: [] }]) {
    const r = L.equip(junk, 'a', 'pace-haiku');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.loadout, { agents: { a: ['pace-haiku'] } });
  }
});

test('unequip removes the item and drops an agent left with an empty belt', () => {
  const eq = L.equip(L.emptyLoadout(), 'a', 'pace-haiku').loadout;
  const r = L.unequip(eq, 'a', 'pace-haiku');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.loadout, { agents: {} });
});

test('unequip keeps the other items on the belt', () => {
  let l = L.equip(L.emptyLoadout(), 'a', 'pace-haiku').loadout;
  l = L.equip(l, 'a', 'review-twice').loadout;
  const r = L.unequip(l, 'a', 'pace-haiku');
  assert.deepStrictEqual(r.loadout, { agents: { a: ['review-twice'] } });
});

test('unequip of something not equipped is refused with a reason', () => {
  const r = L.unequip(L.emptyLoadout(), 'a', 'pace-haiku');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not equipped/i);
});

test('itemsFor lists the catalogue entries on an agent, in equip order, and is total', () => {
  let l = L.equip(L.emptyLoadout(), 'a', 'review-twice').loadout;
  l = L.equip(l, 'a', 'pace-opus').loadout;
  assert.deepStrictEqual(L.itemsFor(l, 'a').map(i => i.id), ['review-twice', 'pace-opus']);
  assert.deepStrictEqual(L.itemsFor(l, 'nobody'), []);
  assert.deepStrictEqual(L.itemsFor(null, 'a'), []);
  assert.deepStrictEqual(L.itemsFor(l, '__proto__'), []);
});

// --- applyLoadout ------------------------------------------------------------

const equipped = (agent, ...ids) => ids.reduce((l, id) => L.equip(l, agent, id).loadout, L.emptyLoadout());

test('apply is null when nothing is equipped for that agent type', () => {
  const input = { subagent_type: 'code-reviewer', prompt: 'p', description: 'd' };
  assert.strictEqual(L.applyLoadout(input, L.emptyLoadout()), null);
  assert.strictEqual(L.applyLoadout(input, equipped('someone-else', 'pace-haiku')), null);
});

test('Pace writes model and drops nothing else', () => {
  const input = { subagent_type: 'a', prompt: 'p', description: 'd', run_in_background: true, extra: { n: 1 } };
  const out = L.applyLoadout(input, equipped('a', 'pace-haiku'));
  assert.deepStrictEqual(out, { ...input, model: 'haiku' });
});

test('Pace replaces a model the caller asked for: that is the item doing its job', () => {
  const out = L.applyLoadout({ subagent_type: 'a', prompt: 'p', model: 'opus' }, equipped('a', 'pace-haiku'));
  assert.strictEqual(out.model, 'haiku');
});

test('Method PREPENDS its instruction and keeps the original prompt intact', () => {
  const out = L.applyLoadout({ subagent_type: 'a', prompt: 'Fix the bug in x.js' }, equipped('a', 'state-assumptions'));
  assert.strictEqual(out.prompt,
    'State every assumption you made, at the end of your report.\n\nFix the bug in x.js');
});

test('Pace and Method together write both fields', () => {
  const out = L.applyLoadout({ subagent_type: 'a', prompt: 'P' }, equipped('a', 'pace-sonnet', 'verify-with-test'));
  assert.strictEqual(out.model, 'sonnet');
  assert.ok(out.prompt.endsWith('\n\nP'));
  assert.ok(out.prompt.startsWith('Before you finish'));
});

test('applying the output again does not double the prefix', () => {
  const l = equipped('a', 'review-twice');
  const once = L.applyLoadout({ subagent_type: 'a', prompt: 'P' }, l);
  const twice = L.applyLoadout(once, l);
  assert.strictEqual(twice, null, 'nothing left to change');
  assert.strictEqual(once.prompt.split('re-read your own diff').length - 1, 1);
});

test('Method does not invent a prompt when the input has none, and does not touch a non-string one', () => {
  const l = equipped('a', 'verify-with-test');
  assert.strictEqual(L.applyLoadout({ subagent_type: 'a' }, l), null);
  assert.strictEqual(L.applyLoadout({ subagent_type: 'a', prompt: 42 }, l), null);
  const both = L.applyLoadout({ subagent_type: 'a', prompt: 42 }, equipped('a', 'verify-with-test', 'pace-opus'));
  assert.deepStrictEqual(both, { subagent_type: 'a', prompt: 42, model: 'opus' });
});

test('apply never mutates its input', () => {
  const input = { subagent_type: 'a', prompt: 'p' };
  const snapshot = JSON.stringify(input);
  L.applyLoadout(input, equipped('a', 'pace-opus', 'review-twice'));
  assert.strictEqual(JSON.stringify(input), snapshot);
});

test('apply is total over junk: no subagent_type, non-object input, junk loadout', () => {
  assert.strictEqual(L.applyLoadout({ prompt: 'p' }, equipped('a', 'pace-haiku')), null);
  for (const junk of [null, undefined, 7, 'x', []]) {
    assert.strictEqual(L.applyLoadout(junk, equipped('a', 'pace-haiku')), null);
    assert.strictEqual(L.applyLoadout({ subagent_type: 'a', prompt: 'p' }, junk), null);
  }
  assert.strictEqual(L.applyLoadout({ subagent_type: '__proto__', prompt: 'p' }, equipped('a', 'pace-haiku')), null);
});

test('a Pace item already matching the input is a no-op (null), so the hook prints nothing', () => {
  assert.strictEqual(L.applyLoadout({ subagent_type: 'a', prompt: 'p', model: 'haiku' }, equipped('a', 'pace-haiku')), null);
});

// --- validateLoadout ---------------------------------------------------------

test('validateLoadout keeps a good loadout as it is', () => {
  const good = equipped('a', 'pace-haiku', 'review-twice');
  assert.deepStrictEqual(L.validateLoadout(good), good);
});

test('validateLoadout defaults on junk instead of throwing', () => {
  for (const junk of [null, undefined, 7, 'x', true, [], {}, { agents: null }, { agents: 5 }, { agents: [] }]) {
    assert.deepStrictEqual(L.validateLoadout(junk), { agents: {} }, JSON.stringify(junk));
  }
});

test('validateLoadout drops unknown items, bad agent keys and non-array belts, keeps the rest', () => {
  const v = L.validateLoadout({ agents: {
    good: ['pace-haiku', 'made-up', 3, null],
    'bad key!': ['pace-haiku'],
    notArray: 'pace-haiku',
    empty: [],
  } });
  assert.deepStrictEqual(v, { agents: { good: ['pace-haiku'] } });
});

test('validateLoadout re-derives conflicts: a hand-edited file cannot equip two Pace items', () => {
  const v = L.validateLoadout({ agents: { a: ['pace-haiku', 'pace-opus', 'review-twice', 'pace-opus'] } });
  assert.deepStrictEqual(v, { agents: { a: ['pace-haiku', 'review-twice'] } });
});

test('validateLoadout survives a __proto__ key from JSON.parse', () => {
  const parsed = JSON.parse('{"agents":{"__proto__":["pace-haiku"],"ok":["pace-opus"]}}');
  const v = L.validateLoadout(parsed);
  assert.deepStrictEqual(v, { agents: { ok: ['pace-opus'] } });
  assert.strictEqual(({}).polluted, undefined);
});

// --- the wire catalogue --------------------------------------------------------

test('catalogue() is the JSON-safe subset the renderer draws from', () => {
  const c = L.catalogue();
  assert.strictEqual(c.length, L.ITEMS.length);
  for (const item of c) {
    assert.deepStrictEqual(Object.keys(item).sort(), ['description', 'glyph', 'id', 'kind', 'name', 'writes']);
  }
  assert.doesNotThrow(() => JSON.stringify(c));
});
