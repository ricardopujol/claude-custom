'use strict';
/**
 * Live branches on the Git dial (documentation/DESIGN_GIT_TREE.md, "Enhancement #46", decision 3): a branch
 * is LIVE when its worktree tab's session is working, or when its ledger spend was measured to grow since
 * the last refresh. Live spokes draw in their own colour, and stream sparks ONLY for measured growth --
 * never as decoration on a quiet branch, and never because a tab merely says "working".
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const S = require('../app/git-swing');

const br = (name, folder = null) => ({ name, folder });

test('liveSet: a branch is live when its tab is working, or when spend was measured to grow and that is still showing', () => {
  const branches = [br('a', 'C:/p/a'), br('b', 'C:/p/b'), br('c'), br('d', 'C:/p/d')];
  const live = S.liveSet(branches, new Set(['C:/p/a']), new Set(['b', 'c']), true);
  assert.deepStrictEqual([...live].sort(), ['a', 'b', 'c']);
});

test('liveSet: growth that is no longer showing (the sparks ended) is not live; a working tab always is', () => {
  const branches = [br('a', 'C:/p/a'), br('b', 'C:/p/b')];
  assert.deepStrictEqual([...S.liveSet(branches, new Set(['C:/p/a']), new Set(['b']), false)], ['a']);
});

test('liveSet: nothing known is nothing live; a null folder never matches a working folder', () => {
  assert.strictEqual(S.liveSet([br('a')], new Set([null, undefined, '']), new Set(), true).size, 0);
  assert.strictEqual(S.liveSet(null, null, null, true).size, 0);
});

test('sparkNames: ONLY measured growth, only while it shows -- a working tab alone never gets sparks', () => {
  assert.deepStrictEqual([...S.sparkNames(new Set(['b']), true)], ['b']);
  assert.strictEqual(S.sparkNames(new Set(['b']), false).size, 0);
  assert.strictEqual(S.sparkNames(new Set(), true).size, 0);
  assert.strictEqual(S.sparkNames(null, true).size, 0);
});

test('property: sparks are a subset of the measured growth, whatever is working', () => {
  fc.assert(fc.property(
    fc.array(fc.tuple(fc.integer({ min: 0, max: 8 }), fc.boolean(), fc.boolean()), { maxLength: 9 }), fc.boolean(),
    (rows, active) => {
      const names = new Map(rows.map(([i, w, g]) => [`n${i}`, [w, g]]));
      const branches = [...names.keys()].map(n => br(n, `C:/${n}`));
      const working = new Set([...names].filter(([, [w]]) => w).map(([n]) => `C:/${n}`));
      const growth = new Set([...names].filter(([, [, g]]) => g).map(([n]) => n));
      const sparks = S.sparkNames(growth, active);
      for (const n of sparks) assert.ok(growth.has(n));
      const live = S.liveSet(branches, working, growth, active);
      for (const n of sparks) assert.ok(live.has(n), 'a branch with sparks is live');
      for (const n of live) assert.ok(working.has(`C:/${n}`) || (active && growth.has(n)));
    }));
});
