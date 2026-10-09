'use strict';
/**
 * The commit graph behind the Git panel's "Graph" view (BACKLOG #2 follow-up; Ricardo's pick A, "lanes
 * and commits", documentation/DESIGN_ROUND_2026-10-09B.md round 9): the last 50 commits of the
 * integration branch, main and the open branches, each with the lane it sits in and the edges to its
 * parents.
 *
 * Read-only, never fetches. A `git log` of the chosen refs plus three cheap ref reads answer it, with
 * LC_ALL=C like host/git-history.js, whose runner and ref parser it reuses. The lane assignment is a pure
 * function over the parsed log, with property tests (test/git-graph-properties.test.js).
 *
 * Chips (the branch names on a commit) come from `for-each-ref`, never from the log's `%D`: `%D` lists
 * every ref at the commit, `grafted` on a shallow clone, and splits a branch name at its commas.
 *
 * Lane assignment, in log order (children before parents; `--date-order` guarantees it): `active[i]` is the
 * hash lane i is waiting for, and no hash is waited for twice. A commit takes the lane waiting for it (a tip
 * takes a free one); its first parent keeps that lane, every other parent gets the lane already waiting for
 * it or a free one.
 */

const { defaultRun, parseRefs, integrationOf, REF_FORMAT } = require('./git-history');

const US = '\x1f';
const MAX_COMMITS = 50;
const MAX_OPEN = 8;
// How many of the newest remote-reachable commits are read to tell which window commits are on a remote.
const MAX_PUSHED_SCAN = 2000;
// The subject is LAST: it is free text, so a stray separator in it cannot shift another field.
const LOG_FORMAT = '--format=%H%x1f%P%x1f%ct%x1f%an%x1f%s';

/** `git log LOG_FORMAT` -> [{ hash, parents, time|null, author, subject, refs: [] }], in the order git gave. */
function parseLog(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    const [hash, parents = '', time = '', author = '', ...subject] = raw.split(US);
    if (!hash) continue;
    // an absent time is unknown, not the epoch (Number('') is 0)
    const t = /^\d+$/.test(time.trim()) ? Number(time) : null;
    out.push({ hash, parents: parents.trim().split(/\s+/).filter(Boolean), time: t, author, subject: subject.join(US), refs: [] });
  }
  return out;
}

/**
 * commits (children before parents) -> { rows: [{ hash, lane, edges: [{ hash, row|null, lane, merge }] }],
 * laneCount, labels }. `row` is null for a parent outside the window; `labels[lane]` is the first branch
 * ({ name, remote } in `commit.refs`) seen on that lane, a local one in preference to a remote's.
 */
function assignLanes(commits) {
  const list = Array.isArray(commits) ? commits : [];
  const active = [];
  const freeLane = () => {
    const i = active.indexOf(null);
    if (i >= 0) return i;
    active.push(null);
    return active.length - 1;
  };
  const rows = [];
  const rowOf = new Map();
  list.forEach((commit, r) => {
    const waiting = active.indexOf(commit.hash);
    const lane = waiting >= 0 ? waiting : freeLane();
    active[lane] = null;
    const edges = [];
    [...new Set(commit.parents)].forEach((p, k) => {
      let at = active.indexOf(p);
      if (at < 0) {
        at = k === 0 ? lane : freeLane();
        active[at] = p;
      }
      edges.push({ hash: p, row: null, lane: at, merge: k > 0 });
    });
    rows.push({ hash: commit.hash, lane, edges });
    rowOf.set(commit.hash, r);
  });
  for (const r of rows) {
    for (const e of r.edges) if (rowOf.has(e.hash)) e.row = rowOf.get(e.hash);
  }
  const laneCount = rows.reduce((m, r) => Math.max(m, r.lane + 1, ...r.edges.map(e => e.lane + 1)), 0);
  const labels = Array.from({ length: laneCount }, () => null);
  list.forEach((commit, r) => {
    const lane = rows[r].lane;
    const refs = Array.isArray(commit.refs) ? commit.refs : [];
    if (labels[lane] !== null || !refs.length) return;
    labels[lane] = (refs.find(x => !x.remote) || refs[0]).name;
  });
  return { rows, laneCount, labels };
}

/** commits -> { commits: [commit + lane + edges], laneCount, labels } */
function buildGraph(commits) {
  const g = assignLanes(commits);
  return {
    commits: (Array.isArray(commits) ? commits : []).map((c, i) => ({ ...c, lane: g.rows[i].lane, edges: g.rows[i].edges })),
    laneCount: g.laneCount,
    labels: g.labels,
  };
}

const errorText = err => (err && err.message) || String(err);

/** hash -> [{ name, remote }]: the branches at each tip, local ones first (for-each-ref lists refs/heads before refs/remotes). */
function chipsByTip(refs) {
  const out = new Map();
  for (const r of refs) {
    if (!r.tip || r.name.startsWith('worktree-agent-')) continue;
    const name = r.remote ? r.ref.slice('refs/remotes/'.length) : r.name;
    if (!out.has(r.tip)) out.set(r.tip, []);
    out.get(r.tip).push({ name, remote: r.remote });
  }
  return out;
}

/**
 * { ok: true, integration, commits, laneCount, labels } | { ok: false, error }.
 * opts.run: (args, cwd) => Promise<stdout>. The open branches are the local ones not yet merged into the
 * integration branch, the newest MAX_OPEN of them in git's own order (`--sort=-committerdate`: the full
 * timestamp, not the day); if git can't list them the graph still draws the integration branch and main.
 * Each commit says whether a remote ref reaches it (`pushed`: true, false, or null when git couldn't say).
 * A repo with no ref at all (no commit yet) is an empty graph.
 */
async function readGraph(cwd, { run = defaultRun } = {}) {
  let refs;
  try {
    refs = parseRefs(await run(['for-each-ref', REF_FORMAT, 'refs/heads', 'refs/remotes'], cwd));
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
  if (!refs.length) return { ok: true, integration: null, commits: [], laneCount: 0, labels: [] };
  const integration = integrationOf(refs);
  if (!integration) return { ok: false, error: 'no develop, main or master branch' };
  const local = new Set(refs.filter(r => !r.remote).map(r => r.name));
  let open = [];
  try {
    const out = await run(['branch', '--no-merged', integration, '--sort=-committerdate', '--format=%(refname:short)'], cwd);
    open = String(out).split(/\r?\n/).map(s => s.trim()).filter(n => n && local.has(n) && !n.startsWith('worktree-agent-'));
  } catch { /* the integration branch and main are still worth drawing */ }
  const wanted = [integration];
  if (integration !== 'main' && local.has('main')) wanted.push('main');
  for (const n of open.slice(0, MAX_OPEN)) if (!wanted.includes(n)) wanted.push(n);
  let commits;
  try {
    commits = parseLog(await run(['log', '--date-order', `--max-count=${MAX_COMMITS}`, LOG_FORMAT, ...wanted, '--'], cwd));
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
  const chips = chipsByTip(refs);
  let pushed = null;
  let capped = false;
  if (commits.length) {
    try {
      const lines = String(await run(['rev-list', '--remotes', `--max-count=${MAX_PUSHED_SCAN}`], cwd)).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      pushed = new Set(lines);
      // a scan that hit its cap is cut off: a commit missing from it may simply be older than the newest MAX_PUSHED_SCAN
      capped = lines.length >= MAX_PUSHED_SCAN;
    } catch { /* unknown, not "not pushed" */ }
  }
  for (const c of commits) {
    c.refs = chips.get(c.hash) || [];
    c.pushed = !pushed ? null : pushed.has(c.hash) ? true : capped ? null : false;
  }
  return { ok: true, integration, ...buildGraph(commits) };
}

/** What the host answers to `{type:'git-graph'}`: overlapping asks share one read; nothing here throws. */
function createGitGraphService(d) {
  let inFlight = null;
  function get() {
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(() => d.read(d.cwd))
        .catch(err => ({ ok: false, error: errorText(err) }))
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  }
  return { get };
}

module.exports = { parseLog, assignLanes, buildGraph, readGraph, createGitGraphService,
  LOG_FORMAT, MAX_COMMITS, MAX_OPEN, MAX_PUSHED_SCAN };
