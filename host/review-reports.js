'use strict';
/**
 * Review verdicts for the Git drawer (documentation/DESIGN_GIT_TREE.md, "Enhancement #46").
 *
 * Reviewers (Dexter, Miguel, Mortimer) write their report to
 *   ~/.claude/reviews/<project>/YYYY-MM-DD-<branch-dir>-<reviewer>[-rN].md
 * and the rules for reading them are the merge gate's own (the worktree skill's review-status.ps1):
 * the LATEST round per reviewer, and a verdict line found best effort. Report formats vary, so a
 * report with no verdict line is "report, no verdict line" (verdict: null), never a guess.
 *
 * Pure but for the file system, which is injected (`fs`: readdirSync, readFileSync, and statSync for
 * the cached reader). Nothing here throws to the caller: an unreadable folder is "no reports", an
 * unreadable file is "no verdict". A branch name is data: it is escaped before it joins a pattern.
 */

const nodeFs = require('fs');
const os = require('os');
const path = require('path');

const REVIEWERS = ['dexter', 'miguel', 'mortimer'];
const MAX_VERDICT_CHARS = 160;

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const display = reviewer => reviewer.charAt(0).toUpperCase() + reviewer.slice(1);

/** The worktree layout's folder name for a branch (host/git-tree.js laneFolder): `feat/x` -> `feat-x`. */
const branchDir = branch => String(branch).replace(/\//g, '-');

/** `{ date, reviewer, round }` when `name` is a report of the branch whose folder name is `dir`, else null. */
function parseName(name, dir) {
  if (typeof name !== 'string' || typeof dir !== 'string' || dir === '') return null;
  const m = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-${escapeRe(dir)}-(${REVIEWERS.join('|')})(?:-r(\\d+))?\\.md$`).exec(name);
  if (!m) return null;
  return { date: m[1], reviewer: m[2], round: m[3] === undefined ? 1 : Number(m[3]) };
}

/**
 * A report's verdict, best effort: `## Verdict: **X**`, `## Verdict` and a later line, `**Verdict: X**`
 * at a line start, a bare `Verdict: X` line, and `Veredicto`. The first one wins. Null when there is none.
 */
function verdictLine(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:#{1,3}\s*|\*\*)Vere?dict(?:o)?\s*:?\s*(.*)$/.exec(lines[i]) || /^Vere?dict(?:o)?\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let v = m[1];
    if (!v.replace(/\*/g, '').trim()) {
      v = '';
      for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) { v = lines[j]; break; }
    }
    v = v.replace(/\*/g, '').trim();
    if (!v) return null;
    return v.length > MAX_VERDICT_CHARS ? `${v.slice(0, MAX_VERDICT_CHARS).trimEnd()}…` : v;
  }
  return null;
}

/** The latest round per reviewer among `names`, for the branch folder `dir`: [{ reviewer, round, date, file }]. */
function latest(names, dir) {
  const best = new Map();
  for (const file of Array.isArray(names) ? names : []) {
    const p = parseName(file, dir);
    if (!p) continue;
    const cur = best.get(p.reviewer);
    if (cur && (cur.round > p.round || (cur.round === p.round && cur.date >= p.date))) continue;
    best.set(p.reviewer, { reviewer: p.reviewer, round: p.round, date: p.date, file });
  }
  return REVIEWERS.filter(r => best.has(r)).map(r => best.get(r));
}

// A project name that is a path would walk out of the reviews folder.
const safeProject = p => typeof p === 'string' && p !== '' && p !== '.' && p !== '..' && !/[\\/]/.test(p);

function defaultRoot() { return path.join(os.homedir(), '.claude', 'reviews'); }

function listing(dir, fs) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function verdictOf(file, fs) {
  try { return verdictLine(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** One-shot: [{ reviewer, round, date, verdict }] for `branch`, the latest round per reviewer. */
function read({ reviewsRoot = defaultRoot(), project, branch, fs = nodeFs } = {}) {
  if (!safeProject(project)) return [];
  const dir = path.join(reviewsRoot, project);
  return latest(listing(dir, fs), branchDir(branch)).map(r => ({
    reviewer: display(r.reviewer), round: r.round, date: r.date, verdict: verdictOf(path.join(dir, r.file), fs),
  }));
}

/**
 * A reader for the host, which asks once per branch on every refresh: the folder is listed once per
 * `refresh()` (not once per branch), and a report's verdict is read again only when its size or its
 * modified time changed. `reader(branch)` -> as `read`.
 */
function createReader({ reviewsRoot = defaultRoot(), project, fs = nodeFs } = {}) {
  const dir = safeProject(project) ? path.join(reviewsRoot, project) : null;
  let names = null;
  const cache = new Map();   // file -> { key, verdict }

  function verdictCached(file) {
    let key = null;
    try { const st = fs.statSync(file); key = `${st.mtimeMs}:${st.size}`; } catch { key = null; }
    const hit = cache.get(file);
    if (key !== null && hit && hit.key === key) return hit.verdict;
    const verdict = verdictOf(file, fs);
    if (key !== null) cache.set(file, { key, verdict });
    return verdict;
  }

  function reader(branch) {
    if (!dir) return [];
    if (names === null) names = listing(dir, fs);
    return latest(names, branchDir(branch)).map(r => ({
      reviewer: display(r.reviewer), round: r.round, date: r.date, verdict: verdictCached(path.join(dir, r.file)),
    }));
  }
  reader.refresh = () => { names = null; };
  return reader;
}

module.exports = { read, createReader, parseName, verdictLine, latest, branchDir, MAX_VERDICT_CHARS, REVIEWERS };
