'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createLeanGate } = require('../host/lean-gate');

test('paused only while EVERY attached viewer is lean, and at least one is', () => {
  const g = createLeanGate();
  const a = {}; const b = {};
  assert.strictEqual(g.paused(0), false);
  assert.strictEqual(g.paused(2), false);
  g.set(a, true);
  assert.strictEqual(g.paused(1), true);
  assert.strictEqual(g.paused(2), false, 'a second window that is not lean still wants its summary');
  g.set(b, true);
  assert.strictEqual(g.paused(2), true);
  g.set(a, false);
  assert.strictEqual(g.paused(2), false);
});

test('a viewer that detaches is dropped: a closed window cannot keep the summary off', () => {
  const g = createLeanGate();
  const a = {};
  g.set(a, true);
  g.drop(a);
  assert.strictEqual(g.paused(0), false);
  assert.strictEqual(g.paused(1), false);
});

test('only a real true is lean', () => {
  const g = createLeanGate();
  const a = {};
  for (const v of ['true', 1, null, undefined]) { g.set(a, v); assert.strictEqual(g.paused(1), false, String(v)); }
});

test('wiring: the host pauses the summary tick on the gate, learns lean from the page, and drops a detached viewer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  assert.match(src, /if \(leanGate\.paused\(clients\.size\)\) return;\s*summary\.tick\(\)/);
  assert.match(src, /msg\.type === 'lean'[\s\S]{0,200}leanGate\.set\(ws, msg\.on === true\)/);
  assert.match(src, /leanGate\.drop\(ws\)/);
});

test('D5, the other half: lean never stops main\'s process-tree sampler (it drives the 15-minute Leftovers auto-reap)', () => {
  for (const f of ['app/lean-bridge.js', 'app/lean-state.js', 'host/lean-gate.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, ''), /resources|sampler|setWanted|leftovers/i, f);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'host', 'lean-gate.js'), 'utf8'), /KEEPS running while lean on purpose/);
});

test('the page\'s lean frame is on the control allow-list: off it, it would be typed into the pty as JSON', () => {
  assert.ok(require('../host/control').CONTROL_TYPES.has('lean'));
});
