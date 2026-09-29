'use strict';
/**
 * PR #68, Dexter F1: a second host must notice the shared loadout.json changing.
 * host/loadout-watch.js is the watcher; host/loadout-control.js `changed()`
 * decides whether anything really changed and builds the QUIET frame.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('node:events');

const { tmpDir } = require('./tmp-dir');
const { watchLoadout } = require('../host/loadout-watch');
const { createStore } = require('../host/store');
const { createLoadoutControl } = require('../host/loadout-control');
const { decide } = require('../host/loadout-hook');
const { reduce, ask, emptyState } = require('../app/loadout-display');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const equip = (agentType, itemId) => ({ type: 'loadout-equip', agentType, itemId });
const unequip = (agentType, itemId) => ({ type: 'loadout-unequip', agentType, itemId });

function fakeWatch() {
  const calls = [];
  const watch = (dir, cb) => {
    const w = new EventEmitter();
    w.closed = false;
    w.close = () => { w.closed = true; };
    w.cb = cb;
    calls.push(w);
    return w;
  };
  return { watch, calls };
}

// --- the watcher -----------------------------------------------------------------

test('a write to loadout.json fires onChange, once, however many events it made', async () => {
  const dir = tmpDir('cc-lw-');
  let n = 0;
  const w = watchLoadout({ dir, onChange: () => { n++; }, debounceMs: 60 });
  try {
    await sleep(100);
    const store = createStore({ dir });
    store.write('loadout', { agents: { a: ['pace-haiku'] } });
    store.write('loadout', { agents: { a: ['pace-opus'] } });
    await sleep(800);
    assert.strictEqual(n, 1, 'events inside the debounce window coalesce');
  } finally { w.close(); }
});

test('other files in the state dir do not fire it', async () => {
  const dir = tmpDir('cc-lw-');
  let n = 0;
  const w = watchLoadout({ dir, onChange: () => { n++; }, debounceMs: 30 });
  try {
    await sleep(100);
    fs.writeFileSync(path.join(dir, 'cooldowns.json'), '{}');
    await sleep(400);
    assert.strictEqual(n, 0);
  } finally { w.close(); }
});

test('the filter: loadout.json and an unnamed event fire; another name does not', async () => {
  const { watch, calls } = fakeWatch();
  let n = 0;
  const w = watchLoadout({ dir: tmpDir('cc-lw-'), onChange: () => { n++; }, debounceMs: 10, watch });
  calls[0].cb('rename', 'loadout.json');
  await sleep(40);
  calls[0].cb('change', null);
  await sleep(40);
  calls[0].cb('change', 'loadout.json.tmp123');
  calls[0].cb('change', 'cooldowns.json');
  await sleep(40);
  w.close();
  assert.strictEqual(n, 2);
});

test('a watcher error re-arms the watch and asks the caller to look again', async () => {
  const { watch, calls } = fakeWatch();
  let n = 0;
  const w = watchLoadout({ dir: tmpDir('cc-lw-'), onChange: () => { n++; }, debounceMs: 10, rearmMs: 30, watch });
  calls[0].emit('error', new Error('EPERM'));
  await sleep(150);
  w.close();
  assert.strictEqual(calls.length, 2, 'a second watcher was armed');
  assert.strictEqual(calls[0].closed, true, 'the dead one was closed');
  assert.ok(n >= 1, 'a change while it was down is not lost');
});

test('a watch() that throws keeps retrying instead of giving up', async () => {
  let attempts = 0;
  const watch = () => { attempts++; throw new Error('ENOSPC'); };
  const w = watchLoadout({ dir: tmpDir('cc-lw-'), onChange: () => {}, rearmMs: 20, watch });
  await sleep(120);
  w.close();
  assert.ok(attempts >= 3, `attempts=${attempts}`);
});

test('close() stops everything; a throwing onChange does not kill the watcher', async () => {
  const { watch, calls } = fakeWatch();
  let n = 0;
  const w = watchLoadout({ dir: tmpDir('cc-lw-'), onChange: () => { n++; throw new Error('bad'); }, debounceMs: 10, watch });
  calls[0].cb('change', 'loadout.json');
  await sleep(40);
  calls[0].cb('change', 'loadout.json');
  await sleep(40);
  assert.strictEqual(n, 2);
  w.close();
  assert.strictEqual(calls[0].closed, true);
  calls[0].cb('change', 'loadout.json');
  await sleep(40);
  assert.strictEqual(n, 2, 'nothing fires after close');
});

test('arguments are checked', () => {
  assert.throws(() => watchLoadout({ onChange() {} }), /dir/);
  assert.throws(() => watchLoadout({ dir: 'x' }), /onChange/);
});

// --- two hosts on one state dir -------------------------------------------------------

function twoHosts() {
  const dir = tmpDir('cc-lw2-');
  return { dir, a: createLoadoutControl({ store: createStore({ dir }) }), b: createLoadoutControl({ store: createStore({ dir }) }) };
}

test('F1: an equip through host A reaches host B as a QUIET frame carrying the belt', () => {
  const { a, b } = twoHosts();
  b.payload();                                       // B's window attached: it has seen the empty belt
  a.handle(equip('general-purpose', 'pace-haiku'));
  const frame = b.changed();
  assert.ok(frame, 'B must hear about it');
  assert.strictEqual(frame.type, 'loadout');
  assert.strictEqual(frame.quiet, true, 'an echo is quiet: it must never touch a refusal on screen (PR #64 N1)');
  assert.deepStrictEqual(frame.agents, { 'general-purpose': ['pace-haiku'] });
  assert.ok(Array.isArray(frame.items) && frame.items.length > 0);
});

test('F1: what B\'s window shows equals what the hook applies for the same spawn', () => {
  const { dir, a, b } = twoHosts();
  b.payload();
  a.handle(equip('general-purpose', 'pace-haiku'));
  const shown = reduce(reduce(emptyState(), { type: 'hello', loadout: { agents: {}, items: b.payload().items } }), b.changed());
  assert.deepStrictEqual(shown.agents.get('general-purpose'), ['pace-haiku']);
  const applied = JSON.parse(decide(JSON.stringify({ tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose', prompt: 'p' } }), dir));
  assert.strictEqual(applied.hookSpecificOutput.updatedInput.model, 'haiku');
});

test('F1: an unequip in A also reaches B', () => {
  const { a, b } = twoHosts();
  a.handle(equip('x', 'pace-haiku'));
  assert.ok(b.changed());                            // the watcher fired for the equip
  a.handle(unequip('x', 'pace-haiku'));
  assert.deepStrictEqual(b.changed().agents, {});
});

test('F1: attaching a new window (payload) must not swallow the broadcast the OLD windows still need', () => {
  const { a, b } = twoHosts();
  a.handle(equip('x', 'pace-haiku'));
  b.payload();                                       // a fresh window attached and got the new belt
  assert.ok(b.changed(), 'the windows that were already open have not heard yet');
});

test('F1: nothing changed means no frame, and a host\'s OWN change is not echoed back to it', () => {
  const { a, b } = twoHosts();
  a.payload();
  assert.strictEqual(a.changed(), null, 'no change at all');
  a.handle(equip('x', 'pace-haiku'));
  assert.strictEqual(a.changed(), null, 'A already broadcast its own answer');
  assert.ok(b.changed(), 'but B never saw it');
  assert.strictEqual(b.changed(), null, 'and hears it once');
});

test('F1: a refusal on A leaves the file alone, so B hears nothing', () => {
  const { a, b } = twoHosts();
  a.handle(equip('x', 'pace-haiku'));
  b.changed();
  a.handle(equip('x', 'pace-opus'));
  assert.strictEqual(b.changed(), null);
});

test('F1: a frame from a watcher never clears the refusal shown in a window', () => {
  const { a, b } = twoHosts();
  a.handle(equip('x', 'pace-haiku'));
  let shown = reduce(emptyState(), b.payload() && { type: 'hello', loadout: b.payload() });
  shown = ask(shown, { kind: 'equip', agent: 'x', itemId: 'pace-opus' });   // this window clicked
  shown = reduce(shown, b.handle(equip('x', 'pace-opus')));           // refused in B's window
  assert.ok(shown.error);
  a.handle(unequip('x', 'pace-haiku'));                                // A changes the file
  shown = reduce(shown, b.changed());
  assert.ok(shown.error, 'the refusal survives the echo');
  assert.strictEqual(shown.agents.has('x'), false, 'but the belt behind it is refreshed');
});

test('F1: a corrupt file shows as empty (the hook applies nothing from it, so the card must not claim a belt)', () => {
  const { dir, a, b } = twoHosts();
  a.handle(equip('x', 'pace-haiku'));
  b.changed();
  fs.writeFileSync(path.join(dir, 'loadout.json'), '{"agents": {"x": [');
  assert.deepStrictEqual(b.changed().agents, {});
});

test('F1: an UNREADABLE file (locked, EPERM) produces no frame: that is not "everybody unequipped"', () => {
  const dir = tmpDir('cc-lw3-');
  const real = createStore({ dir });
  real.write('loadout', { agents: { x: ['pace-haiku'] } });
  let unreadable = false;
  const store = { ...real, read: real.read, write: real.write,
    readState: (k) => (unreadable ? { status: 'unreadable', value: null } : real.readState(k)) };
  const control = createLoadoutControl({ store });
  unreadable = true;
  assert.strictEqual(control.changed(), null);
  unreadable = false;
  assert.strictEqual(control.changed(), null, 'and nothing was lost meanwhile');
});
