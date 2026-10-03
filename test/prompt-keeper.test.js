'use strict';
/**
 * The main session's latest prompt (host/prompt-keeper.js, backlog #49, DESIGN_TERMINAL_BAR.md "Sources").
 * `UserPromptSubmit.prompt`, kept per session; a subagent's never counts; nothing stale is ever kept.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createPromptKeeper, PROMPT_MAX } = require('../host/prompt-keeper');

const ev = (event, payload = {}) => ({ event, payload });
const submit = (prompt, extra = {}) => ev('UserPromptSubmit', { prompt, ...extra });
const clock = () => { let t = 1000; const f = () => t; f.set = (v) => { t = v; }; return f; };

test('nothing is known until a prompt arrives: null, never an empty prompt', () => {
  const k = createPromptKeeper({ now: clock() });
  assert.strictEqual(k.snapshot(), null);
});

test('a main-session prompt is kept with its time and a sequence number, and reports the change', () => {
  const now = clock();
  const k = createPromptKeeper({ now });
  assert.strictEqual(k.handle(submit('fix the drawer')), true);
  assert.deepStrictEqual(k.snapshot(), { text: 'fix the drawer', at: 1000, seq: 1 });
  now.set(5000);
  assert.strictEqual(k.handle(submit('and the hover card')), true);
  assert.deepStrictEqual(k.snapshot(), { text: 'and the hover card', at: 5000, seq: 2 });
});

test('the same words typed twice are two prompts: the sequence moves, so the page re-anchors', () => {
  const k = createPromptKeeper({ now: clock() });
  k.handle(submit('continue'));
  assert.strictEqual(k.handle(submit('continue')), true);
  assert.strictEqual(k.snapshot().seq, 2);
});

test("a subagent's prompt event never counts (it carries agent_id)", () => {
  const k = createPromptKeeper({ now: clock() });
  k.handle(submit('mine'));
  assert.strictEqual(k.handle(submit('theirs', { agent_id: 'a1', agent_type: 'electron-pro' })), false);
  assert.strictEqual(k.snapshot().text, 'mine');
});

test('a prompt with no text clears the old one: the old one is no longer "the last prompt" (absence, not stale)', () => {
  const k = createPromptKeeper({ now: clock() });
  k.handle(submit('first'));
  for (const bad of [undefined, null, '', '   \n', 5, {}]) {
    k.handle(submit('first'));
    assert.strictEqual(k.handle(ev('UserPromptSubmit', { prompt: bad })), true, JSON.stringify(bad));
    assert.strictEqual(k.snapshot(), null, JSON.stringify(bad));
  }
  assert.strictEqual(k.handle(ev('UserPromptSubmit', { prompt: '' })), false, 'already empty: nothing changed');
});

test('a new session, a /clear, a resume and the session ending all start with no prompt; a compaction keeps it', () => {
  for (const source of ['startup', 'resume', 'clear']) {
    const k = createPromptKeeper({ now: clock() });
    k.handle(submit('x'));
    assert.strictEqual(k.handle(ev('SessionStart', { source })), true, source);
    assert.strictEqual(k.snapshot(), null, source);
  }
  const c = createPromptKeeper({ now: clock() });
  c.handle(submit('x'));
  assert.strictEqual(c.handle(ev('SessionStart', { source: 'compact' })), false);
  assert.strictEqual(c.snapshot().text, 'x');
  assert.strictEqual(c.handle(ev('SessionEnd')), true);
  assert.strictEqual(c.snapshot(), null);
  assert.strictEqual(c.handle(ev('SessionEnd')), false, 'already empty');
});

test('other events, and junk, change nothing and never throw', () => {
  const k = createPromptKeeper({ now: clock() });
  k.handle(submit('x'));
  for (const junk of [null, undefined, 3, {}, { event: 5 }, ev('Stop'), ev('PreToolUse', { prompt: 'no' }), { event: 'UserPromptSubmit' }]) {
    assert.doesNotThrow(() => k.handle(junk));
  }
  assert.strictEqual(k.snapshot(), null, 'a UserPromptSubmit with no payload at all is a prompt we cannot show');
});

test('a huge paste is capped, never splitting a character in half', () => {
  const k = createPromptKeeper({ now: clock() });
  k.handle(submit('a'.repeat(PROMPT_MAX * 3)));
  assert.strictEqual(k.snapshot().text.length, PROMPT_MAX);
  k.handle(submit('a'.repeat(PROMPT_MAX - 1) + '\u{1F319}'));      // the pair straddles the cap
  const t = k.snapshot().text;
  assert.ok(!/[\uD800-\uDBFF]$/.test(t), 'no lone high surrogate at the end');
  assert.ok(t.length <= PROMPT_MAX);
});

test('property: the kept text is always a prefix of what was typed, never longer than the cap, never blank', () => {
  fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: PROMPT_MAX * 2 }), (s) => {
    const k = createPromptKeeper({ now: clock() });
    k.handle(submit(s));
    const snap = k.snapshot();
    if (s.trim() === '') return snap === null;
    return snap !== null && s.startsWith(snap.text) && snap.text.length <= PROMPT_MAX && snap.text.trim() !== '';
  }));
});

// --- found by mutation testing (a throwaway Stryker run over the new modules) ---------------------------------
test('an empty agent_id is not a subagent: the main session\'s prompt still counts', () => {
  const k = createPromptKeeper({ now: clock() });
  assert.strictEqual(k.handle(submit('mine', { agent_id: '' })), true);
  assert.strictEqual(k.snapshot().text, 'mine');
});

test('the cap keeps exactly PROMPT_MAX characters, and only a pair cut IN HALF at the end loses one', () => {
  const k = createPromptKeeper({ now: clock() });
  k.handle(submit('a'.repeat(PROMPT_MAX - 1) + '\u{1F319}' + 'tail'));
  assert.strictEqual(k.snapshot().text, 'a'.repeat(PROMPT_MAX - 1), 'the moon straddles the cap: cut before it, not mid-pair');
  k.handle(submit('a'.repeat(10) + '\u{1F319}' + 'b'.repeat(PROMPT_MAX)));
  assert.strictEqual(k.snapshot().text.length, PROMPT_MAX, 'a whole pair inside the cap is kept; nothing else is dropped');
  assert.ok(k.snapshot().text.includes('\u{1F319}'));
});

test('handle answers false for every event it does not act on, and for junk', () => {
  const k = createPromptKeeper({ now: clock() });
  k.handle(submit('x'));
  for (const e of [ev('Stop'), ev('PreToolUse', { tool_name: 'Bash' }), ev('Notification'), ev('SubagentStop', { agent_id: 'a' }), { event: 5 }, { event: undefined }]) {
    assert.strictEqual(k.handle(e), false, JSON.stringify(e));
  }
  assert.strictEqual(k.snapshot().text, 'x', 'none of them touched it');
});
