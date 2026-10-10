'use strict';
/**
 * PR #155 (Dexter 1 + 5, Miguel B1 + B2): the SAVE's own guard. Unlike the read guard it must let a file that
 * is gone be recreated (its folder is the thing that has to exist and be inside the worktree), and it must
 * refuse anything whose REAL path is under a `.git` folder, whatever the spelling: a nested repo, a junction, an
 * 8.3 name. A path whose real location can't be resolved is refused, never guessed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { guardWrite } = require('../host/repo-guard');

function tree() {
  const root = tmpDir('cc-gw-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'vendor', 'lib', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a');
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'hook');
  fs.writeFileSync(path.join(root, 'vendor', 'lib', '.git', 'config'), 'c');
  return root;
}

test('an existing file inside the worktree is allowed, with its real path', async () => {
  const root = tree();
  const g = await guardWrite(root, 'src/a.js');
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.rel, 'src/a.js');
  assert.strictEqual(g.created, false);
  assert.strictEqual(fs.readFileSync(g.real, 'utf8'), 'a');
});

test('a file that is GONE is allowed when its folder exists inside the worktree: it is marked created, at the folder\'s real place', async () => {
  const root = tree();
  fs.unlinkSync(path.join(root, 'src', 'a.js'));
  const g = await guardWrite(root, 'src/a.js');
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.created, true);
  assert.strictEqual(path.basename(g.real), 'a.js');
  assert.strictEqual(path.basename(path.dirname(g.real)).toLowerCase(), 'src');
});

test('a file whose FOLDER is gone too is refused as gone', async () => {
  const root = tree();
  const g = await guardWrite(root, 'nope/deeper/a.js');
  assert.deepStrictEqual({ ok: g.ok, why: g.why }, { ok: false, why: 'gone' });
});

test('a gone file whose "folder" is a file is refused, not guessed', async () => {
  const root = tree();
  const g = await guardWrite(root, 'src/a.js/b.js');
  assert.strictEqual(g.ok, false);
});

test('a gone file in a folder reached through a junction that leads OUT is refused', async () => {
  const root = tree();
  const out = tmpDir('cc-gw-out-');
  fs.symlinkSync(out, path.join(root, 'jn'), 'junction');
  const g = await guardWrite(root, 'jn/new.txt');
  assert.strictEqual(g.ok, false);
  assert.ok(!fs.existsSync(path.join(out, 'new.txt')));
});

test('the usual refusals still hold: .., absolute outside, junction out for an existing file', async () => {
  const root = tree();
  const out = tmpDir('cc-gw-out2-');
  fs.writeFileSync(path.join(out, 's.txt'), 's');
  fs.symlinkSync(out, path.join(root, 'jn'), 'junction');
  for (const p of ['../x.txt', path.join(out, 's.txt'), 'jn/s.txt', 5, '']) assert.strictEqual((await guardWrite(root, p)).ok, false, String(p));
});

test('the root-level .git, in any spelling, is protected (existing or not)', async () => {
  const root = tree();
  for (const p of ['.git/hooks/pre-commit', '.git\\hooks\\pre-commit', '.GIT/hooks/pre-commit', '.git/hooks/new-hook', '.git/HEAD']) {
    const g = await guardWrite(root, p);
    assert.deepStrictEqual({ ok: g.ok, why: g.why }, { ok: false, why: 'protected' }, p);
  }
});

test('a NESTED .git (a submodule or a cloned repo inside the worktree) is protected too', async () => {
  const root = tree();
  const g = await guardWrite(root, 'vendor/lib/.git/config');
  assert.deepStrictEqual({ ok: g.ok, why: g.why }, { ok: false, why: 'protected' });
  const g2 = await guardWrite(root, 'vendor/lib/.git/hooks/new');
  assert.strictEqual(g2.ok, false);
});

test('a junction INSIDE the worktree that points at .git/hooks is protected: the real path decides, not the spelling', async () => {
  const root = tree();
  fs.symlinkSync(path.join(root, '.git', 'hooks'), path.join(root, 'link'), 'junction');
  for (const p of ['link/pre-commit', 'link/brand-new']) {
    const g = await guardWrite(root, p);
    assert.deepStrictEqual({ ok: g.ok, why: g.why }, { ok: false, why: 'protected' }, p);
  }
  assert.strictEqual(fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8'), 'hook');
});

test('a junction to the .git folder itself is protected', async () => {
  const root = tree();
  fs.symlinkSync(path.join(root, '.git'), path.join(root, 'd'), 'junction');
  const g = await guardWrite(root, 'd/hooks/pre-commit');
  assert.deepStrictEqual({ ok: g.ok, why: g.why }, { ok: false, why: 'protected' });
});

test('an 8.3 short name resolves to the real .git: the answer of the OS decides (simulated realpath)', async () => {
  const root = tree();
  // a realpath that canonicalises GIT~1 to .git, as the OS does on a volume with short names
  const real = async (p) => fs.promises.realpath(p.replace(/GIT~1/i, '.git'));
  const g = await guardWrite(root, 'GIT~1/hooks/pre-commit', { realpath: real });
  assert.deepStrictEqual({ ok: g.ok, why: g.why }, { ok: false, why: 'protected' });
});

test('when the real path cannot be resolved for a reason other than "gone", the write is REFUSED', async () => {
  const root = tree();
  const real = async (p) => { if (/a\.js$/.test(p)) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.promises.realpath(p); };
  const g = await guardWrite(root, 'src/a.js', { realpath: real });
  assert.strictEqual(g.ok, false);
  assert.notStrictEqual(g.why, undefined);
});

test('names that merely contain "git" are not protected (.github, .gitignore, gitlab)', async () => {
  const root = tree();
  fs.mkdirSync(path.join(root, '.github'));
  for (const p of ['.github/ci.yml', '.gitignore', 'gitlab/x.txt']) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    assert.strictEqual((await guardWrite(root, p)).ok, true, p);
  }
});
