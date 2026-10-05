'use strict';
/**
 * Kill tests for the summary's input checks, from Mortimer's gate on release PR #109 (survivor 14). The summary reaches the
 * tab strip, the shell and the terminal bar from a renderer, so each of them re-checks it: whitespace-only text, a time
 * that is not a number, a note one char over its cap, and a first-ever summary compared with "none" all have to be refused
 * or handled without throwing.
 */
const test = require('node:test');
const assert = require('node:assert');

const { tabStatus, sameStatus, cleanSummary } = require('../app/tab-status');
const { stripModel } = require('../app/tab-model');
const { barModel } = require('../app/terminal-bar');
const { sanitizeStatus } = require('../app/tab-shell');

const GOOD = { text: 'Working on: x', model: 'llama3.2:3b', at: 1000, stale: false, note: null };

test('cleanSummary: whitespace-only text, a model that is empty, or a time that is not a finite number is no summary', () => {
  assert.deepStrictEqual(cleanSummary({ ...GOOD }), GOOD);
  assert.strictEqual(cleanSummary({ ...GOOD, text: '   ' }), null);
  assert.strictEqual(cleanSummary({ ...GOOD, text: '\n\t ' }), null);
  assert.strictEqual(cleanSummary({ ...GOOD, text: '' }), null);
  assert.strictEqual(cleanSummary({ ...GOOD, model: '' }), null);
  for (const at of ['1', null, undefined, NaN, Infinity, -Infinity, {}, [1]]) assert.strictEqual(cleanSummary({ ...GOOD, at }), null, String(at));
  assert.strictEqual(cleanSummary({ ...GOOD, at: 0 }).at, 0, 'zero is a real time');
  for (const bad of [null, undefined, 'x', 5, [], [GOOD]]) assert.strictEqual(cleanSummary(bad), null);
});

test('cleanSummary: the text, model and note caps are inclusive (2000, 100, 300)', () => {
  assert.strictEqual(cleanSummary({ ...GOOD, text: 'x'.repeat(2000) }).text.length, 2000);
  assert.strictEqual(cleanSummary({ ...GOOD, text: 'x'.repeat(2001) }), null);
  assert.strictEqual(cleanSummary({ ...GOOD, model: 'm'.repeat(100) }).model.length, 100);
  assert.strictEqual(cleanSummary({ ...GOOD, model: 'm'.repeat(101) }), null);
  assert.strictEqual(cleanSummary({ ...GOOD, note: 'n'.repeat(300) }).note.length, 300);
  assert.strictEqual(cleanSummary({ ...GOOD, note: 'n'.repeat(301) }).note, null, 'a too-long note is dropped, the summary stays');
  assert.strictEqual(cleanSummary({ ...GOOD, note: '' }).note, null);
});

test('cleanSummary: stale is true only for a real true', () => {
  assert.strictEqual(cleanSummary({ ...GOOD, stale: true }).stale, true);
  for (const s of ['true', 1, {}, null, undefined]) assert.strictEqual(cleanSummary({ ...GOOD, stale: s }).stale, false);
});

test('tabStatus: the "no summary because" note is kept at exactly 300 chars and dropped at 301', () => {
  assert.strictEqual(tabStatus({ summaryNote: 'n'.repeat(300) }).summaryNote.length, 300);
  assert.strictEqual(tabStatus({ summaryNote: 'n'.repeat(301) }).summaryNote, null);
  assert.strictEqual(tabStatus({ summaryNote: '' }).summaryNote, null);
});

test('sameStatus: a first-ever summary against none is a change, either way round, and never throws', () => {
  const none = { summary: null };
  const some = { summary: GOOD };
  assert.strictEqual(sameStatus(none, some), false);
  assert.strictEqual(sameStatus(some, none), false);
  assert.strictEqual(sameStatus(none, { summary: null }), true);
  assert.strictEqual(sameStatus({}, none), true, 'an absent summary is none');
  assert.strictEqual(sameStatus(some, { summary: { ...GOOD } }), true);
});

test('sameStatus: every field of the summary, and the note, is compared', () => {
  const a = { summary: GOOD, summaryNote: null };
  for (const change of [{ text: 'other' }, { model: 'other' }, { at: 2000 }, { stale: true }, { note: 'a note' }]) {
    assert.strictEqual(sameStatus(a, { summary: { ...GOOD, ...change } }), false, JSON.stringify(change));
  }
  assert.strictEqual(sameStatus({ summaryNote: 'x' }, { summaryNote: 'y' }), false);
  assert.strictEqual(sameStatus({ summaryNote: 'x' }, {}), false);
  assert.strictEqual(sameStatus({ summaryNote: undefined }, { summaryNote: null }), true);
});

const DEV = { path: 'c:\\p\\dev', branch: 'develop', isDev: true, phase: 'live', hostSeen: true };
const entryWith = (status) => stripModel({ tabs: [DEV] }, { 'c:\\p\\dev': { status } }, 'c:\\p\\dev', { keyOf: (p) => p })[0];

test('tab-model: the summary note is a non-empty string or null, and the summary a plain object or null', () => {
  assert.strictEqual(entryWith({ summaryNote: 'Local summary off' }).summaryNote, 'Local summary off');
  for (const bad of ['', 5, null, undefined, {}, ['x']]) assert.strictEqual(entryWith({ summaryNote: bad }).summaryNote, null, JSON.stringify(bad));
  assert.deepStrictEqual(entryWith({ summary: GOOD }).summary, GOOD);
  for (const bad of [[GOOD], 'x', 5, null, undefined, true]) assert.strictEqual(entryWith({ summary: bad }).summary, null, JSON.stringify(bad));
});

test('terminal bar: a summary that is not a plain object is not painted; one with neither lines nor note is not either', () => {
  const bar = (summary) => barModel({ summary, now: 1000 });
  for (const bad of [null, undefined, 'x', 5, [], [{ lines: ['a'] }], true]) assert.strictEqual(bar(bad).summary, undefined, JSON.stringify(bad));
  // things that merely CARRY the right properties are not summaries: an array, a function
  assert.strictEqual(bar(Object.assign([], { lines: ['a'] })).summary, undefined);
  assert.strictEqual(bar(Object.assign(() => {}, { lines: ['a'] })).summary, undefined);
  assert.strictEqual(bar({ lines: [] }).summary, undefined);
  assert.strictEqual(bar({ lines: [5, null, {}] }).summary, undefined, 'lines that are not strings are not lines');
  assert.strictEqual(bar({ lines: [], note: 5 }).summary, undefined);
  assert.strictEqual(bar({}).visible, false);
});

test('terminal bar: the summary part says "local model" without a label, and dim / pinned only for a real true', () => {
  const part = (summary) => barModel({ summary, now: 1000 }).summary;
  assert.deepStrictEqual(part({ lines: ['a'] }), { label: 'local model', lines: ['a'], note: null, dim: false, pinned: false });
  assert.deepStrictEqual(part({ lines: ['a', 7, 'b'], label: 'x · y', note: 'why', dim: true, pinned: true }),
    { label: 'x · y', lines: ['a', 'b'], note: 'why', dim: true, pinned: true });
  assert.strictEqual(part({ lines: ['a'], label: 5 }).label, 'local model');
  assert.strictEqual(part({ lines: ['a'], dim: 'true', pinned: 1 }).dim, false);
  assert.strictEqual(part({ lines: ['a'], dim: 'true', pinned: 1 }).pinned, false);
  assert.deepStrictEqual(part({ note: 'only a note' }), { label: 'local model', lines: [], note: 'only a note', dim: false, pinned: false });
});

test('tab shell sanitizeStatus: the summary note is a non-empty string of at most 300 chars, else null', () => {
  assert.strictEqual(sanitizeStatus({ summaryNote: 'n'.repeat(300) }).summaryNote.length, 300);
  for (const bad of ['n'.repeat(301), '', 5, null, undefined, {}]) assert.strictEqual(sanitizeStatus({ summaryNote: bad }).summaryNote, null);
  assert.strictEqual(sanitizeStatus({ summary: { ...GOOD, text: '  ' } }).summary, null);
  assert.deepStrictEqual(sanitizeStatus({ summary: GOOD }).summary, GOOD);
});
