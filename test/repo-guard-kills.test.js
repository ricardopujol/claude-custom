'use strict';
/**
 * Boundaries of the repo browser's path guard that the main suite only meets far from the edge (backlog #60,
 * Mortimer's release-#101 part 2): the length cap, what counts as a drive root, how the root is normalised, and
 * which reason each realpath failure gets.
 */
const test = require('node:test');
const assert = require('node:assert');

const { lexical, guardPath, MAX_INPUT } = require('../host/repo-guard');

const ROOT = 'C:\\w';

test('an input of exactly MAX_INPUT characters is not refused for its length; one more is', () => {
  const edge = lexical(ROOT, 'a'.repeat(MAX_INPUT));
  assert.notStrictEqual(edge.why, 'path too long');
  assert.deepStrictEqual(lexical(ROOT, 'a'.repeat(MAX_INPUT + 1)), { ok: false, why: 'path too long' });
});

test('an input that is not a non-empty string is "not a path"', () => {
  for (const bad of [42, {}, null, undefined, ['a.txt'], '']) {
    assert.deepStrictEqual(lexical(ROOT, bad), { ok: false, why: 'not a path' }, String(bad));
  }
});

test('a root that is not a string is refused even when its text reads like a drive path', () => {
  const NOT_DRIVE = { ok: false, why: 'the worktree root is not a drive path' };
  assert.deepStrictEqual(lexical(['C:\\w'], 'a.txt'), NOT_DRIVE);
  assert.deepStrictEqual(lexical({ toString: () => 'C:\\w' }, 'a.txt'), NOT_DRIVE);
  assert.deepStrictEqual(lexical(null, 'a.txt'), NOT_DRIVE);
  assert.deepStrictEqual(lexical(undefined, 'a.txt'), NOT_DRIVE);
});

test('a root must START with a drive and a separator: a drive path buried inside, UNC, bare drive, or a name is refused', () => {
  for (const root of ['x\\C:\\w', '\\\\host\\share', '\\\\host\\share\\w', 'C:', 'C:w', 'w', '', ' C:\\w']) {
    assert.deepStrictEqual(lexical(root, 'a.txt'), { ok: false, why: 'the worktree root is not a drive path' }, JSON.stringify(root));
  }
});

test('a drive root with either slash is accepted as a root spelling', () => {
  assert.strictEqual(lexical('C:/w', 'a.txt').ok, true);
  assert.strictEqual(lexical('c:\\w', 'a.txt').ok, true);
});

test('trailing separators and forward slashes on the root give the same abs and rel as the plain spelling', () => {
  const want = { ok: true, abs: 'C:\\w\\a.txt', rel: 'a.txt' };
  assert.deepStrictEqual(lexical('C:\\w', 'a.txt'), want);
  assert.deepStrictEqual(lexical('C:\\w\\', 'a.txt'), want);
  assert.deepStrictEqual(lexical('C:\\w\\\\', 'a.txt'), want);
  assert.deepStrictEqual(lexical('C:/w', 'a.txt'), want);
  assert.deepStrictEqual(lexical('C:/w/', 'a.txt'), want);
});

test('the root itself comes back as abs without a trailing separator and rel empty', () => {
  assert.deepStrictEqual(lexical('C:\\w', '.'), { ok: true, abs: 'C:\\w', rel: '' });
  assert.deepStrictEqual(lexical('C:\\w\\', '.'), { ok: true, abs: 'C:\\w', rel: '' });
  assert.deepStrictEqual(lexical('C:\\w', 'sub\\..'), { ok: true, abs: 'C:\\w', rel: '' });
});

test('a path that names a folder with a trailing separator comes back without it', () => {
  assert.deepStrictEqual(lexical('C:\\w', 'sub\\'), { ok: true, abs: 'C:\\w\\sub', rel: 'sub' });
  assert.deepStrictEqual(lexical('C:\\w', 'C:\\w\\sub\\'), { ok: true, abs: 'C:\\w\\sub', rel: 'sub' });
});

test('a bare drive root cannot be a worktree root: nothing is resolved against it', () => {
  for (const root of ['C:\\', 'C:/']) {
    assert.deepStrictEqual(lexical(root, 'x'), { ok: false, why: 'not a path the browser will touch' }, root);
    assert.deepStrictEqual(lexical(root, '.'), { ok: false, why: 'not a path the browser will touch' }, root);
  }
});

test('rel always uses forward slashes, however the input was spelled', () => {
  assert.strictEqual(lexical(ROOT, 'a\\b\\c.txt').rel, 'a/b/c.txt');
  assert.strictEqual(lexical(ROOT, 'a/b/c.txt').rel, 'a/b/c.txt');
});

// ---- guardPath ----

const fail = (code) => async () => { const e = new Error('x'); if (code) e.code = code; throw e; };

test('guardPath asks the disk about the NORMALISED root: no trailing separator, backslashes', async () => {
  const asked = [];
  const r = await guardPath('C:/w/', 'a.txt', { realpath: async (p) => { asked.push(p); return p; } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(asked, ['C:\\w', 'C:\\w\\a.txt']);
});

test('a missing file is "gone"; any other failure is "unreadable"', async () => {
  const withFileError = (code) => guardPath(ROOT, 'a.txt', {
    realpath: async (p) => { if (p.endsWith('a.txt')) throw Object.assign(new Error('x'), code ? { code } : {}); return p; },
  });
  assert.deepStrictEqual(await withFileError('ENOENT'), { ok: false, why: 'gone' });
  assert.deepStrictEqual(await withFileError('EACCES'), { ok: false, why: 'unreadable' });
  assert.deepStrictEqual(await withFileError(undefined), { ok: false, why: 'unreadable' });
});

test('a rejection that is not an Error at all (undefined, null, a string) is "unreadable" and does not throw', async () => {
  for (const thrown of [undefined, null, 'ENOENT']) {
    const r = await guardPath(ROOT, 'a.txt', {
      realpath: async (p) => { if (p.endsWith('a.txt')) throw thrown; return p; },
    });
    assert.deepStrictEqual(r, { ok: false, why: 'unreadable' }, String(thrown));
  }
});

test('a worktree whose own realpath fails is "the worktree itself is unreadable", for ENOENT and for anything else', async () => {
  for (const code of ['ENOENT', 'EACCES', undefined]) {
    const r = await guardPath(ROOT, 'a.txt', { realpath: fail(code) });
    assert.deepStrictEqual(r, { ok: false, why: 'the worktree itself is unreadable' }, String(code));
  }
});

test('the file is only looked up after the root resolved', async () => {
  const asked = [];
  await guardPath(ROOT, 'a.txt', { realpath: async (p) => { asked.push(p); throw new Error('no'); } });
  assert.deepStrictEqual(asked, [ROOT]);
});

test('a lexical refusal never reaches the disk', async () => {
  let asked = 0;
  const r = await guardPath(ROOT, '..\\x', { realpath: async (p) => { asked++; return p; } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(asked, 0);
});

test('a file whose real path leaves the real root through a link is refused; real is returned as a string when inside', async () => {
  const out = await guardPath(ROOT, 'a.txt', { realpath: async (p) => (p.endsWith('a.txt') ? 'D:\\elsewhere\\a.txt' : p) });
  assert.deepStrictEqual(out, { ok: false, why: 'outside the worktree (a link leads out)' });
  const inside = await guardPath(ROOT, 'a.txt', { realpath: async (p) => new String(p) });
  assert.deepStrictEqual(inside, { ok: true, abs: 'C:\\w\\a.txt', rel: 'a.txt', real: 'C:\\w\\a.txt' });
});

test('a sibling that merely shares the root as a name prefix is outside', async () => {
  const r = await guardPath(ROOT, 'a.txt', { realpath: async (p) => (p.endsWith('a.txt') ? 'C:\\w2\\a.txt' : p) });
  assert.deepStrictEqual(r, { ok: false, why: 'outside the worktree (a link leads out)' });
});
