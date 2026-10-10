'use strict';
// The pure half of host/drift-git.js: a fake `run` / `execFileImpl`, no process. The real-git half is drift-git-process.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { createDriftGit, isInfraError, MAX_DIFF_BYTES } = require('../host/drift-git');

const H = (c) => c.repeat(40);
// What `run` rejects with: what a process said (an exit status), or what stopped it.
const exit = (code, message = 'Command failed: git ...') => Object.assign(new Error(message), { code, killed: false, signal: null });
const TIMEOUT = Object.assign(new Error('Command failed: git -c core.quotepath=false merge-base --is-ancestor a b'), { code: null, killed: true, signal: 'SIGTERM' });

test('anything that is not a commit id is refused before git is spawned', async () => {
  const calls = [];
  const g = createDriftGit({ cwd: '.', run: async (args) => { calls.push(args); return ''; } });
  for (const bad of ['--output=x', 'HEAD; rm -rf', '', null, 'xyz', 'abc']) {
    await assert.rejects(() => g.diff(bad), /not a commit id/);
    await assert.rejects(() => g.merges(bad, H('a')), /not a commit id/);
    await assert.rejects(() => g.merges(H('a'), bad), /not a commit id/);
  }
  assert.deepStrictEqual(calls, []);
});

test('head: exit 1 of `rev-parse --verify --quiet` is "no such branch"; not a repository is nothing to watch', async () => {
  assert.strictEqual(await createDriftGit({ cwd: '.', run: async () => { throw exit(1); } }).head(), null);
  assert.strictEqual(await createDriftGit({ cwd: '.', run: async () => { throw exit(128, 'fatal: not a git repository (or any of the parent directories): .git'); } }).head(), null);
  assert.strictEqual(await createDriftGit({ cwd: '.', run: async () => H('a') + '\n' }).head(), H('a'));
  assert.strictEqual(await createDriftGit({ cwd: '.', run: async () => 'garbage\n' }).head(), null);
});

test('head: a timeout, a missing git, a full buffer or another exit is thrown, never "no develop" (PR #153 B1)', async () => {
  for (const err of [TIMEOUT, exit('ENOENT', 'spawn git ENOENT'), exit('ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'maxBuffer'), exit(128, 'fatal: detected dubious ownership'), exit(2), new Error('git is not installed')]) {
    await assert.rejects(() => createDriftGit({ cwd: '.', run: async () => { throw err; } }).head(), (e) => e === err);
  }
});

test('merges: exit 1 of `--is-ancestor` is a rewound branch (null); a timeout or any other failure throws and says nothing about a rewind', async () => {
  const g = (err) => createDriftGit({ cwd: '.', run: async () => { throw err; } });
  assert.strictEqual(await g(exit(1)).merges(H('a'), H('b')), null);
  for (const err of [TIMEOUT, exit('ENOENT'), new Error('Command failed: git merge-base --is-ancestor a b')]) {
    await assert.rejects(() => g(err).merges(H('a'), H('b')), (e) => e === err);
  }
});

test('merges: from === to is nothing to read, without asking git', async () => {
  const g = createDriftGit({ cwd: '.', run: async () => { throw new Error('must not run'); } });
  assert.deepStrictEqual(await g.merges(H('a'), H('a')), []);
});

test('merges: newest first from git, the newest `limit` of them, oldest first out; a merge whose second parent is already in `from` is skipped', async () => {
  const log = [`${H('5')}\t${H('4')} ${H('9')}\tm5`, `${H('4')}\t${H('3')} ${H('8')}\tMerge origin/develop into feat/x`, `${H('3')}\t${H('2')} ${H('7')}\tm3`, `${H('2')}\t${H('1')} ${H('6')}\tm2`].join('\n');
  const asked = [];
  const run = async (args) => {
    asked.push(args.join(' '));
    if (args[0] === 'log') return log;
    if (args[1] === '--is-ancestor' && args[2] === H('8')) return '';        // already in develop's history: not a change brought in
    if (args[1] === '--is-ancestor' && args[2] === H('a')) return '';        // from is an ancestor of to
    throw exit(1);
  };
  const g = createDriftGit({ cwd: '.', run });
  assert.deepStrictEqual((await g.merges(H('a'), H('f'), { limit: 2 })).map(m => m.sha), [H('3'), H('5')]);
  assert.deepStrictEqual((await g.merges(H('a'), H('f'), { limit: 10 })).map(m => m.sha), [H('2'), H('3'), H('5')]);
  assert.deepStrictEqual(await g.merges(H('a'), H('f'), { limit: 0 }), []);
  assert.ok(asked.some(a => a.startsWith('log --first-parent --merges')), asked.join('\n'));
});

test('merges: a failure while checking a merge\'s second parent throws (mark kept), it is not read as "keep" or "skip"', async () => {
  const log = `${H('5')}\t${H('4')} ${H('9')}\tm5`;
  const run = async (args) => { if (args[0] === 'log') return log; if (args[2] === H('9')) throw TIMEOUT; return ''; };
  await assert.rejects(() => createDriftGit({ cwd: '.', run }).merges(H('a'), H('f')), (e) => e === TIMEOUT);
});

test('merges: a subject with tabs keeps them; a line that is not a merge row is ignored', async () => {
  const run = async (args) => (args[0] === 'log' ? `${H('5')}\t${H('4')} ${H('9')}\tsubject\twith tab\nnot a row\n\n${H('6')}\t${H('4')}\tno second parent` : (() => { throw exit(1); })());
  const got = await createDriftGit({ cwd: '.', run: (a) => (a[1] === '--is-ancestor' && a[2] === H('a') ? Promise.resolve('') : run(a)) }).merges(H('a'), H('f'));
  assert.deepStrictEqual(got, [{ sha: H('5'), subject: 'subject\twith tab' }]);
});

test('diff: asks for the first-parent diff and allows a truncated answer', async () => {
  let seen;
  const g = createDriftGit({ cwd: '.', run: async (args, opts) => { seen = [args, opts]; return 'D'; } });
  assert.strictEqual(await g.diff(H('c')), 'D');
  assert.deepStrictEqual(seen[0].slice(0, 6), ['diff', '--no-color', '--no-ext-diff', '-U2', `${H('c')}^1`, H('c')]);
  assert.deepStrictEqual(seen[1], { truncateOk: true });
});

test('the real run: a diff past the buffer is the part that fitted, not a failure; any other failure carries what the process said', async () => {
  const mk = (cb) => createDriftGit({ cwd: '.', execFileImpl: (cmd, args, opts, done) => { mk.opts = opts; cb(done); } });
  const big = mk((done) => done(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'partial diff', ''));
  assert.strictEqual(await big.diff(H('c')), 'partial diff');
  assert.strictEqual(mk.opts.maxBuffer, MAX_DIFF_BYTES);
  const nothing = mk((done) => done(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), '', ''));
  await assert.rejects(() => nothing.diff(H('c')), (e) => e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && isInfraError(e));
  const killed = mk((done) => done(Object.assign(new Error('Command failed: git diff'), { code: null, killed: true, signal: 'SIGTERM' }), '', ''));
  await assert.rejects(() => killed.diff(H('c')), (e) => e.killed === true && e.signal === 'SIGTERM' && /Command failed/.test(e.message) && isInfraError(e));
  const status = mk((done) => done(Object.assign(new Error('Command failed'), { code: 128 }), '', 'fatal: bad object\n'));
  await assert.rejects(() => status.diff(H('c')), (e) => e.code === 128 && e.message === 'fatal: bad object' && !isInfraError(e));
});

test('isInfraError: only a plain exit status is an answer', () => {
  assert.strictEqual(isInfraError(exit(1)), false);
  assert.strictEqual(isInfraError(exit(0)), false);
  for (const e of [TIMEOUT, exit('ENOENT'), { code: 1, killed: true }, { code: 1, signal: 'SIGKILL' }, new Error('x'), null, undefined]) assert.strictEqual(isInfraError(e), true);
});

// ---- PR #153 round 2 ---------------------------------------------------------------------------------------------
const { EXCLUDE_PATHSPECS } = require('../host/drift-text');

test('diff: files nobody reads (maps, lockfiles, dist, minified, keys) are excluded by git itself, so the byte cap is spent on code (R2-3)', async () => {
  let args;
  const g = createDriftGit({ cwd: '.', run: async (a) => { args = a; return ''; } });
  await g.diff(H('c'));
  const at = args.indexOf('--');
  assert.ok(at > 0, args.join(' '));
  assert.deepStrictEqual(args.slice(at), ['--', '.', ...EXCLUDE_PATHSPECS]);
  assert.deepStrictEqual(args.slice(0, at), ['diff', '--no-color', '--no-ext-diff', '-U2', `${H('c')}^1`, H('c')]);
});

test('merges: a mark git no longer has (exit 128 and the commit is not there) is a rewind to follow, not a failure every minute (R2-6)', async () => {
  const gone = exit(128, 'fatal: Not a valid commit name');
  const run = (catFile) => async (args) => { if (args[0] === 'merge-base') throw gone; if (args[0] === 'cat-file') return catFile(); return ''; };
  assert.strictEqual(await createDriftGit({ cwd: '.', run: run(() => { throw exit(1); }) }).merges(H('a'), H('b')), null);
  assert.strictEqual(await createDriftGit({ cwd: '.', run: run(() => { throw exit(128, 'fatal: Not a valid object name'); }) }).merges(H('a'), H('b')), null);
  // the commit IS there, so the 128 was something else: that is thrown
  await assert.rejects(() => createDriftGit({ cwd: '.', run: run(() => '') }).merges(H('a'), H('b')), (e) => e === gone);
  // asking about the commit timed out: thrown too
  await assert.rejects(() => createDriftGit({ cwd: '.', run: run(() => { throw TIMEOUT; }) }).merges(H('a'), H('b')), (e) => e === TIMEOUT);
});
