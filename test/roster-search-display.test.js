'use strict';
/**
 * BACKLOG #76: the roster card's two names, the Role/Name toggle and the search
 * filter. Pure decisions, drawn by renderer.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { normalizeMode, cardNames, matches, emptyMessage, MODES } = require('../app/roster-search-display');

const miguel = { agent: 'code-reviewer', persona: 'Miguel', fn: 'Elite code reviewer for PRs.' };

test('normalizeMode keeps the two real modes and defaults everything else to name (Ricardo, 2026-10-09)', () => {
  assert.strictEqual(normalizeMode('name'), 'name');
  assert.strictEqual(normalizeMode('role'), 'role');
  for (const v of [undefined, null, '', 'NAME', 'ROLE', 'both', 3, {}, true]) assert.strictEqual(normalizeMode(v), 'name');
  assert.deepStrictEqual([...MODES], ['role', 'name']);
});

test('cardNames puts the toggle\'s pick big and the other small', () => {
  assert.deepStrictEqual(cardNames('code-reviewer', miguel, 'role'), { big: 'code-reviewer', small: 'Miguel' });
  assert.deepStrictEqual(cardNames('code-reviewer', miguel, 'name'), { big: 'Miguel', small: 'code-reviewer' });
});

test('cardNames with no mode yet shows the persona big (the default is Name)', () => {
  assert.deepStrictEqual(cardNames('code-reviewer', miguel, undefined), { big: 'Miguel', small: 'code-reviewer' });
});

test('cardNames shows Cedar as "Cedar" when the persona is the role again, ignoring case', () => {
  const cedar = { persona: 'Cedar', fn: 'Interrogator.' };
  assert.deepStrictEqual(cardNames('cedar', cedar, 'name'), { big: 'Cedar', small: 'cedar' });
  assert.deepStrictEqual(cardNames('cedar', cedar, 'role'), { big: 'cedar', small: 'Cedar' });
});

test('cardNames shows the role only for an agent with no persona, in both modes', () => {
  for (const entry of [undefined, null, {}, { persona: null }, { persona: '' }, { persona: 7 }]) {
    for (const mode of ['role', 'name']) {
      assert.deepStrictEqual(cardNames('general-purpose', entry, mode), { big: 'general-purpose', small: null });
    }
  }
});

test('matches is case-insensitive over role, persona and function', () => {
  assert.strictEqual(matches('code-reviewer', miguel, 'CODE-REV'), true);
  assert.strictEqual(matches('code-reviewer', miguel, 'migu'), true);
  assert.strictEqual(matches('code-reviewer', miguel, 'for prs'), true);
  assert.strictEqual(matches('code-reviewer', miguel, 'dexter'), false);
});

test('matches treats a blank query as everything, and trims it', () => {
  assert.strictEqual(matches('x', undefined, ''), true);
  assert.strictEqual(matches('x', undefined, '   '), true);
  assert.strictEqual(matches('x', undefined, undefined), true);
  assert.strictEqual(matches('code-reviewer', miguel, '  miguel  '), true);
});

test('matches survives an agent with no entry or null fields', () => {
  assert.strictEqual(matches('solo', undefined, 'sol'), true);
  assert.strictEqual(matches('solo', { persona: null, fn: null }, 'null'), false);
  assert.strictEqual(matches('solo', { persona: null, fn: null }, 'undefined'), false);
});

test('emptyMessage names the tab, quotes the query and points at the other tab', () => {
  assert.strictEqual(emptyMessage('active', 'zzz'), 'No active agent matches “zzz”. Try the inactive tab.');
  assert.strictEqual(emptyMessage('inactive', 'zzz'), 'No inactive agent matches “zzz”. Try the active tab.');
  assert.strictEqual(emptyMessage('whatever', ' q '), 'No active agent matches “q”. Try the inactive tab.');
});

test('property: cardNames always has a non-empty big, and a persona-bearing agent shows both names', () => {
  fc.assert(fc.property(fc.string({ minLength: 1 }), fc.option(fc.string({ minLength: 1 })), fc.constantFrom('role', 'name'),
    (agent, persona, mode) => {
      const r = cardNames(agent, persona === null ? null : { persona }, mode);
      assert.ok(r.big.length > 0);
      if (persona === null) assert.strictEqual(r.small, null);
      else assert.deepStrictEqual([r.big, r.small].sort(), [agent, persona].sort());
    }));
});

test('property: a query that is a substring of the role always matches', () => {
  fc.assert(fc.property(fc.string({ minLength: 1 }), fc.nat(5), fc.nat(5), (agent, a, b) => {
    const q = agent.slice(a, agent.length - b);
    fc.pre(q.trim() !== '');
    assert.strictEqual(matches(agent, undefined, q.toUpperCase()), true);
  }));
});

// --- PR #141 review fixes ------------------------------------------------------

const { hiddenMatchMessage } = require('../app/roster-search-display');

test('F1: search folds case and accents, in the query and in the names', () => {
  const jose = { agent: 'ux-researcher-cl', persona: 'José Tomás', fn: 'Runs interviews.' };
  for (const q of ['josé', 'jose', 'JOSE', 'tomás', 'tomas', 'José Tomás', 'jose tomas']) {
    assert.strictEqual(matches('ux-researcher-cl', jose, q), true, q);
  }
  assert.strictEqual(matches('ux-researcher-cl', jose, 'jorge'), false);
  assert.strictEqual(matches('x', { persona: 'Jose', fn: null }, 'josé'), true);
  assert.strictEqual(matches('x', { persona: null, fn: 'Café owner.' }, 'cafe'), true);
});

test('F2: hiddenMatchMessage counts the hidden matches honestly', () => {
  assert.strictEqual(hiddenMatchMessage(1, 'naomi'), '1 hidden agent matches “naomi”.');
  assert.strictEqual(hiddenMatchMessage(3, ' q '), '3 hidden agents match “q”.');
});
