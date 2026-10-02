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

// ---------- readHistory (Task 2): four git calls, whatever the number of branches ----------
const { readHistory, MERGE_FORMAT, REF_FORMAT, GRAPH_FORMAT } = require('../host/git-history');

function fakeRun(table) {
  return async args => {
    const k = args.join(' ');
    if (Object.prototype.hasOwnProperty.call(table, k)) return table[k];
    throw new Error('no ' + k);
  };
}
const rowsToGraph = rows => rows.map(([h, p, t, s]) => [h, p, String(t), s].join('\x1f')).join('\n') + '\n';
// develop: a - m1 (merged feat/a: x1) - d2      feat/open: m1 - o1 - o2      remote-only: m1 - r1
// spike/z and main sit on a (contained); worktree-agent-x too
const base = {
  [`for-each-ref ${REF_FORMAT} refs/heads refs/remotes`]: [
    'refs/heads/develop\x1f2026-10-01\x1fd2', 'refs/heads/main\x1f2026-09-11\x1fa', 'refs/heads/feat/a\x1f2026-09-20\x1fx1',
    'refs/heads/feat/open\x1f2026-10-01\x1fo2', 'refs/heads/worktree-agent-x\x1f2026-09-11\x1fa', 'refs/heads/spike/z\x1f2026-09-15\x1fa',
    'refs/remotes/origin/feat/open\x1f2026-10-01\x1fo2', 'refs/remotes/origin/feat/remote-only\x1f2026-09-25\x1fr1', ''].join('\n'),
  'worktree list --porcelain': 'worktree C:/p/dev\nbranch refs/heads/develop\n\nworktree C:/p/feat-open\nbranch refs/heads/feat/open\n',
  [`log --merges --first-parent --reverse --date=short ${MERGE_FORMAT} develop`]:
    'm1\x1f2026-09-20\x1fMerge pull request #3 from o/feat/a\x1fa x1\x1fFeat a\x1e',
  [`log --all ${GRAPH_FORMAT}`]: rowsToGraph([
    ['o2', 'o1', 7, 'open two'], ['o1', 'm1', 6, 'feat(x): first'], ['d2', 'm1', 5, 'd two'], ['r1', 'm1', 4, 'only on the remote'],
    ['m1', 'a x1', 3, 'Merge pull request #3 from o/feat/a'], ['x1', 'a', 2, 'x one'], ['a', '', 1, 'root'],
  ]),
};

test('history: merges with commit counts; unmerged with ahead, first commit and worktree', async () => {
  const h = await readHistory('C:/p/dev', { run: fakeRun(base) });
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.integration, 'develop');
  assert.strictEqual(h.mainMerges, 0);
  assert.deepStrictEqual(h.merges.map(m => [m.branch, m.commits]), [['feat/a', 1]]);
  // every ref is a lane, merged ones too (0 ahead): the model joins them with their merges (Dexter F2)
  assert.deepStrictEqual(h.lanes.map(u => [u.name, u.remote, u.ahead, u.first, u.worktree]), [
    ['feat/a', false, 0, null, null],
    ['feat/open', false, 2, 'feat(x): first', 'C:/p/feat-open'],
    ['spike/z', false, 0, null, null],
    ['feat/remote-only', true, 1, 'only on the remote', null],
  ]);
});

test('the integration branch, main, worktree-agent-* and a remote twin of a local branch are not listed', async () => {
  const h = await readHistory('C:/p/dev', { run: fakeRun(base) });
  const names = h.lanes.map(u => u.name);
  for (const n of ['develop', 'main', 'worktree-agent-x']) assert.ok(!names.includes(n), n);
  assert.strictEqual(names.filter(n => n === 'feat/open').length, 1);
});

test('four git calls, whatever the number of branches', async () => {
  let calls = 0;
  const run = fakeRun(base);
  await readHistory('C:/p/dev', { run: async a => { calls++; return run(a); } });
  assert.strictEqual(calls, 4);
});

test('a tip the graph does not hold is null, never 0; so is a merge off the first-parent line', async () => {
  const t = { ...base,
    [`for-each-ref ${REF_FORMAT} refs/heads refs/remotes`]: 'refs/heads/develop\x1f2026-10-01\x1fd2\nrefs/heads/feat/ghost\x1f2026-10-01\x1fzz\n',
    [`log --merges --first-parent --reverse --date=short ${MERGE_FORMAT} develop`]:
      'q9\x1f2026-09-20\x1fMerge pull request #4 from o/feat/q\x1fa x1\x1f\x1e' };
  const h = await readHistory('C:/p/dev', { run: fakeRun(t) });
  assert.deepStrictEqual(h.lanes.map(u => [u.name, u.ahead]), [['feat/ghost', null]]);
  assert.strictEqual(h.merges[0].commits, null);
  assert.strictEqual(h.mainMerges, null);
});

test('not a repo (git fails) is ok:false with the reason, never an empty history', async () => {
  const h = await readHistory('C:/x', { run: fakeRun({}) });
  assert.strictEqual(h.ok, false);
  assert.match(h.error, /no for-each-ref/);
});

test('the graph failing is ok:false too', async () => {
  const t = { ...base };
  delete t[`log --all ${GRAPH_FORMAT}`];
  const h = await readHistory('C:/p/dev', { run: fakeRun(t) });
  assert.strictEqual(h.ok, false);
});

test('a repo with no develop, main or master is ok:false', async () => {
  const h = await readHistory('C:/p/dev', { run: fakeRun({
    [`for-each-ref ${REF_FORMAT} refs/heads refs/remotes`]: 'refs/heads/trunk\x1f2026-10-01\x1ft1\n',
    'worktree list --porcelain': 'worktree C:/p/dev\nbranch refs/heads/trunk\n',
  }) });
  assert.strictEqual(h.ok, false);
  assert.match(h.error, /no develop, main or master/);
});

// ---------- one graph instead of a spawn per branch ----------
const { parseGraph, mergeCounts, laneFacts: laneFactsOf } = require('../host/git-history');
// "hash parents time subject" rows, newest first like git log
const graph = rows => rows.map(([h, p, t, s]) => [h, p, String(t), s].join('\x1f')).join('\n') + '\n';

test('parseGraph: hash -> { parents, time, subject }', () => {
  const g = parseGraph(graph([['b', 'a', 2, 'two'], ['a', '', 1, 'one']]));
  assert.deepStrictEqual(g.get('b'), { parents: ['a'], time: 2, subject: 'two' });
  assert.deepStrictEqual(g.get('a'), { parents: [], time: 1, subject: 'one' });
});

// develop: a - m1 - c - m2     feature x: a - x1 - x2 (merged at m1)     feature y: m1 - y1 (merged at m2)
const G = parseGraph(graph([
  ['m2', 'c y1', 6, 'Merge y'], ['y1', 'm1', 5, 'y one'], ['c', 'm1', 4, 'c'],
  ['m1', 'a x2', 3, 'Merge x'], ['x2', 'x1', 2.5, 'x two'], ['x1', 'a', 2, 'x one'], ['a', '', 1, 'root'],
]));

test('mergeCounts: commits each merge brought in = git rev-list --count p1..p2', () => {
  assert.deepStrictEqual(mergeCounts(G, 'm2'), new Map([['m1', 2], ['m2', 1]]));
});

test('mergeCounts of an unknown tip is empty', () => {
  assert.deepStrictEqual(mergeCounts(G, 'nope'), new Map());
});

test('laneFacts: ahead of the integration tip, and the oldest non-merge commit it adds', () => {
  const g = parseGraph(graph([
    ['l3', 'l2 c', 9, 'Merge develop into lane'], ['l2', 'l1', 8, 'lane two'], ['l1', 'm1', 7, 'lane one'],
    ['m2', 'c y1', 6, 'Merge y'], ['y1', 'm1', 5, 'y one'], ['c', 'm1', 4, 'c'],
    ['m1', 'a x2', 3, 'Merge x'], ['x2', 'x1', 2.5, 'x two'], ['x1', 'a', 2, 'x one'], ['a', '', 1, 'root'],
  ]));
  assert.deepStrictEqual(laneFactsOf(g, 'm2', 'l3'), { ahead: 3, first: 'lane one' });
  assert.deepStrictEqual(laneFactsOf(g, 'm2', 'y1'), { ahead: 0, first: null });
  assert.deepStrictEqual(laneFactsOf(g, 'm2', 'missing'), { ahead: null, first: null });
});

// ---------- PR #84 review (Dexter, Miguel) ----------

test('Dexter F3: a rebased lane whose commits share one commit time still gives its FIRST commit', () => {
  const g = parseGraph(rowsToGraph([
    ['c', 'b', 1000, 'third'], ['b', 'a', 1000, 'second'], ['a', 'd1', 1000, 'first'], ['d1', '', 1, 'root'],
  ]));
  assert.deepStrictEqual(laneFactsOf(g, 'd1', 'c'), { ahead: 3, first: 'first' });
});

test('Dexter F3: clock skew (a child older than its parent) still gives the first commit', () => {
  const g = parseGraph(rowsToGraph([
    ['c', 'b', 5, 'third'], ['b', 'a', 3, 'second'], ['a', 'd1', 9, 'first'], ['d1', '', 1, 'root'],
  ]));
  assert.strictEqual(laneFactsOf(g, 'd1', 'c').first, 'first');
});

test('a lane that merged another lane in: the older of its two starts', () => {
  const g = parseGraph(rowsToGraph([
    ['m', 'b2 o1', 9, 'Merge other'], ['o1', 'd1', 2, 'other start'], ['b2', 'b1', 8, 'b two'], ['b1', 'd1', 5, 'b start'], ['d1', '', 1, 'root'],
  ]));
  assert.deepStrictEqual(laneFactsOf(g, 'd1', 'm'), { ahead: 4, first: 'other start' });
});

test('Dexter F11: an integration tip the graph does not hold makes every count unknown, not the whole history', async () => {
  const t = { ...base, [`for-each-ref ${REF_FORMAT} refs/heads refs/remotes`]:
    'refs/heads/develop\x1f2026-10-01\x1fAMENDED\nrefs/heads/feat/open\x1f2026-10-01\x1fo2\n' };
  const h = await readHistory('C:/p/dev', { run: fakeRun(t) });
  assert.deepStrictEqual(h.lanes.map(u => [u.name, u.ahead, u.first]), [['feat/open', null, null]]);
  assert.strictEqual(h.merges[0].commits, null);
});

test('Dexter F2: a merged name whose ref moved on again is listed as a lane, with what it adds now', async () => {
  const t = { ...base,
    [`for-each-ref ${REF_FORMAT} refs/heads refs/remotes`]: 'refs/heads/develop\x1f2026-10-01\x1fd2\nrefs/heads/feat/a\x1f2026-10-02\x1fa2\n',
    [`log --all ${GRAPH_FORMAT}`]: rowsToGraph([
      ['a2', 'd2', 8, 'feat(a): round two'], ['d2', 'm1', 5, 'd two'],
      ['m1', 'a x1', 3, 'Merge pull request #3 from o/feat/a'], ['x1', 'a', 2, 'x one'], ['a', '', 1, 'root'],
    ]) };
  const h = await readHistory('C:/p/dev', { run: fakeRun(t) });
  assert.deepStrictEqual(h.merges.map(m => m.branch), ['feat/a']);
  assert.deepStrictEqual(h.lanes.map(u => [u.name, u.ahead, u.first]), [['feat/a', 1, 'feat(a): round two']]);
});
