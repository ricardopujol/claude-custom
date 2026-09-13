'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createAttention } = require('../host/attention');

function harness(opts = {}) {
  let now = 1_000_000;
  const sent = [];
  const a = createAttention({ now: () => now, project: 'claude-custom', ...opts });
  a.on('attention', e => sent.push(e));
  return {
    a, sent,
    advance(ms) { now += ms; },
    fire(event, payload = {}) { a.handle({ event, payload }); },
  };
}

test('a Notification hook means the session wants input', () => {
  const h = harness();
  h.fire('Notification', { message: 'Claude needs your permission to use Bash' });
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].kind, 'input-needed');
});

test('a Stop hook means the turn finished', () => {
  const h = harness();
  h.fire('Stop', {});
  assert.strictEqual(h.sent[0].kind, 'finished');
});

test('every notification names the project', () => {
  // Several windows can be open at once; "Claude is done" is useless without
  // saying which one.
  const h = harness({ project: 'komodo-agency' });
  h.fire('Stop', {});
  assert.strictEqual(h.sent[0].project, 'komodo-agency');
});

test('carries the hook message when there is one', () => {
  const h = harness();
  h.fire('Notification', { message: 'needs permission to run npm test' });
  assert.match(h.sent[0].body, /npm test/);
});

test('a finished turn still reads sensibly with no message', () => {
  const h = harness();
  h.fire('Stop', {});
  assert.ok(h.sent[0].title);
  assert.ok(h.sent[0].body);
});

test('repeated identical events inside the debounce window fire once', () => {
  // Stop can fire more than once around a single turn ending. Two toasts for
  // one event trains you to ignore them.
  const h = harness({ debounceMs: 5000 });
  h.fire('Stop', {});
  h.advance(100);
  h.fire('Stop', {});
  assert.strictEqual(h.sent.length, 1);
});

test('the same event fires again after the debounce window', () => {
  const h = harness({ debounceMs: 5000 });
  h.fire('Stop', {});
  h.advance(5001);
  h.fire('Stop', {});
  assert.strictEqual(h.sent.length, 2);
});

test('input-needed is not suppressed by a preceding finished', () => {
  // They are different kinds. Debouncing across kinds would swallow a request
  // for input because a turn happened to end moments earlier.
  const h = harness({ debounceMs: 5000 });
  h.fire('Stop', {});
  h.fire('Notification', { message: 'permission needed' });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['finished', 'input-needed']);
});

test('input-needed outranks finished in urgency', () => {
  // A waiting prompt blocks progress; a finished turn does not.
  const h = harness();
  h.fire('Notification', { message: 'x' });
  h.fire('Stop', {});
  assert.ok(h.sent[0].urgent);
  assert.ok(!h.sent[1].urgent);
});

test('unrelated hook events raise nothing', () => {
  const h = harness();
  h.fire('PreToolUse', { tool_name: 'Bash' });
  h.fire('PostToolUse', { tool_name: 'Bash' });
  h.fire('SubagentStop', {});
  assert.deepStrictEqual(h.sent, []);
});

test('a SubagentStop is not a finished turn', () => {
  // Subagents stop constantly mid-task. Notifying on those would fire dozens of
  // times during one piece of work.
  const h = harness();
  h.fire('SubagentStop', {});
  assert.deepStrictEqual(h.sent, []);
});
