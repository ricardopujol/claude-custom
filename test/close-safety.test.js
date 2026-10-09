'use strict';
/**
 * Backlog #77: Ctrl+click closes a merged, safe tab with no confirm (host/close-safety.js).
 * Safe means ALL of: merged, nothing uncommitted, nothing unpushed, no agent working there.
 * Anything unknown is NOT safe.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { isSafeToClose, closeReasons, closeReason, readCloseFacts } = require('../host/close-safety');

const SAFE = { merged: true, dirtyCount: 0, unpushedCount: 0, agentsHere: 0 };

test('isSafeToClose: merged, clean, pushed and unoccupied is safe', () => {
  assert.strictEqual(isSafeToClose(SAFE), true);
});

test('isSafeToClose: every combination -- only the all-clear one is safe', () => {
  for (const merged of [true, false]) {
    for (const dirtyCount of [0, 2]) {
      for (const unpushedCount of [0, 3]) {
        for (const agentsHere of [0, 1]) {
          const expected = merged && dirtyCount === 0 && unpushedCount === 0 && agentsHere === 0;
          const facts = { merged, dirtyCount, unpushedCount, agentsHere };
          assert.strictEqual(isSafeToClose(facts), expected, JSON.stringify(facts));
          assert.strictEqual(closeReasons(facts).length === 0, expected, JSON.stringify(facts));
        }
      }
    }
  }
});

test('isSafeToClose: unknown is never safe (null, undefined, strings, NaN, negatives)', () => {
  for (const bad of [null, undefined, '0', NaN, -1, 1.5, {}, false]) {
    for (const k of ['dirtyCount', 'unpushedCount', 'agentsHere']) {
      assert.strictEqual(isSafeToClose({ ...SAFE, [k]: bad }), false, `${k}=${String(bad)}`);
    }
  }
  for (const bad of [null, undefined, 'true', 1, 0]) {
    assert.strictEqual(isSafeToClose({ ...SAFE, merged: bad }), false, `merged=${String(bad)}`);
  }
  assert.strictEqual(isSafeToClose(null), false);
  assert.strictEqual(isSafeToClose(undefined), false);
  assert.strictEqual(isSafeToClose('x'), false);
});

test('closeReasons: names each thing that is wrong, in a fixed order', () => {
  assert.deepStrictEqual(closeReasons({ merged: false, dirtyCount: 2, unpushedCount: 3, agentsHere: 1 }),
    ['not merged', '2 uncommitted files', '3 unpushed commits', 'an agent is working here']);
});

test('closeReasons: singular and plural', () => {
  assert.deepStrictEqual(closeReasons({ ...SAFE, dirtyCount: 1 }), ['1 uncommitted file']);
  assert.deepStrictEqual(closeReasons({ ...SAFE, unpushedCount: 1 }), ['1 unpushed commit']);
  assert.deepStrictEqual(closeReasons({ ...SAFE, agentsHere: 2 }), ['2 agents are working here']);
});

test('closeReasons: an unknown fact says it could not be checked, never "0"', () => {
  assert.deepStrictEqual(closeReasons({ ...SAFE, dirtyCount: null }), ["couldn't check for uncommitted files"]);
  assert.deepStrictEqual(closeReasons({ ...SAFE, unpushedCount: undefined }), ["couldn't check for unpushed commits"]);
  assert.deepStrictEqual(closeReasons({ ...SAFE, agentsHere: null }), ["couldn't check for agents"]);
  assert.deepStrictEqual(closeReasons(null).length > 0, true);
});

test('closeReason: joins the reasons for the confirm, or is empty when safe', () => {
  assert.strictEqual(closeReason(SAFE), '');
  assert.strictEqual(closeReason({ ...SAFE, dirtyCount: 2, merged: false }), 'not merged; 2 uncommitted files');
});

test('property: safe exactly when closeReasons is empty', () => {
  const n = fc.oneof(fc.nat(5), fc.constant(null), fc.constant(undefined), fc.constant(NaN), fc.constant('0'));
  fc.assert(fc.property(fc.oneof(fc.boolean(), fc.constant(null)), n, n, n, (merged, dirtyCount, unpushedCount, agentsHere) => {
    const f = { merged, dirtyCount, unpushedCount, agentsHere };
    assert.strictEqual(isSafeToClose(f), closeReasons(f).length === 0);
  }));
});

// --- readCloseFacts: git facts through an injected runner --------------------------------------------

const runner = (table) => async (args) => {
  const key = args.join(' ');
  for (const [k, v] of Object.entries(table)) {
    if (key === k) { if (v instanceof Error) throw v; return v; }
  }
  throw new Error(`unexpected git ${key}`);
};

test('readCloseFacts: counts porcelain lines and commits not on the upstream', async () => {
  const run = runner({
    'status --porcelain': ' M a.js\n?? b.js\n',
    'rev-list --count @{upstream}..HEAD': '3\n',
  });
  assert.deepStrictEqual(await readCloseFacts('/x', { run }), { dirtyCount: 2, unpushedCount: 3 });
});

test('readCloseFacts: a clean tree is 0, not unknown', async () => {
  const run = runner({ 'status --porcelain': '', 'rev-list --count @{upstream}..HEAD': '0\n' });
  assert.deepStrictEqual(await readCloseFacts('/x', { run }), { dirtyCount: 0, unpushedCount: 0 });
});

test('readCloseFacts: no upstream falls back to origin/develop', async () => {
  const run = runner({
    'status --porcelain': '',
    'rev-list --count @{upstream}..HEAD': new Error('no upstream'),
    'rev-list --count origin/develop..HEAD': '4\n',
  });
  assert.deepStrictEqual(await readCloseFacts('/x', { run }), { dirtyCount: 0, unpushedCount: 4 });
});

test('readCloseFacts: git failing is unknown (null), never zero', async () => {
  const none = runner({
    'status --porcelain': new Error('boom'),
    'rev-list --count @{upstream}..HEAD': new Error('no'),
    'rev-list --count origin/develop..HEAD': new Error('no'),
  });
  assert.deepStrictEqual(await readCloseFacts('/x', { run: none }), { dirtyCount: null, unpushedCount: null });
  const junk = runner({ 'status --porcelain': '', 'rev-list --count @{upstream}..HEAD': 'banana' });
  const r = await readCloseFacts('/x', { run: junk });
  assert.strictEqual(r.unpushedCount, null, 'a non-number answer is unknown');
});

test('readCloseFacts: a bad folder is unknown without running git', async () => {
  let ran = 0;
  const run = async () => { ran++; return ''; };
  assert.deepStrictEqual(await readCloseFacts('', { run }), { dirtyCount: null, unpushedCount: null });
  assert.deepStrictEqual(await readCloseFacts(null, { run }), { dirtyCount: null, unpushedCount: null });
  assert.strictEqual(ran, 0);
});
