'use strict';
/**
 * PROPERTIES of the tail reader (BACKLOG #10).
 *
 *   P1  for ANY transcript and ANY sequence of chunk boundaries, the entries the
 *       tail hands out, in order, equal a whole-file parse. Nothing lost,
 *       duplicated, or reordered by where the CLI happened to be mid-write.
 *   P2  a partial trailing line NEVER emits: after each prefix of the file, the
 *       entries handed out so far equal a parse of exactly the complete lines in
 *       that prefix.
 *   P3  the per-call cap changes nothing about the union either.
 *
 * One temp directory per test, not per iteration (test/tmp-dir.js: a mkdtemp per
 * iteration is what made the mutation gate 22x slower).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');
const log = require('../host/agent-log');

const T = '2026-09-29T12:34:58.694Z';

// Lines drawn from the shapes measured in real transcripts, plus hostile ones:
// multi-byte text, blank lines, garbage, unknown types, tool calls and results
// whose ids may or may not pair.
const textArb = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.constantFrom('héllo', '日本語', '✓ done', 'emoji 😀 mid', 'tab\there', 'a\nb'),
);
const idArb = fc.constantFrom('t1', 't2', 't3');
const lineArb = fc.oneof(
  textArb.map(text => JSON.stringify({ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text }] } })),
  fc.tuple(idArb, fc.constantFrom('Bash', 'Read', 'Grep'), textArb).map(([id, name, c]) =>
    JSON.stringify({ type: 'assistant', timestamp: T, message: { content: [{ type: 'tool_use', id, name, input: { command: c } }] } })),
  fc.tuple(idArb, textArb, fc.boolean()).map(([id, c, e]) =>
    JSON.stringify({ type: 'user', timestamp: T, message: { content: [{ type: 'tool_result', tool_use_id: id, content: c, is_error: e }] } })),
  textArb.map(text => JSON.stringify({ type: 'user', timestamp: T, message: { content: text } })),
  fc.constant(JSON.stringify({ type: 'attachment', attachment: { type: 'environment' } })),
  fc.constant(JSON.stringify({ type: 'assistant', timestamp: T, message: { content: [{ type: 'thinking', thinking: '' }] } })),
  fc.constantFrom('', '   ', 'not json', '{"type":', 'null', '[1]'),
  fc.string({ maxLength: 20 }).map(t => JSON.stringify({ type: t, timestamp: T })),
);
const transcriptArb = fc.array(lineArb, { maxLength: 12 })
  .chain(lines => fc.tuple(fc.constant(lines), fc.boolean()));

// The oracle: every complete line of `text`, parsed in order with one name memory.
function wholeParse(text) {
  const names = new Map();
  const out = [];
  let unknown = 0;
  const parts = text.split('\n');
  parts.pop();                                  // whatever follows the last \n is partial
  for (const p of parts) {
    for (const e of log.parseLine(p, names).entries) {
      if (e.kind === 'unknown') unknown++;
      out.push(e);
    }
  }
  return { entries: out, unknown };
}

const render = (lines, trailingNewline) => lines.join('\n') + (trailingNewline ? '\n' : '');

test('P1: the union of readMore outputs over any chunk split equals a whole-file parse', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'agent-p1.jsonl');
  await fc.assert(fc.asyncProperty(
    transcriptArb,
    fc.array(fc.nat(400), { maxLength: 8 }),
    async ([lines, trailing], cuts) => {
      const bytes = Buffer.from(render(lines, trailing));
      const points = [...new Set(cuts.map(c => c % (bytes.length + 1)))].sort((a, b) => a - b);
      points.push(bytes.length);

      fs.writeFileSync(file, '');
      let state = log.createTail(file);
      const got = [];
      let prev = 0;
      for (const p of points) {
        fs.appendFileSync(file, bytes.subarray(prev, p));
        prev = p;
        const r = await log.readMore(state);
        got.push(...r.entries);
        state = r.state;
      }
      // A final drain, as the host's poll would do.
      const last = await log.readMore(state);
      got.push(...last.entries);

      const want = wholeParse(bytes.toString('utf8'));
      assert.deepStrictEqual(got, want.entries);
      assert.strictEqual(last.state.unknown, want.unknown);
    },
  ), { numRuns: 120 });
});

test('P2: after every prefix, only COMPLETE lines have been emitted', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'agent-p2.jsonl');
  await fc.assert(fc.asyncProperty(
    transcriptArb,
    fc.array(fc.nat(400), { minLength: 1, maxLength: 6 }),
    async ([lines, trailing], cuts) => {
      const bytes = Buffer.from(render(lines, trailing));
      const points = [...new Set(cuts.map(c => c % (bytes.length + 1)))].sort((a, b) => a - b);

      fs.writeFileSync(file, '');
      let state = log.createTail(file);
      const got = [];
      let prev = 0;
      for (const p of points) {
        fs.appendFileSync(file, bytes.subarray(prev, p));
        prev = p;
        const r = await log.readMore(state);
        got.push(...r.entries);
        state = r.state;
        // Everything emitted so far is exactly the complete lines of this prefix.
        assert.deepStrictEqual(got, wholeParse(bytes.subarray(0, p).toString('utf8')).entries,
          `prefix of ${p} bytes`);
        // And the offset never points into the middle of a line.
        assert.ok(state.offset === 0 || bytes[state.offset - 1] === 10, 'offset sits just past a newline');
      }
    },
  ), { numRuns: 120 });
});

test('P3: a per-call cap never changes the union, and always terminates', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'agent-p3.jsonl');
  await fc.assert(fc.asyncProperty(
    transcriptArb,
    fc.integer({ min: 1, max: 5 }),
    async ([lines, trailing], cap) => {
      const text = render(lines, trailing);
      fs.writeFileSync(file, text);
      let state = log.createTail(file);
      const got = [];
      let calls = 0;
      for (;;) {
        const r = await log.readMore(state, { maxEntries: cap });
        got.push(...r.entries);
        state = r.state;
        assert.ok(++calls <= lines.length + 2, 'reading must make progress');
        if (!r.more) break;
      }
      assert.deepStrictEqual(got, wholeParse(text).entries);
    },
  ), { numRuns: 100 });
});

test('P4: with ANY window size, "caught up" is never claimed while a complete line is unread', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'agent-p4.jsonl');
  await fc.assert(fc.asyncProperty(
    transcriptArb,
    fc.integer({ min: 1, max: 300 }),
    fc.integer({ min: 1, max: 6 }),
    async ([lines, trailing], windowBytes, cap) => {
      const bytes = Buffer.from(render(lines, trailing));
      fs.writeFileSync(file, bytes);
      const lastNewline = bytes.lastIndexOf(10);          // -1 when there is no complete line
      let state = log.createTail(file);
      const got = [];
      for (let calls = 0; ; calls++) {
        assert.ok(calls <= bytes.length + lines.length + 2, 'reading must make progress');
        const r = await log.readMore(state, { windowBytes, maxEntries: cap });
        got.push(...r.entries);
        state = r.state;
        if (!r.more) {
          // done is derived from !more, so this IS "done is never true while offset < size":
          // the only bytes left may be a partial line with no newline.
          assert.strictEqual(state.offset, lastNewline + 1, 'more=false with a complete line still unread');
          break;
        }
      }
      assert.deepStrictEqual(got, wholeParse(bytes.toString('utf8')).entries);
    },
  ), { numRuns: 150 });
});
