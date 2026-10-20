'use strict';
/**
 * The brief a lane started from a GitHub issue begins with (BACKLOG #119 A6). Joins three things that each have their
 * own tests: the issue (host/issues.js: gh, the template), where the lane's brief lives (host/worktree-ops.js:
 * sync-docs' brief-path.ps1, so /handoff and /pickup find it), and a write that can't leave half a file.
 *
 *   createLaneBriefWriter(deps)({ number, branch, worktree })
 *     -> { ok: true, issue, brief, existed }          the brief is at `brief` (existed: it was already there, untouched)
 *     -> { ok: false, error, issue }                  nothing was written; `issue` is what is known of it (or null)
 *
 * A BRIEF IS NEVER OVERWRITTEN: one that is already there belongs to the lane (a hub may have written it first).
 * Never throws: the caller is a worktree that was just made, and a brief that can't be written is a line on its tab,
 * not a reason to lose the tab.
 */

const fs = require('fs');
const path = require('path');
const { buildBrief } = require('./issues');
const { writeFileAtomic } = require('./atomic-write');

const message = (err) => (err && err.message) || String(err);

function createLaneBriefWriter({
  cwd, service, ops, now = () => new Date(),
  exists = fs.existsSync,
  mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }),
  write = writeFileAtomic,
} = {}) {
  return async function writeLaneBrief(lane) {
    const l = lane && typeof lane === 'object' ? lane : {};
    const okLane = Number.isInteger(l.number) && l.number >= 1
      && typeof l.branch === 'string' && l.branch !== '' && typeof l.worktree === 'string' && l.worktree !== '';
    if (!okLane) return { ok: false, error: 'no issue, branch or worktree to write a brief for', issue: null };

    // The issue with its body; failing that, what the picker's list knew of it (no body).
    let issue = null;
    let body = '';
    let why = null;
    const seen = await service.view(cwd, l.number);
    if (seen.ok) {
      issue = seen.issue;
      body = seen.body;
    } else {
      why = seen.text;
      const listed = service.cached(cwd);
      issue = Array.isArray(listed) ? listed.find(i => i && i.number === l.number) || null : null;
    }
    if (!issue) return { ok: false, error: `couldn't read issue #${l.number}: ${why}`, issue: null };

    let where;
    try { where = await ops.briefPath({ path: l.worktree }); } catch (err) { where = { ok: false, error: message(err) }; }
    if (!where || where.ok !== true) return { ok: false, error: (where && where.error) || 'no brief path', issue };

    try {
      if (exists(where.path)) return { ok: true, issue, brief: where.path, existed: true };
      mkdir(path.dirname(where.path));
      write(where.path, buildBrief({ branch: l.branch, worktree: l.worktree, issue, body, now: now() }));
    } catch (err) {
      return { ok: false, error: `couldn't write the brief: ${message(err)}`, issue };
    }
    return { ok: true, issue, brief: where.path, existed: false };
  };
}

module.exports = { createLaneBriefWriter };
