'use strict';
/**
 * The indexing assistant's document side (host/indexing-doc.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Claude's
 * call" 1, 2 and 5): read a backlog's numbered items, build the text of a filed note, place it, and take it back.
 * Pure: strings in, strings out.
 */
const test = require('node:test');
const assert = require('node:assert');

const doc = require('../host/indexing-doc');

const BACKLOG = [
  '# proj — Backlog',
  '',
  '## Suggested groupings',
  '- a',
  '',
  '## 1. First thing',
  'Ricardo: "one"',
  '',
  '## 3. Third thing (captured 2026-10-01)',
  'body',
  '### a sub heading inside the item',
  '- last line of three',
  '',
  '',
  '## 2. Second thing',
  'two',
  '',
].join('\n');

// --- parsing ---------------------------------------------------------------------------------------------------------

test('parseBacklog: numbered ## items in file order, with their number and title', () => {
  const { items } = doc.parseBacklog(BACKLOG);
  assert.deepStrictEqual(items.map(i => [i.n, i.title]), [[1, 'First thing'], [3, 'Third thing (captured 2026-10-01)'], [2, 'Second thing']]);
});

test('parseBacklog: an item runs from its heading to the next # or ## heading, a ### inside it does not end it', () => {
  const { items } = doc.parseBacklog(BACKLOG);
  const three = items.find(i => i.n === 3);
  const body = BACKLOG.slice(three.start, three.end);
  assert.ok(body.startsWith('## 3. Third thing'));
  assert.ok(body.includes('### a sub heading'));
  assert.ok(body.endsWith('- last line of three\n\n\n'));
  const two = items.find(i => i.n === 2);
  assert.strictEqual(two.end, BACKLOG.length);
});

test('parseBacklog: a heading inside a ``` fence is not an item and does not end one', () => {
  const text = '## 1. One\n```\n## 9. not an item\n# nor this\n```\nstill one\n## 2. Two\n';
  const { items } = doc.parseBacklog(text);
  assert.deepStrictEqual(items.map(i => i.n), [1, 2]);
  assert.ok(text.slice(items[0].start, items[0].end).includes('still one'));
});

test('parseBacklog: a number used twice is marked dup on both', () => {
  const { items } = doc.parseBacklog('## 4. a\n## 4. b\n## 5. c\n');
  assert.deepStrictEqual(items.map(i => i.dup), [true, true, false]);
});

test('parseBacklog: CRLF files parse the same, titles carry no \\r', () => {
  const { items } = doc.parseBacklog(BACKLOG.replace(/\n/g, '\r\n'));
  assert.deepStrictEqual(items.map(i => i.title), ['First thing', 'Third thing (captured 2026-10-01)', 'Second thing']);
});

test('parseBacklog: "## 7 no dot", "##7. tight" and "## x. word" are not items', () => {
  assert.deepStrictEqual(doc.parseBacklog('## 7 no dot\n##7. tight\n## x. word\n').items, []);
});

test('titleLines: the "## N. title" lines only, in file order', () => {
  assert.deepStrictEqual(doc.titleLines(BACKLOG), ['## 1. First thing', '## 3. Third thing (captured 2026-10-01)', '## 2. Second thing']);
});

test('nextItemNumber: one more than the highest ## N., wherever it sits, fenced included', () => {
  assert.strictEqual(doc.nextItemNumber(BACKLOG), 4);
  assert.strictEqual(doc.nextItemNumber('## 1. a\n```\n## 40. fenced\n```\n'), 41);
  assert.strictEqual(doc.nextItemNumber('# nothing numbered\n'), 1);
  assert.strictEqual(doc.nextItemNumber(''), 1);
});

test('newlineOf: CRLF when the file uses it, else LF', () => {
  assert.strictEqual(doc.newlineOf('a\r\nb'), '\r\n');
  assert.strictEqual(doc.newlineOf('a\nb'), '\n');
  assert.strictEqual(doc.newlineOf(''), '\n');
});

// --- the text of a filed note ----------------------------------------------------------------------------------------

test('a new item: "## N. title (captured DATE, indexing assistant)" then Ricardo: "<verbatim>"', () => {
  const p = doc.planInsert(BACKLOG, { target: 'new', title: 'Tab colours', text: 'tabs should "glow"', date: '2026-10-05' });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.n, 4);
  assert.strictEqual(p.offset, BACKLOG.length);
  assert.strictEqual(p.inserted, '\n## 4. Tab colours (captured 2026-10-05, indexing assistant)\nRicardo: "tabs should "glow""\n');
});

test('a new item after a file with no final newline, and after one that already ends in a blank line', () => {
  const p1 = doc.planInsert('## 1. a\nlast', { target: 'new', title: 'T', text: 'x', date: 'D' });
  assert.strictEqual(p1.inserted, '\n\n## 2. T (captured D, indexing assistant)\nRicardo: "x"\n');
  const p2 = doc.planInsert('## 1. a\nlast\n\n', { target: 'new', title: 'T', text: 'x', date: 'D' });
  assert.strictEqual(p2.inserted, '## 2. T (captured D, indexing assistant)\nRicardo: "x"\n');
  const p3 = doc.planInsert('', { target: 'new', title: 'T', text: 'x', date: 'D' });
  assert.strictEqual(p3.inserted, '## 1. T (captured D, indexing assistant)\nRicardo: "x"\n');
});

test('a new item in a CRLF file uses CRLF, and a multi-line note keeps its lines', () => {
  const crlf = BACKLOG.replace(/\n/g, '\r\n');
  const p = doc.planInsert(crlf, { target: 'new', title: 'T', text: 'line one\nline two', date: 'D' });
  assert.strictEqual(p.inserted, '\r\n## 4. T (captured D, indexing assistant)\r\nRicardo: "line one\r\nline two"\r\n');
});

test('a title is one line: runs of whitespace (a newline too) become one space', () => {
  const p = doc.planInsert('', { target: 'new', title: '  A\n  title\t here ', text: 'x', date: 'D' });
  assert.ok(p.inserted.startsWith('## 1. A title here (captured'));
});

test('a note on item #N goes after its last non-blank line, as "- **Note (DATE, indexing assistant):** text"', () => {
  const p = doc.planInsert(BACKLOG, { target: 3, text: 'also do X', date: '2026-10-05' });
  assert.strictEqual(p.ok, true);
  const at = BACKLOG.indexOf('- last line of three\n') + '- last line of three\n'.length;
  assert.strictEqual(p.offset, at);
  assert.strictEqual(p.inserted, '- **Note (2026-10-05, indexing assistant):** also do X\n');
  const after = doc.applyInsert(BACKLOG, p);
  assert.ok(after.includes('- last line of three\n- **Note (2026-10-05, indexing assistant):** also do X\n\n\n## 2.'));
});

test('a note on the last item when the file has no final newline', () => {
  const text = '## 1. a\nbody';
  const p = doc.planInsert(text, { target: 1, text: 'n', date: 'D' });
  assert.strictEqual(p.offset, text.length);
  assert.strictEqual(p.inserted, '\n- **Note (D, indexing assistant):** n\n');
});

test('a multi-line note on an item: the lines after the first are indented under the bullet', () => {
  const p = doc.planInsert('## 1. a\nbody\n', { target: 1, text: 'first\nsecond', date: 'D' });
  assert.strictEqual(p.inserted, '- **Note (D, indexing assistant):** first\n  second\n');
});

test('a note on an item that does not exist, or exists twice, is refused', () => {
  assert.deepStrictEqual(doc.planInsert(BACKLOG, { target: 9, text: 'x', date: 'D' }), { ok: false, reason: 'no-item' });
  assert.deepStrictEqual(doc.planInsert('## 4. a\n## 4. b\n', { target: 4, text: 'x', date: 'D' }), { ok: false, reason: 'dup-item' });
});

test('a history entry is add-history.ps1\'s format: "- DATE [kind] text", appended at the end', () => {
  const hist = '# H\n\n- 2026-10-04 [note] old\n';
  const p = doc.planInsert(hist, { target: 'history', kind: 'decision', text: '  keep it simple  ', date: '2026-10-05' });
  assert.deepStrictEqual(p, { ok: true, offset: hist.length, inserted: '- 2026-10-05 [decision] keep it simple\n' });
});

test('a history entry after a file with no final newline, in CRLF, with continuation lines', () => {
  const p = doc.planInsert('# H\r\n- x', { target: 'history', kind: 'learning', text: 'a\nb', date: 'D' });
  assert.strictEqual(p.inserted, '\r\n- D [learning] a\r\n  b\r\n');
});

test('history only takes decision or learning', () => {
  assert.deepStrictEqual(doc.planInsert('', { target: 'history', kind: 'idea', text: 'x', date: 'D' }), { ok: false, reason: 'bad-kind' });
});

test('an empty note, or a target that is none of new / N / history, is refused', () => {
  assert.deepStrictEqual(doc.planInsert(BACKLOG, { target: 'new', title: 'T', text: '   ', date: 'D' }), { ok: false, reason: 'empty' });
  assert.deepStrictEqual(doc.planInsert(BACKLOG, { target: 'build-log', text: 'x', date: 'D' }), { ok: false, reason: 'bad-target' });
  assert.deepStrictEqual(doc.planInsert(BACKLOG, { target: 0, text: 'x', date: 'D' }), { ok: false, reason: 'bad-target' });
  assert.deepStrictEqual(doc.planInsert(BACKLOG, { target: 'new', title: '  ', text: 'x', date: 'D' }), { ok: false, reason: 'no-title' });
});

// --- exact undo ------------------------------------------------------------------------------------------------------

test('undoInsert takes back exactly what was inserted', () => {
  const p = doc.planInsert(BACKLOG, { target: 1, text: 'n', date: 'D' });
  const rec = doc.recordOf(BACKLOG, p);
  assert.deepStrictEqual(doc.undoInsert(doc.applyInsert(BACKLOG, p), rec), { ok: true, text: BACKLOG });
});

test('undoInsert allows text added AFTER the note (another session appending), and keeps it', () => {
  const p = doc.planInsert(BACKLOG, { target: 'new', title: 'T', text: 'n', date: 'D' });
  const rec = doc.recordOf(BACKLOG, p);
  const later = doc.applyInsert(BACKLOG, p) + '\n## 5. Someone else\n';
  assert.deepStrictEqual(doc.undoInsert(later, rec), { ok: true, text: BACKLOG + '\n## 5. Someone else\n' });
});

test('undoInsert refuses when anything before the note changed, or the note itself was edited', () => {
  const p = doc.planInsert(BACKLOG, { target: 3, text: 'n', date: 'D' });
  const rec = doc.recordOf(BACKLOG, p);
  const filed = doc.applyInsert(BACKLOG, p);
  assert.deepStrictEqual(doc.undoInsert('X' + filed, rec), { ok: false, reason: 'changed' });
  assert.deepStrictEqual(doc.undoInsert(filed.replace('** n', '** m'), rec), { ok: false, reason: 'changed' });
  assert.deepStrictEqual(doc.undoInsert(filed.slice(0, rec.offset + 3), rec), { ok: false, reason: 'changed' });
});

test('undoInsert refuses a record that is not one', () => {
  for (const bad of [null, {}, { offset: -1, inserted: 'x', prefixHash: 'h' }, { offset: 1.5, inserted: 'x', prefixHash: 'h' },
    { offset: 0, inserted: '', prefixHash: doc.hashOf('') }, { offset: 0, inserted: 'x' }]) {
    assert.deepStrictEqual(doc.undoInsert('xyz', bad), { ok: false, reason: 'bad-record' }, JSON.stringify(bad));
  }
});

test('recordOf: the offset, the inserted text and the hash of everything before it', () => {
  const p = doc.planInsert('## 1. a\n', { target: 1, text: 'n', date: 'D' });
  assert.deepStrictEqual(doc.recordOf('## 1. a\n', p), { offset: 8, inserted: p.inserted, prefixHash: doc.hashOf('## 1. a\n') });
});
