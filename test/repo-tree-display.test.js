'use strict';
/** The Files tab's tree (#45): the rows drawn from the listing, the overlay and the filter. */
const test = require('node:test');
const assert = require('node:assert');
const { rows, indexOverlay, overlayNote, ROW_CAP } = require('../app/repo-tree-display');

const file = (name, path) => ({ name, path, kind: 'file' });
const dir = (name, path) => ({ name, path, kind: 'dir' });
const kids = (obj) => new Map(Object.entries(obj));
const overlay = (files = [], dirs = []) => ({ files, dirs });

test('the root lists its entries at depth 0, folders closed', () => {
  const r = rows({ children: kids({ '': [dir('src', 'src'), file('a.js', 'a.js')] }), expanded: new Set(), overlay: overlay() });
  assert.deepStrictEqual(r.map(x => [x.kind, x.path, x.depth, x.expanded]), [['dir', 'src', 0, false], ['file', 'a.js', 0, undefined]]);
});

test('an expanded folder shows its children one deeper', () => {
  const r = rows({
    children: kids({ '': [dir('src', 'src')], src: [file('b.js', 'src/b.js')] }),
    expanded: new Set(['src']), overlay: overlay(),
  });
  assert.deepStrictEqual(r.map(x => [x.path, x.depth, x.expanded]), [['src', 0, true], ['src/b.js', 1, undefined]]);
});

test('an expanded folder whose listing has not arrived shows a loading row, not nothing', () => {
  const r = rows({ children: kids({ '': [dir('src', 'src')] }), expanded: new Set(['src']), overlay: overlay() });
  assert.deepStrictEqual(r.map(x => [x.kind, x.depth]), [['dir', 0], ['loading', 1]]);
});

test('a folder that is collapsed hides its children even if they are loaded', () => {
  const r = rows({ children: kids({ '': [dir('src', 'src')], src: [file('b.js', 'src/b.js')] }), expanded: new Set(), overlay: overlay() });
  assert.strictEqual(r.length, 1);
});

test('before the root has arrived there are no rows (the caller says "reading")', () => {
  assert.deepStrictEqual(rows({ children: new Map(), expanded: new Set(), overlay: overlay() }), []);
});

test('an edited file wears ●N and the edited state; a read file the read state and no badge; an untouched one neither', () => {
  const r = rows({
    children: kids({ '': [file('e.js', 'e.js'), file('r.js', 'r.js'), file('n.js', 'n.js')] }),
    expanded: new Set(),
    overlay: overlay([{ path: 'e.js', tier: 'edited', edits: 3 }, { path: 'r.js', tier: 'read', edits: 0 }]),
  });
  assert.deepStrictEqual(r.map(x => [x.state, x.badge]), [['edited', '●3'], ['read', ''], ['none', '']]);
});

test('a folder rolls up: the sum of edits as its badge, edited state if any file was edited, else read', () => {
  const ov = overlay(
    [{ path: 'a/x.js', tier: 'edited', edits: 2 }, { path: 'a/y.js', tier: 'edited', edits: 1 }, { path: 'b/z.js', tier: 'read', edits: 0 }],
    [{ path: '', edits: 3, edited: 2, read: 1 }, { path: 'a', edits: 3, edited: 2, read: 0 }, { path: 'b', edits: 0, edited: 0, read: 1 }]);
  const r = rows({ children: kids({ '': [dir('a', 'a'), dir('b', 'b'), dir('c', 'c')] }), expanded: new Set(), overlay: ov });
  assert.deepStrictEqual(r.map(x => [x.path, x.state, x.badge]), [['a', 'edited', '●3'], ['b', 'read', ''], ['c', 'none', '']]);
});

test('titles say it in words: how many edits, in how many files', () => {
  const ov = overlay([{ path: 'a/x.js', tier: 'edited', edits: 1 }], [{ path: 'a', edits: 1, edited: 1, read: 0 }]);
  const r = rows({ children: kids({ '': [dir('a', 'a')], a: [file('x.js', 'a/x.js')] }), expanded: new Set(['a']), overlay: ov });
  assert.match(r[0].title, /1 edit in 1 file/);
  assert.match(r[1].title, /edited 1 time by Claude/);
});

test('only what Claude touched: just those files, under their folders, all open', () => {
  const ov = overlay([{ path: 'src/deep/a.js', tier: 'edited', edits: 2 }, { path: 'docs/r.md', tier: 'read', edits: 0 }, { path: 'top.js', tier: 'read', edits: 0 }]);
  const r = rows({ children: kids({ '': [dir('src', 'src'), file('other.js', 'other.js')] }), expanded: new Set(), overlay: ov, onlyTouched: true });
  assert.deepStrictEqual(r.map(x => `${x.depth}:${x.path}`), ['0:docs', '1:docs/r.md', '0:src', '1:src/deep', '2:src/deep/a.js', '0:top.js']);
  assert.ok(!r.some(x => x.path === 'other.js'));
});

test('only what Claude touched with nothing touched is no rows', () => {
  assert.deepStrictEqual(rows({ children: kids({ '': [file('a.js', 'a.js')] }), expanded: new Set(), overlay: overlay(), onlyTouched: true }), []);
});

test('a file or folder named like an Object.prototype member is just a name', () => {
  const ov = overlay([{ path: '__proto__/constructor.js', tier: 'edited', edits: 1 }], [{ path: '', edits: 1, edited: 1, read: 0 }, { path: '__proto__', edits: 1, edited: 1, read: 0 }]);
  const r = rows({ children: kids({ '': [dir('__proto__', '__proto__'), file('toString', 'toString')] }), expanded: new Set(), overlay: ov });
  assert.deepStrictEqual(r.map(x => [x.path, x.state]), [['__proto__', 'edited'], ['toString', 'none']]);
});

test('a huge folder is cut at ROW_CAP with a "more" row that counts what is hidden', () => {
  const many = Array.from({ length: ROW_CAP + 25 }, (_, i) => file(`f${i}.js`, `f${i}.js`));
  const r = rows({ children: kids({ '': many }), expanded: new Set(), overlay: overlay() });
  assert.strictEqual(r.length, ROW_CAP + 1);
  assert.deepStrictEqual({ kind: r[ROW_CAP].kind, count: r[ROW_CAP].count }, { kind: 'more', count: 25 });
});

test('indexOverlay builds Maps, so any path is a safe key', () => {
  const ix = indexOverlay(overlay([{ path: '__proto__', tier: 'read', edits: 0 }], [{ path: '', edits: 0, edited: 0, read: 1 }]));
  assert.ok(ix.files instanceof Map && ix.dirs instanceof Map);
  assert.strictEqual(ix.files.get('__proto__').tier, 'read');
  assert.deepStrictEqual(indexOverlay(null), { files: new Map(), dirs: new Map() });
});

// ---- the one-line note above the tree ----

test('the note counts edited and read files from the root row', () => {
  const n = overlayNote(overlay([], [{ path: '', edits: 9, edited: 4, read: 11 }]), { transcriptsFound: 2, transcriptErrors: 0, transcriptsMissing: false });
  assert.deepStrictEqual(n, { text: '4 edited · 11 read by Claude', warn: false });
});

test('no transcripts at all is said, not shown as "nothing touched"', () => {
  const n = overlayNote(overlay(), { transcriptsFound: 0, transcriptErrors: 0, transcriptsMissing: true });
  assert.strictEqual(n.warn, true);
  assert.match(n.text, /no transcripts/);
});

test('unreadable transcripts are counted in the note, because their files may be missing from the overlay', () => {
  const n = overlayNote(overlay([], [{ path: '', edits: 1, edited: 1, read: 0 }]), { transcriptsFound: 3, transcriptErrors: 2, transcriptsMissing: false });
  assert.strictEqual(n.warn, true);
  assert.match(n.text, /2 transcripts? unreadable/);
});

test('transcripts found and nothing touched is plain "nothing touched yet", not a warning', () => {
  const n = overlayNote(overlay(), { transcriptsFound: 4, transcriptErrors: 0, transcriptsMissing: false });
  assert.deepStrictEqual(n, { text: 'Claude hasn\'t touched any file here yet', warn: false });
});

test('no overlay yet (null) or no status is "reading", never a confident zero', () => {
  assert.deepStrictEqual(overlayNote(null, null), { text: 'reading what Claude touched…', warn: false });
  const n = overlayNote(overlay(), undefined);
  assert.notStrictEqual(n.text, 'Claude hasn\'t touched any file here yet');
});

test('a failed overlay says so in the error\'s words', () => {
  const n = overlayNote({ ok: false, error: 'the overlay could not be read: boom' }, null);
  assert.deepStrictEqual(n, { text: 'the overlay could not be read: boom', warn: true });
});

// ---- PR #95 Dexter D13 ----

test('D13: a nested repository row is a folder that says what it is, and its listing is empty', () => {
  const r = rows({
    children: kids({ '': [{ name: 'vendor-x', path: 'vendor-x', kind: 'dir', nested: true }, file('a.js', 'a.js')], 'vendor-x': [] }),
    expanded: new Set(), overlay: overlay(),
  });
  assert.strictEqual(r[0].kind, 'dir');
  assert.strictEqual(r[0].nested, true);
  assert.match(r[0].title, /nested git repository/);
  assert.strictEqual(r[1].nested, undefined);
});

// ---- PR #95 Miguel M6 ----

test('M6: a folder the host cut short ends with a "more" row that counts what was left out, at the folder\'s depth', () => {
  const r = rows({
    children: kids({ '': [dir('src', 'src')], src: [file('a.js', 'src/a.js')] }),
    expanded: new Set(['src']), overlay: overlay(), omitted: new Map([['src', 41], ['', 0]]),
  });
  assert.deepStrictEqual(r.map(x => [x.kind, x.depth, x.count]), [['dir', 0, undefined], ['file', 1, undefined], ['more', 1, 41]]);
});

test('M6: the root can be cut short too, and zero or absent counts add no row', () => {
  const r = rows({ children: kids({ '': [file('a.js', 'a.js')] }), expanded: new Set(), overlay: overlay(), omitted: new Map([['', 5]]) });
  assert.deepStrictEqual(r.map(x => [x.kind, x.count]), [['file', undefined], ['more', 5]]);
  assert.strictEqual(rows({ children: kids({ '': [file('a.js', 'a.js')] }), expanded: new Set(), overlay: overlay(), omitted: new Map([['', 0]]) }).length, 1);
  assert.strictEqual(rows({ children: kids({ '': [file('a.js', 'a.js')] }), expanded: new Set(), overlay: overlay() }).length, 1);
});
