'use strict';
/**
 * BACKLOG #14, host side: the persisted per-project hidden set. The host is
 * authoritative -- it applies the same "only a sleeper can be hidden" rule the
 * renderer does, on every mood update, and persists the clearing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { tmpDir } = require('./tmp-dir');
const { createStore } = require('../host/store');
const { createHiddenAgents, validRosterMsg } = require('../host/hidden-agents');
const display = require('../app/hidden-agents-display');

const row = (agent, state) => ({ agent, state });
function setup(project = 'C:\\proj\\a') {
  const dir = tmpDir('hidden-agents');
  const store = createStore({ dir });
  return { dir, store, make: (p = project) => createHiddenAgents({ store, project: p }) };
}

// --- hide / unhide -----------------------------------------------------------

test('hiding a sleeping agent adds it and persists', () => {
  const { make } = setup();
  const h = make();
  const out = h.hide('paris', [row('paris', 'sleeping')]);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(h.list(), ['paris']);
  assert.deepStrictEqual(make().list(), ['paris'], 'a fresh instance (a restart) reads it back');
});

test('the host refuses to hide an agent that is not sleeping, or not on the roster', () => {
  const h = setup().make();
  for (const s of ['working', 'happy', 'stressed', 'bogus']) {
    const out = h.hide('paris', [row('paris', s)]);
    assert.strictEqual(out.ok, false, s);
    assert.strictEqual(out.reason, 'not-sleeping', s);
  }
  assert.strictEqual(h.hide('ghost', [row('paris', 'sleeping')]).reason, 'not-sleeping');
  assert.deepStrictEqual(h.list(), []);
});

test('hiding twice is a no-op, not a duplicate', () => {
  const h = setup().make();
  h.hide('paris', [row('paris', 'sleeping')]);
  h.hide('paris', [row('paris', 'sleeping')]);
  assert.deepStrictEqual(h.list(), ['paris']);
});

test('unhide removes and persists; unhiding something not hidden changes nothing', () => {
  const { make } = setup();
  const h = make();
  h.hide('paris', [row('paris', 'sleeping')]);
  assert.strictEqual(h.unhide('paris').changed, true);
  assert.deepStrictEqual(make().list(), []);
  assert.strictEqual(h.unhide('paris').changed, false);
});

test('bad names are refused without touching the set', () => {
  const h = setup().make();
  for (const n of ['', null, undefined, 5, {}]) {
    assert.strictEqual(h.hide(n, [row('x', 'sleeping')]).ok, false);
    assert.strictEqual(h.unhide(n).changed, false);
  }
});

// --- reconcile ---------------------------------------------------------------

test('an agent that wakes is un-hidden host-side and the clearing is persisted', () => {
  const { make } = setup();
  const h = make();
  h.hide('paris', [row('paris', 'sleeping')]);
  const out = h.reconcile([row('paris', 'working')]);
  assert.deepStrictEqual(out.cleared, ['paris']);
  assert.deepStrictEqual(h.list(), []);
  assert.deepStrictEqual(make().list(), [], 'the clearing survives a restart');
});

test('going back to sleep does not re-hide', () => {
  const h = setup().make();
  h.hide('paris', [row('paris', 'sleeping')]);
  h.reconcile([row('paris', 'working')]);
  const out = h.reconcile([row('paris', 'sleeping')]);
  assert.deepStrictEqual(out.hidden, []);
  assert.deepStrictEqual(h.list(), []);
});

test('reconcile with nothing to clear does not write', () => {
  let writes = 0;
  const store = { read: () => null, write: () => { writes++; } };
  const h = createHiddenAgents({ store, project: 'p' });
  h.hide('paris', [row('paris', 'sleeping')]);
  assert.strictEqual(writes, 1);
  const out = h.reconcile([row('paris', 'sleeping')]);
  assert.deepStrictEqual(out.cleared, []);
  assert.strictEqual(writes, 1);
  h.reconcile([row('paris', 'working')]);
  assert.strictEqual(writes, 2);
});

test('a hidden name not yet seen after a restart is kept', () => {
  const { make } = setup();
  make().hide('paris', [row('paris', 'sleeping')]);
  const h = make();
  h.reconcile([]);
  assert.deepStrictEqual(h.list(), ['paris']);
});

// --- persistence -------------------------------------------------------------

test('the set is per project', () => {
  const { make } = setup();
  make('C:\\proj\\a').hide('paris', [row('paris', 'sleeping')]);
  assert.deepStrictEqual(make('C:\\proj\\b').list(), []);
  assert.deepStrictEqual(make('C:\\proj\\a').list(), ['paris']);
});

test('two projects never share a file (so two hosts cannot lose each other\'s update)', () => {
  const { dir, make } = setup();
  make('C:\\proj\\a').hide('x', [row('x', 'sleeping')]);
  make('C:\\proj\\b').hide('y', [row('y', 'sleeping')]);
  assert.strictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.json')).length, 2);
});

test('a corrupt or hostile file reads as empty rather than throwing', () => {
  const { dir, store, make } = setup();
  make().hide('paris', [row('paris', 'sleeping')]);
  const file = path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.json')));
  fs.writeFileSync(file, '{not json');
  assert.deepStrictEqual(make().list(), []);
  const name = path.basename(file, '.json');
  store.write(name, { hidden: 'paris' });
  assert.deepStrictEqual(make().list(), []);
  store.write(name, { hidden: ['ok', 3, '', null, 'ok'] });
  assert.deepStrictEqual(make().list(), ['ok']);
});

test('a failed write is reported and the in-memory set still moves', () => {
  const store = { read: () => null, write: () => { throw new Error('disk full'); } };
  const h = createHiddenAgents({ store, project: 'p' });
  const out = h.hide('paris', [row('paris', 'sleeping')]);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.persisted, false);
  assert.deepStrictEqual(h.list(), ['paris']);
});

test('list() returns a copy the caller cannot use to edit the set', () => {
  const h = setup().make();
  h.hide('paris', [row('paris', 'sleeping')]);
  h.list().push('evil');
  assert.deepStrictEqual(h.list(), ['paris']);
});

test('createHiddenAgents insists on a store and a project', () => {
  assert.throws(() => createHiddenAgents({ project: 'p' }), /store/);
  const store = { read: () => null, write() {} };
  assert.throws(() => createHiddenAgents({ store, project: '' }), /project/);
  assert.throws(() => createHiddenAgents({ store, project: 5 }), /project/);
  assert.throws(() => createHiddenAgents({ store: {}, project: 'p' }), /store/);
});

// --- the wire message --------------------------------------------------------

test('validRosterMsg accepts hide/unhide with a sane agent name only', () => {
  assert.strictEqual(validRosterMsg({ type: 'roster', action: 'hide', agent: 'paris' }), true);
  assert.strictEqual(validRosterMsg({ type: 'roster', action: 'unhide', agent: 'paris' }), true);
  for (const bad of [
    { action: 'delete', agent: 'paris' }, { action: 'hide' }, { action: 'hide', agent: '' },
    { action: 'hide', agent: 5 }, { action: 'hide', agent: 'x'.repeat(201) }, null, 'x',
  ]) assert.strictEqual(validRosterMsg(bad), false, JSON.stringify(bad));
  assert.strictEqual(validRosterMsg({ action: 'hide', agent: 'x'.repeat(200) }), true);
});

// --- host and renderer agree -------------------------------------------------

const STATES = ['sleeping', 'working', 'happy', 'stressed', 'bogus'];
const NAMES = ['a', 'b', 'c', 'd'];
const arbRows = fc.uniqueArray(fc.constantFrom(...NAMES), { maxLength: 4 }).chain(names =>
  fc.tuple(...names.map(n => fc.constantFrom(...STATES).map(s => row(n, s)))));

test('PROPERTY: the host and the renderer reconcile to the same set', () => {
  fc.assert(fc.property(arbRows, fc.array(fc.constantFrom(...NAMES, 'ghost'), { maxLength: 6 }), (rows, seed) => {
    const store = { read: () => ({ hidden: seed }), write() {} };
    const h = createHiddenAgents({ store, project: 'p' });
    const host = h.reconcile(rows);
    const view = display.reconcileHidden(seed, rows);
    assert.deepStrictEqual(host.hidden, view.hidden);
    assert.deepStrictEqual(host.cleared, view.cleared);
  }));
});

test('PROPERTY: whatever the host does, an active agent is never in its hidden set', () => {
  const ops = fc.array(fc.oneof(
    fc.record({ op: fc.constant('hide'), name: fc.constantFrom(...NAMES) }),
    fc.record({ op: fc.constant('unhide'), name: fc.constantFrom(...NAMES) }),
    fc.record({ op: fc.constant('mood'), name: fc.constantFrom(...NAMES), state: fc.constantFrom(...STATES) }),
  ), { maxLength: 30 });
  fc.assert(fc.property(ops, (seq) => {
    const store = { read: () => null, write() {} };
    const h = createHiddenAgents({ store, project: 'p' });
    const roster = new Map();
    for (const o of seq) {
      if (o.op === 'mood') { roster.set(o.name, o.state); h.reconcile([...roster].map(([a, s]) => row(a, s))); }
      else if (o.op === 'hide') h.hide(o.name, [...roster].map(([a, s]) => row(a, s)));
      else h.unhide(o.name);
      for (const [a, s] of roster) if (s !== 'sleeping') assert.ok(!h.list().includes(a), `${a} ${s}`);
    }
  }));
});
