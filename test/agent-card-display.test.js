'use strict';
/**
 * How the roster card draws two truths it did not draw before:
 *
 *   1. How many instances of ONE agent are running right now -- `mood.stack()`
 *      already holds one entry per running instance, and the roster used to
 *      collapse them into a single card with no count at all.
 *   2. Which model an agent actually used -- host/session-model.js reads it
 *      from the agent's OWN transcript, never the Agent tool_input's requested
 *      model, and absence must render as "not read yet", never a guess or an
 *      empty string. Same "unknown is not zero" shape as app/career-display.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const { instanceCounts, modelLine } = require('../app/agent-card-display');

// --- instanceCounts ----------------------------------------------------------

test('instanceCounts: empty or missing party is an empty map', () => {
  assert.strictEqual(instanceCounts([]).size, 0);
  assert.strictEqual(instanceCounts(null).size, 0);
  assert.strictEqual(instanceCounts(undefined).size, 0);
});

test('instanceCounts: one running instance counts as one', () => {
  const c = instanceCounts(['code-reviewer']);
  assert.strictEqual(c.get('code-reviewer'), 1);
});

test('instanceCounts: two concurrent instances of the same agent count as two', () => {
  const c = instanceCounts(['code-reviewer', 'code-reviewer']);
  assert.strictEqual(c.get('code-reviewer'), 2);
});

test('instanceCounts: different agents are counted independently', () => {
  const c = instanceCounts(['code-reviewer', 'logic-reviewer', 'code-reviewer']);
  assert.strictEqual(c.get('code-reviewer'), 2);
  assert.strictEqual(c.get('logic-reviewer'), 1);
});

test('instanceCounts: ignores non-string entries rather than throwing', () => {
  const c = instanceCounts(['code-reviewer', null, '', undefined, 42]);
  assert.strictEqual(c.get('code-reviewer'), 1);
  assert.strictEqual(c.size, 1);
});

// property: the total of every count in the map never exceeds the party's
// length, and equals it once junk entries are excluded.
test('property: instanceCounts never invents or loses a running instance', () => {
  for (let trial = 0; trial < 100; trial++) {
    const pool = ['a', 'b', 'c'];
    const party = [];
    const len = Math.floor(Math.random() * 8);
    for (let i = 0; i < len; i++) party.push(pool[Math.floor(Math.random() * pool.length)]);
    const counts = instanceCounts(party);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    assert.strictEqual(total, party.length, JSON.stringify(party));
  }
});

// --- modelLine ---------------------------------------------------------------

test('modelLine: no entry at all is "not read yet", never a guess', () => {
  const m = modelLine(undefined);
  assert.strictEqual(m.text, '—');
  assert.match(m.title, /not read yet/i);
  assert.strictEqual(m.unresolved, false);
});

test('modelLine: an entry with model:null is the same "not read yet" state', () => {
  const m = modelLine({ model: null, at: null });
  assert.strictEqual(m.text, '—');
  assert.match(m.title, /not read yet/i);
});

test('modelLine: never renders an empty string, even for a malformed entry', () => {
  for (const bad of [{}, { model: '' }, { model: 42 }, { model: undefined }]) {
    const m = modelLine(bad);
    assert.notStrictEqual(m.text, '');
    assert.strictEqual(m.text, '—');
  }
});

test('modelLine: a real model is shown verbatim', () => {
  const m = modelLine({ model: 'claude-fable-5-1', at: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(m.text, 'claude-fable-5-1');
  assert.strictEqual(m.title, 'claude-fable-5-1');
  assert.strictEqual(m.unresolved, false);
});

test('modelLine: an unresolved identity says so in the title, not just the display module', () => {
  const m = modelLine({ model: 'claude-opus-5', at: null, unresolved: true });
  assert.strictEqual(m.text, 'claude-opus-5');
  assert.strictEqual(m.unresolved, true);
  assert.match(m.title, /identity unresolved/i);
});

// --- Miguel, PR #34: I1 (read side) and S1 -----------------------------------

const { modelEntry, UNKNOWN } = require('../app/agent-card-display');

test('modelEntry: only an OWN key is an entry -- __proto__ never reads the prototype', () => {
  assert.strictEqual(modelEntry({}, '__proto__'), undefined);
  assert.strictEqual(modelEntry({}, 'toString'), undefined);
  const own = JSON.parse('{"__proto__": {"model": "m"}}');
  assert.deepStrictEqual(modelEntry(own, '__proto__'), { model: 'm' });
  assert.deepStrictEqual(modelEntry({ x: { model: 'm' } }, 'x'), { model: 'm' });
});

test('modelEntry: no map at all is no entry, not a throw', () => {
  assert.strictEqual(modelEntry(undefined, 'x'), undefined);
  assert.strictEqual(modelEntry(null, 'x'), undefined);
});

test('modelLine: failed reads are SAID, not hidden (S1)', () => {
  const missing = modelLine(undefined, 2);
  assert.strictEqual(missing.text, UNKNOWN);
  assert.match(missing.title, /2 transcripts? unreadable/);
  const known = modelLine({ model: 'claude-opus-5' }, 1);
  assert.strictEqual(known.text, 'claude-opus-5');
  assert.match(known.title, /1 transcript unreadable/);
});

test('modelLine: zero, missing or garbage errors add nothing to the title', () => {
  for (const errors of [0, undefined, null, NaN, -1, '3', 1.5]) {
    assert.strictEqual(modelLine({ model: 'm' }, errors).title, 'm', `errors=${String(errors)}`);
    assert.strictEqual(modelLine(undefined, errors).title, 'model not read yet', `errors=${String(errors)}`);
  }
});
