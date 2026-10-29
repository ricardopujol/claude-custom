'use strict';
/**
 * BACKLOG #156 (agent cues, part 2): a cross-session message HELD FOR APPROVAL is detected from the CLI's own signal.
 *
 * Measured in the installed CLI (2.1.312, its dialog table): the held-message dialog opens with
 * `notification: { text: "A message from another session needs your approval" }`, which the CLI sends as a Notification hook.
 * So the host reads it off that hook (no terminal scraping) and raises its own kind, `peer-message`, instead of the generic
 * `input-needed`. It never approves anything: the CLI's own prompt is the only way to accept.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createAttention, isHeldPeerMessage, HELD_PEER_MESSAGE } = require('../host/attention');

function harness(opts = {}) {
  let now = 1_000_000;
  const sent = [];
  const a = createAttention({ now: () => now, project: 'claude-custom', ...opts });
  a.on('attention', e => sent.push(e));
  return { a, sent, advance(ms) { now += ms; }, fire(event, payload = {}) { a.handle({ event, payload }); } };
}

test('the CLI\'s own wording is the signal', () => {
  assert.strictEqual(HELD_PEER_MESSAGE, 'A message from another session needs your approval');
  assert.strictEqual(isHeldPeerMessage({ message: HELD_PEER_MESSAGE }), true);
  assert.strictEqual(isHeldPeerMessage({ message: 'a message from another session needs your approval.' }), true, 'case and a full stop do not matter');
  for (const bad of [undefined, null, {}, { message: '' }, { message: 'Claude needs your permission to use Bash' }, { message: 42 }]) {
    assert.strictEqual(isHeldPeerMessage(bad), false, JSON.stringify(bad));
  }
});

test('a held message raises one urgent peer-message, not the generic input-needed', () => {
  const h = harness();
  h.fire('Notification', { notification_type: 'permission_prompt', message: HELD_PEER_MESSAGE });
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].kind, 'peer-message');
  assert.strictEqual(h.sent[0].urgent, true);
  assert.strictEqual(h.sent[0].project, 'claude-custom');
  assert.match(h.sent[0].title, /claude-custom/);
  assert.match(h.sent[0].body, /message from another session/i);
});

test('it is detected whatever the notification type says, and with no type at all', () => {
  for (const type of [undefined, 'permission_prompt', 'agent_needs_input', 'elicitation_dialog']) {
    const h = harness();
    h.fire('Notification', { ...(type ? { notification_type: type } : {}), message: HELD_PEER_MESSAGE });
    assert.deepStrictEqual(h.sent.map(e => e.kind), ['peer-message'], String(type));
  }
});

test('it still raises once the CLI speaks OSC 7501 (the root record does not know about it)', () => {
  const h = harness();
  h.a.programStatus({ live: true, root: { state: 'working' }, children: [] });
  h.fire('Notification', { message: HELD_PEER_MESSAGE });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['peer-message']);
});

test('PR #224 Dexter 3: every held message is raised, however close together; telling a re-notified dialog from a new one is the page\'s (it can see the dialog)', () => {
  const h = harness();
  h.fire('Notification', { message: HELD_PEER_MESSAGE });
  h.advance(1000);
  h.fire('Notification', { message: HELD_PEER_MESSAGE });
  h.fire('Notification', { message: HELD_PEER_MESSAGE });
  assert.strictEqual(h.sent.length, 3);
});

test('PR #224 Dexter 6: a Notification text that is not the held-message words is logged once per distinct text, so a reworded dialog is visible', () => {
  const lines = [];
  const h = harness({ log: m => lines.push(m) });
  h.fire('Notification', { notification_type: 'permission_prompt', message: 'A message from another Claude session needs your approval' });
  h.fire('Notification', { notification_type: 'permission_prompt', message: 'A message from another Claude session needs your approval' });
  h.fire('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /not recognised as a held message/);
  assert.match(lines[0], /another Claude session/);
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['input-needed'], 'logging changes nothing it raises');
});

test('PR #224 Dexter 6: the held-message words themselves are not logged, and an empty or missing text is not either', () => {
  const lines = [];
  const h = harness({ log: m => lines.push(m) });
  h.fire('Notification', { message: HELD_PEER_MESSAGE });
  h.fire('Notification', { notification_type: 'auth_success' });
  h.fire('Notification', { message: '   ' });
  assert.deepStrictEqual(lines, []);
});

test('a held message does not swallow a permission prompt raised just after it', () => {
  const h = harness();
  h.fire('Notification', { message: HELD_PEER_MESSAGE });
  h.fire('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['peer-message', 'input-needed']);
});

test('a different notification is untouched by this', () => {
  const h = harness();
  h.fire('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  h.fire('Notification', { notification_type: 'auth_success', message: 'signed in' });
  assert.deepStrictEqual(h.sent, []);
});
