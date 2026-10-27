'use strict';
/**
 * The Changes panel's git parsers (BACKLOG #119 A3, host/changes.js). Pure: they read the NUL-separated output of
 * `git diff --name-status -z`, `git diff --numstat -z` and `git ls-files -z`, so a path with a space, a quote, a
 * newline or non-ASCII letters arrives as itself, never quoted.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const C = require('../host/changes');

const nul = (...parts) => parts.join('\0');

test('name-status: M / A / D, then a rename carrying both paths, then a copy counted as an add', () => {
  const text = nul('M', 'src/a.js', 'A', 'new file.txt', 'D', 'gone.md', 'R087', 'old/name.js', 'new/name.js', 'C100', 'src/a.js', 'src/copy.js', '');
  assert.deepStrictEqual(C.parseNameStatusZ(text), [
    { status: 'M', path: 'src/a.js' },
    { status: 'A', path: 'new file.txt' },
    { status: 'D', path: 'gone.md' },
    { status: 'R', path: 'new/name.js', oldPath: 'old/name.js' },
    { status: 'A', path: 'src/copy.js' },
  ]);
});

test('name-status: a type change reads as modified, unmerged as U, an unknown letter is skipped with its path', () => {
  assert.deepStrictEqual(C.parseNameStatusZ(nul('T', 'a', 'U', 'b', 'X', 'c', 'M', 'd', '')), [
    { status: 'M', path: 'a' }, { status: 'U', path: 'b' }, { status: 'M', path: 'd' },
  ]);
});

test('name-status: empty, non-string and truncated input give a short list, never a throw', () => {
  assert.deepStrictEqual(C.parseNameStatusZ(''), []);
  assert.deepStrictEqual(C.parseNameStatusZ(null), []);
  assert.deepStrictEqual(C.parseNameStatusZ(nul('R100', 'only-old')), []);
  assert.deepStrictEqual(C.parseNameStatusZ(nul('M')), []);
});

test('numstat: counts, a binary file as nulls (not zeros), and a rename whose path field is empty', () => {
  const text = nul('12\t3\tsrc/a.js', '-\t-\timg.png', '0\t0\t', 'old.js', 'new.js', '5\t0\ta b\tc.txt', '');
  assert.deepStrictEqual(C.parseNumstatZ(text), [
    { path: 'src/a.js', add: 12, del: 3, binary: false },
    { path: 'img.png', add: null, del: null, binary: true },
    { path: 'new.js', oldPath: 'old.js', add: 0, del: 0, binary: false },
    { path: 'a b\tc.txt', add: 5, del: 0, binary: false },
  ]);
});

test('numstat: a count that is not a number or - is refused, as is a short record', () => {
  assert.deepStrictEqual(C.parseNumstatZ(nul('x\t1\ta', '1\ta', '1\t2\tok', '')), [{ path: 'ok', add: 1, del: 2, binary: false }]);
  assert.deepStrictEqual(C.parseNumstatZ(nul('0\t0\t', 'only-old')), []);
});

test('a NUL list (ls-files -z) drops the empty tail', () => {
  assert.deepStrictEqual(C.parseNulList(nul('a', 'b c', '')), ['a', 'b c']);
  assert.deepStrictEqual(C.parseNulList(''), []);
  assert.deepStrictEqual(C.parseNulList(undefined), []);
});

test('buildChangeset: counts join by the NEW path, untracked files are adds, a missing count stays null', () => {
  const files = C.buildChangeset({
    nameStatus: [{ status: 'M', path: 'b.js' }, { status: 'R', path: 'n.js', oldPath: 'o.js' }, { status: 'D', path: 'd.js' }],
    numstat: [{ path: 'b.js', add: 4, del: 1, binary: false }, { path: 'n.js', oldPath: 'o.js', add: 0, del: 0, binary: false }],
    untracked: [{ path: 'a.js', add: 7 }, { path: 'big.bin', add: null }],
  });
  assert.deepStrictEqual(files, [
    { path: 'a.js', status: 'A', add: 7, del: 0, binary: false, untracked: true },
    { path: 'b.js', status: 'M', add: 4, del: 1, binary: false },
    { path: 'big.bin', status: 'A', add: null, del: null, binary: false, untracked: true },
    { path: 'd.js', status: 'D', add: null, del: null, binary: false },
    { path: 'n.js', oldPath: 'o.js', status: 'R', add: 0, del: 0, binary: false },
  ]);
});

test('buildChangeset: an untracked path git also lists as tracked appears once, as tracked', () => {
  const files = C.buildChangeset({ nameStatus: [{ status: 'M', path: 'x' }], numstat: [], untracked: [{ path: 'x', add: 1 }] });
  assert.deepStrictEqual(files.map(f => [f.path, f.status]), [['x', 'M']]);
});

test('capFiles: the first N, the real total, and how many were left out', () => {
  const files = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}` }));
  assert.deepStrictEqual(C.capFiles(files, 3), { files: files.slice(0, 3), total: 7, more: 4 });
  assert.deepStrictEqual(C.capFiles(files, 7), { files, total: 7, more: 0 });
  assert.strictEqual(C.MAX_FILES, 500);
});

test('summarize: files, additions, deletions; a null count adds nothing and is counted as unknown', () => {
  const s = C.summarize([
    { add: 3, del: 1 }, { add: null, del: null, binary: true }, { add: 2, del: 0 }, { add: null, del: null },
  ]);
  assert.deepStrictEqual(s, { files: 4, add: 5, del: 1, unknown: 2 });
  assert.deepStrictEqual(C.summarize([]), { files: 0, add: 0, del: 0, unknown: 0 });
});

test('summaryLine: 12 files · +340 −58, singular, and a plus sign on unknowns', () => {
  assert.strictEqual(C.summaryLine({ files: 12, add: 340, del: 58, unknown: 0 }), '12 files · +340 −58');
  assert.strictEqual(C.summaryLine({ files: 1, add: 1, del: 0, unknown: 0 }), '1 file · +1 −0');
  assert.strictEqual(C.summaryLine({ files: 2, add: 1, del: 0, unknown: 1 }), '2 files · +1 −0 (+ binary or unread)');
  assert.strictEqual(C.summaryLine({ files: 0, add: 0, del: 0, unknown: 0 }), 'no changes');
});

test('countLines: lines of a text, none for empty, binary (a NUL) is null', () => {
  assert.strictEqual(C.countLines('a\nb\nc\n'), 3);
  assert.strictEqual(C.countLines('a\nb'), 2);
  assert.strictEqual(C.countLines(''), 0);
  assert.strictEqual(C.countLines('a\0b'), null);
});

test('resolveScope: auto is the working tree when dirty, else the branch; an explicit choice stands', () => {
  assert.strictEqual(C.resolveScope('auto', true), 'working');
  assert.strictEqual(C.resolveScope('auto', false), 'branch');
  assert.strictEqual(C.resolveScope('working', false), 'working');
  assert.strictEqual(C.resolveScope('branch', true), 'branch');
  assert.strictEqual(C.resolveScope('nonsense', true), 'working');
  assert.strictEqual(C.resolveScope(undefined, false), 'branch');
});

// ---- properties ----

const segment = fc.string({ minLength: 1, maxLength: 8, unit: 'binary' }).filter(s => !/[\0]/.test(s));
const pathArb = fc.array(segment, { minLength: 1, maxLength: 3 }).map(p => p.join('/'));

test('PROPERTY: name-status written by the git format reads back to the same entries', () => {
  fc.assert(fc.property(
    fc.array(fc.oneof(
      fc.record({ status: fc.constantFrom('M', 'A', 'D', 'U'), path: pathArb }),
      fc.record({ status: fc.constant('R'), path: pathArb, oldPath: pathArb }),
    ), { maxLength: 12 }),
    (entries) => {
      const text = entries.map(e => (e.status === 'R' ? nul('R090', e.oldPath, e.path) : nul(e.status, e.path))).join('\0') + (entries.length ? '\0' : '');
      assert.deepStrictEqual(C.parseNameStatusZ(text), entries.map(e => ({ ...e })));
    },
  ));
});

test('PROPERTY: numstat written by the git format reads back to the same entries', () => {
  const count = fc.oneof(fc.nat(100000), fc.constant(null));
  fc.assert(fc.property(
    fc.array(fc.record({ path: pathArb, add: count, del: count, rename: fc.boolean(), oldPath: pathArb }), { maxLength: 12 }),
    (rows) => {
      const entries = rows.map(r => {
        const binary = r.add === null || r.del === null;
        const e = { path: r.path, add: binary ? null : r.add, del: binary ? null : r.del, binary };
        if (r.rename && r.oldPath !== r.path) e.oldPath = r.oldPath;
        return e;
      });
      const num = (n) => (n === null ? '-' : String(n));
      const text = entries.map(e => (e.oldPath ? nul(`${num(e.add)}\t${num(e.del)}\t`, e.oldPath, e.path) : `${num(e.add)}\t${num(e.del)}\t${e.path}`)).join('\0') + (entries.length ? '\0' : '');
      assert.deepStrictEqual(C.parseNumstatZ(text).map(e => ({ path: e.path, ...(e.oldPath ? { oldPath: e.oldPath } : {}), add: e.add, del: e.del, binary: e.binary })),
        entries.map(e => ({ path: e.path, ...(e.oldPath ? { oldPath: e.oldPath } : {}), add: e.add, del: e.del, binary: e.binary })));
    },
  ));
});

test('PROPERTY: no input makes a parser throw, and the summary never counts more files than it was given', () => {
  fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (s) => {
    const a = C.parseNameStatusZ(s);
    const b = C.parseNumstatZ(s);
    C.parseNulList(s);
    assert.ok(Array.isArray(a) && Array.isArray(b));
    assert.strictEqual(C.summarize(b).files, b.length);
  }));
});

test('decodeBase: BOM dropped, CRLF folded, UTF-16 is `encoding`, a NUL is `binary`, a non-buffer is refused', () => {
  assert.deepStrictEqual(C.decodeBase(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62])), { ok: true, text: 'a\nb' });
  assert.deepStrictEqual(C.decodeBase(Buffer.from('plain\r\n')), { ok: true, text: 'plain\n' });
  assert.deepStrictEqual(C.decodeBase(Buffer.from([0xff, 0xfe, 0x61, 0x00])), { ok: false, why: 'encoding' });
  assert.deepStrictEqual(C.decodeBase(Buffer.from([0xfe, 0xff, 0x00, 0x61])), { ok: false, why: 'encoding' });
  assert.deepStrictEqual(C.decodeBase(Buffer.from([0x61, 0x00, 0x62])), { ok: false, why: 'binary' });
  assert.deepStrictEqual(C.decodeBase(Buffer.alloc(0)), { ok: true, text: '' });
  assert.strictEqual(C.decodeBase('text').ok, false);
  assert.strictEqual(C.MAX_COUNT_BYTES, 256 * 1024);
});

test('PROPERTY: decodeBase of valid UTF-8 text never keeps a CR+LF pair or a leading BOM', () => {
  fc.assert(fc.property(fc.string({ maxLength: 60 }).filter(s => !s.includes('\0')), (s) => {
    const r = C.decodeBase(Buffer.from(String.fromCharCode(0xfeff) + s.replace(/\n/g, '\r\n')));
    assert.strictEqual(r.ok, true);
    assert.ok(!r.text.includes('\r\n') && r.text.charCodeAt(0) !== 0xfeff || s.startsWith(String.fromCharCode(0xfeff)));
  }));
});
