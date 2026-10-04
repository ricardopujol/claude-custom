'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const m = require('../app/tab-marks');

const IDS = m.MARKS.map(x => x.id);
const storeOf = (marks) => m.parseMarks(JSON.stringify({ version: 1, marks })).store;

test('ten marks, unique ids and emoji, each with a meaning', () => {
  assert.strictEqual(m.MARKS.length, 10);
  assert.strictEqual(new Set(IDS).size, 10);
  assert.strictEqual(new Set(m.MARKS.map(x => x.emoji)).size, 10);
  for (const x of m.MARKS) {
    assert.ok(typeof x.meaning === 'string' && x.meaning.trim() !== '', x.id);
    assert.ok(typeof x.emoji === 'string' && x.emoji !== '', x.id);
  }
});

test('a file that is not a version-1 marks object is refused, not read as empty', () => {
  for (const text of ['', 'nope', '[]', 'null', '{}', '{"version":2,"marks":{}}', '{"version":1,"marks":[]}',
    '{"version":1}', 42]) {
    assert.strictEqual(m.parseMarks(text).ok, false, String(text));
  }
});

test('parse keeps every string id, known or not, and drops empty branches and non-string ids', () => {
  const r = m.parseMarks(JSON.stringify({ version: 1, marks: { 'feat/a': 'waiting', 'feat/b': 'nope', '': 'bug', 'feat/c': 7 } }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.store.marks), ['feat/a', 'feat/b']);
});

test('a branch called __proto__ is just a branch', () => {
  const s = m.setMark(m.emptyMarks(), '__proto__', 'bug');
  assert.strictEqual(m.markFor(s, '__proto__').id, 'bug');
  assert.strictEqual(m.markFor(m.emptyMarks(), '__proto__'), null);
  assert.strictEqual(m.markFor(m.emptyMarks(), 'constructor'), null);
  const back = m.parseMarks(m.serializeMarks(s));
  assert.strictEqual(m.markFor(back.store, '__proto__').id, 'bug');
});

test('markFor gives the whole mark, or null', () => {
  const s = storeOf({ 'feat/a': 'waiting' });
  const w = m.MARKS.find(x => x.id === 'waiting');
  assert.deepStrictEqual(m.markFor(s, 'feat/a'), { id: 'waiting', emoji: w.emoji, meaning: w.meaning });
  assert.strictEqual(m.markFor(s, 'feat/b'), null);
  assert.strictEqual(m.markFor(s, null), null);
  assert.strictEqual(m.markFor(null, 'feat/a'), null);
});

test('setMark returns a new store; null clears; an unknown id is a bug', () => {
  const s = storeOf({ 'feat/a': 'waiting' });
  const t = m.setMark(s, 'feat/a', 'ship');
  assert.strictEqual(m.markFor(s, 'feat/a').id, 'waiting');
  assert.strictEqual(m.markFor(t, 'feat/a').id, 'ship');
  assert.strictEqual(m.markFor(m.setMark(t, 'feat/a', null), 'feat/a'), null);
  assert.throws(() => m.setMark(s, 'feat/a', 'nope'), TypeError);
  assert.throws(() => m.setMark(s, '', 'bug'), TypeError);
});

test('prune keeps only live branches; an unknown list deletes nothing', () => {
  const s = storeOf({ develop: 'star', 'feat/gone': 'waiting' });
  assert.deepStrictEqual(Object.keys(m.pruneMarks(s, ['develop', 'feat/x']).marks), ['develop']);
  for (const unknown of [null, undefined, 'develop']) {
    assert.deepStrictEqual(Object.keys(m.pruneMarks(s, unknown).marks), ['develop', 'feat/gone']);
  }
});

test('markMenuModel: ten radio rows, the current one checked', () => {
  const s = storeOf({ 'feat/a': 'waiting' });
  const menu = m.markMenuModel(s, 'feat/a', 'ok');
  assert.strictEqual(menu.enabled, true);
  assert.strictEqual(menu.rows.length, 10);
  assert.deepStrictEqual(menu.rows.filter(r => r.checked).map(r => r.id), ['waiting']);
  const w = m.MARKS.find(x => x.id === 'waiting');
  assert.strictEqual(menu.rows.find(r => r.id === 'waiting').label, `${w.emoji}  ${w.meaning}`);
  assert.strictEqual(menu.canClear, true);
  assert.strictEqual(m.markMenuModel(s, 'feat/b', 'missing').canClear, false);
  assert.strictEqual(m.markMenuModel(s, 'feat/b', 'missing').enabled, true);
});

test('markMenuModel: disabled, with why, when the file or the branch is unknown', () => {
  const unreadable = m.markMenuModel(m.emptyMarks(), 'feat/a', 'unreadable');
  assert.strictEqual(unreadable.enabled, false);
  assert.match(unreadable.why, /unreadable/);
  // Dexter #87 F5: a linked .claude-custom is not an unreadable file; say which.
  const linked = m.markMenuModel(m.emptyMarks(), 'feat/a', 'unavailable');
  assert.strictEqual(linked.enabled, false);
  assert.match(linked.why, /link/);
  assert.doesNotMatch(linked.why, /unreadable/);
  const noBranch = m.markMenuModel(m.emptyMarks(), null, 'ok');
  assert.strictEqual(noBranch.enabled, false);
  assert.match(noBranch.why, /branch/);
});

const branchArb = fc.string({ minLength: 1, maxLength: 30 });
const storeArb = fc.dictionary(branchArb, fc.constantFrom(...IDS))
  .map(d => Object.entries(d).reduce((s, [b, id]) => m.setMark(s, b, id), m.emptyMarks()));

test('property: what serialize writes, parse reads back', () => {
  fc.assert(fc.property(storeArb, (s) => {
    const r = m.parseMarks(m.serializeMarks(s));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual({ ...r.store.marks }, { ...s.marks });
  }));
});

test('property: setMark then markFor gives that mark', () => {
  fc.assert(fc.property(storeArb, branchArb, fc.constantFrom(...IDS), (s, b, id) => {
    assert.strictEqual(m.markFor(m.setMark(s, b, id), b).id, id);
  }));
});

test('liveBranchesFrom reads full refnames, and an empty answer is unknown, not "no branches"', () => {
  assert.deepStrictEqual(m.liveBranchesFrom('refs/heads/develop\r\nrefs/heads/feat/a\nrefs/heads/heads/odd\n'),
    ['develop', 'feat/a', 'heads/odd']);
  assert.strictEqual(m.liveBranchesFrom(''), null);
  assert.strictEqual(m.liveBranchesFrom('\n'), null);
  assert.strictEqual(m.liveBranchesFrom(null), null);
  assert.deepStrictEqual(m.liveBranchesFrom('refs/tags/v1\nrefs/heads/main\n'), ['main']);
});

test('markCount counts the marks in a store', () => {
  assert.strictEqual(m.markCount(m.emptyMarks()), 0);
  assert.strictEqual(m.markCount(storeOf({ a: 'bug', b: 'star' })), 2);
});

// --- Dexter #87 F3: an id from a newer build is kept, not wiped ----------------

test('an unknown id is kept through parse, set and serialize, and simply not drawn', () => {
  const s = m.parseMarks(JSON.stringify({ version: 1, marks: { 'feat/a': 'blocked', 'feat/b': 'review' } })).store;
  assert.strictEqual(m.markFor(s, 'feat/a'), null, 'not drawn: this build has no emoji for it');
  const after = m.setMark(s, 'feat/c', 'ship');
  const back = JSON.parse(m.serializeMarks(after)).marks;
  assert.deepStrictEqual(back, { 'feat/a': 'blocked', 'feat/b': 'review', 'feat/c': 'ship' });
  assert.strictEqual(m.markFor(m.setMark(s, 'feat/a', 'bug'), 'feat/a').id, 'bug', 'a new pick replaces it');
  const menu = m.markMenuModel(s, 'feat/a', 'ok');
  assert.deepStrictEqual(menu.rows.filter(r => r.checked), [], 'nothing this build knows is checked');
});

test('property: unknown ids survive a round trip and a set on another branch', () => {
  const unknownId = fc.string({ minLength: 1, maxLength: 12 }).filter(s => !IDS.includes(s));
  fc.assert(fc.property(fc.dictionary(branchArb, unknownId), branchArb, (d, b) => {
    const s = m.parseMarks(JSON.stringify({ version: 1, marks: d })).store;
    const after = m.setMark(s, b, 'star');
    const back = m.parseMarks(m.serializeMarks(after)).store.marks;
    for (const [k, v] of Object.entries(d)) if (k !== b) assert.strictEqual(back[k], v, k);
  }));
});

// --- Dexter #87 F4: NTFS refs are case-insensitive ------------------------------

test('prune keeps a mark whose branch git lists in another letter case', () => {
  const s = storeOf({ 'feat/tab-marks': 'bug', 'feat/gone': 'star' });
  assert.deepStrictEqual(Object.keys(m.pruneMarks(s, ['feat/Tab-Marks', 'develop']).marks), ['feat/tab-marks']);
});

test('clicking the ticked row clears the mark; any other row sets its own (Dexter #87 r2)', () => {
  const menu = m.markMenuModel(storeOf({ 'feat/a': 'waiting' }), 'feat/a', 'ok');
  assert.strictEqual(menu.rows.find(r => r.id === 'waiting').choose, null);
  for (const r of menu.rows.filter(x => x.id !== 'waiting')) assert.strictEqual(r.choose, r.id);
});
