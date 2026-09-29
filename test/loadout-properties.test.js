'use strict';
/**
 * PROPERTIES for host/loadout.js (BACKLOG #17, item 5 of the merge gate).
 *
 * The invariants worth stating, not just spot-checking:
 *   - applying is idempotent on its own output (the Method prefix must never
 *     stack, however many times the same spawn is rewritten);
 *   - equip then unequip is a round trip;
 *   - conflicts is symmetric and is exactly "the fields overlap";
 *   - validateLoadout is total over arbitrary JSON and its output is a fixed
 *     point (validating a validated loadout changes nothing) that is always a
 *     conflict-free loadout.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const L = require('../host/loadout');

const itemId = fc.constantFrom(...L.ITEMS.map(i => i.id));
const agentType = fc.constantFrom('code-reviewer', 'logic-reviewer', 'general-purpose', 'plugin:helper', 'a');

// A sequence of equip/unequip attempts -> whatever loadout results. Refusals
// simply do not change it, so the result is always reachable through the API.
const opSeq = fc.array(fc.tuple(fc.boolean(), agentType, itemId), { maxLength: 25 });
function run(ops) {
  return ops.reduce((l, [eq, a, i]) => (eq ? L.equip(l, a, i) : L.unequip(l, a, i)).loadout, L.emptyLoadout());
}

// Arbitrary JSON, including the keys that break naive object code.
const jsonValue = fc.letrec(tie => ({
  leaf: fc.oneof(fc.constant(null), fc.boolean(), fc.integer(), fc.string(),
    fc.constantFrom('pace-haiku', 'review-twice', '__proto__', 'constructor')),
  tree: fc.oneof(
    { depthSize: 'small' },
    tie('leaf'),
    fc.array(tie('tree'), { maxLength: 4 }),
    fc.dictionary(fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom('agents', '__proto__', 'a', 'constructor')),
      tie('tree'), { maxKeys: 4 }),
  ),
})).tree;

const toolInput = fc.record({
  subagent_type: agentType,
  prompt: fc.oneof(fc.string(), fc.constant(undefined), fc.integer()),
  description: fc.string(),
  model: fc.oneof(fc.constant(undefined), fc.constantFrom('opus', 'sonnet', 'haiku', 'x')),
}, { requiredKeys: ['subagent_type', 'description'] });

test('PROPERTY: apply is idempotent on its own output -- the prefix never stacks', () => {
  fc.assert(fc.property(opSeq, toolInput, (ops, input) => {
    const l = run(ops);
    const once = L.applyLoadout(input, l) || input;
    const twice = L.applyLoadout(once, l) || once;
    assert.deepStrictEqual(twice, once);
    if (typeof once.prompt === 'string') {
      for (const item of L.itemsFor(l, input.subagent_type).filter(i => i.kind === 'method')) {
        assert.strictEqual(once.prompt.split(item.instruction).length - 1 <= 1 +
          (typeof input.prompt === 'string' ? input.prompt.split(item.instruction).length - 1 : 0), true);
      }
    }
  }), { numRuns: 300 });
});

test('PROPERTY: apply preserves every field it does not write, and the original prompt', () => {
  fc.assert(fc.property(opSeq, toolInput, (ops, input) => {
    const out = L.applyLoadout(input, run(ops));
    if (out === null) return;
    for (const k of Object.keys(input)) {
      if (k === 'model' || k === 'prompt') continue;
      assert.deepStrictEqual(out[k], input[k], k);
    }
    if (typeof input.prompt === 'string') {
      assert.ok(out.prompt.endsWith(input.prompt), 'the original prompt is kept intact at the end');
    } else {
      assert.strictEqual(out.prompt, input.prompt);
    }
  }), { numRuns: 300 });
});

test('PROPERTY: equip then unequip round-trips', () => {
  fc.assert(fc.property(opSeq, agentType, itemId, (ops, a, i) => {
    const base = run(ops);
    const eq = L.equip(base, a, i);
    if (!eq.ok) { assert.deepStrictEqual(eq.loadout, base); return; }
    const already = L.itemsFor(base, a).some(x => x.id === i);
    if (already) { assert.deepStrictEqual(eq.loadout, base); return; }
    const un = L.unequip(eq.loadout, a, i);
    assert.strictEqual(un.ok, true);
    assert.deepStrictEqual(un.loadout, base);
  }), { numRuns: 300 });
});

test('PROPERTY: any loadout reachable through the API is conflict-free', () => {
  fc.assert(fc.property(opSeq, (ops) => {
    const l = run(ops);
    for (const a of Object.keys(l.agents)) {
      const ids = l.agents[a];
      assert.ok(ids.length > 0, 'no empty belts are stored');
      for (let x = 0; x < ids.length; x++) {
        for (let y = x + 1; y < ids.length; y++) assert.strictEqual(L.conflicts(ids[x], ids[y]), false);
      }
    }
  }), { numRuns: 300 });
});

test('PROPERTY: conflicts is symmetric and equals "the written fields overlap"', () => {
  fc.assert(fc.property(itemId, itemId, (x, y) => {
    assert.strictEqual(L.conflicts(x, y), L.conflicts(y, x));
    const a = L.itemById(x); const b = L.itemById(y);
    assert.strictEqual(L.conflicts(x, y), a.writes.some(w => b.writes.includes(w)));
  }));
});

test('PROPERTY: validateLoadout is total over arbitrary JSON, and its result is a valid fixed point', () => {
  fc.assert(fc.property(jsonValue, (raw) => {
    const wire = JSON.parse(JSON.stringify(raw));   // exactly what a file read hands back
    const v = L.validateLoadout(wire);
    assert.deepStrictEqual(L.validateLoadout(v), v);
    assert.deepStrictEqual(Object.keys(v), ['agents']);
    for (const a of Object.keys(v.agents)) {
      assert.ok(!(a in Object.prototype));
      for (const id of v.agents[a]) assert.notStrictEqual(L.itemById(id), null);
    }
  }), { numRuns: 500 });
});

test('PROPERTY: validateLoadout never invents: everything it keeps was in the input', () => {
  fc.assert(fc.property(opSeq, (ops) => {
    const l = run(ops);
    assert.deepStrictEqual(L.validateLoadout(JSON.parse(JSON.stringify(l))), l);
  }), { numRuns: 200 });
});
