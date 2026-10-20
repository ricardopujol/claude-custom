'use strict';
/**
 * The Changes panel's service (BACKLOG #119 A3, host/changes.js): what it asks git, and what it answers, on a REAL temp repository
 * (git is on every machine this runs on) and with a recording execFile for the argv rules. Read-only is the point: no git call
 * the service makes can write the index or run a program the repo names.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { tmpDir } = require('./tmp-dir');

const { createChangesService } = require('../host/changes-service');

function git(root, ...args) {
  const r = childProcess.spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

// develop with two files, then a lane branch with one commit that changes a, adds c and deletes b; then a dirty tree
function repo() {
  const root = tmpDir('cc-changes-');
  git(root, 'init', '-q', '-b', 'develop');
  put(root, 'a.txt', '1\n2\n3\n');
  put(root, 'b.txt', 'bee\n');
  put(root, 'sub dir/r.txt', 'rename me\nsecond line\nthird line\nfourth line\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'feat/lane');
  put(root, 'a.txt', '1\n2 changed\n3\n4\n');
  put(root, 'c.txt', 'see\n');
  fs.unlinkSync(path.join(root, 'b.txt'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'lane work');
  return root;
}

const svc = (root, extra) => createChangesService({ root, ...extra });

test('a clean lane: auto picks the BRANCH scope, against develop, with the committed changes', async () => {
  const root = repo();
  const r = await svc(root).handle({ type: 'changes', action: 'list', scope: 'auto', seq: 7 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.seq, 7);
  assert.strictEqual(r.scope, 'branch');
  assert.strictEqual(r.base, 'develop');
  assert.strictEqual(r.dirty, false);
  assert.deepStrictEqual(r.files.map(f => [f.path, f.status, f.add, f.del]), [['a.txt', 'M', 2, 1], ['b.txt', 'D', 0, 1], ['c.txt', 'A', 1, 0]]);
  assert.deepStrictEqual(r.summary, { files: 3, add: 3, del: 2, unknown: 0 });
});

test('a dirty tree: auto picks the WORKING TREE, staged and unstaged together, untracked files as adds with line counts', async () => {
  const root = repo();
  put(root, 'a.txt', '1\n2 changed\n3\n4\n5\n');            // unstaged
  put(root, 'new file.txt', 'x\ny\n');                        // untracked, with a space in its name
  put(root, 'staged.txt', 's\n');
  git(root, 'add', 'staged.txt');
  const r = await svc(root).handle({ type: 'changes', action: 'list', scope: 'auto' });
  assert.strictEqual(r.scope, 'working');
  assert.strictEqual(r.dirty, true);
  assert.deepStrictEqual(r.files.map(f => [f.path, f.status, f.add, f.del, !!f.untracked]), [
    ['a.txt', 'M', 1, 0, false], ['new file.txt', 'A', 2, 0, true], ['staged.txt', 'A', 1, 0, false],
  ]);
});

test('an explicit scope stands: the branch scope of a dirty tree also holds the uncommitted edit, and reports dirty', async () => {
  const root = repo();
  put(root, 'a.txt', 'only\n');
  const r = await svc(root).handle({ type: 'changes', action: 'list', scope: 'branch' });
  assert.strictEqual(r.scope, 'branch');
  assert.strictEqual(r.dirty, true);
  assert.deepStrictEqual(r.files.map(f => f.path), ['a.txt', 'b.txt', 'c.txt']);
  assert.deepStrictEqual(r.files.find(f => f.path === 'a.txt'), { path: 'a.txt', status: 'M', add: 1, del: 3, binary: false });
});

test('a rename keeps both paths and its counts; a binary file has null counts, not zeros', async () => {
  const root = repo();
  git(root, 'mv', 'sub dir/r.txt', 'sub dir/renamed.txt');
  fs.writeFileSync(path.join(root, 'pic.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(root, 'add', '-A');
  const r = await svc(root).handle({ type: 'changes', action: 'list', scope: 'working' });
  const ren = r.files.find(f => f.status === 'R');
  assert.deepStrictEqual(ren, { path: 'sub dir/renamed.txt', oldPath: 'sub dir/r.txt', status: 'R', add: 0, del: 0, binary: false });
  const bin = r.files.find(f => f.path === 'pic.bin');
  assert.deepStrictEqual([bin.add, bin.del, bin.binary], [null, null, true]);
  assert.strictEqual(r.summary.unknown, 1);
});

test('an untracked binary file is an add with unknown counts', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 0, 1]));
  const r = await svc(root).handle({ type: 'changes', action: 'list', scope: 'working' });
  const f = r.files.find(x => x.path === 'blob.bin');
  assert.deepStrictEqual([f.status, f.add, f.del, f.binary, f.untracked], ['A', null, null, true, true]);
});

test('the list is capped, with the true total and how many are left out; the summary counts them all', async () => {
  const root = repo();
  for (let i = 0; i < 7; i += 1) put(root, `many/f${i}.txt`, 'x\n');
  const r = await svc(root, { cap: 3 }).handle({ type: 'changes', action: 'list', scope: 'working' });
  assert.strictEqual(r.files.length, 3);
  assert.strictEqual(r.total, 7);
  assert.strictEqual(r.more, 4);
  // the summary counts every file; only the first few untracked ones are read for line counts, the rest say so as unknown
  assert.strictEqual(r.summary.files, 7);
  assert.strictEqual(r.summary.add + r.summary.unknown, 4 + 3);
  assert.ok(r.summary.unknown > 0);
});

test('base: the file at HEAD for the working tree, at the merge-base for the branch; new and deleted-in-place files answer plainly', async () => {
  const root = repo();
  put(root, 'a.txt', 'edited after the commit\n');
  put(root, 'fresh.txt', 'never committed\n');
  const s = svc(root);
  const w = await s.handle({ type: 'changes', action: 'base', scope: 'working', path: 'a.txt' });
  assert.deepStrictEqual([w.ok, w.text, w.base], [true, '1\n2 changed\n3\n4\n', 'HEAD']);
  const b = await s.handle({ type: 'changes', action: 'base', scope: 'branch', path: 'a.txt' });
  assert.deepStrictEqual([b.ok, b.text, b.base], [true, '1\n2\n3\n', 'develop']);
  const del = await s.handle({ type: 'changes', action: 'base', scope: 'branch', path: 'b.txt' });
  assert.strictEqual(del.text, 'bee\n');
  const fresh = await s.handle({ type: 'changes', action: 'base', scope: 'working', path: 'fresh.txt' });
  assert.deepStrictEqual([fresh.ok, fresh.why], [false, 'new']);
});

test('base of a renamed file reads the OLD path at the base', async () => {
  const root = repo();
  git(root, 'mv', 'sub dir/r.txt', 'sub dir/renamed.txt');
  const r = await svc(root).handle({ type: 'changes', action: 'base', scope: 'working', path: 'sub dir/renamed.txt', oldPath: 'sub dir/r.txt' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.startsWith('rename me'));
});

test('base of a binary file and of an oversized one are refused with a reason, never decoded', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
  put(root, 'big.txt', 'x'.repeat(1024 * 1024 + 10));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'big and binary');
  put(root, 'big.txt', 'y');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([9, 0, 9]));
  const s = svc(root);
  const bin = await s.handle({ type: 'changes', action: 'base', scope: 'working', path: 'bin.dat' });
  assert.deepStrictEqual([bin.ok, bin.why], [false, 'binary']);
  const big = await s.handle({ type: 'changes', action: 'base', scope: 'working', path: 'big.txt' });
  assert.deepStrictEqual([big.ok, big.why], [false, 'too-large']);
});

test('PATH SAFETY: a path outside the worktree, a drive path, a NUL or a flag-looking name never reaches git', async () => {
  const root = repo();
  const calls = [];
  const execFile = (cmd, args, opts, cb) => { calls.push(args); return childProcess.execFile(cmd, args, opts, cb); };
  const s = svc(root, { execFile });
  for (const bad of ['../outside.txt', 'C:\\Windows\\win.ini', 'a\0b', '..\\..\\x', '\\\\server\\share\\f', '']) {
    const r = await s.handle({ type: 'changes', action: 'base', scope: 'working', path: bad });
    assert.strictEqual(r.ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(calls.length, 0, 'no git process was started for a refused path');
  // a name that looks like an option is a path argument after the `rev:` prefix, never a flag
  const flagLike = await s.handle({ type: 'changes', action: 'base', scope: 'working', path: '--output=evil.txt' });
  assert.strictEqual(flagLike.ok, false);
  assert.ok(!fs.existsSync(path.join(root, 'evil.txt')));
  for (const args of calls) assert.ok(args.every(a => !a.startsWith('--output')), 'the name is only ever behind <sha>:');
});

test('READ-ONLY: every git call is an argv array, uses no index-writing command, and runs with optional locks off', async () => {
  const root = repo();
  put(root, 'a.txt', 'dirty\n');
  const seen = [];
  const execFile = (cmd, args, opts, cb) => { seen.push({ cmd, args, env: opts && opts.env }); return childProcess.execFile(cmd, args, opts, cb); };
  const s = svc(root, { execFile });
  await s.handle({ type: 'changes', action: 'list', scope: 'auto' });
  await s.handle({ type: 'changes', action: 'list', scope: 'branch' });
  await s.handle({ type: 'changes', action: 'base', scope: 'branch', path: 'a.txt' });
  assert.ok(seen.length > 5);
  const WRITERS = new Set(['add', 'commit', 'checkout', 'reset', 'restore', 'stash', 'rm', 'mv', 'clean', 'merge', 'rebase', 'update-index', 'gc', 'fetch', 'pull', 'push', 'apply', 'write-tree']);
  for (const c of seen) {
    assert.strictEqual(c.cmd, 'git');
    assert.ok(Array.isArray(c.args));
    const sub = c.args[c.args.indexOf('-c') + 2];      // -C <root> -c core.quotePath=false <sub> ...
    assert.ok(!WRITERS.has(sub), `git ${sub} writes`);
    assert.strictEqual(c.env.GIT_OPTIONAL_LOCKS, '0');
    if (sub === 'diff') { assert.ok(c.args.includes('--no-ext-diff')); assert.ok(c.args.includes('--no-textconv')); }
  }
});

test('READ-ONLY, measured: the index file is byte-identical after a list and a base on a dirty tree', async () => {
  const root = repo();
  put(root, 'a.txt', 'dirty\n');
  const index = path.join(root, '.git', 'index');
  const before = fs.readFileSync(index);
  const s = svc(root);
  await s.handle({ type: 'changes', action: 'list', scope: 'auto' });
  await s.handle({ type: 'changes', action: 'list', scope: 'branch' });
  await s.handle({ type: 'changes', action: 'base', scope: 'working', path: 'a.txt' });
  assert.ok(Buffer.compare(before, fs.readFileSync(index)) === 0);
});

test('failures are answers: no repository, no commits, no base branch, an unknown action', async () => {
  const none = tmpDir('cc-changes-nogit-');
  const a = await svc(none).handle({ type: 'changes', action: 'list', scope: 'working', seq: 1 });
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.seq, 1);
  assert.ok(typeof a.error === 'string' && a.error.length > 0);

  const empty = tmpDir('cc-changes-empty-');
  git(empty, 'init', '-q', '-b', 'develop');
  const b = await svc(empty).handle({ type: 'changes', action: 'list', scope: 'working' });
  assert.deepStrictEqual([b.ok, b.error], [false, 'this repository has no commits yet']);

  const odd = tmpDir('cc-changes-odd-');
  git(odd, 'init', '-q', '-b', 'trunk');
  put(odd, 'f', '1\n');
  git(odd, 'add', '-A');
  git(odd, 'commit', '-q', '-m', 'x');
  const c = await svc(odd).handle({ type: 'changes', action: 'list', scope: 'branch' });
  assert.deepStrictEqual([c.ok, c.error], [false, 'no develop, main or master branch to compare with']);
  // ...and auto still answers with the (empty) working tree rather than an error
  const d = await svc(odd).handle({ type: 'changes', action: 'list', scope: 'auto' });
  assert.deepStrictEqual([d.ok, d.scope, d.files.length], [true, 'working', 0]);

  const e = await svc(odd).handle({ type: 'changes', action: 'nope' });
  assert.deepStrictEqual([e.ok, e.why], [false, 'unknown action']);
  const f = await svc(odd).handle(null);
  assert.strictEqual(f.ok, false);
});

test('main is the base when there is no develop', async () => {
  const root = tmpDir('cc-changes-main-');
  git(root, 'init', '-q', '-b', 'main');
  put(root, 'f', '1\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'x');
  git(root, 'checkout', '-q', '-b', 'feat/x');
  put(root, 'g', '2\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'y');
  const r = await svc(root).handle({ type: 'changes', action: 'list', scope: 'auto' });
  assert.deepStrictEqual([r.scope, r.base, r.files.map(f => f.path)], ['branch', 'main', ['g']]);
});

test('an untracked LINK is listed but never followed: what it points at is not read for a line count', async (t) => {
  const root = repo();
  const outside = tmpDir('cc-changes-outside-');
  put(outside, 'secret.txt', 'one\ntwo\nthree\n');
  try { fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'), 'file'); } catch { t.skip('this machine cannot create a symlink'); return; }
  const read = [];
  const r = await svc(root, { readFile: async (p) => { read.push(p); return fs.readFileSync(p, 'utf8'); } }).handle({ type: 'changes', action: 'list', scope: 'working' });
  const f = r.files.find(x => x.path === 'link.txt');
  assert.ok(f, 'the link is listed');
  assert.strictEqual(f.add, null, 'its target\'s lines are not counted');
  assert.ok(!read.some(p => p.endsWith('link.txt')), 'and the link was never read');
});

test('an untracked path that is not a plain file (a link, a device) is listed with unknown counts and is not read, whatever the platform can create', async () => {
  const root = repo();
  put(root, 'odd.txt', 'one\ntwo\n');
  const read = [];
  const lstat = async () => ({ isFile: () => false, size: 3 });
  const r = await svc(root, { lstat, readFile: async (p) => { read.push(p); return ''; } }).handle({ type: 'changes', action: 'list', scope: 'working' });
  const f = r.files.find(x => x.path === 'odd.txt');
  assert.deepStrictEqual([f.status, f.add, f.del, f.untracked], ['A', null, null, true]);
  assert.deepStrictEqual(read, []);
});
