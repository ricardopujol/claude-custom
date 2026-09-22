// @ts-nocheck
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createProcessTracker } = require('../host/processes');

function harness() {
  let now = 1_000_000;
  const t = createProcessTracker({ now: () => now });
  return {
    t,
    advance(ms) { now += ms; },
    pre(tool, input, id) {
      t.handle({ event: 'PreToolUse', payload: { tool_name: tool, tool_input: input, tool_use_id: id } });
    },
    post(tool, input, id) {
      t.handle({ event: 'PostToolUse', payload: { tool_name: tool, tool_input: input, tool_use_id: id } });
    },
  };
}

test('nothing is running to begin with', () => {
  assert.deepStrictEqual(harness().t.list(), []);
});

test('a started tool call shows as running', () => {
  const h = harness();
  h.pre('Bash', { command: 'npm test' }, 'a1');
  const [p] = h.t.list();
  assert.strictEqual(p.tool, 'Bash');
  assert.strictEqual(p.label, 'npm test');
});

test('a finished tool call stops showing', () => {
  const h = harness();
  h.pre('Bash', { command: 'npm test' }, 'a1');
  h.post('Bash', { command: 'npm test' }, 'a1');
  assert.deepStrictEqual(h.t.list(), []);
});

test('reports how long each call has been running', () => {
  // The whole point: a GPU job that takes four minutes should visibly be
  // taking four minutes, not silently appear stuck.
  const h = harness();
  h.pre('Bash', { command: 'python generate.py' }, 'a1');
  h.advance(65_000);
  assert.strictEqual(h.t.list()[0].elapsedMs, 65_000);
});

test('tracks several concurrent calls', () => {
  const h = harness();
  h.pre('Bash', { command: 'one' }, 'a1');
  h.pre('Bash', { command: 'two' }, 'a2');
  h.pre('Task', { subagent_type: 'code-reviewer' }, 'a3');
  assert.strictEqual(h.t.list().length, 3);
  h.post('Bash', { command: 'one' }, 'a1');
  assert.deepStrictEqual(h.t.list().map(p => p.label).sort(), ['code-reviewer', 'two']);
});

test('identical concurrent commands are tracked separately', () => {
  // Two runs of the same command are two processes. Keying on the command text
  // would make the first PostToolUse clear both.
  const h = harness();
  h.pre('Bash', { command: 'npm test' }, 'a1');
  h.pre('Bash', { command: 'npm test' }, 'a2');
  assert.strictEqual(h.t.list().length, 2);
  h.post('Bash', { command: 'npm test' }, 'a1');
  assert.strictEqual(h.t.list().length, 1);
});

test('falls back to matching by command when no tool_use_id is present', () => {
  // The hook payload shape is not guaranteed to carry an id; losing tracking
  // entirely would be worse than the rare mismatch of same-command calls.
  const h = harness();
  h.pre('Bash', { command: 'npm test' });
  assert.strictEqual(h.t.list().length, 1);
  h.post('Bash', { command: 'npm test' });
  assert.deepStrictEqual(h.t.list(), []);
});

test('a Task is labelled by its agent', () => {
  const h = harness();
  h.pre('Task', { subagent_type: 'mutation-tester' }, 'a1');
  assert.strictEqual(h.t.list()[0].label, 'mutation-tester');
});

test('long commands are truncated for display', () => {
  const h = harness();
  h.pre('Bash', { command: 'x'.repeat(400) }, 'a1');
  assert.ok(h.t.list()[0].label.length <= 80);
});

test('an unmatched PostToolUse does not throw', () => {
  const h = harness();
  h.post('Bash', { command: 'never started' }, 'zz');
  assert.deepStrictEqual(h.t.list(), []);
});

test('longest-running first, so the slow thing is at the top', () => {
  const h = harness();
  h.pre('Bash', { command: 'old' }, 'a1');
  h.advance(30_000);
  h.pre('Bash', { command: 'new' }, 'a2');
  assert.deepStrictEqual(h.t.list().map(p => p.label), ['old', 'new']);
});

test('stale entries are swept so a missed PostToolUse cannot pin one forever', () => {
  // If a hook is dropped the entry would otherwise show as running for the rest
  // of the session, which is worse than showing nothing.
  const h = harness();
  h.pre('Bash', { command: 'lost' }, 'a1');
  h.advance(45 * 60_000);
  h.t.sweep();
  assert.deepStrictEqual(h.t.list(), []);
});
