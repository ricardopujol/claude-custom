'use strict';
/**
 * The Files tab's listing (#45): what is in the worktree, served one folder at a time, and what it says
 * when git can't answer.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpDir } = require('./tmp-dir');

const { parseLsFiles, buildIndex, listFiles, createIndex, LS_FILES_ARGS } = require('../host/repo-index');

const NUL = String.fromCharCode(0);
const z = (...names) => names.join(NUL) + NUL;

test('git -z output is split on NUL, with no trim: a name may begin or end with a space', () => {
  assert.deepStrictEqual(parseLsFiles(z('a.js', ' lead.js', 'trail.js ', 'dir/b.js')), ['a.js', ' lead.js', 'trail.js ', 'dir/b.js']);
});

test('a path git lists once per merge stage is one row', () => {
  assert.deepStrictEqual(parseLsFiles(z('a.js', 'a.js', 'a.js', 'b.js')), ['a.js', 'b.js']);
});

test('empty output is an empty list, and a non-string is too', () => {
  assert.deepStrictEqual(parseLsFiles(''), []);
  assert.deepStrictEqual(parseLsFiles(null), []);
});

test('the root lists folders first, then files, each sorted without regard to case', () => {
  const idx = buildIndex(['z.js', 'B.md', 'a.js', 'src/x.js', 'Lib/y.js', 'docs/z.md']);
  assert.deepStrictEqual(idx.children('').map(e => `${e.kind}:${e.name}`), ['dir:docs', 'dir:Lib', 'dir:src', 'file:a.js', 'file:B.md', 'file:z.js']);
});

test('a folder lists only its own children, with their full paths', () => {
  const idx = buildIndex(['src/a.js', 'src/deep/b.js', 'src/deep/c.js', 'other/d.js']);
  assert.deepStrictEqual(idx.children('src'), [
    { name: 'deep', path: 'src/deep', kind: 'dir' },
    { name: 'a.js', path: 'src/a.js', kind: 'file' },
  ]);
  assert.deepStrictEqual(idx.children('src/deep').map(e => e.path), ['src/deep/b.js', 'src/deep/c.js']);
});

test('a folder that is not in the list is reported as missing, not as an empty folder', () => {
  const idx = buildIndex(['a.js']);
  assert.strictEqual(idx.children('nope'), null);
  assert.strictEqual(idx.has('nope'), false);
  assert.strictEqual(idx.has(''), true);
});

test('names like __proto__ and constructor are just names', () => {
  const idx = buildIndex(['__proto__/constructor.js', 'toString']);
  assert.deepStrictEqual(idx.children('').map(e => e.name), ['__proto__', 'toString']);
  assert.deepStrictEqual(idx.children('__proto__').map(e => e.name), ['constructor.js']);
  assert.strictEqual(idx.children('hasOwnProperty'), null);
});

test('the file count is the number of distinct paths', () => {
  assert.strictEqual(buildIndex(['a', 'b', 'c/d', 'c/d']).size, 3);
});

// ---- running git ----

test('git is asked for tracked AND new-but-not-ignored files, NUL separated, un-quoted', () => {
  assert.ok(LS_FILES_ARGS.includes('--cached') && LS_FILES_ARGS.includes('--others') && LS_FILES_ARGS.includes('--exclude-standard'));
  assert.ok(LS_FILES_ARGS.includes('-z'));
  assert.ok(LS_FILES_ARGS.join(' ').includes('core.quotePath=false'));
});

const failing = (err) => (file, args, opts, cb) => cb(err);

test('a listing that worked answers the files', async () => {
  let seen;
  const r = await listFiles('C:\\r', { execFile: (file, args, opts, cb) => { seen = { file, args, opts }; cb(null, z('a.js', 'b/c.js'), ''); } });
  assert.deepStrictEqual(r, { ok: true, files: ['a.js', 'b/c.js'] });
  assert.strictEqual(seen.file, 'git');
  assert.deepStrictEqual(seen.args.slice(0, 2), ['-C', 'C:\\r']);
  assert.ok(seen.opts.maxBuffer >= 32 * 1024 * 1024, 'a repo of tens of thousands of files must not hit ENOBUFS');
  assert.ok(seen.opts.timeout > 0);
});

test('git missing is said plainly, and is NOT an empty tree', async () => {
  const e = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  const r = await listFiles('C:\\r', { execFile: failing(e) });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /git (is )?(not installed|missing|could not be started)/i);
  assert.ok(!('files' in r) || r.files.length === 0);
});

test('not a repository is said plainly', async () => {
  const e = Object.assign(new Error('Command failed'), { code: 128 });
  const r = await listFiles('C:\\r', { execFile: (f, a, o, cb) => cb(e, '', 'fatal: not a git repository (or any of the parent directories): .git') });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not a git repository/i);
});

test('a timeout is said as a timeout', async () => {
  const e = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
  const r = await listFiles('C:\\r', { execFile: failing(e) });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /too long|timed out/i);
});

test('any other failure carries git\'s own message', async () => {
  const e = Object.assign(new Error('boom'), { code: 1 });
  const r = await listFiles('C:\\r', { execFile: (f, a, o, cb) => cb(e, '', 'fatal: something odd') });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /something odd/);
});

test('a repo with no files at all is ok and empty (a real answer, unlike an error)', async () => {
  const r = await listFiles('C:\\r', { execFile: (f, a, o, cb) => cb(null, '', '') });
  assert.deepStrictEqual(r, { ok: true, files: [] });
});

// ---- the index a host keeps ----

test('createIndex answers a folder after a refresh, and says "not loaded" before one', async () => {
  const ix = createIndex('C:\\r', { execFile: (f, a, o, cb) => cb(null, z('a.js', 'src/b.js'), '') });
  assert.deepStrictEqual(ix.list(''), { ok: false, error: 'the file list has not been read yet' });
  const st = await ix.refresh();
  assert.strictEqual(st.ok, true);
  assert.deepStrictEqual(ix.list('').entries.map(e => e.name), ['src', 'a.js']);
  assert.deepStrictEqual(ix.list('src').entries.map(e => e.name), ['b.js']);
  assert.deepStrictEqual(ix.list('nope'), { ok: true, entries: [], missing: true });
});

test('after git fails, listing says so: the LAST GOOD tree is not served as if it were current', async () => {
  let n = 0;
  const ix = createIndex('C:\\r', { execFile: (f, a, o, cb) => (n++ === 0 ? cb(null, z('a.js'), '') : cb(new Error('boom'), '', 'fatal: gone')) });
  await ix.refresh();
  assert.strictEqual(ix.list('').ok, true);
  await ix.refresh();
  const r = ix.list('');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /gone/);
});

test('overlapping refreshes share one git run', async () => {
  let runs = 0;
  const ix = createIndex('C:\\r', { execFile: (f, a, o, cb) => { runs++; setTimeout(() => cb(null, z('a.js'), ''), 20); } });
  await Promise.all([ix.refresh(), ix.refresh(), ix.refresh()]);
  assert.strictEqual(runs, 1);
  await ix.refresh();
  assert.strictEqual(runs, 2);
});

test('a refresh asked for DURING a run is run again after it (the change may have landed after git looked)', async () => {
  let runs = 0;
  const ix = createIndex('C:\\r', { execFile: (f, a, o, cb) => { runs++; setTimeout(() => cb(null, z('a.js'), ''), 20); } });
  const first = ix.refresh();
  await new Promise(r => setTimeout(r, 5));
  const second = ix.refresh({ again: true });
  await Promise.all([first, second]);
  assert.strictEqual(runs, 2);
});

// ---- with a real git ----

function realRepo() {
  const root = tmpDir('cc-index-');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', ...a], { cwd: root, stdio: 'pipe', windowsHide: true });
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n*.log\n');
  fs.writeFileSync(path.join(root, 'src', 'tracked.js'), '1');
  fs.writeFileSync(path.join(root, 'caf\u00e9.js'), '1');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'i.js'), '1');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, git };
}

test('real git: tracked files, a NEW untracked file Claude just wrote, but not node_modules or ignored files', async () => {
  const { root } = realRepo();
  fs.writeFileSync(path.join(root, 'src', 'brand-new.js'), '2');       // untracked, not ignored
  fs.writeFileSync(path.join(root, 'debug.log'), '3');                 // ignored
  const r = await listFiles(root);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([...r.files].sort(), ['.gitignore', 'caf\u00e9.js', 'src/brand-new.js', 'src/tracked.js']);
});

test('real git: a folder that is not a repository is an error, not an empty list', async () => {
  const dir = tmpDir('cc-index-norepo-');
  const r = await listFiles(dir);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not a git repository/i);
});

// ---- PR #95 Dexter D3: the listing can say how it spells a file ----

test('D3: buildIndex.resolve finds a file by any case and answers the listing\'s own spelling', () => {
  const idx = buildIndex(['app/renderer.js', 'README.md']);
  assert.strictEqual(idx.resolve('APP/Renderer.JS'), 'app/renderer.js');
  assert.strictEqual(idx.resolve('readme.MD'), 'README.md');
  assert.strictEqual(idx.resolve('app/other.js'), null);
  assert.strictEqual(idx.resolve('app'), null, 'a folder is not a listed file');
});

test('D3: createIndex.resolve is undefined (unknown) until a listing worked or after one failed, never null', async () => {
  let ok = true;
  const ix = createIndex('C:\r', { execFile: (f, a, o, cb) => (ok ? cb(null, z('a.js'), '') : cb(new Error('x'), '', 'fatal: no')) });
  assert.strictEqual(ix.resolve('a.js'), undefined);
  await ix.refresh();
  assert.strictEqual(ix.resolve('A.JS'), 'a.js');
  assert.strictEqual(ix.resolve('b.js'), null);
  ok = false;
  await ix.refresh();
  assert.strictEqual(ix.resolve('a.js'), undefined);
});

// ---- PR #95 Dexter D13: git prints an untracked nested repository as `dir/` ----

test('D13: a trailing-slash entry (an untracked nested repo) is a FOLDER row marked nested, never a file', () => {
  const idx = buildIndex(['a/', 'b.js', 'tools/vendor-x/', 'tools/t.js']);
  assert.deepStrictEqual(idx.children('').map(e => `${e.kind}:${e.name}${e.nested ? ':nested' : ''}`), ['dir:a:nested', 'dir:tools', 'file:b.js']);
  assert.deepStrictEqual(idx.children('tools').map(e => `${e.kind}:${e.name}${e.nested ? ':nested' : ''}`), ['dir:vendor-x:nested', 'file:t.js']);
  assert.deepStrictEqual(idx.children('a'), [], 'its contents belong to its own repo: nothing is listed under it');
});

test('D13: a nested repo is not a file: it is not counted, resolved or openable', () => {
  const idx = buildIndex(['a/', 'b.js']);
  assert.strictEqual(idx.size, 1);
  assert.strictEqual(idx.resolve('a'), null);
});

test('D13: a real folder with the same name as a nested one stays an ordinary folder', () => {
  const idx = buildIndex(['a/', 'a/x.js']);
  assert.deepStrictEqual(idx.children('').map(e => [e.name, e.kind, !!e.nested]), [['a', 'dir', false]]);
});

test('D13 (real git): an untracked folder with its own .git is listed as `dir/` and shown as a nested folder', async () => {
  const { root, git } = realRepo();
  const nested = path.join(root, 'tools', 'vendor-x');
  fs.mkdirSync(nested, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: nested, stdio: 'pipe', windowsHide: true });
  fs.writeFileSync(path.join(nested, 'f.js'), 'x');
  void git;
  const r = await listFiles(root);
  assert.strictEqual(r.ok, true);
  assert.ok(r.files.includes('tools/vendor-x/'), r.files.join(', '));
  assert.strictEqual(buildIndex(r.files).children('tools').find(e => e.name === 'vendor-x').kind, 'dir');
});
