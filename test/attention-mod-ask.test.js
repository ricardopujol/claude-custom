'use strict';
/**
 * BACKLOG #119 A2: an `ask` record from the claude-custom mod (a tool.check that resolved to `ask`) raises the same "needs you"
 * output a permission Notification does, through the same debounce, so the CLI's own Notification for the same prompt never
 * makes a second toast.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createAttention, DEFAULT_DEBOUNCE_MS } = require('../host/attention');

function harness(opts = {}) {
  let now = 1_000_000;
  const sent = [];
  const a = createAttention({ now: () => now, project: 'claude-custom', ...opts });
  a.on('attention', e => sent.push(e));
  return { a, sent, advance(ms) { now += ms; } };
}

test('an ask raises input-needed, urgent, naming the project and the tool', () => {
  const h = harness();
  h.a.ask({ tool: 'Bash' });
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].kind, 'input-needed');
  assert.strictEqual(h.sent[0].urgent, true);
  assert.strictEqual(h.sent[0].project, 'claude-custom');
  assert.strictEqual(h.sent[0].title, 'claude-custom needs you');
  assert.match(h.sent[0].body, /Bash/);
});

test('the same prompt reaching attention twice (the mod\'s ask, then the CLI\'s Notification) is one toast', () => {
  const h = harness();
  h.a.ask({ tool: 'Edit' });
  h.advance(50);
  h.a.handle({ event: 'Notification', payload: { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Edit' } });
  assert.strictEqual(h.sent.length, 1);
});

test('after the debounce a second ask raises again', () => {
  const h = harness();
  h.a.ask({ tool: 'Bash' });
  h.advance(DEFAULT_DEBOUNCE_MS);
  h.a.ask({ tool: 'Bash' });
  assert.strictEqual(h.sent.length, 2);
});

test('an ask from a subagent raises the same cue (the card is the mood machine\'s to mark)', () => {
  const h = harness();
  h.a.ask({ tool: 'Write', agentId: 'agent-1' });
  assert.strictEqual(h.sent[0].kind, 'input-needed');
});

test('a malformed ask raises nothing and never throws', () => {
  const h = harness();
  for (const bad of [undefined, null, 'x', 5, {}, { tool: '' }, { tool: 5 }]) assert.doesNotThrow(() => h.a.ask(bad));
  assert.deepStrictEqual(h.sent, []);
});

test('an ask does not disturb a Stop held back for running agents', () => {
  const h = harness();
  h.a.handle({ event: 'Stop', payload: { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] } });
  h.a.ask({ tool: 'Bash' });
  h.a.handle({ event: 'SubagentStop', payload: { agent_id: 'a1' } });
  h.a.handle({ event: 'Notification', payload: { notification_type: 'idle_prompt' } });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['input-needed', 'finished']);
});
