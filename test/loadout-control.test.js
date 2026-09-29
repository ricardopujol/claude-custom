'use strict';
/**
 * host/loadout-control.js -- the host's side of the tool belt's protocol
 * (BACKLOG #17): `hello` carries the loadout, `loadout-equip` and
 * `loadout-unequip` change it, and the answer is a `loadout` frame.
 *
 * host.js itself is not unit-testable; like the bug vault (applyVaultAction)
 * and the style actions, the routing lives in a module that is, and host.js
 * only calls it and broadcasts what comes back.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { tmpDir } = require('./tmp-dir');
const { createStore } = require('../host/store');
const { createLoadoutControl, STORE_KEY } = require('../host/loadout-control');
const { parseControlFrame, handleFrame, CONTROL_TYPES } = require('../host/control');
const L = require('../host/loadout');

function harness() {
  const dir = tmpDir('cc-loadout-control-');
  const store = createStore({ dir });
  return { dir, store, control: createLoadoutControl({ store }), file: path.join(dir, 'loadout.json') };
}
const equip = (agentType, itemId) => ({ type: 'loadout-equip', agentType, itemId });
const unequip = (agentType, itemId) => ({ type: 'loadout-unequip', agentType, itemId });

test('the store key is loadout, which is the file the hook reads', () => {
  assert.strictEqual(STORE_KEY, 'loadout');
});

test('payload() on a fresh install is an empty belt plus the catalogue', () => {
  const { control } = harness();
  const p = control.payload();
  assert.deepStrictEqual(p.agents, {});
  assert.deepStrictEqual(p.items, L.catalogue());
});

test('equip writes loadout.json in the shape the hook reads, and answers ok', () => {
  const { control, file } = harness();
  const frame = control.handle(equip('code-reviewer', 'pace-haiku'));
  assert.strictEqual(frame.type, 'loadout');
  assert.strictEqual(frame.ok, true);
  assert.strictEqual(frame.reason, null);
  assert.strictEqual(frame.agentType, 'code-reviewer');
  assert.strictEqual(frame.itemId, 'pace-haiku');
  assert.deepStrictEqual(frame.agents, { 'code-reviewer': ['pace-haiku'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { agents: { 'code-reviewer': ['pace-haiku'] } });
  assert.deepStrictEqual(frame.items, L.catalogue());
});

test('what the frame writes is what the real hook then applies', () => {
  const { control, dir } = harness();
  control.handle(equip('code-reviewer', 'pace-opus'));
  const { decide } = require('../host/loadout-hook');
  const out = JSON.parse(decide(JSON.stringify({ tool_name: 'Agent',
    tool_input: { subagent_type: 'code-reviewer', prompt: 'p' } }), dir));
  assert.strictEqual(out.hookSpecificOutput.updatedInput.model, 'opus');
});

test('a conflicting equip is refused: ok:false, a reason, the file untouched, the truth in the frame', () => {
  const { control, file } = harness();
  control.handle(equip('a', 'pace-haiku'));
  const before = fs.readFileSync(file, 'utf8');
  const frame = control.handle(equip('a', 'pace-opus'));
  assert.strictEqual(frame.type, 'loadout');
  assert.strictEqual(frame.ok, false);
  assert.match(frame.reason, /model/);
  assert.strictEqual(frame.agentType, 'a');
  assert.strictEqual(frame.itemId, 'pace-opus');
  assert.deepStrictEqual(frame.agents, { a: ['pace-haiku'] });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('a refusal is never marked quiet: the renderer must be able to show it', () => {
  // PR #64 N1: a `quiet` echo must not touch the error line, so the frame that
  // CARRIES a refusal must never be quiet, and neither must a success (which is
  // what clears it).
  const { control } = harness();
  control.handle(equip('a', 'pace-haiku'));
  assert.ok(!('quiet' in control.handle(equip('a', 'pace-opus'))));
  assert.ok(!('quiet' in control.handle(unequip('a', 'pace-haiku'))));
});

test('unequip removes the item; an agent with an empty belt disappears from the file', () => {
  const { control, file } = harness();
  control.handle(equip('a', 'pace-haiku'));
  const frame = control.handle(unequip('a', 'pace-haiku'));
  assert.strictEqual(frame.ok, true);
  assert.deepStrictEqual(frame.agents, {});
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { agents: {} });
});

test('unequip of something not equipped is refused with a reason', () => {
  const { control } = harness();
  const frame = control.handle(unequip('a', 'pace-haiku'));
  assert.strictEqual(frame.ok, false);
  assert.match(frame.reason, /not equipped/i);
});

test('equipping what is already equipped succeeds without rewriting the file', () => {
  const { control, file } = harness();
  control.handle(equip('a', 'pace-haiku'));
  const t0 = fs.statSync(file).mtimeMs;
  const before = fs.readFileSync(file, 'utf8');
  const frame = control.handle(equip('a', 'pace-haiku'));
  assert.strictEqual(frame.ok, true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.strictEqual(fs.statSync(file).mtimeMs, t0);
});

test('malformed messages are refused and never throw or write', () => {
  const { control, file } = harness();
  for (const msg of [
    { type: 'loadout-equip' },
    { type: 'loadout-equip', agentType: 5, itemId: 'pace-haiku' },
    { type: 'loadout-equip', agentType: 'a', itemId: {} },
    { type: 'loadout-equip', agentType: '__proto__', itemId: 'pace-haiku' },
    { type: 'loadout-equip', agentType: 'a', itemId: 'not-an-item' },
    { type: 'loadout-unequip', agentType: null, itemId: null },
    { type: 'loadout-something-else', agentType: 'a', itemId: 'pace-haiku' },
    null, undefined, 'x', 7,
  ]) {
    let frame;
    assert.doesNotThrow(() => { frame = control.handle(msg); }, JSON.stringify(msg));
    assert.strictEqual(frame.type, 'loadout');
    assert.strictEqual(frame.ok, false, JSON.stringify(msg));
    assert.strictEqual(typeof frame.reason, 'string');
  }
  assert.strictEqual(fs.existsSync(file), false, 'a refused message must not create the file');
});

test('a corrupt loadout file reads as empty and the next equip heals it', () => {
  const { control, file } = harness();
  fs.writeFileSync(file, '{"agents": {"a": [');
  assert.deepStrictEqual(control.payload().agents, {});
  const frame = control.handle(equip('a', 'pace-sonnet'));
  assert.strictEqual(frame.ok, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { agents: { a: ['pace-sonnet'] } });
});

test('the file is re-read on every message: another host\'s change is not overwritten', () => {
  // .harness/state is install-wide and two hosts can be open. Read-modify-write
  // from a cached copy would erase the other window's equip.
  const a = harness();
  const other = createLoadoutControl({ store: createStore({ dir: a.dir }) });
  a.control.handle(equip('x', 'pace-haiku'));
  other.handle(equip('y', 'pace-opus'));
  const frame = a.control.handle(equip('x', 'review-twice'));
  assert.deepStrictEqual(frame.agents, { x: ['pace-haiku', 'review-twice'], y: ['pace-opus'] });
});

test('a store that cannot write answers ok:false with a reason instead of throwing', () => {
  const real = harness().store;
  const store = { read: real.read, write() { throw new Error('disk full'); } };
  const control = createLoadoutControl({ store });
  let frame;
  assert.doesNotThrow(() => { frame = control.handle(equip('a', 'pace-haiku')); });
  assert.strictEqual(frame.ok, false);
  assert.match(frame.reason, /disk full/);
  assert.deepStrictEqual(frame.agents, {}, 'the frame reports what is really saved');
});

test('createLoadoutControl needs a store', () => {
  assert.throws(() => createLoadoutControl({}), /store/);
});

// --- the wire: control.js must know these types ---------------------------------

test('both loadout types are in the control vocabulary, so a frame is never typed into the pty', () => {
  // Twice already in this repo a new type missed this list and its JSON was
  // typed verbatim into a session running --dangerously-skip-permissions.
  for (const type of ['loadout-equip', 'loadout-unequip']) {
    assert.ok(CONTROL_TYPES.has(type), type);
    const msg = parseControlFrame(JSON.stringify({ type, agentType: 'a', itemId: 'pace-haiku' }));
    assert.strictEqual(msg.type, type);
  }
});

test('a throwing loadout dispatch still never reaches the pty', () => {
  const typed = [];
  const r = handleFrame(JSON.stringify(equip('a', 'pace-haiku')), () => { throw new Error('boom'); }, t => typed.push(t));
  assert.strictEqual(r.handled, true);
  assert.deepStrictEqual(typed, []);
});
