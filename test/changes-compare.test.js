'use strict';
/**
 * The Changes panel's side-by-side Compare (BACKLOG #119 A3, app/changes-compare.js): app/repo-linediff.js decides how two texts line up;
 * this pairs a removed run with the added run beside it, folds long unchanged stretches, finds the hunks (the `j` / `k` keys), and
 * composes the comment that is typed into the prompt.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { diffLines, linesOf } = require('../app/repo-linediff');
const X = require('../app/changes-compare');

const rowsOf = (a, b) => diffLines(a, b);

test('pairing: a removed line beside the line that replaced it is ONE change row, with both numbers', () => {
  const p = X.sideBySide(rowsOf('a\nb\nc\n', 'a\nB\nc\n'));
  assert.deepStrictEqual(p.map(r => r.kind), ['same', 'change', 'same']);
  assert.deepStrictEqual(p[1], { kind: 'change', left: { no: 2, text: 'b' }, right: { no: 2, text: 'B' } });
});

test('pairing: more additions than removals leaves the extra as add-only rows; more removals leaves del-only rows', () => {
  const a = X.sideBySide(rowsOf('a\nb\n', 'a\nB\nB2\nB3\n'));
  assert.deepStrictEqual(a.map(r => r.kind), ['same', 'change', 'add', 'add']);
  assert.deepStrictEqual(a[3], { kind: 'add', left: null, right: { no: 4, text: 'B3' } });
  const d = X.sideBySide(rowsOf('a\nb\nc\nd\n', 'a\nZ\n'));
  assert.deepStrictEqual(d.map(r => r.kind), ['same', 'change', 'del', 'del']);
  assert.deepStrictEqual(d[2], { kind: 'del', left: { no: 3, text: 'c' }, right: null });
});

test('a new file is all adds, a deleted file is all dels, equal files are all same', () => {
  assert.deepStrictEqual(X.sideBySide(rowsOf('', 'x\ny\n')).map(r => r.kind), ['add', 'add']);
  assert.deepStrictEqual(X.sideBySide(rowsOf('x\ny\n', '')).map(r => r.kind), ['del', 'del']);
  assert.deepStrictEqual(X.sideBySide(rowsOf('x\n', 'x\n')).map(r => r.kind), ['same']);
  assert.deepStrictEqual(X.sideBySide([]), []);
});

test('fold: a long unchanged stretch keeps 3 lines at each edge and says how many it hid; the file ends stay whole', () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
  const b = a.slice(); b[14] = 'CHANGED';
  const folded = X.fold(X.sideBySide(rowsOf(a.join('\n') + '\n', b.join('\n') + '\n')));
  const kinds = folded.map(r => r.kind);
  assert.deepStrictEqual(kinds, ['gap', 'same', 'same', 'same', 'change', 'same', 'same', 'same', 'gap']);
  assert.strictEqual(folded[0].hidden, 11);
  assert.strictEqual(folded[8].hidden, 12);
  assert.strictEqual(folded[4].right.no, 15);
});

test('fold: a short unchanged stretch is not folded (a gap that hides one line would cost more than the line)', () => {
  const folded = X.fold(X.sideBySide(rowsOf('a\n1\n2\n3\n4\n5\n6\n7\nb\n', 'A\n1\n2\n3\n4\n5\n6\n7\nB\n')));
  assert.ok(!folded.some(r => r.kind === 'gap'));
});

test('fold: the row cap ends the list with a note instead of drawing a wall', () => {
  const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join('\n');
  const folded = X.fold(X.sideBySide(rowsOf(a, b)), { maxRows: 10 });
  assert.strictEqual(folded.length, 11);
  assert.strictEqual(folded[10].kind, 'gap');
  assert.match(folded[10].note, /not shown/);
});

test('hunks: the index of the first row of each run of changes', () => {
  const rows = X.sideBySide(rowsOf('1\n2\n3\n4\n5\n6\n7\n8\n9\n', '1\nTWO\n3\n4\n5\n6\n7\n8\nNINE\nTEN\n'));
  const folded = X.fold(rows, { context: 1 });
  const h = X.hunkStarts(folded);
  assert.strictEqual(h.length, 2);
  assert.ok(folded[h[0]].kind === 'change' && folded[h[0]].left.text === '2');
  assert.ok(folded[h[1]].kind === 'change' && folded[h[1]].left.text === '9');
});

test('nextHunk / prevHunk: wrap at the ends, and cope with no hunks or no current row', () => {
  assert.strictEqual(X.nextHunk([3, 9, 20], 3), 9);
  assert.strictEqual(X.nextHunk([3, 9, 20], 9), 20);
  assert.strictEqual(X.nextHunk([3, 9, 20], 20), 3);
  assert.strictEqual(X.nextHunk([3, 9, 20], null), 3);
  assert.strictEqual(X.nextHunk([3, 9, 20], 5), 9);
  assert.strictEqual(X.prevHunk([3, 9, 20], 9), 3);
  assert.strictEqual(X.prevHunk([3, 9, 20], 3), 20);
  assert.strictEqual(X.prevHunk([3, 9, 20], null), 20);
  assert.strictEqual(X.prevHunk([3, 9, 20], 15), 9);
  assert.strictEqual(X.nextHunk([], 4), null);
  assert.strictEqual(X.prevHunk([], null), null);
});

test('commentText: In <path>:<line> — <comment>, one line, trimmed', () => {
  assert.deepStrictEqual(X.commentText('src/a.js', 12, '  rename this  '), { ok: true, text: 'In src/a.js:12 — rename this' });
  assert.deepStrictEqual(X.commentText('sub dir/r.txt', 3, 'why?\nand\tthis\r\nalso'), { ok: true, text: 'In sub dir/r.txt:3 — why? and this also' });
});

test('commentText refuses what cannot be a one-line comment', () => {
  for (const [p, l, t] of [['a', 0, 'x'], ['a', -1, 'x'], ['a', 1.5, 'x'], ['a', NaN, 'x'], ['', 1, 'x'], [null, 1, 'x'], ['a', 1, ''], ['a', 1, '  \n '], ['a', 1, 5], ['a\nb', 1, 'x']]) {
    assert.strictEqual(X.commentText(p, l, t).ok, false, JSON.stringify([p, l, t]));
  }
});

test('commentText drops control characters and a trailing backslash (the CLI reads backslash + Enter as a newline)', () => {
  assert.strictEqual(X.commentText('a', 1, 'x\u0007y').text, 'In a:1 — xy');
  assert.strictEqual(X.commentText('a', 1, 'ends with \\').text, 'In a:1 — ends with');
  assert.strictEqual(X.commentText('a', 1, '\\').ok, false);
  assert.strictEqual(X.commentText('a', 1, 'x y').text, 'In a:1 — x y');
});

test('stackText: comments are joined on ONE line, in order, within the typing limit', () => {
  const a = X.commentText('a.js', 1, 'one').text;
  const b = X.commentText('b.js', 2, 'two').text;
  assert.deepStrictEqual(X.stackText([a, b]), { ok: true, text: `${a}; ${b}`, count: 2 });
  assert.deepStrictEqual(X.stackText([a]), { ok: true, text: a, count: 1 });
  assert.strictEqual(X.stackText([]).ok, false);
  assert.strictEqual(X.stackText(['x'.repeat(1990), 'y'.repeat(30)]).ok, false);
  assert.strictEqual(X.MAX_STACK_CHARS, 1990);
});

test('the composed line passes the typing gate the prompt uses (planTyping kind `comment`)', () => {
  const { planTyping } = require('../app/top-bar-display');
  const one = X.commentText('src/a b.js', 40, 'this should not throw — use the guard').text;
  const stack = X.stackText([one, X.commentText('c.js', 2, 'nit').text]).text;
  for (const text of [one, stack]) assert.strictEqual(planTyping({ command: text, screen: 'ready', connected: true, kind: 'comment' }).ok, true, text);
});

test('PROPERTY: a pairing is complete: reading its left column gives the base, its right column gives the new text', () => {
  const lines = fc.array(fc.constantFrom('a', 'b', 'c', 'd', '', 'e e'), { maxLength: 14 });
  fc.assert(fc.property(lines, lines, (x, y) => {
    const a = x.length ? x.join('\n') + '\n' : '';
    const b = y.length ? y.join('\n') + '\n' : '';
    const p = X.sideBySide(rowsOf(a, b));
    assert.deepStrictEqual(p.filter(r => r.left).map(r => r.left.text), linesOf(a));
    assert.deepStrictEqual(p.filter(r => r.right).map(r => r.right.text), linesOf(b));
    assert.deepStrictEqual(p.filter(r => r.left).map(r => r.left.no), linesOf(a).map((_, i) => i + 1));
    assert.deepStrictEqual(p.filter(r => r.right).map(r => r.right.no), linesOf(b).map((_, i) => i + 1));
    // a change row has both sides and they differ; a same row has equal sides
    for (const r of p) {
      if (r.kind === 'change') assert.ok(r.left && r.right);
      if (r.kind === 'same') assert.strictEqual(r.left.text, r.right.text);
    }
  }));
});

test('PROPERTY: folding never loses a changed row, and hunk starts point at changed rows only', () => {
  const lines = fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 40 });
  fc.assert(fc.property(lines, lines, (x, y) => {
    const p = X.sideBySide(rowsOf(x.join('\n'), y.join('\n')));
    const folded = X.fold(p);
    assert.strictEqual(folded.filter(r => r.kind !== 'same' && r.kind !== 'gap').length, p.filter(r => r.kind !== 'same').length);
    for (const i of X.hunkStarts(folded)) assert.ok(folded[i].kind !== 'same' && folded[i].kind !== 'gap');
    assert.strictEqual(folded.reduce((n, r) => n + (r.kind === 'gap' ? r.hidden : r.kind === 'same' ? 1 : 0), 0), p.filter(r => r.kind === 'same').length);
  }));
});

// ---- the DOM ----

function fakeDoc() {
  const mk = (tag) => ({
    tag, className: '', textContent: '', dataset: {}, children: [], attrs: {}, hidden: false,
    append(...kids) { this.children.push(...kids); }, setAttribute(k, v) { this.attrs[k] = String(v); },
  });
  return { createElement: mk };
}

test('buildRows: one element per row, the line numbers and text in the right columns, a comment button only where there is a new line', () => {
  const doc = fakeDoc();
  const folded = X.fold(X.sideBySide(rowsOf('a\nb\n', 'a\nB\nc\n')));
  const els = X.buildRows(doc, folded);
  assert.strictEqual(els.length, 3);
  assert.match(els[1].className, /sbs-row change/);
  const cells = els[1].children;
  assert.deepStrictEqual(cells.map(c => c.className.split(' ')[0]), ['sbs-no', 'sbs-l', 'sbs-no', 'sbs-r', 'sbs-act']);
  assert.deepStrictEqual([cells[0].textContent, cells[1].textContent, cells[2].textContent, cells[3].textContent], ['2', 'b', '2', 'B']);
  assert.strictEqual(els[1].dataset.line, '2');
  assert.strictEqual(cells[4].children[0].dataset.line, '2');
  const del = X.buildRows(doc, X.sideBySide(rowsOf('x\n', '')))[0];
  assert.strictEqual(del.children[4].children.length, 0, 'no comment button on a removed line');
  assert.strictEqual(del.dataset.line, undefined);
});

test('buildRows: a gap row says how many lines it hides; empty text keeps its height', () => {
  const doc = fakeDoc();
  const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n\n';
  const b = a.replace('l15', 'X');
  const els = X.buildRows(doc, X.fold(X.sideBySide(rowsOf(a, b))));
  assert.match(els[0].className, /sbs-row gap/);
  assert.match(els[0].textContent, /\d+ unchanged lines/);
});
