'use strict';
/**
 * The repo browser's path guard (#45): what may be read, dragged out or revealed.
 * One rule: the path, after `..`, symlinks and junctions, is inside THIS tab's worktree.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { lexical, guardPath, MAX_INPUT } = require('../host/repo-guard');

const ROOT = 'C:\\proj\\feat-x';
const ok = (r) => r && r.ok === true;

test('a relative path with forward slashes resolves inside the root', () => {
  const r = lexical(ROOT, 'src/a.js');
  assert.deepStrictEqual(r, { ok: true, abs: 'C:\\proj\\feat-x\\src\\a.js', rel: 'src/a.js' });
});

test('mixed slashes and a ./ prefix normalise to the same file', () => {
  assert.strictEqual(lexical(ROOT, '.\\src/./a.js').rel, 'src/a.js');
});

test('an absolute path inside the root is accepted, and case does not matter on Windows', () => {
  const r = lexical(ROOT, 'c:\\PROJ\\Feat-X\\src\\a.js');
  assert.ok(ok(r));
  assert.strictEqual(r.rel, 'src/a.js');
});

test('.. that stays inside is fine; .. that leaves is refused', () => {
  assert.strictEqual(lexical(ROOT, 'src/../lib/b.js').rel, 'lib/b.js');
  assert.strictEqual(lexical(ROOT, '../feat-y/a.js').ok, false);
  assert.strictEqual(lexical(ROOT, '..').ok, false);
  assert.strictEqual(lexical(ROOT, 'src/../../x').ok, false);
});

test('a sibling that merely starts with the root name is outside', () => {
  assert.strictEqual(lexical(ROOT, 'C:\\proj\\feat-x-other\\a.js').ok, false);
  assert.strictEqual(lexical(ROOT, '..\\feat-x-other\\a.js').ok, false);
});

test('another drive, UNC, device and rooted paths are refused', () => {
  for (const p of ['D:\\proj\\feat-x\\a.js', '\\\\server\\share\\a.js', '\\\\?\\C:\\proj\\feat-x\\a.js',
    '\\\\.\\pipe\\x', '\\proj\\feat-x\\a.js', '/proj/feat-x/a.js', 'C:a.js']) {
    assert.strictEqual(lexical(ROOT, p).ok, false, p);
  }
});

test('alternate data streams, NUL, trailing dot or space, and an empty or huge input are refused', () => {
  for (const p of ['a.js:stream', 'a\u0000.js', 'a.js.', 'a.js ', 'dir./a.js', '', 'x'.repeat(MAX_INPUT + 1)]) {
    assert.strictEqual(lexical(ROOT, p).ok, false, JSON.stringify(p.slice(0, 20)));
  }
});

test('anything that is not a string is refused, and a root that is not a drive path refuses everything', () => {
  for (const p of [null, undefined, 5, {}, ['a']]) assert.strictEqual(lexical(ROOT, p).ok, false);
  assert.strictEqual(lexical('relative/root', 'a.js').ok, false);
  assert.strictEqual(lexical(undefined, 'a.js').ok, false);
});

test('the root itself is inside, with an empty rel', () => {
  const r = lexical(ROOT, ROOT);
  assert.deepStrictEqual(r, { ok: true, abs: ROOT, rel: '' });
});

test('every refusal says why', () => {
  assert.ok(lexical(ROOT, '../x').why.length > 0);
  assert.ok(lexical(ROOT, 5).why.length > 0);
});

// ---- the realpath half, on a real disk (a junction needs no admin rights on Windows) ----

function fixture() {
  const base = tmpDir('cc-guard-');
  const root = path.join(base, 'wt');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  return { base, root, outside };
}

test('a real file inside resolves and answers its real path', async () => {
  const { root } = fixture();
  const r = await guardPath(root, 'src/a.js');
  assert.ok(ok(r), JSON.stringify(r));
  assert.strictEqual(r.rel, 'src/a.js');
  assert.strictEqual(r.abs.toLowerCase(), path.join(root, 'src', 'a.js').toLowerCase());
});

test('a junction inside the worktree that points OUT is refused', async () => {
  const { root, outside } = fixture();
  fs.symlinkSync(outside, path.join(root, 'jn'), 'junction');
  const r = await guardPath(root, 'jn/secret.txt');
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /outside/);
});

test('a junction that points to another place INSIDE the worktree is fine', async () => {
  const { root } = fixture();
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'also-src'), 'junction');
  const r = await guardPath(root, 'also-src/a.js');
  assert.ok(ok(r), JSON.stringify(r));
});

test('a file that is gone is "gone", not a crash and not an allow', async () => {
  const { root } = fixture();
  const r = await guardPath(root, 'src/missing.js');
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /gone/);
});

test('a path outside is refused before the disk is asked at all', async () => {
  let asked = 0;
  const r = await guardPath(ROOT, '..\\x', { realpath: async (p) => { asked++; return p; } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(asked, 0, 'no stat of a path that was already refused');
});

test('a realpath that throws something other than ENOENT is "unreadable"', async () => {
  const r = await guardPath(ROOT, 'a.js', { realpath: async () => { const e = new Error('nope'); e.code = 'EPERM'; throw e; } });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /unreadable/);
});

test('a root that cannot be resolved refuses everything', async () => {
  const r = await guardPath(ROOT, 'a.js', {
    realpath: async (p) => { if (p === ROOT) { const e = new Error('x'); e.code = 'ENOENT'; throw e; } return p; },
  });
  assert.strictEqual(r.ok, false);
});

test('the answer carries the lexical abs (what gets dragged / revealed) and the real one (what was checked)', async () => {
  const r = await guardPath(ROOT, 'a.js', { realpath: async (p) => (p.endsWith('a.js') ? 'C:\\proj\\feat-x\\real.js' : p) });
  assert.ok(ok(r));
  assert.strictEqual(r.abs, 'C:\\proj\\feat-x\\a.js');
  assert.strictEqual(r.real, 'C:\\proj\\feat-x\\real.js');
});
