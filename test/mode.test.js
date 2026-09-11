'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { parsePermissionMode, MODES } = require('../host/mode');

test('reads each of the five modes from the status line', () => {
  // Measured from the real TUI in verify/probe-detach.js: shift+tab cycles
  // bypass -> auto -> manual -> accept edits -> plan. Five, not three.
  const lines = {
    bypass: '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    auto: '  ⏵⏵ auto mode on (shift+tab to cycle)',
    manual: '  ⏸ manual mode on',
    'accept edits': '  ⏵⏵ accept edits on (shift+tab to cycle)',
    plan: '  ⏸ plan mode on (shift+tab to cycle)',
  };
  for (const [expected, line] of Object.entries(lines)) {
    assert.strictEqual(parsePermissionMode([line]), expected, line);
  }
});

test('returns null when no mode line is present', () => {
  assert.strictEqual(parsePermissionMode(['just some output', '❯ ']), null);
});

test('scans a whole screen, not just one line', () => {
  const screen = ['banner', '', '❯ ', '  ⏸ plan mode on (shift+tab to cycle)', ''];
  assert.strictEqual(parsePermissionMode(screen), 'plan');
});

test('the riskiest mode is flagged as such', () => {
  // "running with permissions bypassed" should be impossible to forget.
  assert.strictEqual(MODES.bypass.risky, true);
  assert.strictEqual(MODES.plan.risky, false);
  assert.strictEqual(MODES.manual.risky, false);
});

test('every mode has a label and a rank', () => {
  for (const [name, m] of Object.entries(MODES)) {
    assert.ok(m.label, name);
    assert.ok(Number.isInteger(m.rank), name);
  }
});

test('ranks order from most permissive to least', () => {
  assert.ok(MODES.bypass.rank < MODES.plan.rank);
  assert.ok(MODES['accept edits'].rank < MODES.manual.rank);
});

test('a later line wins, since the status line is redrawn at the bottom', () => {
  const screen = ['  ⏸ plan mode on', 'output', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
  assert.strictEqual(parsePermissionMode(screen), 'bypass');
});
