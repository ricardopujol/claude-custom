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
 */

const path = require('path');
const { samePath, isInside } = require('./project-layout');

// Never a spoke: the integration branch is the hub, `HEAD` is a detached checkout (its spend is the
// hub's), and main/master are where releases land, not lanes.
const NOT_LANES = new Set(['develop', 'main', 'master', 'HEAD']);
const SCRATCH = /^worktree-agent-/;
const MAX_WORDS = 15;

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

function peopleOf(runs) {
  const by = new Map();
  for (const r of runs) {
    const name = personOf(r.agentType);
    const p = by.get(name) || { name, runs: 0, spend: 0 };
    p.runs += 1;
    p.spend += r.spend;
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

function buildTree({ history, totals = {}, openPrs = null, projectRoot, current = null }) {
  if (!history || !history.ok) return { ok: false, error: (history && history.error) || 'no history' };
  const worktrees = history.worktrees || [];
  const known = new Set([...history.merges.map(m => m.branch), ...history.unmerged.map(u => u.name)]);
  // Loose spend (a line whose cwd was outside the project root, PLAN G2) is ours only for a branch
  // name this repo's git knows; a shared name like develop could be any project's.
  const spendOf = name => {
    const t = totals[name];
    if (!t) return null;
    return t.spend + (known.has(name) && !NOT_LANES.has(name) ? t.loose : 0);
  };
  const entry = (name, fields) => {
    const t = totals[name] || null;
    const runs = t ? t.runs : [];
    return { name, ...fields, place: placeOf(name, t, worktrees, projectRoot), spend: spendOf(name),
      runs: runs.length, people: peopleOf(runs) };
  };

  const branches = [];
  for (const m of history.merges) {
    if (NOT_LANES.has(m.branch) || SCRATCH.test(m.branch)) continue;
    branches.push(entry(m.branch, { state: 'merged', pr: m.pr, remote: false, why: purpose(m.title), when: m.date, commits: m.commits }));
  }
  for (const u of history.unmerged) {
    if (NOT_LANES.has(u.name) || SCRATCH.test(u.name)) continue;
    const t = totals[u.name];
    const when = (t && t.last) || u.date || null;
    if (u.ahead === 0) {
      // fully contained in the integration branch: merged, by a fast-forward or a rebase
      branches.push(entry(u.name, { state: 'merged', pr: null, remote: u.remote, why: purpose(u.first), when, commits: 0 }));
      continue;
    }
    const open = openPrs instanceof Map ? openPrs.get(u.name) : undefined;
    branches.push(entry(u.name, {
      state: open ? 'open' : 'unmerged', pr: open ? open.pr : null, remote: u.remote,
      why: purpose(open && open.title) || purpose(u.first), when, commits: u.ahead,
    }));
  }
  for (const [name, t] of Object.entries(totals)) {
    if (known.has(name) || NOT_LANES.has(name) || name === history.integration || SCRATCH.test(name)) continue;
    // only spend from inside the project makes an unknown branch ours (G2)
    if (!(t.spend > 0)) continue;
    branches.push({ name, state: 'deleted', place: placeOf(name, t, worktrees, projectRoot), pr: null, remote: false,
      why: null, when: t.last, commits: null, spend: t.spend, runs: t.runs.length, people: peopleOf(t.runs) });
  }
  branches.sort((a, b) => String(a.when).localeCompare(String(b.when))
    || (a.pr == null ? Infinity : a.pr) - (b.pr == null ? Infinity : b.pr) || a.name.localeCompare(b.name));

  const hubParts = [totals[history.integration], totals.HEAD].filter(Boolean);
  const hub = {
    spend: hubParts.length ? hubParts.reduce((s, t) => s + t.spend, 0) : null,
    people: peopleOf(hubParts.flatMap(t => t.runs)),
  };
  const totalSpend = (hub.spend || 0) + branches.reduce((s, b) => s + (b.spend || 0), 0);
  return { ok: true, integration: history.integration, mainMerges: history.mainMerges, current, hub, totalSpend, branches };
}

module.exports = { buildTree, purpose, personOf };
