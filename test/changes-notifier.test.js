'use strict';
/**
 * When the Changes panel is told to look again (BACKLOG #119 A3): after a hook event for a tool that can change the worktree
 * (Edit, Write, MultiEdit, NotebookEdit, Bash, PowerShell), once things have been quiet for the debounce. Nothing else wakes git.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createChangesNotifier, isChangingTool, DEBOUNCE_MS } = require('../host/changes-notifier');

function fake() {
  const timers = [];
  const sent = [];
  const n = createChangesNotifier({
    announce: (m) => sent.push(m),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
  });
  const fire = () => { const t = timers.filter(x => x.live).pop(); if (t) { t.live = false; t.fn(); } };
  return { n, timers, sent, fire };
}
const ev = (event, tool) => ({ event, payload: { tool_name: tool } });

test('the debounce is two seconds', () => { assert.strictEqual(DEBOUNCE_MS, 2000); });

test('the tools that can change files count, the readers do not', () => {
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']) assert.strictEqual(isChangingTool(t), true, t);
  for (const t of ['Read', 'Grep', 'Glob', 'Task', 'Agent', '', undefined, null, 5]) assert.strictEqual(isChangingTool(t), false, String(t));
});

test('a changing tool event announces `changed` once, after the debounce, not before', () => {
  const { n, sent, fire, timers } = fake();
  assert.strictEqual(n.handle(ev('PreToolUse', 'Edit')), true);
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(timers[0].ms, 2000);
  fire();
  assert.deepStrictEqual(sent, [{ type: 'changes', action: 'changed' }]);
});

test('a burst of events is ONE announcement: each event pushes the timer back', () => {
  const { n, sent, fire, timers } = fake();
  n.handle(ev('PreToolUse', 'Edit'));
  n.handle(ev('PreToolUse', 'Write'));
  n.handle(ev('PostToolUse', 'Bash'));
  assert.strictEqual(timers.filter(t => t.live).length, 1, 'earlier timers were cancelled');
  fire();
  fire();
  assert.strictEqual(sent.length, 1);
});

test('events that cannot change a file wake nothing', () => {
  const { n, timers } = fake();
  for (const e of [ev('PreToolUse', 'Read'), ev('Stop', undefined), { event: 'PreToolUse' }, null, undefined, 'x', { event: 'Status', payload: {} }]) {
    assert.strictEqual(n.handle(e), false);
  }
  assert.strictEqual(timers.length, 0);
});

test('a later burst announces again; close() drops a pending announcement', () => {
  const { n, sent, fire } = fake();
  n.handle(ev('PostToolUse', 'Bash')); fire();
  n.handle(ev('PostToolUse', 'Bash')); fire();
  assert.strictEqual(sent.length, 2);
  n.handle(ev('PostToolUse', 'Bash'));
  n.close();
  fire();
  assert.strictEqual(sent.length, 2);
});

test('an announce that throws does not escape the timer', () => {
  const timers = [];
  const n = createChangesNotifier({ announce: () => { throw new Error('socket gone'); }, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  n.handle(ev('PreToolUse', 'Edit'));
  assert.doesNotThrow(() => timers[0]());
});

test('PROPERTY: any number of events yields at most one live timer, and never throws', () => {
  fc.assert(fc.property(fc.array(fc.oneof(fc.constantFrom('Edit', 'Bash', 'Read', 'Write'), fc.anything()), { maxLength: 30 }), (tools) => {
    const { n, timers } = fake();
    for (const t of tools) n.handle(ev('PreToolUse', t));
    assert.ok(timers.filter(x => x.live).length <= 1);
  }));
});
