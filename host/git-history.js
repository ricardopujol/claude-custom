'use strict';
/**
 * The git facts behind the git tree (documentation/DESIGN_GIT_TREE.md, PLAN_GIT_TREE.md): merges
 * into the integration branch, every ref, the worktrees.
 *
 * Read-only and NEVER fetches: the tree shows what this repo's refs already know. The parsers are
 * pure; readHistory runs git through an injected runner (host/branch-health.js pattern) with
 * LC_ALL=C, because git translates its messages and these parsers read its output.
 *
 * Records are split on ASCII unit/record separators (\x1f, \x1e), which never appear in a commit
 * subject or a ref name, so a PR title holding "|" or a newline in a body can't shift a field.
 */

const { execFile } = require('child_process');

const US = '\x1f';
const RS = '\x1e';
// The merge commit GitHub writes: subject "Merge pull request #N from owner/branch", body line 1 =
// the PR title. %P gives both parents; %b the body. Days are asked as `short-local`: plain `short`
// prints in the zone STORED in the commit, while the ledger's days are the viewer's local ones
// (host/branch-ledger.js localDay), so the two clocks only agree when both are local (PR #88 F1).
const MERGE_FORMAT = '--format=%H%x1f%ad%x1f%s%x1f%P%x1f%b%x1e';
const REF_FORMAT = '--format=%(refname)%1f%(committerdate:short-local)%1f%(objectname)';
const PR_MERGE = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)$/;
const BRANCH_MERGE = /^Merge branch '([^']+)'(?: into \S+)?$/;

function defaultRun(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/** `git log --merges --first-parent MERGE_FORMAT` -> [{ hash, date, pr|null, branch, title|null, parents }] */
function parseMerges(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const raw of text.split(RS)) {
    // git ends each record with a newline before the next one starts
    const r = raw.replace(/^[\r\n]+/, '');
    if (!r.trim()) continue;
    const [hash, date, subject = '', parents = '', body = ''] = r.split(US);
    const p = parents.trim().split(/\s+/).filter(Boolean);
    if (p.length < 2) continue;
    const s = subject.trim();
    let m = PR_MERGE.exec(s);
    let pr = null;
    let branch;
    if (m) { pr = Number(m[1]); branch = m[2]; }
    else if ((m = BRANCH_MERGE.exec(s))) branch = m[1];
    else continue;
    const title = body.split(/\r?\n/).map(l => l.trim()).find(Boolean) || null;
    out.push({ hash, date, pr, branch, title, parents: p.slice(0, 2) });
  }
  return out;
}

/** `git for-each-ref REF_FORMAT refs/heads refs/remotes` -> [{ name, ref, remote, date }] */
function parseRefs(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const [ref, date = '', tip = null] = line.split(US);
    if (!ref) continue;
    if (ref.startsWith('refs/heads/')) {
      out.push({ name: ref.slice('refs/heads/'.length), ref, remote: false, date, tip });
    } else if (ref.startsWith('refs/remotes/')) {
      // refs/remotes/<remote>/<branch...>: the branch may itself hold slashes
      const name = ref.split('/').slice(3).join('/');
      if (name && name !== 'HEAD') out.push({ name, ref, remote: true, date, tip });
    }
  }
  return out;
}

/** `git worktree list --porcelain` -> [{ path, branch|null }] (null: detached) */
function parseWorktrees(text) {
  if (typeof text !== 'string') return [];
  return text.split(/\r?\n\r?\n/).map(block => {
    const p = /^worktree (.+)$/m.exec(block);
    if (!p) return null;
    const b = /^branch refs\/heads\/(.+)$/m.exec(block);
    return { path: p[1].trim(), branch: b ? b[1].trim() : null };
  }).filter(Boolean);
}

/** The branch every lane merges into: develop, else main, else master; local refs only. */
function integrationOf(refs) {
  const local = new Set(refs.filter(r => !r.remote).map(r => r.name));
  return ['develop', 'main', 'master'].find(n => local.has(n)) || null;
}


// ---------- the commit graph: one git call instead of a spawn per branch ----------
//
// Asking git per branch (`rev-list --count p1..p2` per merge, two calls per lane) cost ~6s cold on
// this repo: ~110 spawns at ~55ms each on Windows, paid by every tab's host. One `git log --all`
// of hash/parents/time/subject holds all of it, and the counts below are linear walks over it.

const GRAPH_FORMAT = '--format=%H%x1f%P%x1f%ct%x1f%s';

function addGraphLine(g, line) {
  if (!line) return;
  const [hash, parents = '', time = '', subject = ''] = line.split(US);
  if (!hash) return;
  g.set(hash, { parents: parents.trim().split(/\s+/).filter(Boolean), time: Number(time) || 0, subject });
}

/** `git log --all GRAPH_FORMAT` -> Map(hash -> { parents, time, subject }) */
function parseGraph(text) {
  const g = new Map();
  if (typeof text !== 'string') return g;
  for (const line of text.split(/\r?\n/)) addGraphLine(g, line);
  return g;
}

// The same, yielding to the event loop every few thousand commits: on a big repo one synchronous
// parse could hold the host past the hook helper's 80ms connect timeout (PR #84 Miguel I3).
const GRAPH_BATCH = 5000;
async function parseGraphYielding(text) {
  const g = new Map();
  if (typeof text !== 'string') return g;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    addGraphLine(g, lines[i]);
    if (i % GRAPH_BATCH === GRAPH_BATCH - 1) await new Promise(resolve => setImmediate(resolve));
  }
  return g;
}

// Every commit reachable from `from` that isn't in `seen` (added to it). Iterative: a long history
// must not blow the stack.
function claim(g, from, seen) {
  const got = [];
  const stack = [from];
  while (stack.length) {
    const h = stack.pop();
    if (seen.has(h) || !g.has(h)) continue;
    seen.add(h);
    got.push(h);
    for (const p of g.get(h).parents) stack.push(p);
  }
  return got;
}

function firstParentChain(g, tip) {
  const chain = [];
  for (let h = tip; h && g.has(h); h = g.get(h).parents[0]) chain.push(h);
  return chain.reverse();
}

/**
 * Map(merge hash -> commits it brought in) for every merge on `tip`'s first-parent line; the
 * same number as `git rev-list --count p1..p2`. Walking the line oldest first, `seen` is exactly
 * everything reachable from the current first parent, so what a merge's other parents reach
 * beyond it is what the merge brought in.
 */
function mergeCounts(g, tip) {
  const out = new Map();
  const seen = new Set();
  for (const h of firstParentChain(g, tip)) {
    const { parents } = g.get(h);
    if (parents.length > 1) {
      let n = 0;
      for (const p of parents.slice(1)) n += claim(g, p, seen).length;
      out.set(h, n);
    }
    // the first parent was claimed one step earlier; this commit is the only new one on the line
    seen.add(h);
  }
  return out;
}

/**
 * { ahead, first } for a lane's tip against the integration tip: how many commits it has that the
 * integration branch doesn't (`rev-list --count I..L`), and the subject of the OLDEST non-merge
 * one -- what the branch set out to do; its newest is often "merge develop in". A tip the graph
 * doesn't hold is unknown: { ahead: null }.
 */
function laneFacts(g, integrationTip, laneTip, base = null) {
  if (!g.has(laneTip) || !g.has(integrationTip)) return { ahead: null, first: null };
  const inIntegration = base || new Set(claim(g, integrationTip, new Set()));
  // walked against the base without copying it: one copy per lane was O(lanes x commits) (Miguel I3)
  const own = [];
  const seen = new Set();
  const stack = [laneTip];
  while (stack.length) {
    const h = stack.pop();
    if (seen.has(h) || inIntegration.has(h) || !g.has(h)) continue;
    seen.add(h);
    own.push(h);
    for (const p of g.get(h).parents) stack.push(p);
  }
  // The FIRST commit is where the lane starts: a non-merge commit none of whose parents is the
  // lane's own. Picking by commit time alone broke on a rebase, where every commit shares one
  // time, and on clock skew (PR #84 Dexter F3). With several starts (it merged another lane in),
  // the older wins; a tie goes to the one found deepest from the tip.
  let first = null;
  let firstDepth = -1;
  own.forEach((h, depth) => {
    const c = g.get(h);
    if (c.parents.length > 1 || c.parents.some(p => seen.has(p))) return;
    if (first === null || c.time < g.get(first).time || (c.time === g.get(first).time && depth > firstDepth)) {
      first = h;
      firstDepth = depth;
    }
  });
  return { ahead: own.length, first: first ? g.get(first).subject.trim() || null : null };
}

function firstParentMerges(g, tip) {
  return firstParentChain(g, tip).filter(h => g.get(h).parents.length > 1).length;
}

const errorText = err => (err && err.message) || String(err);
const NOT_LANE_REFS = new Set(['develop', 'main', 'master']);

/**
 * { ok: true, integration, merges, lanes, worktrees, mainMerges } | { ok: false, error }
 * Four git calls whatever the number of branches. opts.run: (args, cwd) => Promise<stdout>.
 */
async function readHistory(cwd, { run = defaultRun } = {}) {
  let refs;
  let worktrees;
  let merges;
  let g;
  try {
    refs = parseRefs(await run(['for-each-ref', REF_FORMAT, 'refs/heads', 'refs/remotes'], cwd));
    worktrees = parseWorktrees(await run(['worktree', 'list', '--porcelain'], cwd));
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
  const integration = integrationOf(refs);
  if (!integration) return { ok: false, error: 'no develop, main or master branch' };
  try {
    merges = parseMerges(await run(['log', '--merges', '--first-parent', '--reverse', '--date=short-local',
      MERGE_FORMAT, integration], cwd));
    g = await parseGraphYielding(await run(['log', '--all', GRAPH_FORMAT], cwd));
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }

  const tipOf = name => (refs.find(r => !r.remote && r.name === name) || {}).tip || null;
  const integrationTip = tipOf(integration);
  const counts = mergeCounts(g, integrationTip);
  for (const m of merges) m.commits = counts.has(m.hash) ? counts.get(m.hash) : null;

  // A tip the graph doesn't hold (amended between two git calls) makes every count unknown --
  // an empty base would make each lane "ahead" by the whole history (PR #84 Dexter F11).
  const base = g.has(integrationTip) ? new Set(claim(g, integrationTip, new Set())) : null;
  const listed = new Set();
  const lanes = [];
  // EVERY ref is a lane, merged ones too: a merged name can be reused, and the model joins a lane
  // with its merges by name (PR #84 Dexter F2). for-each-ref sorts by refname, so refs/heads/*
  // come before refs/remotes/*: a local branch wins over its remote twin, which is skipped.
  for (const r of refs) {
    if (NOT_LANE_REFS.has(r.name) || listed.has(r.name)) continue;
    // left behind by Agent isolation worktrees (DESIGN_GIT_TREE.md decision 8)
    if (r.name.startsWith('worktree-agent-')) continue;
    listed.add(r.name);
    const { ahead, first } = r.tip && base ? laneFacts(g, integrationTip, r.tip, base) : { ahead: null, first: null };
    const wt = worktrees.find(w => w.branch === r.name);
    lanes.push({ name: r.name, remote: r.remote, date: r.date, ahead, first, worktree: wt ? wt.path : null });
  }

  const mainTip = integration !== 'main' ? tipOf('main') : null;
  const mainMerges = mainTip && g.has(mainTip) ? firstParentMerges(g, mainTip) : null;
  return { ok: true, integration, merges, lanes, worktrees, mainMerges };
}

module.exports = {
  parseMerges, parseRefs, parseWorktrees, parseGraph, integrationOf, mergeCounts, laneFacts, readHistory,
  defaultRun, MERGE_FORMAT, REF_FORMAT, GRAPH_FORMAT,
};
