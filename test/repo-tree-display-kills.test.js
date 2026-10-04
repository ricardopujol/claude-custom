'use strict';
/**
 * The Files tab's tree at its edges (backlog #60, Mortimer's release-#101 part 2): the sort of "only what
 * Claude touched" (equal-ignoring-case names, folders before files, from every input order), badge and title
 * pluralisation, the placeholder rows, the row cap at its exact edge, and the note above the tree. Titles are
 * matched on the part that carries the count and its plural, not on the whole sentence.
 */
const test = require('node:test');
const assert = require('node:assert');

const { rows, indexOverlay, overlayNote, ROW_CAP } = require('../app/repo-tree-display');

const DOT = '●';
const file = (name, path) => ({ name, path, kind: 'file' });
const dir = (name, path) => ({ name, path, kind: 'dir' });
const kids = (obj) => new Map(Object.entries(obj));
const ov = (files = [], dirs = []) => ({ files, dirs });
const listed = (children, overlay = ov(), extra = {}) => rows({ children: kids(children), expanded: new Set(), overlay, ...extra });
const touched = (files, dirs = []) => rows({ onlyTouched: true, overlay: ov(files, dirs) });
const permutations = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));

// ---- the order of "only what Claude touched" ----

test('touched files sort ignoring case, ties broken by case (capital first), from every input order', () => {
  const want = ['A', 'a', 'B', 'b'];
  for (const order of permutations(['a', 'A', 'b', 'B'])) {
    const r = touched(order.map((p) => ({ path: p, tier: 'read' })));
    assert.deepStrictEqual(r.map((x) => x.name), want, order.join(','));
  }
});

test('touched folders sort the same way and come before every file, from every input order', () => {
  const names = ['zdir/x', 'Adir/x', 'adir/x', 'bdir/x', 'a.txt', 'B.txt'];
  const expected = ['Adir', 'Adir/x', 'adir', 'adir/x', 'bdir', 'bdir/x', 'zdir', 'zdir/x', 'a.txt', 'B.txt'];
  for (const order of permutations(names)) {
    const r = touched(order.map((p) => ({ path: p, tier: 'read' })));
    assert.deepStrictEqual(r.map((x) => x.path), expected, order.join(','));
  }
});

test('touched rows: every folder above a file is listed once, open, one level deeper than its parent; files are not open', () => {
  const r = touched([{ path: 'a/b/c.js', tier: 'edited', edits: 2 }, { path: 'a/d.js', tier: 'read' }, { path: 'top.js', tier: 'read' }]);
  assert.deepStrictEqual(r.map((x) => [x.kind, x.path, x.name, x.depth, x.expanded]), [
    ['dir', 'a', 'a', 0, true],
    ['dir', 'a/b', 'b', 1, true],
    ['file', 'a/b/c.js', 'c.js', 2, undefined],
    ['file', 'a/d.js', 'd.js', 1, undefined],
    ['file', 'top.js', 'top.js', 0, undefined],
  ]);
});

test('touched rows ignore empty path segments: a doubled or leading slash adds no folder', () => {
  const r = touched([{ path: 'lib//x.js', tier: 'read' }, { path: '/y.js', tier: 'read' }]);
  assert.deepStrictEqual(r.map((x) => [x.kind, x.path, x.name, x.depth]), [
    ['dir', 'lib', 'lib', 0],
    ['file', 'lib/x.js', 'x.js', 1],
    ['file', 'y.js', 'y.js', 0],
  ]);
});

test('touched rows carry the look of their file and their folder', () => {
  const r = touched([{ path: 'd/e.js', tier: 'edited', edits: 3 }], [{ path: 'd', edits: 3, edited: 1, read: 0 }]);
  assert.strictEqual(r[0].state, 'edited');
  assert.strictEqual(r[0].badge, `${DOT}3`);
  assert.strictEqual(r[1].state, 'edited');
  assert.strictEqual(r[1].badge, `${DOT}3`);
});

test('with nothing touched there are no rows', () => {
  assert.deepStrictEqual(touched([]), []);
});

// ---- file looks ----

const fileRow = (entry) => listed({ '': [file('a.js', 'a.js')] }, ov(entry === undefined ? [] : [{ path: 'a.js', ...entry }]))[0];

test('an untouched file has the none look: no badge, no title', () => {
  assert.deepStrictEqual(fileRow(undefined), { kind: 'file', path: 'a.js', name: 'a.js', depth: 0, state: 'none', badge: '', title: '' });
  assert.deepStrictEqual(fileRow({ tier: 'mystery' }), { kind: 'file', path: 'a.js', name: 'a.js', depth: 0, state: 'none', badge: '', title: '' });
  assert.deepStrictEqual(fileRow({}), { kind: 'file', path: 'a.js', name: 'a.js', depth: 0, state: 'none', badge: '', title: '' });
});

test('an edited file wears the dot and its edit count; the title says "time" for one and "times" for the rest', () => {
  const one = fileRow({ tier: 'edited', edits: 1 });
  assert.strictEqual(one.state, 'edited');
  assert.strictEqual(one.badge, `${DOT}1`);
  assert.match(one.title, /edited 1 time\b(?!s)/);
  const two = fileRow({ tier: 'edited', edits: 2 });
  assert.strictEqual(two.badge, `${DOT}2`);
  assert.match(two.title, /edited 2 times\b/);
  const many = fileRow({ tier: 'edited', edits: 12 });
  assert.strictEqual(many.badge, `${DOT}12`);
  assert.match(many.title, /12 times/);
});

test('an edited file with no usable edit count wears the bare dot, never "0", "NaN" or "undefined"', () => {
  for (const edits of [0, undefined, null, NaN, Infinity, -Infinity, '3', {}]) {
    const r = fileRow({ tier: 'edited', edits });
    assert.strictEqual(r.state, 'edited', String(edits));
    assert.strictEqual(r.badge, DOT, `badge for ${String(edits)}`);
    assert.ok(!/NaN|undefined|Infinity/.test(r.title), r.title);
    assert.match(r.title, /edited 0 times\b/);
  }
});

test('a read file has the read state, no badge, and a title that says so', () => {
  const r = fileRow({ tier: 'read', edits: 5 });
  assert.strictEqual(r.state, 'read');
  assert.strictEqual(r.badge, '');
  assert.match(r.title, /read by Claude/);
});

// ---- folder looks ----

const dirRow = (entry) => listed({ '': [dir('d', 'd')] }, ov([], entry === undefined ? [] : [{ path: 'd', ...entry }]))[0];

test('a folder with edited files wears the dot and the edit total, and its title counts edits and files with plurals', () => {
  const r = dirRow({ edits: 1, edited: 1, read: 0 });
  assert.strictEqual(r.state, 'edited');
  assert.strictEqual(r.badge, `${DOT}1`);
  assert.match(r.title, /\b1 edit\b(?!s)/);
  assert.match(r.title, /in 1 file\b(?!s)/);
  assert.doesNotMatch(r.title, /read/, 'no read files, no read clause');
  const more = dirRow({ edits: 3, edited: 2, read: 1 });
  assert.strictEqual(more.badge, `${DOT}3`);
  assert.match(more.title, /\b3 edits\b/);
  assert.match(more.title, /in 2 files\b/);
  assert.match(more.title, /1 more file read\b/);
  const many = dirRow({ edits: 3, edited: 1, read: 4 });
  assert.match(many.title, /4 more files read\b/);
});

test('a folder with only read files has the read state, no badge, and counts them with a plural', () => {
  const one = dirRow({ edits: 0, edited: 0, read: 1 });
  assert.strictEqual(one.state, 'read');
  assert.strictEqual(one.badge, '');
  assert.match(one.title, /\b1 file\b(?!s)/);
  assert.match(one.title, /read by Claude/);
  assert.match(dirRow({ edits: 0, edited: 0, read: 3 }).title, /\b3 files\b/);
});

test('a folder nothing touched has the none look, whether it is absent from the overlay or all zeros', () => {
  for (const entry of [undefined, { edits: 0, edited: 0, read: 0 }, {}, { edited: -1, read: -1 }]) {
    const r = dirRow(entry);
    assert.deepStrictEqual([r.state, r.badge, r.title], ['none', '', ''], JSON.stringify(entry));
  }
});

test('folder counts that are not finite numbers count as zero', () => {
  for (const bad of ['2', NaN, Infinity, null, undefined, {}]) {
    const r = dirRow({ edits: 4, edited: bad, read: bad });
    assert.strictEqual(r.state, 'none', String(bad));
  }
  const r = dirRow({ edits: 'x', edited: 1, read: 0 });
  assert.strictEqual(r.badge, `${DOT}0`, 'an edited folder with no usable total says 0 edits');
});

test('a nested repository folder keeps its look but its title is the nested explanation', () => {
  const r = listed({ '': [{ name: 'n', path: 'n', kind: 'dir', nested: true }] }, ov([], [{ path: 'n', edits: 1, edited: 1, read: 0 }]))[0];
  assert.strictEqual(r.nested, true);
  assert.match(r.title, /nested git repository/);
  assert.strictEqual(r.state, 'edited');
  const plain = listed({ '': [{ name: 'n', path: 'n', kind: 'dir', nested: false }] })[0];
  assert.strictEqual('nested' in plain, false);
});

// ---- placeholder rows ----

test('an open folder with no listing yet shows one loading row at the next depth, exactly', () => {
  const r = rows({ children: kids({ '': [dir('src', 'src')] }), expanded: new Set(['src']), overlay: ov() });
  assert.deepStrictEqual(r[1], { kind: 'loading', path: 'src', name: '', depth: 1, state: 'none', badge: '', title: '' });
  assert.strictEqual(r.length, 2);
});

test('the root with no listing yet has no loading row', () => {
  assert.deepStrictEqual(rows({ children: new Map(), expanded: new Set(['']), overlay: ov() }), []);
});

test('a folder the host cut short ends with a "more" row carrying the count, at that folder\'s depth', () => {
  const r = rows({
    children: kids({ '': [dir('src', 'src'), file('a', 'a')], src: [file('b', 'src/b')] }),
    expanded: new Set(['src']), overlay: ov(), omitted: new Map([['', 7], ['src', 3]]),
  });
  assert.deepStrictEqual(r.map((x) => [x.kind, x.depth, x.count]), [
    ['dir', 0, undefined], ['file', 1, undefined], ['more', 1, 3], ['file', 0, undefined], ['more', 0, 7],
  ]);
  assert.deepStrictEqual(r[2], { kind: 'more', path: '', name: '', depth: 1, state: 'none', badge: '', title: '', count: 3 });
});

test('a "more" row appears only for a positive number: zero, negative, text and NaN add none', () => {
  for (const left of [0, -1, '5', NaN, null, undefined, true]) {
    const r = rows({ children: kids({ '': [file('a', 'a')] }), expanded: new Set(), overlay: ov(), omitted: new Map([['', left]]) });
    assert.strictEqual(r.length, 1, String(left));
  }
});

test('an omitted that is not a Map, a children that is not a Map and an expanded that is not a Set are ignored', () => {
  assert.deepStrictEqual(rows({ children: { '': [file('a', 'a')] }, expanded: new Set(), overlay: ov() }), []);
  const r = rows({ children: kids({ '': [dir('s', 's')], s: [file('b', 's/b')] }), expanded: ['s'], overlay: ov(), omitted: { '': 4 } });
  assert.deepStrictEqual(r.map((x) => x.kind), ['dir']);
  assert.deepStrictEqual(rows(), []);
});

// ---- the row cap ----

const many = (n) => ({ '': Array.from({ length: n }, (_, i) => file(`f${i}`, `f${i}`)) });

test('exactly ROW_CAP rows come back whole; one more is cut to ROW_CAP plus a "more" row with the remainder', () => {
  assert.strictEqual(listed(many(ROW_CAP)).length, ROW_CAP);
  assert.ok(listed(many(ROW_CAP)).every((x) => x.kind === 'file'));
  const over = listed(many(ROW_CAP + 1));
  assert.strictEqual(over.length, ROW_CAP + 1);
  assert.deepStrictEqual(over[ROW_CAP], { kind: 'more', path: '', name: '', depth: 0, state: 'none', badge: '', title: '', count: 1 });
  assert.strictEqual(over[ROW_CAP - 1].path, `f${ROW_CAP - 1}`);
  assert.strictEqual(listed(many(ROW_CAP + 37))[ROW_CAP].count, 37);
});

// ---- indexOverlay ----

test('indexOverlay keeps only entries with a string path, and survives null, numbers and strings among them', () => {
  const ix = indexOverlay({ files: [null, undefined, 'x', 5, { path: 5 }, { path: null }, {}, { path: 'a' }, { path: '__proto__' }], dirs: [null, 0, { path: 7 }, { path: '' }, { path: 'd' }] });
  assert.deepStrictEqual([...ix.files.keys()], ['a', '__proto__']);
  assert.deepStrictEqual([...ix.dirs.keys()], ['', 'd']);
});

test('indexOverlay of nothing, or of lists that are not arrays, is empty', () => {
  for (const o of [null, undefined, 5, 'x', {}, { files: 'abc', dirs: 'abc' }, { files: { 0: { path: 'a' }, length: 1 }, dirs: { 0: { path: 'a' }, length: 1 } }]) {
    const ix = indexOverlay(o);
    assert.deepStrictEqual([ix.files.size, ix.dirs.size], [0, 0], JSON.stringify(o));
  }
});

// ---- the note above the tree ----

test('overlayNote: no overlay yet is "reading", not a count', () => {
  for (const o of [null, undefined]) {
    const n = overlayNote(o, { transcriptsMissing: false });
    assert.strictEqual(n.warn, false);
    assert.match(n.text, /reading/);
  }
});

test('overlayNote: a failed overlay shows its error as text, or a reason when it has none, and warns', () => {
  assert.deepStrictEqual(overlayNote({ ok: false, error: 'git went away' }, {}), { text: 'git went away', warn: true });
  assert.strictEqual(overlayNote({ ok: false, error: 404 }, {}).text, '404');
  for (const error of [undefined, '', null, 0]) {
    const n = overlayNote({ ok: false, error }, {});
    assert.strictEqual(n.warn, true);
    assert.match(n.text, /could not be read/);
  }
});

test('overlayNote: with no status it says it is not known yet and does not warn, for anything that is not an object', () => {
  for (const status of [null, undefined, 5, 'x', true, 0, '']) {
    const n = overlayNote(ov(), status);
    assert.deepStrictEqual(n, { text: "what Claude touched isn't known yet", warn: false }, String(status));
  }
});

test('overlayNote: missing transcripts say so, warn, and still mention unreadable ones', () => {
  const n = overlayNote(ov(), { transcriptsMissing: true, transcriptErrors: 0 });
  assert.strictEqual(n.warn, true);
  assert.match(n.text, /no transcripts/);
  assert.doesNotMatch(n.text, /unreadable/);
  const e = overlayNote(ov(), { transcriptsMissing: true, transcriptErrors: 2 });
  assert.match(e.text, /no transcripts/);
  assert.match(e.text, /2 transcripts unreadable/);
  assert.strictEqual(overlayNote(ov(), { transcriptsMissing: 'yes' }).warn, false, 'only true counts');
});

test('overlayNote: unreadable transcripts are counted with a plural and make the note warn; none, or a bad count, do not', () => {
  const one = overlayNote(ov([], [{ path: '', edited: 1, read: 0, edits: 1 }]), { transcriptErrors: 1 });
  assert.strictEqual(one.warn, true);
  assert.match(one.text, /1 transcript unreadable/);
  assert.doesNotMatch(one.text, /1 transcripts/);
  const three = overlayNote(ov(), { transcriptErrors: 3 });
  assert.match(three.text, /3 transcripts unreadable/);
  for (const transcriptErrors of [0, undefined, NaN, '2', null, -1, Infinity]) {
    const n = overlayNote(ov(), { transcriptErrors });
    assert.strictEqual(n.warn, false, String(transcriptErrors));
    assert.doesNotMatch(n.text, /unreadable/, String(transcriptErrors));
  }
});

test('overlayNote: the root folder\'s counts are what the note reports, whenever either is above zero', () => {
  const note = (top) => overlayNote(ov([], top ? [{ path: '', ...top }] : []), { transcriptErrors: 0 }).text;
  assert.match(note({ edited: 2, read: 3 }), /2 edited · 3 read by Claude/);
  assert.match(note({ edited: 0, read: 3 }), /0 edited · 3 read by Claude/);
  assert.match(note({ edited: 2, read: 0 }), /2 edited · 0 read by Claude/);
  for (const top of [undefined, { edited: 0, read: 0 }, { edited: -1, read: -1 }, {}]) {
    assert.match(note(top), /hasn't touched any file/, JSON.stringify(top));
  }
});

test('overlayNote: counts and the unreadable suffix join into one text, and only the suffix makes it warn', () => {
  const n = overlayNote(ov([], [{ path: '', edited: 1, read: 1, edits: 1 }]), { transcriptErrors: 2 });
  assert.match(n.text, /^1 edited · 1 read by Claude · 2 transcripts unreadable/);
  assert.strictEqual(n.warn, true);
  assert.strictEqual(overlayNote(ov([], [{ path: '', edited: 1, read: 1, edits: 1 }]), {}).warn, false);
});
