'use strict';
/**
 * PR #66 review fixes for host/hidden-agents.js: Dexter F2, F3 and Miguel M4,
 * M5. Each test fails without its fix.
 */
const test = require('node:test');
const assert = require('node:assert');

const { tmpDir } = require('./tmp-dir');
const { createStore } = require('../host/store');
const { createHiddenAgents, storeKey, HIDDEN_MAX } = require('../host/hidden-agents');

const row = (agent, state) => ({ agent, state });

test('Dexter F2 / Miguel M5: one project has one key however its path is spelled', () => {
  assert.strictEqual(storeKey('C:\\p'), storeKey('c:\\p'));
  assert.strictEqual(storeKey('C:\\p'), storeKey('C:\\p\\'));
  assert.strictEqual(storeKey('C:\\p'), storeKey('C:/p'));
  assert.strictEqual(storeKey('C:\\p\\q\\..'), storeKey('c:\\p'));
  assert.notStrictEqual(storeKey('C:\\p'), storeKey('C:\\q'));
});

test('a hide made under one spelling of the path is read back under another', () => {
  const store = createStore({ dir: tmpDir('hidden-review') });
  createHiddenAgents({ store, project: 'C:\\Users\\r\\Proj' }).hide('paris', [row('paris', 'sleeping')]);
  assert.deepStrictEqual(createHiddenAgents({ store, project: 'c:\\users\\r\\proj\\' }).list(), ['paris']);
});

test('a project path that cannot be normalised is refused', () => {
  const store = { read: () => null, write() {} };
  assert.throws(() => createHiddenAgents({ store, project: '   ' }), /project/);
});

function flakyStore() {
  const disk = {};
  const s = {
    failNext: false,
    writes: 0,
    read: (k, f) => (k in disk ? disk[k] : f),
    write(k, v) {
      s.writes++;
      if (s.failNext) { s.failNext = false; throw new Error('EPERM'); }
      disk[k] = JSON.parse(JSON.stringify(v));
    },
  };
  return s;
}

test('Dexter F3: a cleared flag whose write failed is retried on the next reconcile', () => {
  const store = flakyStore();
  const h = createHiddenAgents({ store, project: 'p' });
  h.hide('X', [row('X', 'sleeping')]);
  store.failNext = true;
  const first = h.reconcile([row('X', 'working')]);
  assert.deepStrictEqual(first.cleared, ['X']);
  assert.strictEqual(first.persisted, false);
  assert.deepStrictEqual(createHiddenAgents({ store, project: 'p' }).list(), ['X'], 'disk is stale so far');
  const second = h.reconcile([row('X', 'sleeping')]);
  assert.strictEqual(second.persisted, true);
  assert.deepStrictEqual(createHiddenAgents({ store, project: 'p' }).list(), []);
});

test('a failed unhide write is retried the same way, and once disk matches nothing writes', () => {
  const store = flakyStore();
  const h = createHiddenAgents({ store, project: 'p' });
  h.hide('X', [row('X', 'sleeping')]);
  store.failNext = true;
  assert.strictEqual(h.unhide('X').persisted, false);
  assert.strictEqual(h.reconcile([]).persisted, true);
  const n = store.writes;
  assert.strictEqual(h.reconcile([]).persisted, true);
  assert.strictEqual(store.writes, n, 'clean reconcile does not write');
  assert.deepStrictEqual(createHiddenAgents({ store, project: 'p' }).list(), []);
});

test('a failed hide write is retried too', () => {
  const store = flakyStore();
  const h = createHiddenAgents({ store, project: 'p' });
  store.failNext = true;
  assert.strictEqual(h.hide('X', [row('X', 'sleeping')]).persisted, false);
  h.reconcile([row('X', 'sleeping')]);
  assert.deepStrictEqual(createHiddenAgents({ store, project: 'p' }).list(), ['X']);
});

test('Miguel M4: the set is capped and drops the OLDEST', () => {
  const h = createHiddenAgents({ store: { read: () => null, write() {} }, project: 'p' });
  const rows = Array.from({ length: HIDDEN_MAX + 5 }, (_, i) => row('a' + i, 'sleeping'));
  for (const r of rows) h.hide(r.agent, rows);
  const list = h.list();
  assert.strictEqual(list.length, HIDDEN_MAX);
  assert.strictEqual(list[0], 'a5');
  assert.strictEqual(list[list.length - 1], 'a' + (HIDDEN_MAX + 4));
});

test('a loaded set over the cap is trimmed, and an over-long name is not loaded', () => {
  const many = Array.from({ length: HIDDEN_MAX + 3 }, (_, i) => 'n' + i);
  const trimmed = createHiddenAgents({ store: { read: () => ({ hidden: many }), write() {} }, project: 'p' });
  assert.strictEqual(trimmed.list().length, HIDDEN_MAX);
  assert.strictEqual(trimmed.list()[0], 'n3');
  const long = createHiddenAgents({
    store: { read: () => ({ hidden: ['ok', 'x'.repeat(201)] }), write() {} }, project: 'p',
  });
  assert.deepStrictEqual(long.list(), ['ok']);
});
