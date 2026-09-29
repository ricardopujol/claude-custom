'use strict';
/**
 * BACKLOG #14, "Hide sleeping agents": the pure decisions behind the small
 * hide button on a sleeping agent's card. Drawn by renderer.js; no DOM here.
 *
 * The invariant that matters, and the only reason this is a property test: an
 * ACTIVE agent (anything that is not `sleeping`) is never hidden, whatever the
 * hidden set says. A stale or corrupt persisted set must never be able to make
 * a working agent vanish.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  reconcileHidden, visibleRows, hideButtonFor, hiddenCount,
} = require('../app/hidden-agents-display');

const row = (agent, state) => ({ agent, state });

// --- hideButtonFor -----------------------------------------------------------

test('the hide button shows for a sleeping agent only', () => {
  assert.strictEqual(hideButtonFor(row('paris', 'sleeping')), true);
  for (const s of ['working', 'happy', 'stressed']) {
    assert.strictEqual(hideButtonFor(row('paris', s)), false, s);
  }
});

test('an unknown or missing state is NOT sleeping: never offer to hide on a guess', () => {
  for (const s of [undefined, null, '', 'asleep', 'Sleeping', 0, {}, ['sleeping']]) {
    assert.strictEqual(hideButtonFor({ agent: 'paris', state: s }), false, String(s));
  }
  for (const r of [null, undefined, 'sleeping', 42, {}]) {
    assert.strictEqual(hideButtonFor(r), false);
  }
});

test('a sleeping row without a usable name gets no button (nothing to hide by)', () => {
  assert.strictEqual(hideButtonFor({ agent: '', state: 'sleeping' }), false);
  assert.strictEqual(hideButtonFor({ agent: 7, state: 'sleeping' }), false);
  assert.strictEqual(hideButtonFor({ state: 'sleeping' }), false);
});

// --- reconcileHidden ---------------------------------------------------------

test('an agent that woke is removed from hidden and listed in cleared', () => {
  const out = reconcileHidden(['paris', 'dexter'], [row('paris', 'working'), row('dexter', 'sleeping')]);
  assert.deepStrictEqual(out.hidden, ['dexter']);
  assert.deepStrictEqual(out.cleared, ['paris']);
});

test('every non-sleeping state clears the flag', () => {
  for (const s of ['working', 'happy', 'stressed']) {
    const out = reconcileHidden(['paris'], [row('paris', s)]);
    assert.deepStrictEqual(out, { hidden: [], cleared: ['paris'] }, s);
  }
});

test('an unknown state clears too: hidden is only ever kept for a KNOWN sleeper', () => {
  const out = reconcileHidden(['paris'], [row('paris', 'mystery')]);
  assert.deepStrictEqual(out, { hidden: [], cleared: ['paris'] });
});

test('a hidden name not on the roster is kept: after a restart nobody has been seen yet', () => {
  const out = reconcileHidden(['paris'], []);
  assert.deepStrictEqual(out, { hidden: ['paris'], cleared: [] });
});

test('junk in the hidden list is dropped, duplicates collapse', () => {
  const out = reconcileHidden(['paris', 'paris', '', null, 7, undefined, {}], []);
  assert.deepStrictEqual(out.hidden, ['paris']);
  assert.deepStrictEqual(out.cleared, []);
});

test('non-array inputs are treated as empty, never thrown on', () => {
  assert.deepStrictEqual(reconcileHidden(null, null), { hidden: [], cleared: [] });
  assert.deepStrictEqual(reconcileHidden('paris', 'x'), { hidden: [], cleared: [] });
  assert.deepStrictEqual(reconcileHidden(['a'], [null, 3, 'x']), { hidden: ['a'], cleared: [] });
});

test('a name appearing twice on the roster with one awake is cleared (awake wins)', () => {
  const out = reconcileHidden(['paris'], [row('paris', 'sleeping'), row('paris', 'working')]);
  assert.deepStrictEqual(out, { hidden: [], cleared: ['paris'] });
});

test('reconcile does not mutate its inputs', () => {
  const hidden = ['paris'];
  const rows = [row('paris', 'working')];
  reconcileHidden(hidden, rows);
  assert.deepStrictEqual(hidden, ['paris']);
  assert.deepStrictEqual(rows, [row('paris', 'working')]);
});

// --- visibleRows -------------------------------------------------------------

test('a hidden sleeping row is left out; showHidden brings it back', () => {
  const rows = [row('paris', 'sleeping'), row('dexter', 'sleeping')];
  assert.deepStrictEqual(visibleRows(rows, ['paris'], false), [row('dexter', 'sleeping')]);
  assert.deepStrictEqual(visibleRows(rows, ['paris'], true), rows);
});

test('a non-sleeping row is visible even when its name is in the hidden set', () => {
  const rows = [row('paris', 'working')];
  assert.deepStrictEqual(visibleRows(rows, ['paris'], false), rows);
});

test('showHidden must be exactly true to reveal: a truthy guess does not', () => {
  const rows = [row('paris', 'sleeping')];
  assert.deepStrictEqual(visibleRows(rows, ['paris'], 'yes'), []);
  assert.deepStrictEqual(visibleRows(rows, ['paris'], 1), []);
});

test('visibleRows returns a new array and keeps roster order', () => {
  const rows = [row('b', 'sleeping'), row('a', 'working'), row('c', 'sleeping')];
  const out = visibleRows(rows, ['b'], false);
  assert.notStrictEqual(out, rows);
  assert.deepStrictEqual(out.map(r => r.agent), ['a', 'c']);
});

test('non-array rows give an empty list', () => {
  assert.deepStrictEqual(visibleRows(null, ['a'], false), []);
});

// --- hiddenCount -------------------------------------------------------------

test('the count is of rows actually hidden right now, not of names in the set', () => {
  const rows = [row('a', 'sleeping'), row('b', 'working'), row('c', 'sleeping')];
  // 'b' is awake (would be cleared), 'zzz' is not on the roster at all.
  assert.strictEqual(hiddenCount(rows, ['a', 'b', 'zzz']), 1);
  assert.strictEqual(hiddenCount(rows, []), 0);
  assert.strictEqual(hiddenCount(null, ['a']), 0);
});

// --- properties --------------------------------------------------------------

const STATES = ['sleeping', 'working', 'happy', 'stressed'];
const NAMES = ['a', 'b', 'c', 'd', 'e'];
const arbRows = fc.uniqueArray(fc.constantFrom(...NAMES), { maxLength: 5 }).chain(names =>
  fc.tuple(...names.map(n => fc.constantFrom(...STATES, 'bogus').map(s => row(n, s)))).map(a => a));
const arbHidden = fc.array(fc.constantFrom(...NAMES, 'ghost'), { maxLength: 8 });

test('PROPERTY: an active agent is never hidden', () => {
  fc.assert(fc.property(arbRows, arbHidden, (rows, hidden) => {
    const shown = new Set(visibleRows(rows, hidden, false));
    for (const r of rows) {
      if (r.state !== 'sleeping') assert.ok(shown.has(r), `${r.agent} (${r.state}) was hidden`);
    }
    // ... and the same after reconcile, which is what the host persists.
    const rec = reconcileHidden(hidden, rows);
    for (const r of rows) {
      if (r.state !== 'sleeping') assert.ok(!rec.hidden.includes(r.agent));
    }
  }));
});

test('PROPERTY: reconcile is idempotent, and cleared is empty the second time', () => {
  fc.assert(fc.property(arbRows, arbHidden, (rows, hidden) => {
    const once = reconcileHidden(hidden, rows);
    const twice = reconcileHidden(once.hidden, rows);
    assert.deepStrictEqual(twice.hidden, once.hidden);
    assert.deepStrictEqual(twice.cleared, []);
  }));
});

test('PROPERTY: cleared and hidden partition the distinct valid input names that are on the roster or kept', () => {
  fc.assert(fc.property(arbRows, arbHidden, (rows, hidden) => {
    const out = reconcileHidden(hidden, rows);
    for (const n of out.cleared) assert.ok(!out.hidden.includes(n));
    assert.deepStrictEqual([...new Set([...out.hidden, ...out.cleared])].sort(), [...new Set(hidden)].sort());
  }));
});

test('PROPERTY: hide -> wake -> sleep ends visible', () => {
  fc.assert(fc.property(fc.constantFrom(...NAMES), fc.constantFrom('working', 'happy', 'stressed'), (name, awake) => {
    let hidden = [name];                                                    // hidden while sleeping
    assert.deepStrictEqual(visibleRows([row(name, 'sleeping')], hidden, false), []);
    hidden = reconcileHidden(hidden, [row(name, awake)]).hidden;            // wakes
    assert.deepStrictEqual(hidden, []);
    const back = [row(name, 'sleeping')];                                   // sleeps again
    hidden = reconcileHidden(hidden, back).hidden;
    assert.deepStrictEqual(visibleRows(back, hidden, false), back);        // still visible
    assert.strictEqual(hideButtonFor(back[0]), true);                       // and can be hidden again
  }));
});
