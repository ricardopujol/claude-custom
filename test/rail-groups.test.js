'use strict';
/**
 * Chrome grammar (2026-10-26): the rail's buttons come in three groups with a separator between them: Work, Repo, Me.
 * app/rail-groups.js is pure; app/dock-tree-display.js draws what it returns.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { GROUPS, groupRail, groupOf } = require('../app/rail-groups');
const { TABS } = require('../app/side-tabs');

const ids = items => items.filter(i => !i.sep).map(i => i.id);

test('the three groups, in the order Ricardo picked', () => {
  assert.deepStrictEqual(GROUPS.map(g => g.name), ['Work', 'Repo', 'Me']);
  assert.deepStrictEqual(GROUPS[0].ids.slice(0, 4), ['agents', 'git', 'fog', 'resources']);
  assert.deepStrictEqual(GROUPS[1].ids, ['ask', 'changes', 'preview']);
  assert.deepStrictEqual(GROUPS[2].ids, ['style', 'vault', 'wand', 'games', 'models', 'projects', 'bugvault', 'canvas']);
});

test('Map sits in Work after Resources (the brief\'s default)', () => {
  assert.strictEqual(groupOf('map'), 'Work');
  const w = GROUPS[0].ids;
  assert.strictEqual(w.indexOf('map'), w.indexOf('resources') + 1);
});

test('every module in TABS belongs to exactly one group', () => {
  const all = GROUPS.flatMap(g => g.ids);
  assert.strictEqual(new Set(all).size, all.length, 'no id twice');
  for (const t of TABS) assert.ok(all.includes(t.id), `${t.id} has a group`);
});

test('a full rail comes out grouped, with a separator between groups only', () => {
  const out = groupRail(TABS.map(t => t.id).reverse());
  assert.deepStrictEqual(out.filter(i => i.sep).length, 2);
  assert.ok(!out[0].sep && !out[out.length - 1].sep);
  const names = [];
  for (const i of out) if (!i.sep) names.push(groupOf(i.id));
  assert.deepStrictEqual([...new Set(names)], ['Work', 'Repo', 'Me']);
});

test('a rail with one group has no separator; an empty one is empty', () => {
  assert.deepStrictEqual(groupRail(['git', 'agents']), [{ id: 'agents' }, { id: 'git' }]);
  assert.deepStrictEqual(groupRail([]), []);
});

test('an unknown id is kept, at the end of Me', () => {
  const out = groupRail(['zzz', 'agents', 'style']);
  assert.deepStrictEqual(out, [{ id: 'agents' }, { sep: true }, { id: 'style' }, { id: 'zzz' }]);
});

test('junk input gives an empty list and never throws', () => {
  for (const j of [null, undefined, 5, 'x', {}]) assert.deepStrictEqual(groupRail(j), []);
  assert.deepStrictEqual(groupRail([null, 3, '', 'git']), [{ id: 'git' }]);
});

test('property: the same ids come out (a permutation), each once', () => {
  const pool = [...TABS.map(t => t.id), 'zzz', 'yyy'];
  fc.assert(fc.property(fc.shuffledSubarray(pool), (sub) => {
    const out = groupRail(sub);
    assert.deepStrictEqual([...ids(out)].sort(), [...sub].sort());
    for (let i = 0; i < out.length; i++) if (out[i].sep) assert.ok(i > 0 && i < out.length - 1 && !out[i - 1].sep && !out[i + 1].sep);
  }));
});
