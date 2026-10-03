'use strict';
/**
 * Open PRs for the git tree (documentation/DESIGN_GIT_TREE.md, PLAN_GIT_TREE.md Task 6): which
 * branches have a PR open, and its title (the card's "what it was for").
 *
 * OPTIONAL. gh may be missing, logged out, offline or slow, and the tree must still draw: every
 * failure is null, meaning UNKNOWN. Never an empty Map, which would say "no PR is open" and
 * recolor an open branch as abandoned. The caller caches the answer (60s), and the 2s timeout keeps
 * a hung network from holding the panel.
 */

const { execFile } = require('child_process');

const GH_ARGS = ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName', '--limit', '100'];

function defaultRun(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 2000 },
      (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/** gh's JSON -> Map(headRefName -> { pr, title|null }), or null when it isn't a list. */
function parseOpenPrs(text) {
  if (typeof text !== 'string') return null;
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const out = new Map();
  for (const p of list) {
    if (!p || typeof p.headRefName !== 'string' || !p.headRefName) continue;
    if (typeof p.number !== 'number' || !Number.isInteger(p.number)) continue;
    out.set(p.headRefName, { pr: p.number, title: typeof p.title === 'string' && p.title ? p.title : null });
  }
  return out;
}

async function readOpenPrs(cwd, { run = defaultRun } = {}) {
  try {
    return parseOpenPrs(await run(GH_ARGS, cwd));
  } catch {
    return null;
  }
}

/**
 * Has `branch` an open PR, asked in `cwd`? true / false, or null when gh can't say. Run /merged's own
 * re-check in main (PR #93 Miguel I3), so the renderer's word is never enough to type into a session.
 */
async function openPrFor(cwd, branch, { read = readOpenPrs } = {}) {
  if (typeof branch !== 'string' || !branch) return false;
  let map;
  try { map = await read(cwd); } catch { return null; }
  if (!(map instanceof Map)) return null;
  return map.has(branch);
}

module.exports = { parseOpenPrs, readOpenPrs, openPrFor, GH_ARGS };
