'use strict';
/**
 * The chat view's conversation, built from the CLI's own hooks (host/chat-feed.js, BACKLOG #157).
 * The invariants: the chat holds only what the person said and what Claude concluded; a tool call, a subagent
 * and a dialog never add a line; a repeated Stop adds nothing; history from the transcript never doubles a line.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createChatFeed, MESSAGE_CAP } = require('../host/chat-feed');

const ev = (event, payload = {}) => ({ event, payload });
const START = ev('SessionStart', { source: 'startup', session_id: 's1', transcript_path: 'C:/x/s1.jsonl' });
const run = (events) => {
  const f = createChatFeed({ now: () => 1000 });
  for (const e of events) f.handle(e);
  return f;
};
const texts = (f) => f.snapshot().messages.map(m => `${m.role}:${m.text}`);

test('a prompt becomes a you bubble and the turn is working until Stop brings Claude\'s reply', () => {
  const f = run([START, ev('UserPromptSubmit', { prompt: 'fix the bug' })]);
  assert.deepStrictEqual(texts(f), ['user:fix the bug']);
  assert.strictEqual(f.snapshot().working, true);
  f.handle(ev('Stop', { last_assistant_message: 'Done. **Fixed.**' }));
  assert.deepStrictEqual(texts(f), ['user:fix the bug', 'assistant:Done. **Fixed.**']);
  assert.strictEqual(f.snapshot().working, false);
});

test('handle answers whether the snapshot changed', () => {
  const f = createChatFeed();
  assert.strictEqual(f.handle(START), false);
  assert.strictEqual(f.handle(ev('UserPromptSubmit', { prompt: 'hi' })), true);
  assert.strictEqual(f.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })), false);
  assert.strictEqual(f.handle(ev('Stop', { last_assistant_message: 'yo' })), true);
});

test('a tool call, its result and a dialog add no line', () => {
  const f = run([START, ev('UserPromptSubmit', { prompt: 'run it' }),
    ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }),
    ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs permission' }),
    ev('PostToolUse', { tool_name: 'Bash', tool_response: { stdout: 'out' } })]);
  assert.deepStrictEqual(texts(f), ['user:run it']);
});

test('a subagent\'s prompt and Stop are not the conversation', () => {
  const f = run([START, ev('UserPromptSubmit', { prompt: 'agent task', agent_id: 'a1' }),
    ev('Stop', { last_assistant_message: 'agent said', agent_id: 'a1' }), ev('SubagentStop', { last_assistant_message: 'x', agent_id: 'a1' })]);
  assert.deepStrictEqual(texts(f), []);
});

test('a Stop with no message, or a blank one, adds nothing but ends the work', () => {
  const f = run([START, ev('UserPromptSubmit', { prompt: 'q' }), ev('Stop', {})]);
  assert.deepStrictEqual(texts(f), ['user:q']);
  assert.strictEqual(f.snapshot().working, false);
  f.handle(ev('Stop', { last_assistant_message: '   ' }));
  assert.deepStrictEqual(texts(f), ['user:q']);
});

test('the same Stop twice in a turn is one reply', () => {
  const f = run([START, ev('UserPromptSubmit', { prompt: 'q' }), ev('Stop', { last_assistant_message: 'a' }), ev('Stop', { last_assistant_message: 'a' })]);
  assert.deepStrictEqual(texts(f), ['user:q', 'assistant:a']);
});

test('the same words in two turns are two replies', () => {
  const f = run([START, ev('UserPromptSubmit', { prompt: 'q' }), ev('Stop', { last_assistant_message: 'ok' }),
    ev('UserPromptSubmit', { prompt: 'again' }), ev('Stop', { last_assistant_message: 'ok' })]);
  assert.deepStrictEqual(texts(f), ['user:q', 'assistant:ok', 'user:again', 'assistant:ok']);
});

test('a message from another session is a one-line note, never its content', () => {
  const f = run([START, ev('UserPromptSubmit', { prompt: '<cross-session-message from="x">secret plan</cross-session-message>' })]);
  const [m] = f.snapshot().messages;
  assert.strictEqual(m.role, 'note');
  assert.ok(!m.text.includes('secret plan'));
});

test('a blank prompt opens a turn but says nothing', () => {
  const f = run([START, ev('UserPromptSubmit', { prompt: '  ' })]);
  assert.deepStrictEqual(texts(f), []);
  assert.strictEqual(f.snapshot().working, true);
});

test('/clear and a fresh start empty the chat; a compaction keeps it', () => {
  const f = run([START, ev('UserPromptSubmit', { prompt: 'q' }), ev('Stop', { last_assistant_message: 'a' })]);
  f.handle(ev('SessionStart', { source: 'compact' }));
  assert.strictEqual(f.snapshot().messages.length, 2);
  f.handle(ev('SessionStart', { source: 'clear' }));
  assert.strictEqual(f.snapshot().messages.length, 0);
});

test('StopFailure and SessionEnd end the working line', () => {
  for (const end of [ev('StopFailure'), ev('SessionEnd')]) {
    const f = run([START, ev('UserPromptSubmit', { prompt: 'q' }), end]);
    assert.strictEqual(f.snapshot().working, false);
  }
});

test('a long text is cut and says so; the log is capped', () => {
  const f = run([START, ev('UserPromptSubmit', { prompt: 'x'.repeat(100000) })]);
  const [m] = f.snapshot().messages;
  assert.ok(m.text.length < 100000);
  assert.strictEqual(m.truncated, true);
  const g = createChatFeed();
  g.handle(START);
  for (let i = 0; i < MESSAGE_CAP + 20; i++) g.handle(ev('UserPromptSubmit', { prompt: 'p' + i }));
  assert.strictEqual(g.snapshot().messages.length, MESSAGE_CAP);
  assert.strictEqual(g.snapshot().messages.at(-1).text, 'p' + (MESSAGE_CAP + 19));
});

test('ids only grow, so a page can tell a new line from a re-sent one', () => {
  const f = run([START, ev('UserPromptSubmit', { prompt: 'a' }), ev('Stop', { last_assistant_message: 'b' }), ev('UserPromptSubmit', { prompt: 'c' })]);
  const ids = f.snapshot().messages.map(m => m.id);
  assert.deepStrictEqual(ids, [...ids].sort((x, y) => x - y));
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('a resume asks for its history once; seeding puts it before what the hooks already saw', () => {
  const f = run([ev('SessionStart', { source: 'resume', transcript_path: 'C:/x/s1.jsonl' })]);
  assert.strictEqual(f.pendingHistory(), 'C:/x/s1.jsonl');
  f.handle(ev('UserPromptSubmit', { prompt: 'new one' }));
  f.seedHistory([{ role: 'user', text: 'old q' }, { role: 'assistant', text: 'old a' }]);
  assert.deepStrictEqual(texts(f), ['user:old q', 'assistant:old a', 'user:new one']);
  assert.strictEqual(f.pendingHistory(), null);
  assert.strictEqual(f.seedHistory([{ role: 'user', text: 'again' }]), false);
});

test('history that already holds the hooks\' first line stops before it', () => {
  const f = run([ev('SessionStart', { source: 'resume', transcript_path: 'p.jsonl' }), ev('UserPromptSubmit', { prompt: 'new one' })]);
  f.seedHistory([{ role: 'user', text: 'old' }, { role: 'user', text: 'new one' }]);
  assert.deepStrictEqual(texts(f), ['user:old', 'user:new one']);
});

test('a startup session wants no history', () => {
  assert.strictEqual(run([START]).pendingHistory(), null);
});

test('property: only prompts and last_assistant_message ever reach the chat, whatever else fires', () => {
  const marker = 'TOOLMARKER';
  const evt = fc.oneof(
    fc.constantFrom('PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'PermissionRequest', 'SubagentStop', 'SessionEnd', 'StopFailure')
      .map(e => ev(e, { tool_name: 'Bash', tool_input: { command: marker }, tool_response: { stdout: marker }, message: marker, last_assistant_message: marker, agent_id: 'a1' })),
    fc.string({ minLength: 1, maxLength: 12 }).filter(s => s.trim() && !s.includes(marker)).map(s => ev('UserPromptSubmit', { prompt: s })),
    fc.string({ minLength: 1, maxLength: 12 }).filter(s => s.trim() && !s.includes(marker)).map(s => ev('Stop', { last_assistant_message: s })));
  fc.assert(fc.property(fc.array(evt, { maxLength: 40 }), (events) => {
    const f = run([START, ...events]);
    return f.snapshot().messages.every(m => !m.text.includes(marker) && ['user', 'assistant', 'note'].includes(m.role));
  }));
});

test('property: seeding never repeats a line the hooks already gave', () => {
  const line = fc.record({ role: fc.constantFrom('user', 'assistant'), text: fc.constantFrom('a', 'b', 'c', 'd') });
  fc.assert(fc.property(fc.array(line, { maxLength: 8 }), fc.array(line, { maxLength: 8 }), (hooks, history) => {
    const f = createChatFeed();
    f.handle(ev('SessionStart', { source: 'resume', transcript_path: 'p.jsonl' }));
    for (const h of hooks) {
      f.handle(h.role === 'user' ? ev('UserPromptSubmit', { prompt: h.text }) : ev('Stop', { last_assistant_message: h.text }));
    }
    const before = f.snapshot().messages.map(m => `${m.role}:${m.text}`);
    f.seedHistory(history);
    const after = f.snapshot().messages.map(m => `${m.role}:${m.text}`);
    // what the hooks gave stays, in order, as the tail
    return after.slice(after.length - before.length).join('|') === before.join('|');
  }));
});
