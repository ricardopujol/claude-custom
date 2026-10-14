'use strict';
/**
 * The page (plain scripts, app/) and the host (host/) cannot share a module, so the lists they both hold are written twice. This pins that
 * they are the same: a level or a model added on one side only would be silently turned into the default by the other, and the person's
 * choice ignored (PR #169 El Gordo 3).
 */
const test = require('node:test');
const assert = require('node:assert');
const P = require('../app/ask-profile');
const D = require('../app/ask-display');
const E = require('../host/ask-explain');
const M = require('../host/ask-models');

test('the explanation levels: the page\'s ids and labels are the host\'s, in the same order', () => {
  assert.deepStrictEqual(P.LEVEL_IDS, E.LEVELS.map(l => l.id));
  assert.deepStrictEqual(D.LEVELS, E.LEVELS.map(l => ({ id: l.id, label: l.label })));
  assert.ok(P.LEVEL_IDS.includes(E.DEFAULT_LEVEL));
  assert.strictEqual(P.load(null).level, E.DEFAULT_LEVEL, 'a first-time person starts where the host defaults');
});

test('the models: the page\'s ids are the host\'s choices, and the default is the same', () => {
  assert.deepStrictEqual(P.MODEL_IDS, [...M.CHOICES]);
  assert.strictEqual(P.load(null).model, M.DEFAULT_MODEL);
});

test('About me is cut to the same length on both sides', () => {
  assert.strictEqual(P.ABOUT_ME_MAX, E.ABOUT_ME_MAX_CHARS);
});
