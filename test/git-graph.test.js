'use strict';
/**
 * The commit graph's host side (BACKLOG #2 follow-up, "Graph" next to Rings): the log parser, the
 * lane assignment, and the reader that asks git for the last 50 commits of develop, main and the
 * open branches. Properties of the lanes are in git-graph-properties.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const { parseLog, assignLanes, buildGraph, readGraph, createGitGraphService,
  LOG_FORMAT, MAX_COMMITS, MAX_OPEN, MAX_PUSHED_SCAN } = require('../host/git-graph');

const US = '\x1f';
const line = (hash, parents, time, author, subject) => [hash, parents, time, author, subject].join(US);
const c = (hash, ...parents) => ({ hash, parents, time: 0, author: 'a', subject: hash, refs: [] });
const ref = (name, remote = false) => ({ name, remote });

test('parseLog reads hash, parents, time, author and subject; skips blank and hash-less lines', () => {
  const text = [
    line('aaa', 'bbb ccc', '1700000100', 'Ann', 'Merge pull request #5 from o/feat-x'),
    '',
    line('bbb', 'ddd', '1700000050', 'Bo', 'a subject with | pipes'),
    line('', 'x', '1', 'z', 'no hash'),
    line('ddd', '', '1700000000', 'Cy', 'root'),
  ].join('\n');
  const got = parseLog(text);
  assert.deepStrictEqual(got.map(x => x.hash), ['aaa', 'bbb', 'ddd']);
  assert.deepStrictEqual(got[0].parents, ['bbb', 'ccc']);
  assert.strictEqual(got[0].time, 1700000100);
  assert.strictEqual(got[0].author, 'Ann');
  assert.deepStrictEqual(got[0].refs, []);
  assert.strictEqual(got[1].subject, 'a subject with | pipes');
  assert.deepStrictEqual(got[2].parents, []);
});

test('a unit separator inside a subject stays in the subject (the subject is the last field)', () => {
  const [one] = parseLog(['h', '', '1', 'a', 'fix\x1ffeat/a'].join(US));
  assert.strictEqual(one.subject, 'fix\x1ffeat/a');
  assert.deepStrictEqual(one.refs, []);
});

test('parseLog copes with CRLF and with input that is not text', () => {
  assert.strictEqual(parseLog(line('a', '', '1', 'x', 's') + '\r\n' + line('b', 'a', '2', 'x', 't') + '\r\n').length, 2);
  assert.deepStrictEqual(parseLog(null), []);
  assert.deepStrictEqual(parseLog(42), []);
});

test('a missing or garbled time is unknown (null), never 0', () => {
  const [a, b] = parseLog([line('a', '', '', 'x', 's'), line('b', '', 'soon', 'x', 's')].join('\n'));
  assert.strictEqual(a.time, null);
  assert.strictEqual(b.time, null);
});

test('assignLanes: a straight line is one lane, each commit points at the next', () => {
  const g = assignLanes([c('a', 'b'), c('b', 'c'), c('c')]);
  assert.strictEqual(g.laneCount, 1);
  assert.deepStrictEqual(g.rows.map(r => r.lane), [0, 0, 0]);
  assert.deepStrictEqual(g.rows[0].edges, [{ hash: 'b', row: 1, lane: 0, merge: false }]);
  assert.deepStrictEqual(g.rows[2].edges, []);
});

test('assignLanes: a merge opens a second lane and both lines converge on their shared parent', () => {
  //  m (merge of d and f)   d-> base   f-> base
  const g = assignLanes([c('m', 'd', 'f'), c('f', 'base'), c('d', 'base'), c('base')]);
  const lane = Object.fromEntries(g.rows.map(r => [r.hash, r.lane]));
  assert.strictEqual(lane.m, 0);
  assert.strictEqual(lane.d, 0);
  assert.strictEqual(lane.f, 1);
  assert.strictEqual(lane.base, 1, 'f reached base first, so base takes the lane f was running down');
  assert.strictEqual(g.laneCount, 2);
  assert.deepStrictEqual(g.rows[0].edges.map(e => [e.hash, e.merge, e.lane]), [['d', false, 0], ['f', true, 1]]);
  // f runs down lane 1 to base; d, on lane 0, crosses over to the same parent
  assert.deepStrictEqual(g.rows[1].edges, [{ hash: 'base', row: 3, lane: 1, merge: false }]);
  assert.deepStrictEqual(g.rows[2].edges, [{ hash: 'base', row: 3, lane: 1, merge: false }]);
});

test('assignLanes: a parent past the window has no row and still has a lane', () => {
  const g = assignLanes([c('a', 'gone'), c('b', 'gone2')]);
  assert.strictEqual(g.rows[0].edges[0].row, null);
  assert.strictEqual(g.rows[0].edges[0].lane, 0);
  assert.strictEqual(g.rows[1].lane, 1);
});

test('assignLanes: two tips are two lanes; a lane is labelled by the first local branch on it, else a remote one', () => {
  const a = { ...c('a', 'x'), refs: [ref('develop')] };
  const b = { ...c('b', 'y'), refs: [ref('origin/feat/y', true), ref('feat/y')] };
  const d = { ...c('d', 'z'), refs: [ref('origin/only-remote', true)] };
  const g = assignLanes([a, b, d, c('x')]);
  assert.deepStrictEqual(g.labels, ['develop', 'feat/y', 'origin/only-remote']);
});

test('assignLanes: duplicate parents and empty input are harmless', () => {
  const g = assignLanes([c('a', 'b', 'b'), c('b')]);
  assert.strictEqual(g.rows[0].edges.length, 1);
  assert.deepStrictEqual(assignLanes([]), { rows: [], laneCount: 0, labels: [] });
  assert.deepStrictEqual(assignLanes(null), { rows: [], laneCount: 0, labels: [] });
});

test('buildGraph joins commits and rows, one entry per commit', () => {
  const g = buildGraph([c('a', 'b'), c('b')]);
  assert.strictEqual(g.commits.length, 2);
  assert.strictEqual(g.commits[0].hash, 'a');
  assert.strictEqual(g.commits[0].lane, 0);
  assert.deepStrictEqual(g.commits[0].edges.map(e => e.hash), ['b']);
  assert.strictEqual(g.laneCount, 1);
});

// ---------- readGraph ----------

const REFS = [
  'refs/heads/develop\x1f2026-10-09\x1faaa',
  'refs/heads/feat/old\x1f2026-09-01\x1fbbb',
  'refs/heads/feat/new\x1f2026-10-08\x1fccc',
  'refs/heads/main\x1f2026-10-01\x1fddd',
  'refs/heads/worktree-agent-1\x1f2026-10-09\x1feee',
  'refs/remotes/origin/develop\x1f2026-10-09\x1faaa',
  'refs/remotes/upstream/feat/remote-only\x1f2026-10-07\x1fccc',
].join('\n');

function fakeGit(over = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'for-each-ref') return over.refs !== undefined ? over.refs : REFS;
    if (args[0] === 'branch') {
      const newestFirst = (over.noMerged !== undefined ? over.noMerged : 'feat/new\nfeat/old\nworktree-agent-1\n').split('\n').filter(Boolean);
      // git lists alphabetically unless it is told to sort by the commit time
      return (args.includes('--sort=-committerdate') ? newestFirst : [...newestFirst].sort()).join('\n');
    }
    if (args[0] === 'rev-list') {
      if (over.revList instanceof Error) throw over.revList;
      return over.revList !== undefined ? over.revList : 'aaa\nzzz\n';
    }
    if (args[0] === 'log') {
      return over.log !== undefined ? over.log : [line('aaa', 'zzz', '5', 'A', 's'), line('ccc', 'zzz', '4', 'A', 'on feat'), line('zzz', '', '3', 'A', 'root')].join('\n');
    }
    throw new Error('unexpected ' + args.join(' '));
  };
  return { run, calls };
}
const asked = log => log.slice(log.indexOf(LOG_FORMAT) + 1, log.indexOf('--'));

test('readGraph asks for the integration branch, main, and the open branches in git\'s own newest-first order, 50 commits at most', async () => {
  const { run, calls } = fakeGit();
  const r = await readGraph('C:\\p', { run });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.integration, 'develop');
  const branch = calls.find(a => a[0] === 'branch');
  assert.ok(branch.includes('--sort=-committerdate'), 'ordered by the full timestamp, not the day');
  const log = calls.find(a => a[0] === 'log');
  assert.ok(log.includes(`--max-count=${MAX_COMMITS}`));
  assert.ok(log.includes('--date-order'));
  assert.ok(log.includes(LOG_FORMAT));
  assert.deepStrictEqual(asked(log), ['develop', 'main', 'feat/new', 'feat/old']);
  assert.ok(!log.includes('worktree-agent-1'));
  assert.strictEqual(MAX_COMMITS, 50);
  assert.strictEqual(r.commits.length, 3);
});

test('the log asks for no decorations: its format has no %D', () => {
  assert.ok(!LOG_FORMAT.includes('%D'));
  assert.ok(LOG_FORMAT.endsWith('%s'), 'the subject is the last field');
});

test('nine unmerged branches on one day: the newest by time is kept, the last of git\'s order is dropped', async () => {
  const names = Array.from({ length: MAX_OPEN + 1 }, (_, i) => `feat/${String.fromCharCode(97 + i)}`);
  const newest = 'zz/hotfix';
  const all = [newest, ...names];
  const refs = ['refs/heads/develop\x1f2026-10-09\x1faaa']
    .concat(all.map((n, i) => `refs/heads/${n}\x1f2026-10-09\x1f${i}`)).join('\n');
  const { run, calls } = fakeGit({ refs, noMerged: all.join('\n') });
  await readGraph('C:\\p', { run });
  const got = asked(calls.find(a => a[0] === 'log'));
  assert.strictEqual(got.length, 1 + MAX_OPEN, 'develop and the newest MAX_OPEN');
  assert.ok(got.includes(newest));
  assert.ok(!got.includes(names[names.length - 1]), 'the one git listed last is the one dropped');
});

test('readGraph with no develop uses main alone and does not ask for it twice', async () => {
  const refs = 'refs/heads/main\x1f2026-10-09\x1faaa';
  const { run, calls } = fakeGit({ refs, noMerged: '' });
  const r = await readGraph('C:\\p', { run });
  assert.strictEqual(r.integration, 'main');
  assert.deepStrictEqual(asked(calls.find(a => a[0] === 'log')), ['main']);
});

test('readGraph says so when there is no integration branch, or git fails', async () => {
  const none = await readGraph('C:\\p', { run: fakeGit({ refs: 'refs/heads/feat/x\x1f2026-10-09\x1faaa' }).run });
  assert.strictEqual(none.ok, false);
  assert.match(none.error, /develop, main or master/);
  const boom = await readGraph('C:\\p', { run: async () => { throw new Error('not a git repository'); } });
  assert.deepStrictEqual(boom, { ok: false, error: 'not a git repository' });
});

test('a failing `branch --no-merged` still draws the integration branch and main', async () => {
  const f = fakeGit();
  const run = async (args, cwd) => { if (args[0] === 'branch') throw new Error('x'); return f.run(args, cwd); };
  const r = await readGraph('C:\\p', { run });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(asked(f.calls.find(a => a[0] === 'log')), ['develop', 'main']);
});

test('a repo with no commit yet (an unborn branch has no ref) is an empty graph, not an error', async () => {
  const f = fakeGit({ refs: '', log: '' });
  const r = await readGraph('C:\\p', { run: f.run });
  assert.deepStrictEqual(r, { ok: true, integration: null, commits: [], laneCount: 0, labels: [] });
  assert.ok(!f.calls.some(a => a[0] === 'log'), 'nothing to ask for');
});

test('chips come from the refs git listed: local branches plain, any remote marked, scratch refs and HEAD left out', async () => {
  const r = await readGraph('C:\\p', { run: fakeGit().run });
  const byHash = Object.fromEntries(r.commits.map(x => [x.hash, x.refs]));
  assert.deepStrictEqual(byHash.aaa, [ref('develop'), ref('origin/develop', true)]);
  assert.deepStrictEqual(byHash.ccc, [ref('feat/new'), ref('upstream/feat/remote-only', true)]);
  assert.deepStrictEqual(byHash.zzz, []);
  const odd = await readGraph('C:\\p', { run: fakeGit({ refs: ['refs/heads/develop\x1f2026-10-09\x1faaa', 'refs/heads/feat/a,b\x1f2026-10-09\x1faaa', 'refs/heads/worktree-agent-9\x1f2026-10-09\x1faaa'].join('\n'),
    noMerged: '', log: line('aaa', '', '1', 'A', 's') }).run });
  assert.deepStrictEqual(odd.commits[0].refs, [ref('develop'), ref('feat/a,b')], 'a comma in a branch name stays one chip');
});

test('a commit is "pushed" when a remote ref reaches it; unknown when git could not say', async () => {
  const f = fakeGit({ revList: 'aaa\nzzz\n' });
  const r = await readGraph('C:\\p', { run: f.run });
  assert.deepStrictEqual(r.commits.map(x => [x.hash, x.pushed]), [['aaa', true], ['ccc', false], ['zzz', true]]);
  const rl = f.calls.find(a => a[0] === 'rev-list');
  assert.ok(rl.includes('--remotes') && rl.includes(`--max-count=${MAX_PUSHED_SCAN}`));
  const unknown = await readGraph('C:\\p', { run: fakeGit({ revList: new Error('x') }).run });
  assert.deepStrictEqual(unknown.commits.map(x => x.pushed), [null, null, null]);
});

test('a repo with no remote has no pushed commit: every commit is "not pushed" (the strip has no address anyway)', async () => {
  const r = await readGraph('C:\\p', { run: fakeGit({ revList: '' }).run });
  assert.deepStrictEqual(r.commits.map(x => x.pushed), [false, false, false]);
});

// ---------- the service ----------

test('the service shares one read between overlapping asks and never rejects', async () => {
  let n = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const svc = createGitGraphService({ cwd: 'x', read: async () => { n++; await gate; return { ok: true, commits: [] }; } });
  const a = svc.get();
  const b = svc.get();
  release();
  assert.deepStrictEqual(await a, await b);
  assert.strictEqual(n, 1);
  await svc.get();
  assert.strictEqual(n, 2, 'a finished read is not cached');
  const bad = createGitGraphService({ cwd: 'x', read: async () => { throw new Error('boom'); } });
  assert.deepStrictEqual(await bad.get(), { ok: false, error: 'boom' });
});

test('`git-graph` is on the control allow-list: off it, the panel\'s ask would be TYPED into the session as JSON', () => {
  const { CONTROL_TYPES, parseControlFrame } = require('../host/control');
  assert.ok(CONTROL_TYPES.has('git-graph'));
  assert.deepStrictEqual(parseControlFrame(JSON.stringify({ type: 'git-graph' })), { type: 'git-graph' });
});

test('a scan that hit its cap never reads absence as "not pushed" (a local branch far behind a fetched origin)', async () => {
  const flood = Array.from({ length: MAX_PUSHED_SCAN }, (_, i) => `f${i}`).join('\n');
  const capped = await readGraph('C:\p', { run: fakeGit({ revList: flood }).run });
  assert.deepStrictEqual(capped.commits.map(x => x.pushed), [null, null, null], 'none of the window is in the newest 2000: unknown');
  const seen = await readGraph('C:\p', { run: fakeGit({ revList: `${flood}\naaa` }).run });
  assert.strictEqual(seen.commits.find(x => x.hash === 'aaa').pushed, true, 'a hit is still a hit');
  const one = await readGraph('C:\p', { run: fakeGit({ revList: flood.split('\n').slice(1).join('\n') }).run });
  assert.deepStrictEqual(one.commits.map(x => x.pushed), [false, false, false], 'one under the cap is a complete scan');
});
