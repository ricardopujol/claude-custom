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
 * A BRIEF IS NEVER OVERWRITTEN: one that is already there belongs to the lane (a hub may have written it first). Checked
 * before building it, and enforced by the write itself (an exclusive create: writeNoClobber), because a check followed by
 * a replacing rename lets a brief written in between be lost (PR #202 Dexter 8).
 *
 * A BODY THAT WASN'T FETCHED IS NOT AN EMPTY ONE (PR #202 Dexter 1): when `gh issue view` fails but the picker's list
 * has the issue, the brief is still written from the list entry, says in its Source line and in the issue section that
 * the description wasn't fetched and why, and the result carries a `warning` the tab shows.
 * Never throws: the caller is a worktree that was just made, and a brief that can't be written is a line on its tab,
 * not a reason to lose the tab.
 */

const fs = require('fs');
const path = require('path');
const { buildBrief } = require('./issues');

const message = (err) => (err && err.message) || String(err);

/**
 * Write `text` to `file` only if nothing is there, never replacing: the text goes to a temp file beside it and is HARD-LINKED
 * into place (the link fails with EEXIST when the file exists, atomically), then the temp is removed. Never opens the
 * target for writing, so a failed write can't leave half a brief. Throws (EEXIST when it was already there).
 */
function writeNoClobber(file, text, { fsImpl = fs } = {}) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fsImpl.writeFileSync(temp, text);
    fsImpl.linkSync(temp, file);
  } finally {
    try { fsImpl.unlinkSync(temp); } catch { /* nothing left to remove */ }
  }
}

function createLaneBriefWriter({
  cwd, service, ops, now = () => new Date(),
  exists = fs.existsSync,
  mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }),
  create = writeNoClobber,
} = {}) {
  return async function writeLaneBrief(lane) {
    const l = lane && typeof lane === 'object' ? lane : {};
    const okLane = Number.isInteger(l.number) && l.number >= 1
      && typeof l.branch === 'string' && l.branch !== '' && typeof l.worktree === 'string' && l.worktree !== '';
    if (!okLane) return { ok: false, error: 'no issue, branch or worktree to write a brief for', issue: null };

    // The issue with its body; failing that, what the picker's list knew of it (no body).
    let issue = null;
    let body = '';
    let why = null;           // set when the body was NOT fetched
    const seen = await service.view(cwd, l.number);
    if (seen.ok) {
      issue = seen.issue;
      body = seen.body;
    } else {
      why = seen.text || 'gh gave no answer';
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
      create(where.path, buildBrief({ branch: l.branch, worktree: l.worktree, issue, body, bodyUnavailable: why, now: now() }));
    } catch (err) {
      if (err && err.code === 'EEXIST') return { ok: true, issue, brief: where.path, existed: true };   // got there first: keep theirs
      return { ok: false, error: `couldn't write the brief: ${message(err)}`, issue };
    }
    const done = { ok: true, issue, brief: where.path, existed: false };
    if (why !== null) done.warning = `the issue's text wasn't fetched (${why}); the brief links it`;
    return done;
  };
}

module.exports = { createLaneBriefWriter, writeNoClobber };
