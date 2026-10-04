'use strict';
/**
 * Kill tests for host/summary-text.js, from Mortimer's gate on release PR #109 (survivor 10): the conversation
 * filters and the budget boundaries. What the flattener lets through is what the local model reads and what is written to
 * disk as a summary, so each filter is pinned on its own, with the secret it keeps out named.
 */
const test = require('node:test');
const assert = require('node:assert');

const { flattenTranscript } = require('../host/summary-text');

const line = (o) => JSON.stringify(o);
const user = (content, extra = {}) => line({ type: 'user', uuid: 'u' + Math.random(), message: { role: 'user', content }, ...extra });
const asst = (content, extra = {}) => line({ type: 'assistant', uuid: 'a' + Math.random(), message: { role: 'assistant', content }, ...extra });
const flat = (lines, opts) => flattenTranscript(lines.join('\n'), opts);

test('one fixture: sidechain, meta, compaction-summary and reminder content is filtered, and no SECRET reaches the output', () => {
  const r = flat([
    user('a normal question'),
    user('SECRET sidechain', { isSidechain: true }),
    user('SECRET meta', { isMeta: true }),
    user('SECRET compaction', { isCompactSummary: true }),
    asst([{ type: 'text', text: 'Real answer\n<system-reminder>\nSECRET from CLAUDE.md\n</system-reminder>' }]),
  ]);
  assert.deepStrictEqual(r.messages.map(m => [m.role, m.text]), [['user', 'a normal question'], ['assistant', 'Real answer']]);
  assert.ok(!/SECRET/.test(r.transcript), r.transcript);
});

test('each flag filters on its own (an assistant sidechain, a user meta line, a compaction line with ordinary words)', () => {
  for (const extra of [{ isSidechain: true }, { isMeta: true }, { isCompactSummary: true }]) {
    for (const make of [user, asst]) {
      const r = flat([make('just words', extra), make('kept words')]);
      assert.deepStrictEqual(r.messages.map(m => m.text), ['kept words'], JSON.stringify(extra));
    }
  }
  // only the literal true filters: a flag of another value is not a flag
  const r = flat([user('one', { isSidechain: false, isMeta: 'true', isCompactSummary: 1 })]);
  assert.deepStrictEqual(r.messages.map(m => m.text), ['one']);
});

test('a reminder block is removed from a string message and from a block message, whatever line it sits on, and its words are gone', () => {
  const r = flat([
    user('<system-reminder>\nSECRET at the top\n</system-reminder>\nthe question'),
    user('the follow-up\n<system-reminder>\nSECRET at the bottom\n</system-reminder>'),
    asst([{ type: 'text', text: 'before' }, { type: 'text', text: '  <system-reminder>SECRET indented\n</system-reminder>  ' }, { type: 'text', text: 'after' }]),
    user('x <system-reminder>mid-sentence mention</system-reminder> y'),
  ]);
  assert.deepStrictEqual(r.messages.map(m => m.text), [
    'the question', 'the follow-up', 'before\nafter', 'x <system-reminder>mid-sentence mention</system-reminder> y']);
  assert.ok(!/SECRET/.test(r.transcript));
});

test('two reminders in one message are both cut (the pattern is global)', () => {
  const r = flat([user('a\n<system-reminder>\nSECRET 1\n</system-reminder>\nb\n<system-reminder>\nSECRET 2\n</system-reminder>')]);
  assert.deepStrictEqual(r.messages.map(m => m.text), ['a\nb']);
  assert.ok(!/SECRET/.test(r.transcript));
});

test('non-text blocks and non-object blocks are not conversation', () => {
  const r = flat([
    asst([{ type: 'tool_use', name: 'Bash', input: { command: 'echo SECRET' } }, { type: 'text', text: 'said this' }, null, 'SECRET bare string', { type: 'text', text: 7 }]),
    asst([{ type: 'text', text: 'SECRET' }].slice(0, 0)),
    user(42),
  ]);
  assert.deepStrictEqual(r.messages.map(m => m.text), ['said this']);
});

test('the budget is inclusive: a window of exactly maxChars keeps the older message, one char less drops it', () => {
  const lines = [asst('a'.repeat(30)), user('b'.repeat(50))];
  // newest user: 'User: ' (6) + 50 = 56; the older assistant: 'Assistant: ' (11) + 30 + 2 (separator) = 43; 99 together
  const exact = flat(lines, { maxChars: 99 });
  assert.deepStrictEqual(exact.messages.map(m => m.role), ['assistant', 'user']);
  assert.strictEqual(exact.transcript.length, 99);
  const tight = flat(lines, { maxChars: 98 });
  assert.deepStrictEqual(tight.messages.map(m => m.role), ['user']);
  assert.strictEqual(tight.transcript, 'User: ' + 'b'.repeat(50));
});

test('the newest message alone is kept whole at exactly maxChars, and cut to fit one char under', () => {
  const lines = [user('z'.repeat(100))];
  const exact = flat(lines, { maxChars: 106 });
  assert.strictEqual(exact.messages[0].text, 'z'.repeat(100));
  const under = flat(lines, { maxChars: 105 });
  assert.strictEqual(under.messages.length, 1);
  assert.ok(under.messages[0].text.length <= 99);
  assert.ok(under.messages[0].text.includes('[...]'));
  assert.ok(under.transcript.length <= 105);
});

test('a newest message that must be cut needs room for at least 20 characters: 20 is kept, 19 is not', () => {
  const lines = [user('z'.repeat(100))];
  const twenty = flat(lines, { maxChars: 6 + 20 });
  assert.strictEqual(twenty.messages.length, 1);
  assert.strictEqual(twenty.messages[0].text.length, 20);
  assert.ok(twenty.newestKey !== null);
  const nineteen = flat(lines, { maxChars: 6 + 19 });
  assert.deepStrictEqual(nineteen, { messages: [], transcript: '', newestKey: null });
});
