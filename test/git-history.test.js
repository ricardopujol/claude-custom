'use strict';
/**
 * The git facts behind the git tree (documentation/PLAN_GIT_TREE.md Tasks 1-2): merges into the
 * integration branch, every ref, the worktrees. Parsers are pure; readHistory runs git through an
 * injected runner, so these tests never touch a real repo.
 */
const test = require('node:test');
const assert = require('node:assert');

const { parseMerges, parseRefs, parseWorktrees, integrationOf } = require('../host/git-history');

const US = '\x1f', RS = '\x1e';
const rec = (h, d, s, p, b) => [h, d, s, p, b].join(US) + RS;

test('a PR merge gives its number, branch and the title from the body', () => {
  const out = parseMerges(rec('aaa', '2026-10-01', 'Merge pull request #82 from ricardopujol/feat/layout-dock-zones',
    'p1 p2', 'feat(layout): dock zones\n\nmore'));
  assert.deepStrictEqual(out, [{ hash: 'aaa', date: '2026-10-01', pr: 82, branch: 'feat/layout-dock-zones',
    title: 'feat(layout): dock zones', parents: ['p1', 'p2'] }]);
});

test("a local merge (Merge branch 'x') has no PR and no title", () => {
  const [m] = parseMerges(rec('b', '2026-09-01', "Merge branch 'spike/x' into develop", 'p1 p2', ''));
  assert.strictEqual(m.pr, null);
  assert.strictEqual(m.branch, 'spike/x');
  assert.strictEqual(m.title, null);
});

test('records after a newline (CRLF too) parse; junk and single-parent records are dropped', () => {
  const t = '\r\n' + rec('c', '2026-09-02', 'Merge pull request #1 from o/feat/a', 'p1 p2', '') + '\n' +
    rec('d', '2026-09-02', 'not a merge subject', 'p1 p2', '') +
    rec('e', '2026-09-02', 'Merge pull request #2 from o/b', 'p1', '');
  assert.deepStrictEqual(parseMerges(t).map(m => m.hash), ['c']);
});

test('not a string is no merges, no refs, no worktrees', () => {
  assert.deepStrictEqual(parseMerges(undefined), []);
  assert.deepStrictEqual(parseRefs(null), []);
  assert.deepStrictEqual(parseWorktrees(42), []);
});

test('refs: heads and remotes, remote HEAD skipped, the full ref kept for git', () => {
  const t = ['refs/heads/develop\x1f2026-10-01\x1fd1', 'refs/heads/feat/x\x1f2026-09-30\x1fx1',
    'refs/remotes/origin/HEAD\x1f2026-10-01\x1fh1', 'refs/remotes/origin/feat/y\x1f2026-09-29\x1fy1', ''].join('\n');
  assert.deepStrictEqual(parseRefs(t), [
    { name: 'develop', ref: 'refs/heads/develop', remote: false, date: '2026-10-01', tip: 'd1' },
    { name: 'feat/x', ref: 'refs/heads/feat/x', remote: false, date: '2026-09-30', tip: 'x1' },
    { name: 'feat/y', ref: 'refs/remotes/origin/feat/y', remote: true, date: '2026-09-29', tip: 'y1' }]);
});

test('worktree porcelain: path and branch; a detached worktree has branch null', () => {
  const t = 'worktree C:/p/dev\nHEAD 1\nbranch refs/heads/develop\n\nworktree C:/p/feat-x\nHEAD 2\ndetached\n';
  assert.deepStrictEqual(parseWorktrees(t),
    [{ path: 'C:/p/dev', branch: 'develop' }, { path: 'C:/p/feat-x', branch: null }]);
});

test('worktree porcelain with CRLF line ends', () => {
  const t = 'worktree C:/p/dev\r\nbranch refs/heads/develop\r\n\r\nworktree C:/p/feat-x\r\nbranch refs/heads/feat/x\r\n';
  assert.deepStrictEqual(parseWorktrees(t),
    [{ path: 'C:/p/dev', branch: 'develop' }, { path: 'C:/p/feat-x', branch: 'feat/x' }]);
});

test('integration: develop, else main, else master, else null; remote refs do not count', () => {
  const r = n => ({ name: n, remote: false });
  assert.strictEqual(integrationOf([r('main'), r('develop')]), 'develop');
  assert.strictEqual(integrationOf([r('master'), r('main')]), 'main');
  assert.strictEqual(integrationOf([r('master')]), 'master');
  assert.strictEqual(integrationOf([{ name: 'develop', remote: true }]), null);
});

// ---------- readHistory (Task 2) ----------
const { readHistory, MERGE_FORMAT, REF_FORMAT } = require('../host/git-history');

function fakeRun(table) {
  return async args => {
    const k = args.join(' ');
    if (Object.prototype.hasOwnProperty.call(table, k)) return table[k];
    throw new Error('no ' + k);
  };
}
const base = {
  [`for-each-ref ${REF_FORMAT} refs/heads refs/remotes`]: [
    'refs/heads/develop\x1f2026-10-01', 'refs/heads/main\x1f2026-09-11', 'refs/heads/feat/a\x1f2026-09-20',
    'refs/heads/feat/open\x1f2026-10-01', 'refs/heads/worktree-agent-x\x1f2026-09-11', 'refs/heads/spike/z\x1f2026-09-15',
    'refs/remotes/origin/feat/open\x1f2026-10-01', 'refs/remotes/origin/feat/remote-only\x1f2026-09-25', ''].join('\n'),
  'worktree list --porcelain': 'worktree C:/p/dev\nbranch refs/heads/develop\n\nworktree C:/p/feat-open\nbranch refs/heads/feat/open\n',
  [`log --merges --first-parent --reverse --date=short ${MERGE_FORMAT} develop`]:
    'h1\x1f2026-09-20\x1fMerge pull request #3 from o/feat/a\x1fp1 p2\x1fFeat a\x1e',
  'rev-list --count p1..p2': '4\n',
  'rev-list --count develop..refs/heads/feat/open': '2\n',
  'log --reverse --no-merges --format=%s develop..refs/heads/feat/open': 'feat(x): first\nsecond\n',
  'rev-list --count develop..refs/heads/spike/z': '0\n',
  'rev-list --count develop..refs/remotes/origin/feat/remote-only': '1\n',
  'log --reverse --no-merges --format=%s develop..refs/remotes/origin/feat/remote-only': 'only on the remote\n',
  'rev-list --count --merges --first-parent main': '0\n',
};

test('history: merges with commit counts; unmerged with ahead, first commit and worktree', async () => {
  const h = await readHistory('C:/p/dev', { run: fakeRun(base) });
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.integration, 'develop');
  assert.strictEqual(h.mainMerges, 0);
  assert.deepStrictEqual(h.merges.map(m => [m.branch, m.commits]), [['feat/a', 4]]);
  assert.deepStrictEqual(h.unmerged.map(u => [u.name, u.remote, u.ahead, u.first, u.worktree]), [
    ['feat/open', false, 2, 'feat(x): first', 'C:/p/feat-open'],
    ['spike/z', false, 0, null, null],
    ['feat/remote-only', true, 1, 'only on the remote', null],
  ]);
});

test('the integration branch, main, worktree-agent-* and a remote twin of a local branch are not listed', async () => {
  const h = await readHistory('C:/p/dev', { run: fakeRun(base) });
  const names = h.unmerged.map(u => u.name);
  for (const n of ['develop', 'main', 'worktree-agent-x']) assert.ok(!names.includes(n), n);
  assert.strictEqual(names.filter(n => n === 'feat/open').length, 1);
});

test('a count git cannot give is null, never 0', async () => {
  const t = { ...base };
  delete t['rev-list --count p1..p2'];
  delete t['rev-list --count --merges --first-parent main'];
  const h = await readHistory('C:/p/dev', { run: fakeRun(t) });
  assert.strictEqual(h.merges[0].commits, null);
  assert.strictEqual(h.mainMerges, null);
});

test('merge counts are cached by merge hash: a second read does not ask again', async () => {
  const asked = [];
  const run = fakeRun(base);
  const spy = async a => { asked.push(a.join(' ')); return run(a); };
  const counts = new Map();
  await readHistory('C:/p/dev', { run: spy, counts });
  asked.length = 0;
  const h = await readHistory('C:/p/dev', { run: spy, counts });
  assert.ok(!asked.includes('rev-list --count p1..p2'));
  assert.strictEqual(h.merges[0].commits, 4);
});

test('an unmerged branch is asked about once per (its tip, the integration tip) pair', async () => {
  const withTips = { ...base, [`for-each-ref ${REF_FORMAT} refs/heads refs/remotes`]:
    'refs/heads/develop\x1f2026-10-01\x1fD1\nrefs/heads/feat/open\x1f2026-10-01\x1fO1\n' };
  const asked = [];
  const run = fakeRun(withTips);
  const spy = async a => { asked.push(a.join(' ')); return run(a); };
  const counts = new Map();
  await readHistory('C:/p/dev', { run: spy, counts });
  asked.length = 0;
  const h = await readHistory('C:/p/dev', { run: spy, counts });
  assert.ok(!asked.some(k => k.includes('feat/open')), asked.join('; '));
  assert.deepStrictEqual(h.unmerged.map(u => [u.name, u.ahead, u.first]), [['feat/open', 2, 'feat(x): first']]);

  // the branch moves: asked again
  const moved = { ...withTips, [`for-each-ref ${REF_FORMAT} refs/heads refs/remotes`]:
    'refs/heads/develop\x1f2026-10-01\x1fD1\nrefs/heads/feat/open\x1f2026-10-01\x1fO2\n' };
  asked.length = 0;
  const run2 = fakeRun(moved);
  await readHistory('C:/p/dev', { run: async a => { asked.push(a.join(' ')); return run2(a); }, counts });
  assert.ok(asked.includes('rev-list --count develop..refs/heads/feat/open'));
});

test('a failed count is not cached: it is asked again next time', async () => {
  const t = { ...base };
  delete t['rev-list --count p1..p2'];
  const counts = new Map();
  await readHistory('C:/p/dev', { run: fakeRun(t), counts });
  const h = await readHistory('C:/p/dev', { run: fakeRun(base), counts });
  assert.strictEqual(h.merges[0].commits, 4);
});

test('not a repo (git fails) is ok:false with the reason, never an empty history', async () => {
  const h = await readHistory('C:/x', { run: fakeRun({}) });
  assert.strictEqual(h.ok, false);
  assert.match(h.error, /no for-each-ref/);
});

test('a repo with no develop, main or master is ok:false', async () => {
  const h = await readHistory('C:/p/dev', { run: fakeRun({
    [`for-each-ref ${REF_FORMAT} refs/heads refs/remotes`]: 'refs/heads/trunk\x1f2026-10-01\n',
    'worktree list --porcelain': 'worktree C:/p/dev\nbranch refs/heads/trunk\n',
  }) });
  assert.strictEqual(h.ok, false);
  assert.match(h.error, /no develop, main or master/);
});
