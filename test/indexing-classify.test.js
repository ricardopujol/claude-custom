'use strict';
/**
 * The indexing assistant's classifier (host/indexing-classify.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Claude's
 * call" 3 and 4). Measured on the real model (verify/probe-indexing-accuracy.js, 2026-10-05): llama3.2:3b sorts a note
 * best from four lettered choices, cannot tell "same item" from "new item" (every phrasing either always attached or
 * never), and writes a fine title. So: the model answers the KIND, code matches the TARGET by shared words, and the
 * model writes a NEW item's title. History follows from the kind, so a decision is never put on a backlog item.
 */
const test = require('node:test');
const assert = require('node:assert');

const c = require('../host/indexing-classify');
const { parseBacklog } = require('../host/indexing-doc');

const BACKLOG = [
  '# Backlog', '',
  '## 61. Wand buttons run the skill, not just type it',
  'Ricardo: "the wand should run skills" and a long body that must never reach the model',
  '## 63. A resource panel: CPU and memory per session',
  'body',
  '## 66. The indexing assistant: type anything, a local model files it',
  '## 67. Remove the CLI\'s footer block',
  '## 68. host-identity\'s rename can fail with EPERM on Windows',
  '## 70. dup a', '## 70. dup b', '',
].join('\n');
const ITEMS = parseBacklog(BACKLOG).items;

// --- the kind --------------------------------------------------------------------------------------------------------

test('buildKindPrompt: the note and four lettered kinds, nothing from the backlog', () => {
  const p = c.buildKindPrompt('the wand should remember its order');
  assert.ok(p.includes('the wand should remember its order'));
  for (const l of ['A)', 'B)', 'C)', 'D)']) assert.ok(p.includes(l), l);
  assert.ok(!p.includes('Wand buttons run'));
  assert.ok(p.lastIndexOf('"answer"') > p.indexOf('the wand should remember'), 'the answer shape comes after the note');
});

test('parseKindReply: A B C D are idea bug decision learning; the words themselves are read too', () => {
  assert.strictEqual(c.parseKindReply('{"answer":"A"}'), 'idea');
  assert.strictEqual(c.parseKindReply('{"answer":"b"}'), 'bug');
  assert.strictEqual(c.parseKindReply('{"answer":" C) "}'), 'decision');
  assert.strictEqual(c.parseKindReply('{"answer":"D"}'), 'learning');
  assert.strictEqual(c.parseKindReply('{"answer":"Learning"}'), 'learning');
  assert.strictEqual(c.parseKindReply('{"kind":"bug"}'), 'bug');
  assert.strictEqual(c.parseKindReply('{"answer":"problem"}'), 'bug');
});

test('parseKindReply: JSON inside prose or a fence is found', () => {
  assert.strictEqual(c.parseKindReply('Here:\n```json\n{"answer": "D"}\n```'), 'learning');
});

test('parseKindReply: anything else is null', () => {
  for (const raw of ['', 'nope', '{', '[1]', 'null', '{"answer":"E"}', '{"answer":"AB"}', '{"answer":5}', 42, null, '{}']) {
    assert.strictEqual(c.parseKindReply(raw), null, String(raw));
  }
});

// --- the target ------------------------------------------------------------------------------------------------------

test('matchTarget: the item sharing the most words, when it shares at least MATCH_MIN and beats the runner-up', () => {
  assert.strictEqual(c.MATCH_MIN, 3);
  assert.deepStrictEqual(c.matchTarget('the wand buttons should run skills mid-turn', ITEMS), { target: 61, score: 4, next: 0 });
});

test('matchTarget: under MATCH_MIN shared words is a new item', () => {
  assert.strictEqual(c.matchTarget('the wand should glow', ITEMS).target, 'new');
});

test('matchTarget: a tie at the top is a new item (which one is meant cannot be told)', () => {
  const items = parseBacklog('## 1. alpha beta gamma\n## 2. alpha beta gamma delta\n').items;
  assert.strictEqual(c.matchTarget('alpha beta gamma', items).target, 'new');
});

test('matchTarget: a duplicated number is never matched; no items is a new item', () => {
  const items = parseBacklog('## 4. dup alpha beta gamma\n## 4. other\n').items;
  assert.strictEqual(c.matchTarget('dup alpha beta gamma', items).target, 'new');
  assert.deepStrictEqual(c.matchTarget('anything at all', []), { target: 'new', score: 0, next: 0 });
});

// --- the title -------------------------------------------------------------------------------------------------------

test('buildTitlePrompt: the note and at most five of the newest title lines as examples of the style', () => {
  const p = c.buildTitlePrompt('tabs should glow when a session needs me', BACKLOG);
  assert.ok(p.includes('tabs should glow when a session needs me'));
  const examples = p.split('\n').filter(l => l.startsWith('- '));
  assert.deepStrictEqual(examples, [
    '- Wand buttons run the skill, not just type it', '- A resource panel: CPU and memory per session',
    '- The indexing assistant: type anything, a local model files it', '- Remove the CLI\'s footer block',
    '- host-identity\'s rename can fail with EPERM on Windows',
  ], 'the newest five unique items, in file order');
  assert.ok(!p.includes('long body that must never reach the model'));
  assert.ok(p.lastIndexOf('"title"') > p.indexOf('tabs should glow'));
});

test('parseTitleReply: one clean line, no heading marks, no number, no quotes, at most 80 characters', () => {
  assert.strictEqual(c.parseTitleReply('{"title":"## 72. \\"Tabs\\nglow\\""}'), 'Tabs glow');
  assert.ok(c.parseTitleReply(`{"title":"${'word '.repeat(40)}"}`).length <= 80);
  for (const raw of ['{"title":"  "}', '{"title":"## 72."}', '{}', 'nope', '{"title":7}']) assert.strictEqual(c.parseTitleReply(raw), null, raw);
});

// --- the whole call --------------------------------------------------------------------------------------------------

function fakeGenerate(replies) {
  const calls = [];
  const fn = async (prompt, opts) => {
    calls.push({ prompt, opts });
    const r = replies[calls.length - 1];
    return typeof r === 'string' ? { ok: true, text: r, ms: 5 } : r;
  };
  fn.calls = calls;
  return fn;
}

test('classifyNote: a decision goes to history after ONE call; the model is asked for JSON with the shared options', async () => {
  const gen = fakeGenerate(['{"answer":"C"}']);
  const r = await c.classifyNote({ note: 'we keep the journal as JSONL', backlogText: BACKLOG, generate: gen });
  assert.deepStrictEqual(r, { ok: true, result: { sure: true, kind: 'decision', target: 'history', title: null } });
  assert.strictEqual(gen.calls.length, 1);
  assert.deepStrictEqual(gen.calls[0].opts, c.GENERATE_OPTIONS);
});

test('classifyNote: an idea that matches an item goes on it, with no title call', async () => {
  const gen = fakeGenerate(['{"answer":"A"}']);
  const r = await c.classifyNote({ note: 'wand buttons should run skills mid-turn', backlogText: BACKLOG, generate: gen });
  assert.deepStrictEqual(r.result, { sure: true, kind: 'idea', target: 61, title: null });
  assert.strictEqual(gen.calls.length, 1);
});

test('classifyNote: a new bug gets a title from a second call', async () => {
  const gen = fakeGenerate(['{"answer":"B"}', '{"title":"Tabs flicker on resize"}']);
  const r = await c.classifyNote({ note: 'tabs flicker when I resize the window', backlogText: BACKLOG, generate: gen });
  assert.deepStrictEqual(r.result, { sure: true, kind: 'bug', target: 'new', title: 'Tabs flicker on resize' });
  assert.ok(gen.calls[1].prompt.includes('tabs flicker when I resize the window'));
});

test('classifyNote: no usable title is not sure, and the note\'s own first words stand in', async () => {
  const gen = fakeGenerate(['{"answer":"A"}', '{"title":""}']);
  const r = await c.classifyNote({ note: 'tabs flicker when I resize the window', backlogText: BACKLOG, generate: gen });
  assert.deepStrictEqual(r.result, { sure: false, kind: 'idea', target: 'new', title: 'tabs flicker when I resize the window' });
});

test('classifyNote: an unreadable kind is not sure with no guess, and asks nothing more', async () => {
  const gen = fakeGenerate(['{"answer":"Z"}']);
  const r = await c.classifyNote({ note: 'x', backlogText: BACKLOG, generate: gen });
  assert.deepStrictEqual(r, { ok: true, result: { sure: false, kind: null, target: null, title: null } });
  assert.strictEqual(gen.calls.length, 1);
});

test('classifyNote: a failed model call is passed on, so the note waits (the reason kept)', async () => {
  const r1 = await c.classifyNote({ note: 'x', backlogText: BACKLOG, generate: fakeGenerate([{ ok: false, reason: 'unreachable' }]) });
  assert.deepStrictEqual(r1, { ok: false, reason: 'unreachable' });
  const r2 = await c.classifyNote({ note: 'tabs flicker', backlogText: BACKLOG, generate: fakeGenerate(['{"answer":"B"}', { ok: false, reason: 'timeout' }]) });
  assert.deepStrictEqual(r2, { ok: false, reason: 'timeout' });
});

test('a whole classification (two calls, each tried twice) fits inside the GPU slot\'s staleness, or another tab could take the slot mid-job', () => {
  const { STALE_MS } = require('../host/summary-slot');
  assert.ok(Number.isInteger(c.GENERATE_TIMEOUT_MS) && c.GENERATE_TIMEOUT_MS > 0);
  assert.ok(2 * 2 * c.GENERATE_TIMEOUT_MS < STALE_MS, `${4 * c.GENERATE_TIMEOUT_MS} >= ${STALE_MS}`);
});

// --- the picker's candidates -----------------------------------------------------------------------------------------

test('candidates: the items sharing the most words with the note, newest first on a tie, at most k', () => {
  const r = c.candidates('the wand should run the skill when clicked', ITEMS, 3);
  assert.strictEqual(r[0], 61);
  assert.strictEqual(r.length, 3);
});

test('candidates: never a duplicated number, and filled with the newest items when nothing overlaps', () => {
  assert.deepStrictEqual(c.candidates('zebra quantum', ITEMS, 3), [68, 67, 66]);
});

test('candidates: common words do not count as overlap', () => {
  assert.deepStrictEqual(c.candidates('the and a it to of', ITEMS, 1), [68]);
});

test('overlap: the meaningful words a note and a title share, plurals folded, stop words and short words ignored', () => {
  assert.strictEqual(c.overlap('the wand buttons should run skills', 'Wand buttons run the skill, not just type it'), 4);
  assert.strictEqual(c.overlap('the and of it', 'the and of it'), 0);
  assert.strictEqual(c.overlap('', 'anything'), 0);
  assert.strictEqual(c.overlap('Resource panel', 'A RESOURCE panel'), 2);
});

test('fallbackTitle: the first words of the note, one line, at most 8 words', () => {
  assert.strictEqual(c.fallbackTitle('  tabs should\nglow when a session needs me and more words here '), 'tabs should glow when a session needs me…');
  assert.strictEqual(c.fallbackTitle('short one'), 'short one');
});
