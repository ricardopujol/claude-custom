'use strict';
/**
 * The commit graph's host side (BACKLOG #2 follow-up, "Graph" next to Rings): the log parser, the
 * lane assignment, and the reader that asks git for the last 50 commits of develop, main and the
 * open branches. Properties of the lanes are in git-graph-properties.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const { parseLog, parseDecorations, assignLanes, buildGraph, readGraph, createGitGraphService,
  LOG_FORMAT, MAX_COMMITS, MAX_OPEN } = require('../host/git-graph');

const US = '\x1f';
const line = (hash, parents, time, author, subject, refs = '') => [hash, parents, time, author, subject, refs].join(US);
const c = (hash, ...parents) => ({ hash, parents, time: 0, author: 'a', subject: hash, refs: [] });

test('parseDecorations keeps branches, drops HEAD, tags and the remote HEAD', () => {
  assert.deepStrictEqual(parseDecorations('HEAD -> develop, origin/develop, tag: v1.0, origin/HEAD, feat/x'),
    ['develop', 'origin/develop', 'feat/x']);
  assert.deepStrictEqual(parseDecorations(''), []);
  assert.deepStrictEqual(parseDecorations('HEAD'), []);
  assert.deepStrictEqual(parseDecorations(undefined), []);
});

test('parseLog reads hash, parents, time, author, subject and refs; skips blank and hash-less lines', () => {
  const text = [
    line('aaa', 'bbb ccc', '1700000100', 'Ann', 'Merge pull request #5 from o/feat-x', 'HEAD -> develop'),
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
  assert.deepStrictEqual(got[0].refs, ['develop']);
  assert.strictEqual(got[1].subject, 'a subject with | pipes');
  assert.deepStrictEqual(got[2].parents, []);
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
  assert.deepStrictEqual(g.rows[0].edges, [{ hash: 'b', row: 1, via: 0, lane: 0, merge: false }]);
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
  const mEdges = g.rows[0].edges;
  assert.deepStrictEqual(mEdges.map(e => [e.hash, e.merge, e.lane]), [['d', false, 0], ['f', true, 1]]);
  // f runs down lane 1 to base; d, on lane 0, crosses over to the same parent
  assert.deepStrictEqual(g.rows[1].edges, [{ hash: 'base', row: 3, via: 1, lane: 1, merge: false }]);
  assert.deepStrictEqual(g.rows[2].edges, [{ hash: 'base', row: 3, via: 1, lane: 1, merge: false }]);
});

test('assignLanes: a parent past the window has no row and still has a lane', () => {
  const g = assignLanes([c('a', 'gone'), c('b', 'gone2')]);
  assert.strictEqual(g.rows[0].edges[0].row, null);
  assert.strictEqual(g.rows[0].edges[0].lane, 0);
  assert.strictEqual(g.rows[1].lane, 1);
});

test('assignLanes: two tips are two lanes; labels come from the refs on a lane\'s first labelled commit', () => {
  const a = { ...c('a', 'x'), refs: ['develop'] };
  const b = { ...c('b', 'x'), refs: ['origin/feat/y', 'feat/y'] };
  const g = assignLanes([a, b, c('x')]);
  assert.deepStrictEqual(g.labels, ['develop', 'feat/y']);
});

test('assignLanes: duplicate parents and empty input are harmless', () => {
  const g = assignLanes([c('a', 'b', 'b'), c('b')]);
  assert.strictEqual(g.rows[0].edges.length, 1);
  assert.deepStrictEqual(assignLanes([]), { rows: [], laneCount: 0, labels: [] });
  assert.deepStrictEqual(assignLanes(null), { rows: [], laneCount: 0, labels: [] });
});

test('buildGraph joins commits and rows, one entry per commit', () => {
  const commits = [c('a', 'b'), c('b')];
  const g = buildGraph(commits);
  assert.strictEqual(g.commits.length, 2);
  assert.strictEqual(g.commits[0].hash, 'a');
  assert.strictEqual(g.commits[0].lane, 0);
  assert.deepStrictEqual(g.commits[0].edges.map(e => e.hash), ['b']);
  assert.strictEqual(g.laneCount, 1);
});

// ---------- readGraph ----------

function fakeGit(over = {}) {
  const calls = [];
  const refs = over.refs || [
    'refs/heads/develop\x1f2026-10-09\x1faaa',
    'refs/heads/feat/old\x1f2026-09-01\x1fbbb',
    'refs/heads/feat/new\x1f2026-10-08\x1fccc',
    'refs/heads/main\x1f2026-10-01\x1fddd',
    'refs/heads/worktree-agent-1\x1f2026-10-09\x1feee',
    'refs/remotes/origin/feat/remote-only\x1f2026-10-07\x1ffff',
  ].join('\n');
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'for-each-ref') return refs;
    if (args[0] === 'branch') return over.noMerged !== undefined ? over.noMerged : 'feat/old\nfeat/new\nworktree-agent-1\n';
    if (args[0] === 'log') return over.log !== undefined ? over.log : [line('aaa', 'zzz', '5', 'A', 's', 'HEAD -> develop'), line('zzz', '', '4', 'A', 'root')].join('\n');
    throw new Error('unexpected ' + args.join(' '));
  };
  return { run, calls };
}

test('readGraph asks for the integration branch, main, and the newest open branches, 50 commits at most', async () => {
  const { run, calls } = fakeGit();
  const r = await readGraph('C:\\p', { run });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.integration, 'develop');
  const log = calls.find(a => a[0] === 'log');
  assert.ok(log.includes(`--max-count=${MAX_COMMITS}`));
  assert.ok(log.includes('--date-order'));
  assert.ok(log.includes(LOG_FORMAT));
  assert.deepStrictEqual(log.slice(log.indexOf('develop'), log.indexOf('--')), ['develop', 'main', 'feat/new', 'feat/old']);
  assert.ok(!log.includes('worktree-agent-1'));
  assert.strictEqual(MAX_COMMITS, 50);
  assert.strictEqual(r.commits.length, 2);
});

test('readGraph caps open branches at MAX_OPEN, newest first', async () => {
  const names = Array.from({ length: MAX_OPEN + 4 }, (_, i) => `feat/b${i}`);
  const refs = ['refs/heads/develop\x1f2026-10-09\x1faaa']
    .concat(names.map((n, i) => `refs/heads/${n}\x1f2026-09-${String(10 + i).padStart(2, '0')}\x1f${i}`)).join('\n');
  const { run, calls } = fakeGit({ refs, noMerged: names.join('\n') });
  await readGraph('C:\\p', { run });
  const log = calls.find(a => a[0] === 'log');
  const asked = log.slice(log.indexOf('develop') + 1, log.indexOf('--'));
  assert.strictEqual(asked.length, MAX_OPEN);
  assert.strictEqual(asked[0], `feat/b${MAX_OPEN + 3}`);
});

test('readGraph with no develop uses main alone and does not ask for it twice', async () => {
  const refs = 'refs/heads/main\x1f2026-10-09\x1faaa';
  const { run, calls } = fakeGit({ refs, noMerged: '' });
  const r = await readGraph('C:\\p', { run });
  assert.strictEqual(r.integration, 'main');
  const log = calls.find(a => a[0] === 'log');
  assert.deepStrictEqual(log.slice(log.indexOf('main'), log.indexOf('--')), ['main']);
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
  const log = f.calls.find(a => a[0] === 'log');
  assert.deepStrictEqual(log.slice(log.indexOf('develop'), log.indexOf('--')), ['develop', 'main']);
});

test('an empty repo (no commits) is an empty graph, not an error', async () => {
  const r = await readGraph('C:\\p', { run: fakeGit({ log: '' }).run });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.commits, []);
  assert.strictEqual(r.laneCount, 0);
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
