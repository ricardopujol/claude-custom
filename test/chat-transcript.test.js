'use strict';
/**
 * The best-effort history for a resumed session (host/chat-transcript.js). The transcript's format is internal to the CLI
 * and can change on any release, so the parser keeps only what it recognises and skips the rest without throwing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { parseTranscript, readTranscript, TAIL_BYTES } = require('../host/chat-transcript');

const line = (o) => JSON.stringify(o);
const user = (content, extra = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra });
const asst = (content, extra = {}) => line({ type: 'assistant', message: { role: 'assistant', content }, ...extra });
const jsonl = (...ls) => ls.join('\n') + '\n';

test('a prompt as a string and as text blocks are both the person\'s words', () => {
  const t = jsonl(user('first'), user([{ type: 'text', text: 'second' }]));
  assert.deepStrictEqual(parseTranscript(t), [{ role: 'user', text: 'first' }, { role: 'user', text: 'second' }]);
});

test('a tool result is not a prompt, and a tool_use or thinking block is not a reply', () => {
  const t = jsonl(user('go'),
    asst([{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
    user([{ type: 'tool_result', tool_use_id: 't', content: 'file.txt' }]),
    asst([{ type: 'text', text: 'Done.' }]));
  assert.deepStrictEqual(parseTranscript(t), [{ role: 'user', text: 'go' }, { role: 'assistant', text: 'Done.' }]);
});

test('a turn keeps only its last reply, as the Stop hook does', () => {
  const t = jsonl(user('q'), asst([{ type: 'text', text: 'Let me look.' }]), asst([{ type: 'tool_use', name: 'Read', input: {} }]),
    user([{ type: 'tool_result', content: 'x' }]), asst([{ type: 'text', text: 'Here is the answer.' }]));
  assert.deepStrictEqual(parseTranscript(t), [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'Here is the answer.' }]);
});

test('meta lines, sidechains and slash-command plumbing are skipped', () => {
  const t = jsonl(user('visible'), user('meta', { isMeta: true }), asst([{ type: 'text', text: 'agent chatter' }], { isSidechain: true }),
    user('<command-name>/clear</command-name>'), user('<local-command-stdout>ok</local-command-stdout>'), asst([{ type: 'text', text: 'reply' }]));
  assert.deepStrictEqual(parseTranscript(t), [{ role: 'user', text: 'visible' }, { role: 'assistant', text: 'reply' }]);
});

test('lines it does not understand are skipped, never thrown on', () => {
  const t = ['not json', '{"type":"summary","summary":"s"}', '[]', 'null', '{"type":"user"}', '{"type":"user","message":{"content":42}}',
    '{"type":"assistant","message":{"content":[null,{"type":"text"},{"type":"text","text":5}]}}', user('kept')].join('\n');
  assert.deepStrictEqual(parseTranscript(t), [{ role: 'user', text: 'kept' }]);
});

test('anything that is not a string parses to nothing', () => {
  for (const bad of [null, undefined, 5, {}, []]) assert.deepStrictEqual(parseTranscript(bad), []);
});

test('property: whatever the bytes, it never throws and only yields user and assistant text', () => {
  fc.assert(fc.property(fc.string({ maxLength: 300 }), (s) => {
    const out = parseTranscript(s);
    return Array.isArray(out) && out.every(m => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim() !== '');
  }));
  fc.assert(fc.property(fc.array(fc.jsonValue(), { maxLength: 8 }), (vals) => {
    const out = parseTranscript(vals.map(v => JSON.stringify(v)).join('\n'));
    return Array.isArray(out);
  }));
});

test('property: an assistant message is never followed by another with no prompt between', () => {
  const entry = fc.oneof(fc.string({ minLength: 1, maxLength: 6 }).filter(s => s.trim() && !s.startsWith('<')).map(s => user(s)),
    fc.string({ minLength: 1, maxLength: 6 }).filter(s => s.trim()).map(s => asst([{ type: 'text', text: s }])));
  fc.assert(fc.property(fc.array(entry, { maxLength: 20 }), (ls) => {
    const out = parseTranscript(jsonl(...ls));
    return out.every((m, i) => !(m.role === 'assistant' && i > 0 && out[i - 1].role === 'assistant'));
  }));
});

test('readTranscript reads a file, drops the cut first line of a big one, and answers [] when it can\'t', async () => {
  const files = {
    'a.jsonl': jsonl(user('hi'), asst([{ type: 'text', text: 'yo' }])),
    'big.jsonl': 'x'.repeat(TAIL_BYTES + 10) + '\n' + user('late'),
  };
  const fsImpl = {
    stat: async (f) => { if (!files[f]) throw new Error('ENOENT'); return { size: Buffer.byteLength(files[f]) }; },
    readTail: async (f, from) => Buffer.from(files[f]).subarray(from).toString('utf8'),
  };
  assert.deepStrictEqual(await readTranscript('a.jsonl', fsImpl), [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }]);
  assert.deepStrictEqual(await readTranscript('big.jsonl', fsImpl), [{ role: 'user', text: 'late' }]);
  assert.deepStrictEqual(await readTranscript('missing.jsonl', fsImpl), []);
  assert.deepStrictEqual(await readTranscript('/etc/passwd', fsImpl), []);
  assert.deepStrictEqual(await readTranscript(null, fsImpl), []);
});

test('a compact summary and a background task\'s notice are not the person\'s words (PR #226 Dexter 7, lines as the real transcripts have them)', () => {
  const t = jsonl(
    user('real question', { origin: { kind: 'human' } }),
    user('This session is being continued from a previous conversation that ran out of context. The summary below...', { isVisibleInTranscriptOnly: true }),
    user('<task-notification>\n<task-id>b1</task-id>\n</task-notification>', { origin: { kind: 'task-notification' } }),
    user('<task-notification>\n<task-id>b2</task-id>', {}),
    user('<cross-session-message from="x">do a thing</cross-session-message>', {}),
    asst([{ type: 'text', text: 'the answer' }]));
  assert.deepStrictEqual(parseTranscript(t), [{ role: 'user', text: 'real question' }, { role: 'assistant', text: 'the answer' }]);
  assert.deepStrictEqual(parseTranscript(jsonl(user('old cli, no origin'))), [{ role: 'user', text: 'old cli, no origin' }], 'a line with no origin is still the person\'s');
});
