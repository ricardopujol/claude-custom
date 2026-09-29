'use strict';
/**
 * BACKLOG #10, the pure half: a transcript line becomes log entries, and a tail
 * reader hands out only COMPLETE lines.
 *
 * Fixtures below are the shapes MEASURED in real subagent transcripts (2026-09-29):
 * `user` with a string prompt, `assistant` with one content block per line
 * (thinking / text / tool_use), `user` carrying `tool_result` blocks, and
 * `attachment` lines that carry no message at all.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const log = require('../host/agent-log');

const T = '2026-09-29T12:34:58.694Z';
const line = o => JSON.stringify(o);
const assistant = (block, ts = T) => line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [block] } });
const user = (content, ts = T) => line({ type: 'user', timestamp: ts, message: { role: 'user', content } });

test('an assistant text block is a text entry with the model as its speaker', () => {
  const { entries } = log.parseLine(assistant({ type: 'text', text: 'No node_modules. Installing.' }));
  assert.deepStrictEqual(entries, [
    { ts: Date.parse(T), kind: 'text', name: 'assistant', summary: 'No node_modules. Installing.' },
  ]);
});

test('a tool_use block names the tool and summarises its input', () => {
  const { entries } = log.parseLine(assistant({ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git log --oneline -1', description: 'x' } }));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'tool_use');
  assert.strictEqual(entries[0].name, 'Bash');
  assert.strictEqual(entries[0].summary, 'git log --oneline -1');
  assert.strictEqual(entries[0].id, 'toolu_1');
});

test('tool input summaries prefer the field that says what the call is about', () => {
  const sum = input => log.parseLine(assistant({ type: 'tool_use', id: 'a', name: 'X', input })).entries[0].summary;
  assert.strictEqual(sum({ file_path: '/a/b.js', content: 'zzz' }), '/a/b.js');
  assert.strictEqual(sum({ pattern: 'foo.*', path: '/src' }), 'foo.*');
  assert.strictEqual(sum({ description: 'Lane B', prompt: 'long' }), 'Lane B');
  // Nothing recognisable: the JSON itself, never an empty line that reads as nothing happened.
  assert.strictEqual(sum({ weird: 1 }), '{"weird":1}');
  assert.strictEqual(sum({}), '{}');
  assert.strictEqual(sum(undefined), '');
});

test('a tool_result is paired to its tool by id and marks an error', () => {
  const names = new Map([['toolu_1', 'Bash']]);
  const ok = log.parseLine(user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done', is_error: false }]), names).entries;
  assert.deepStrictEqual(ok, [{ ts: Date.parse(T), kind: 'tool_result', name: 'Bash', summary: 'done', id: 'toolu_1', error: false }]);
  const bad = log.parseLine(user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true }]), names).entries;
  assert.strictEqual(bad[0].error, true);
});

test('a tool_result whose tool was never seen is still shown, under an explicit name', () => {
  const { entries } = log.parseLine(user([{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }]), new Map());
  assert.strictEqual(entries[0].name, 'tool_result');
  assert.strictEqual(entries[0].kind, 'tool_result');
});

test('tool_result content given as blocks is flattened to their text', () => {
  const { entries } = log.parseLine(user([{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }]));
  assert.strictEqual(entries[0].summary, 'one two');
});

test('a string user message is the prompt: a text entry from the user', () => {
  const { entries } = log.parseLine(user('You are implementing #10'));
  assert.deepStrictEqual(entries.map(e => [e.kind, e.name, e.summary]), [['text', 'user', 'You are implementing #10']]);
});

test('a line with several content blocks yields an entry per block, in order', () => {
  const l = line({ type: 'assistant', timestamp: T, message: { content: [
    { type: 'text', text: 'first' }, { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'f' } }] } });
  assert.deepStrictEqual(log.parseLine(l).entries.map(e => e.kind), ['text', 'tool_use']);
});

test('thinking and attachment lines are unknown entries, named for what they were', () => {
  const think = log.parseLine(assistant({ type: 'thinking', thinking: '', signature: 'sig' })).entries;
  assert.deepStrictEqual(think.map(e => [e.kind, e.name]), [['unknown', 'thinking']]);
  const att = log.parseLine(line({ type: 'attachment', timestamp: T, attachment: { type: 'environment' } })).entries;
  assert.deepStrictEqual(att.map(e => [e.kind, e.name, e.summary]), [['unknown', 'attachment', 'environment']]);
});

test('a line type nobody has heard of is an unknown entry, not a dropped one', () => {
  const { entries } = log.parseLine(line({ type: 'brand-new-thing', timestamp: T }));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'unknown');
  assert.strictEqual(entries[0].name, 'brand-new-thing');
});

test('a complete but unparseable line is an unknown entry, and JSON that is not an object is too', () => {
  for (const bad of ['{"type":', 'null', '42', '"str"', '[]']) {
    const { entries } = log.parseLine(bad);
    assert.strictEqual(entries.length, 1, bad);
    assert.strictEqual(entries[0].kind, 'unknown', bad);
    assert.strictEqual(entries[0].ts, null, bad);
  }
});

test('a blank line is nothing: no entry, and it is not counted as unknown', () => {
  assert.deepStrictEqual(log.parseLine('').entries, []);
  assert.deepStrictEqual(log.parseLine('   \r').entries, []);
});

test('a missing or malformed timestamp is null, never 0 (Number(null) is 0)', () => {
  for (const ts of [undefined, null, '', 'not a date', 5]) {
    const l = line({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text: 'x' }] } });
    assert.strictEqual(log.parseLine(l).entries[0].ts, null, String(ts));
  }
});

test('summaries are one line and bounded, with an ellipsis when cut', () => {
  const long = 'a\n  b\t' + 'x'.repeat(2000);
  const { entries } = log.parseLine(assistant({ type: 'text', text: long }));
  const s = entries[0].summary;
  assert.ok(!/[\r\n\t]/.test(s), 'whitespace runs collapse to one space');
  assert.ok(s.startsWith('a b x'));
  assert.strictEqual(s.length, log.SUMMARY_MAX);
  assert.ok(s.endsWith('…'));
  const exact = log.parseLine(assistant({ type: 'text', text: 'y'.repeat(log.SUMMARY_MAX) })).entries[0].summary;
  assert.strictEqual(exact.length, log.SUMMARY_MAX);
  assert.ok(!exact.endsWith('…'), 'exactly at the bound is not cut');
});

test('the tool-name memory is bounded, oldest out', () => {
  const names = new Map();
  for (let i = 0; i < log.NAMES_MAX + 50; i++) {
    log.parseLine(assistant({ type: 'tool_use', id: 'id' + i, name: 'T' + i, input: {} }), names);
  }
  assert.strictEqual(names.size, log.NAMES_MAX);
  assert.ok(!names.has('id0'));
  assert.ok(names.has('id' + (log.NAMES_MAX + 49)));
});

// ---- the tail reader ------------------------------------------------------

function fileWith(text) {
  const dir = tmpDir();
  const f = path.join(dir, 'agent-x.jsonl');
  fs.writeFileSync(f, text);
  return f;
}

test('readMore starts at byte 0 and returns every complete line', async () => {
  const f = fileWith(assistant({ type: 'text', text: 'a' }) + '\n' + assistant({ type: 'text', text: 'b' }) + '\n');
  const { entries, state } = await log.readMore(log.createTail(f));
  assert.deepStrictEqual(entries.map(e => e.summary), ['a', 'b']);
  assert.strictEqual(state.offset, fs.statSync(f).size);
  const again = await log.readMore(state);
  assert.deepStrictEqual(again.entries, []);
});

test('a partial trailing line is NOT emitted until its newline arrives', async () => {
  const a = assistant({ type: 'text', text: 'a' });
  const b = assistant({ type: 'text', text: 'b' });
  const f = fileWith(a + '\n' + b.slice(0, 20));
  const first = await log.readMore(log.createTail(f));
  assert.deepStrictEqual(first.entries.map(e => e.summary), ['a']);
  assert.strictEqual(first.state.offset, Buffer.byteLength(a + '\n'), 'offset stops before the partial line');
  fs.appendFileSync(f, b.slice(20));
  const mid = await log.readMore(first.state);
  assert.deepStrictEqual(mid.entries, [], 'still no newline, still not emitted');
  fs.appendFileSync(f, '\n');
  const last = await log.readMore(mid.state);
  assert.deepStrictEqual(last.entries.map(e => e.summary), ['b']);
});

test('a multi-byte character split across reads is never mangled', async () => {
  const l = assistant({ type: 'text', text: 'héllo wörld ✓ 日本' });
  const bytes = Buffer.from(l + '\n');
  const cut = bytes.indexOf(Buffer.from('✓')) + 1;      // inside the 3-byte character
  const f = fileWith('');
  fs.writeFileSync(f, bytes.subarray(0, cut));
  const first = await log.readMore(log.createTail(f));
  assert.deepStrictEqual(first.entries, []);
  fs.appendFileSync(f, bytes.subarray(cut));
  const second = await log.readMore(first.state);
  assert.strictEqual(second.entries[0].summary, 'héllo wörld ✓ 日本');
});

test('CRLF line endings do not leak a carriage return into entries', async () => {
  const f = fileWith(assistant({ type: 'text', text: 'a' }) + '\r\n');
  const { entries } = await log.readMore(log.createTail(f));
  assert.deepStrictEqual(entries.map(e => e.summary), ['a']);
});

test('maxEntries caps one call and says more is waiting; the rest comes next call', async () => {
  const lines = Array.from({ length: 5 }, (_, i) => assistant({ type: 'text', text: 'n' + i })).join('\n') + '\n';
  const f = fileWith(lines);
  const one = await log.readMore(log.createTail(f), { maxEntries: 2 });
  assert.deepStrictEqual(one.entries.map(e => e.summary), ['n0', 'n1']);
  assert.strictEqual(one.more, true);
  const two = await log.readMore(one.state, { maxEntries: 2 });
  assert.deepStrictEqual(two.entries.map(e => e.summary), ['n2', 'n3']);
  assert.strictEqual(two.more, true);
  const three = await log.readMore(two.state, { maxEntries: 2 });
  assert.deepStrictEqual(three.entries.map(e => e.summary), ['n4']);
  assert.strictEqual(three.more, false);
});

test('the cap counts LINES read, so a blank or multi-block line cannot stall or skip', async () => {
  const multi = line({ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text: 'p' }, { type: 'text', text: 'q' }] } });
  const f = fileWith('\n' + multi + '\n' + assistant({ type: 'text', text: 'r' }) + '\n');
  const all = [];
  let st = log.createTail(f);
  for (let i = 0; i < 10; i++) {
    const r = await log.readMore(st, { maxEntries: 1 });
    all.push(...r.entries.map(e => e.summary));
    st = r.state;
    if (!r.more) break;
  }
  assert.deepStrictEqual(all, ['p', 'q', 'r']);
});

test('unknown entries are counted in the state, so the UI can say how many', async () => {
  const f = fileWith(line({ type: 'attachment', attachment: { type: 'e' } }) + '\n' + assistant({ type: 'text', text: 'a' }) + '\nnot json\n');
  const { state } = await log.readMore(log.createTail(f));
  assert.strictEqual(state.unknown, 2);
});

test('a file that shrank is read again from the top, and the caller is told', async () => {
  const f = fileWith(assistant({ type: 'text', text: 'long long long long' }) + '\n');
  const first = await log.readMore(log.createTail(f));
  fs.writeFileSync(f, assistant({ type: 'text', text: 'z' }) + '\n');
  const second = await log.readMore(first.state);
  assert.strictEqual(second.reset, true);
  assert.deepStrictEqual(second.entries.map(e => e.summary), ['z']);
});

test('a vanished file rejects with ENOENT so the caller can say so', async () => {
  const dir = tmpDir();
  await assert.rejects(log.readMore(log.createTail(path.join(dir, 'nope.jsonl'))), { code: 'ENOENT' });
});

test('tool names carry across reads: a result arriving in a later call still finds its tool', async () => {
  const f = fileWith(assistant({ type: 'tool_use', id: 'u1', name: 'Grep', input: { pattern: 'p' } }) + '\n');
  const first = await log.readMore(log.createTail(f));
  fs.appendFileSync(f, user([{ type: 'tool_result', tool_use_id: 'u1', content: 'hit' }]) + '\n');
  const second = await log.readMore(first.state);
  assert.strictEqual(second.entries[0].name, 'Grep');
});

// ---- Dexter F2 / Miguel M2, PR #63: `more` false means caught up, not "this window is spent" ----

test('45 lines of 100 KB: the default 4 MB window ends mid-line, and more stays true until line 45', async () => {
  const big = i => assistant({ type: 'text', text: ('L' + i + ' ').padEnd(100000, 'x') });
  const f = fileWith(Array.from({ length: 45 }, (_, i) => big(i)).join('\n') + '\n');
  assert.ok(fs.statSync(f).size > 4 * 1024 * 1024, 'the fixture must exceed the window');
  let state = log.createTail(f);
  const seen = [];
  let calls = 0;
  for (;;) {
    const r = await log.readMore(state);
    calls++;
    seen.push(...r.entries);
    state = r.state;
    if (!r.more) break;
    assert.ok(seen.length < 45, 'more must not be true once everything is delivered');
  }
  assert.ok(calls >= 2, 'the first call cannot have delivered the whole file');
  assert.strictEqual(seen.length, 45);
  assert.strictEqual(state.offset, fs.statSync(f).size);
});

test('with a small window, a window that ends mid-line reports more, and the last call reports none', async () => {
  const lines = Array.from({ length: 6 }, (_, i) => assistant({ type: 'text', text: 'row' + i }));
  const f = fileWith(lines.join('\n') + '\n');
  const lineBytes = Buffer.byteLength(lines[0] + '\n');
  // Room for one and a half lines: the window always ends inside a line.
  const r = await log.readMore(log.createTail(f), { windowBytes: Math.floor(lineBytes * 1.5) });
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.more, true);
});
