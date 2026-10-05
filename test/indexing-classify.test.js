'use strict';
/**
 * The indexing assistant's classifier (host/indexing-classify.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Claude's
 * call" 3 and 4): the prompt shows the model the note and the backlog's title lines only; the reply is a fixed JSON
 * shape, and anything that doesn't parse, names an item that isn't there, or doesn't add up is "not sure".
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

// --- the prompt ------------------------------------------------------------------------------------------------------

test('buildPrompt: the note and the title lines, never an item\'s body, and the instruction comes last', () => {
  const p = c.buildPrompt('the wand should remember its order', BACKLOG);
  assert.ok(p.includes('the wand should remember its order'));
  assert.ok(p.includes('## 61. Wand buttons run the skill, not just type it'));
  assert.ok(p.includes('## 68. host-identity\'s rename can fail with EPERM on Windows'));
  assert.ok(!p.includes('long body that must never reach the model'));
  assert.ok(p.indexOf('## 61.') < p.indexOf('the wand should remember'), 'titles, then the note');
  assert.ok(p.lastIndexOf('"sure"') > p.indexOf('the wand should remember'), 'the JSON shape is spelled out after the note');
  for (const k of ['idea', 'bug', 'decision', 'learning']) assert.ok(p.includes(`"${k}"`), k);
});

test('buildPrompt: a backlog with no items still makes a prompt (everything is new or history)', () => {
  const p = c.buildPrompt('x', '# empty\n');
  assert.ok(p.includes('(none yet)'));
});

// --- the reply -------------------------------------------------------------------------------------------------------

test('parseReply: a sure new item, with its title', () => {
  assert.deepStrictEqual(c.parseReply('{"kind":"idea","target":"new","title":"Tab colours follow the project","sure":true}', ITEMS),
    { sure: true, kind: 'idea', target: 'new', title: 'Tab colours follow the project' });
});

test('parseReply: a note on an existing item, the number as a number, a string or "#N"', () => {
  for (const t of ['61', '"61"', '"#61"', '"# 61"']) {
    assert.deepStrictEqual(c.parseReply(`{"kind":"idea","target":${t},"sure":true}`, ITEMS),
      { sure: true, kind: 'idea', target: 61, title: null }, t);
  }
});

test('parseReply: history for a decision or a learning', () => {
  assert.deepStrictEqual(c.parseReply('{"kind":"learning","target":"history","sure":true}', ITEMS),
    { sure: true, kind: 'learning', target: 'history', title: null });
});

test('parseReply: kind and target are read case-insensitively; "problem" and "fix" are bugs', () => {
  assert.deepStrictEqual(c.parseReply('{"kind":"Problem","target":"NEW","title":"T","sure":true}', ITEMS),
    { sure: true, kind: 'bug', target: 'new', title: 'T' });
  assert.strictEqual(c.parseReply('{"kind":"fix","target":68,"sure":true}', ITEMS).kind, 'bug');
});

test('parseReply: JSON wrapped in prose or a ``` fence is still found', () => {
  const r = c.parseReply('Sure! Here it is:\n```json\n{"kind":"bug","target":68,"sure":true}\n```', ITEMS);
  assert.deepStrictEqual(r, { sure: true, kind: 'bug', target: 68, title: null });
});

test('parseReply: a title is one clean line: no heading marks, no number, no quotes, at most 80 characters', () => {
  assert.strictEqual(c.parseReply('{"kind":"idea","target":"new","title":"## 72. \\"Tabs\\nglow\\"","sure":true}', ITEMS).title, 'Tabs glow');
  const long = 'word '.repeat(40);
  const t = c.parseReply(`{"kind":"idea","target":"new","title":"${long}","sure":true}`, ITEMS).title;
  assert.ok(t.length <= 80, t.length);
});

test('parseReply: "sure" must be a real true; anything else is not sure, and the guess is kept', () => {
  for (const s of ['false', '"true"', '1', 'null']) {
    assert.deepStrictEqual(c.parseReply(`{"kind":"idea","target":61,"sure":${s}}`, ITEMS),
      { sure: false, kind: 'idea', target: 61, title: null }, s);
  }
  assert.strictEqual(c.parseReply('{"kind":"idea","target":61}', ITEMS).sure, false);
});

test('parseReply: unparseable, or not an object, is not sure with no guess', () => {
  const none = { sure: false, kind: null, target: null, title: null };
  for (const raw of ['', 'nope', '{', '[1,2]', 'null', '"text"', 42, null, '{"kind": 5}']) {
    assert.deepStrictEqual(c.parseReply(raw, ITEMS), none, String(raw));
  }
});

test('parseReply: an item that does not exist, or exists twice, is not sure and not a guess', () => {
  assert.deepStrictEqual(c.parseReply('{"kind":"idea","target":99,"sure":true}', ITEMS), { sure: false, kind: 'idea', target: null, title: null });
  assert.deepStrictEqual(c.parseReply('{"kind":"idea","target":70,"sure":true}', ITEMS), { sure: false, kind: 'idea', target: null, title: null });
  assert.deepStrictEqual(c.parseReply('{"kind":"idea","target":"build log","sure":true}', ITEMS), { sure: false, kind: 'idea', target: null, title: null });
});

test('parseReply: a kind that does not go where the target is, is not sure (history vs backlog never swaps silently)', () => {
  assert.strictEqual(c.parseReply('{"kind":"decision","target":61,"sure":true}', ITEMS).sure, false);
  assert.strictEqual(c.parseReply('{"kind":"decision","target":"new","title":"T","sure":true}', ITEMS).sure, false);
  assert.strictEqual(c.parseReply('{"kind":"idea","target":"history","sure":true}', ITEMS).sure, false);
  assert.strictEqual(c.parseReply('{"kind":"thought","target":61,"sure":true}', ITEMS).sure, false);
});

test('parseReply: a new item with no usable title is not sure', () => {
  assert.strictEqual(c.parseReply('{"kind":"idea","target":"new","sure":true}', ITEMS).sure, false);
  assert.strictEqual(c.parseReply('{"kind":"idea","target":"new","title":"  ","sure":true}', ITEMS).sure, false);
  assert.strictEqual(c.parseReply('{"kind":"idea","target":"new","title":"## 72.","sure":true}', ITEMS).sure, false);
});

// --- the picker's candidates -----------------------------------------------------------------------------------------

test('candidates: the items sharing the most words with the note, newest first on a tie, at most k', () => {
  const r = c.candidates('the wand should run the skill when clicked', ITEMS, 3);
  assert.strictEqual(r[0], 61);
  assert.strictEqual(r.length, 3);
});

test('candidates: never a duplicated number, and filled with the newest items when nothing overlaps', () => {
  const r = c.candidates('zebra quantum', ITEMS, 3);
  assert.deepStrictEqual(r, [68, 67, 66]);
});

test('candidates: common words do not count as overlap', () => {
  const r = c.candidates('the and a it to of', ITEMS, 1);
  assert.deepStrictEqual(r, [68]);
});

test('fallbackTitle: the first words of the note, one line, at most 8 words', () => {
  assert.strictEqual(c.fallbackTitle('  tabs should\nglow when a session needs me and more words here '), 'tabs should glow when a session needs me…');
  assert.strictEqual(c.fallbackTitle('short one'), 'short one');
});
