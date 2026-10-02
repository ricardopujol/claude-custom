'use strict';
/**
 * The git tree's model (documentation/DESIGN_GIT_TREE.md, PLAN_GIT_TREE.md Task 7, G4-G7). Pure:
 * git facts (host/git-history.js) + the ledger's totals (host/branch-ledger.js) + open PRs
 * (host/open-prs.js) -> one entry per branch:
 *
 *   { name, state, place, pr, remote, why, when, commits, spend, runs, people }
 *
 *   state  merged | open | unmerged | deleted -- what happened to it (the spoke's color)
 *   place  worktree | had-worktree | dev     -- where it was worked on (the tip's shape)
 *   spend  tokens spent, or NULL when nothing was recorded: unknown, never 0
 *   why    what it was for, 15 words at most, or null
 *
 * and for the tree: { hub: { spend, people }, totalSpend, prsKnown }. totalSpend is EXACTLY every
 * token that's ours (all spend inside the project, plus loose spend on lanes git knows), or null
 * when nothing was recorded at all.
 *
 * Branch names are data (PR #84 Miguel B2): every lookup by name goes through getOwn, so a branch
 * called `constructor` finds its own total, never Object's.
 */

const path = require('path');
const { samePath, isInside } = require('./project-layout');

// Never a spoke; their spend is the hub's. The integration branch IS the hub, `HEAD` is a detached
// checkout, main/master are where releases land, and worktree-agent-* were agents' scratch
// checkouts (PR #84 Dexter F13: dropping them lost spend from the total).
const HUB_NAMES = new Set(['develop', 'main', 'master', 'HEAD']);
const SCRATCH = /^worktree-agent-/;
const isHubName = (name, integration) => HUB_NAMES.has(name) || name === integration || SCRATCH.test(name);
const MAX_WORDS = 15;

const getOwn = (o, k) => (o != null && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** "feat(layout): dock zones -- and more" -> "Dock zones: and more", 15 words at most. */
function purpose(title) {
  if (typeof title !== 'string') return null;
  let s = title.trim().replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '').replace(/\s+--\s+/g, ': ').trim();
  if (!s) return null;
  const words = s.split(/\s+/);
  if (words.length > MAX_WORDS) s = words.slice(0, MAX_WORDS).join(' ').replace(/[,;:]$/, '') + '…';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Agent types are a mix of roles ("logic-reviewer") and named teammates spawned for one job
// ("dexter-pr69", "Miguel-pr42"). Both fold to the person Ricardo knows; anything else is itself.
const PEOPLE = [
  [/^(logic-reviewer|dexter)/i, 'Dexter'],
  [/^(code-reviewer|miguel)/i, 'Miguel'],
  [/^(mutation-tester|mortimer)/i, 'Mortimer'],
  [/^(agent-organizer|paris)/i, 'Paris'],
  [/^(display-integrity-auditor|vera)/i, 'Vera'],
  [/^(ui-ux-tester|naomi)/i, 'Naomi'],
  [/^doc-auditor$/i, 'Dewey'],
  [/^(general-purpose|claude|fork|unknown)$/i, 'general'],
];
function personOf(agentType) {
  const hit = PEOPLE.find(([re]) => re.test(agentType));
  return hit ? hit[1] : agentType;
}

/**
 * runs -> people. A run's loose spend counts only where loose spend is ours (`withLoose`); a run that
 * was ONLY loose spend somewhere it isn't ours is not one of this branch's people (PR #84 Dexter F7).
 */
function peopleOf(runs, withLoose) {
  const by = new Map();
  for (const r of runs) {
    const spend = r.spend + (withLoose ? r.loose || 0 : 0);
    if (spend === 0 && r.spend === 0 && (r.loose || 0) > 0) continue;
    const name = personOf(r.agentType);
    const p = by.get(name) || { name, runs: 0, spend: 0 };
    p.runs += 1;
    p.spend += spend;
    by.set(name, p);
  }
  return [...by.values()].sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
}

// <root>\feat-x for feat/x: the worktree layout's folder for a branch (host/project-layout.js)
const laneFolder = (root, name) => path.join(root, name.replace(/\//g, '-'));

function placeOf(name, t, worktrees, projectRoot) {
  if (worktrees.some(w => w.branch === name)) return 'worktree';
  const own = laneFolder(projectRoot, name);
  if (t && t.cwds.some(c => samePath(c, own) || isInside(c, own))) return 'had-worktree';
  return 'dev';
}

// A name merged more than once is ONE spoke (PR #84 Dexter F2): the latest merge names it, the
// commits add up (unknown if any merge's count is), and its spend is counted once.
function joinMerges(merges) {
  const by = new Map();
  for (const m of merges) {
    const prev = by.get(m.branch);
    if (!prev) { by.set(m.branch, { ...m }); continue; }
    const commits = prev.commits === null || m.commits === null ? null : prev.commits + m.commits;
    by.set(m.branch, { ...m, commits });
  }
  return by;
}

const byWhen = (a, b) => (a.when === b.when ? 0 : a.when == null ? 1 : b.when == null ? -1 : a.when < b.when ? -1 : 1);

function buildTree({ history, totals = {}, openPrs = null, projectRoot, current = null }) {
  if (!history || !history.ok) return { ok: false, error: (history && history.error) || 'no history' };
  const integration = history.integration;
  const worktrees = history.worktrees || [];
  const lanes = history.lanes || [];
  const merged = joinMerges(history.merges.filter(m => !isHubName(m.branch, integration)));
  const laneOf = new Map(lanes.filter(u => !isHubName(u.name, integration)).map(u => [u.name, u]));
  const known = new Set([...merged.keys(), ...laneOf.keys()]);
  const prsKnown = openPrs instanceof Map;

  // Loose spend (a line whose cwd was outside the project root, PLAN G2) is ours only for a lane
  // git knows; a hub name like develop could be any project's.
  const spendOf = name => {
    const t = getOwn(totals, name);
    if (!t) return null;
    return t.spend + (known.has(name) ? t.loose : 0);
  };
  const entry = (name, fields) => {
    const t = getOwn(totals, name) || null;
    return { name, ...fields, place: placeOf(name, t, worktrees, projectRoot), spend: spendOf(name),
      runs: t ? t.runs.length : 0, people: peopleOf(t ? t.runs : [], known.has(name)) };
  };

  const branches = [];
  for (const name of known) {
    const m = merged.get(name);
    const u = laneOf.get(name);
    const open = prsKnown ? openPrs.get(name) : undefined;
    const t = getOwn(totals, name);
    // Live: ahead of the integration branch, or an open PR, or -- for a name never merged -- a
    // worktree with nothing committed yet. A merged branch whose worktree is still around (not yet
    // removed) stays merged: the probe caught feat/layout-dock-zones losing its PR that way.
    const live = u && (u.ahead > 0 || open || (!m && u.ahead === 0 && u.worktree));
    if (m && !live) {
      branches.push(entry(name, { state: 'merged', pr: m.pr, remote: false, why: purpose(m.title), when: m.date, commits: m.commits }));
      continue;
    }
    const when = (t && t.last) || (u && u.date) || null;
    if (!live && u.ahead === 0) {
      // fully contained in the integration branch: merged, by a fast-forward or a rebase
      branches.push(entry(name, { state: 'merged', pr: null, remote: u.remote, why: purpose(u.first), when, commits: 0 }));
      continue;
    }
    // A live lane: ahead, an open PR, or a fresh worktree with nothing committed yet (PR #84 Dexter
    // F9: "0 ahead" alone read a brand-new lane as merged).
    branches.push(entry(name, {
      state: open ? 'open' : 'unmerged', pr: open ? open.pr : null, remote: u.remote,
      why: purpose(open && open.title) || purpose(u.first), when, commits: u.ahead,
    }));
  }

  let hubSpend = null;
  const hubRuns = [];
  for (const [name, t] of Object.entries(totals)) {
    if (isHubName(name, integration)) {
      hubSpend = (hubSpend || 0) + t.spend;
      hubRuns.push(...t.runs);
      continue;
    }
    if (known.has(name)) continue;
    // only spend from inside the project makes an unknown branch ours (G2)
    if (!(t.spend > 0)) continue;
    branches.push({ name, state: 'deleted', place: placeOf(name, t, worktrees, projectRoot), pr: null, remote: false,
      why: null, when: t.last || null, commits: null, spend: t.spend, runs: t.runs.length, people: peopleOf(t.runs, false) });
  }
  branches.sort((a, b) => byWhen(a, b)
    || (a.pr == null ? Infinity : a.pr) - (b.pr == null ? Infinity : b.pr) || a.name.localeCompare(b.name));

  const hub = { spend: hubSpend, people: peopleOf(hubRuns, false) };
  const spokes = branches.filter(b => b.spend !== null);
  // null when nothing at all was recorded: 0 would claim "this project spent nothing" (Dexter F10)
  const totalSpend = hubSpend === null && !spokes.length ? null
    : (hubSpend || 0) + spokes.reduce((s, b) => s + b.spend, 0);
  return { ok: true, integration, mainMerges: history.mainMerges, current, prsKnown, hub, totalSpend, branches };
}

module.exports = { buildTree, purpose, personOf };
