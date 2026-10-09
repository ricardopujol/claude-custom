'use strict';
/**
 * BACKLOG #80: install-wide state (the medals, the bubbles' switch) changed by another host must reach THIS host's windows.
 * Two hosts are two services over one store.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { tmpDir } = require('./tmp-dir');
const { createStore } = require('../host/store');
const { createMedals } = require('../host/medals');
const { createBubbleSettings } = require('../host/bubbles');
const { createChangeWatch } = require('../host/state-watch');

test('a change made through ANOTHER host is announced by this host\'s watch, once', () => {
  const store = createStore({ dir: tmpDir('state-watch') });
  const hostA = createMedals({ store });
  const hostB = createMedals({ store });
  const heard = [];
  const watchB = createChangeWatch({ read: () => hostB.all(), onChange: (v) => heard.push(v) });
  assert.strictEqual(watchB.tick(), false);                   // nothing yet
  hostA.give('miguel', 'fast', 'quick');
  assert.strictEqual(watchB.tick(), true);
  assert.strictEqual(heard.length, 1);
  assert.strictEqual(heard[0][0].agent, 'miguel');
  assert.strictEqual(watchB.tick(), false);                   // the same value is not news
  const id = hostA.all()[0].medals[0].id;
  hostA.remove('miguel', id);
  watchB.tick();
  assert.deepStrictEqual(heard[1], []);
});

test('the bubbles switch turned off in another tab is announced to this tab\'s windows', () => {
  const store = createStore({ dir: tmpDir('state-watch') });
  const tabA = createBubbleSettings({ store });
  const tabB = createBubbleSettings({ store });
  const heard = [];
  const watch = createChangeWatch({ read: () => tabB.enabled(), onChange: (v) => heard.push(v) });
  tabA.set(false);
  watch.tick();
  assert.deepStrictEqual(heard, [false]);
});

test('a change this host made itself and already broadcast is not announced twice (note)', () => {
  const store = createStore({ dir: tmpDir('state-watch') });
  const m = createMedals({ store });
  const heard = [];
  const watch = createChangeWatch({ read: () => m.all(), onChange: (v) => heard.push(v) });
  m.give('a', 'fast', '');
  watch.note();
  assert.strictEqual(watch.tick(), false);
  assert.deepStrictEqual(heard, []);
});

test('a read that throws is a missed look, never a change and never an exception', () => {
  let boom = false; let v = 1;
  const heard = [];
  const watch = createChangeWatch({ read: () => { if (boom) throw new Error('EBUSY'); return v; }, onChange: (x) => heard.push(x) });
  boom = true;
  assert.strictEqual(watch.tick(), false);
  boom = false; v = 2;
  assert.strictEqual(watch.tick(), true);
  assert.deepStrictEqual(heard, [2]);
});

test('a watch whose first read threw announces the first value it can read', () => {
  let boom = true;
  const heard = [];
  const watch = createChangeWatch({ read: () => { if (boom) throw new Error('x'); return 'v'; }, onChange: (x) => heard.push(x) });
  boom = false;
  watch.tick();
  assert.deepStrictEqual(heard, ['v']);
});

test('PROPERTY: the watch announces exactly the distinct consecutive values it was shown', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 40 }), (values) => {
    let cur = -1;
    const heard = [];
    const watch = createChangeWatch({ read: () => cur, onChange: (x) => heard.push(x) });
    const expected = [];
    let prev = -1;
    for (const v of values) { cur = v; watch.tick(); if (v !== prev) { expected.push(v); prev = v; } }
    assert.deepStrictEqual(heard, expected);
  }), { numRuns: 100 });
});

test('createChangeWatch needs both functions', () => {
  assert.throws(() => createChangeWatch({}), /required/);
  assert.throws(() => createChangeWatch({ read: () => 1 }), /required/);
});
