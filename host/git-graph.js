'use strict';
/**
 * The commit graph behind the Git panel's "Graph" view (BACKLOG #2 follow-up; Ricardo's pick A, "lanes
 * and commits", documentation/DESIGN_ROUND_2026-10-09B.md round 9): the last 50 commits of the
 * integration branch, main and the open branches, each with the lane it sits in and the edges to its
 * parents.
 *
 * Read-only, never fetches. One `git log` of the chosen refs (plus two cheap ref reads) answers it, with
 * LC_ALL=C like host/git-history.js, whose runner and parsers it reuses. The lane assignment is a pure
 * function over the parsed log, with property tests (test/git-graph-properties.test.js).
 *
 * Lane assignment, in log order (children before parents; `--date-order` guarantees it): `active[i]` is
 * the hash lane i is waiting for. A commit takes the leftmost lane waiting for it (a tip takes a free
 * one) and frees the other lanes waiting for it; its first parent keeps its lane, every other parent gets
 * the lane already waiting for it or a new one. An edge records `via`, the lane it runs down, and `lane`,
 * where its parent finally sits: they differ only when two lanes were waiting for the same parent.
 */

const { defaultRun, parseRefs, integrationOf, REF_FORMAT } = require('./git-history');

const US = '\x1f';
const MAX_COMMITS = 50;
const MAX_OPEN = 8;
const LOG_FORMAT = '--format=%H%x1f%P%x1f%ct%x1f%an%x1f%s%x1f%D';

/** `%D` ("HEAD -> develop, origin/develop, tag: v1") -> the branch names; HEAD, tags and origin/HEAD are not lanes. */
function parseDecorations(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const raw of text.split(',')) {
    let name = raw.trim();
    if (name.startsWith('HEAD -> ')) name = name.slice('HEAD -> '.length);
    if (!name || name === 'HEAD' || name.startsWith('tag: ') || name.endsWith('/HEAD')) continue;
    out.push(name);
  }
  return out;
}

/** `git log LOG_FORMAT` -> [{ hash, parents, time|null, author, subject, refs }], in the order git gave. */
function parseLog(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    const [hash, parents = '', time = '', author = '', subject = '', refs = ''] = raw.split(US);
    if (!hash) continue;
    // an absent time is unknown, not the epoch (Number('') is 0)
    const t = /^\d+$/.test(time.trim()) ? Number(time) : null;
    out.push({ hash, parents: parents.trim().split(/\s+/).filter(Boolean), time: t, author, subject, refs: parseDecorations(refs) });
  }
  return out;
}

/**
 * commits (children before parents) -> { rows: [{ hash, lane, edges: [{ hash, row|null, via, lane, merge }] }],
 * laneCount, labels }. `row` is null for a parent outside the window; `labels[lane]` is the first branch name
 * seen on that lane, a local one in preference to a remote's.
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
    const waiting = [];
    active.forEach((h, i) => { if (h === commit.hash) waiting.push(i); });
    const lane = waiting.length ? waiting[0] : freeLane();
    for (const i of waiting) active[i] = null;
    const edges = [];
    [...new Set(commit.parents)].forEach((p, k) => {
      let via = active.indexOf(p);
      if (via < 0) {
        via = k === 0 ? lane : freeLane();
        active[via] = p;
      }
      edges.push({ hash: p, row: null, via, lane: via, merge: k > 0 });
    });
    rows.push({ hash: commit.hash, lane, edges });
    rowOf.set(commit.hash, r);
  });
  // the parent's final lane is known only once its row is placed
  for (const r of rows) {
    for (const e of r.edges) {
      if (rowOf.has(e.hash)) { e.row = rowOf.get(e.hash); e.lane = rows[e.row].lane; }
    }
  }
  const laneCount = rows.reduce((m, r) => Math.max(m, r.lane + 1, ...r.edges.map(e => Math.max(e.via, e.lane) + 1)), 0);
  const labels = Array.from({ length: laneCount }, () => null);
  list.forEach((commit, r) => {
    const lane = rows[r].lane;
    if (labels[lane] !== null || !commit.refs || !commit.refs.length) return;
    labels[lane] = commit.refs.find(n => !isRemoteName(n)) || commit.refs[0];
  });
  return { rows, laneCount, labels };
}

// A remote ref prints as <remote>/<branch>; a local branch may hold slashes too ("feat/x"), so the only
// safe tell is the remote name, which is always "origin" for the refs we ask for.
const isRemoteName = n => n.startsWith('origin/');

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

/**
 * { ok: true, integration, commits, laneCount, labels } | { ok: false, error }.
 * opts.run: (args, cwd) => Promise<stdout>. The open branches are the local ones not yet merged into the
 * integration branch, the newest MAX_OPEN of them; if git can't list them the graph still draws the
 * integration branch and main.
 */
async function readGraph(cwd, { run = defaultRun } = {}) {
  let refs;
  try {
    refs = parseRefs(await run(['for-each-ref', REF_FORMAT, 'refs/heads', 'refs/remotes'], cwd));
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
  const integration = integrationOf(refs);
  if (!integration) return { ok: false, error: 'no develop, main or master branch' };
  const local = new Map(refs.filter(r => !r.remote).map(r => [r.name, r]));
  let open = [];
  try {
    const out = await run(['branch', '--no-merged', integration, '--format=%(refname:short)'], cwd);
    open = String(out).split(/\r?\n/).map(s => s.trim()).filter(n => n && local.has(n) && !n.startsWith('worktree-agent-'));
  } catch { /* the integration branch and main are still worth drawing */ }
  open.sort((a, b) => (local.get(a).date < local.get(b).date ? 1 : local.get(a).date > local.get(b).date ? -1 : 0));
  const asked = [integration];
  if (integration !== 'main' && local.has('main')) asked.push('main');
  for (const n of open.slice(0, MAX_OPEN)) if (!asked.includes(n)) asked.push(n);
  let commits;
  try {
    commits = parseLog(await run(['log', '--date-order', `--max-count=${MAX_COMMITS}`, LOG_FORMAT, ...asked, '--'], cwd));
  } catch (err) {
    return { ok: false, error: errorText(err) };
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

module.exports = { parseLog, parseDecorations, assignLanes, buildGraph, readGraph, createGitGraphService,
  LOG_FORMAT, MAX_COMMITS, MAX_OPEN };
