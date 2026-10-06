'use strict';
/**
 * Which `claude` sessions are live in a worktree, other than this host's own?
 * Extension X1 warns about them (it never blocks a terminal session).
 *
 * Read off the CLI's own session registry, `<config>/sessions/<pid>.json`,
 * rather than guessed from transcript recency: the registry sees an idle
 * session and needs no time window. It is undocumented, so
 * verify/probe-session-registry.js pins what this relies on -- `pid` (number),
 * `cwd` (native path), `procStart` (FILETIME string, equal to the OS start time
 * of a live pid). If the files stop carrying those, the result says
 * `format: 'unknown'` and the caller shows nothing; the probe is the tripwire.
 *
 * A file can outlive its session, so a pid only counts when it is alive with
 * the start time the CLI recorded. "Same worktree" is "same git-dir" -- the
 * session lock's own identity -- so a session in a subfolder counts and one in
 * a sibling worktree doesn't.
 *
 * `<pid>.<hash>.key` beside each file holds a peer token. Only `*.json` is
 * ever opened.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeConfigDir } = require('./claude-config-dir');
const { resolveGitDir } = require('./git-branch');
const { samePath } = require('./project-layout');
const procStart = require('./proc-start');

const validPid = pid => Number.isInteger(pid) && pid > 0;
const strOrNull = v => (typeof v === 'string' ? v : null);
const finiteOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function defaultRegistryDir() {
  return path.join(claudeConfigDir(), 'sessions');
}

const gitDirOf = p => (typeof p === 'string' && p ? resolveGitDir(path.resolve(p)) : null);

/**
 * { format: 'ok' | 'unknown', verified, sessions: [{ pid, sessionId, status, startedAt }] }
 * `verified: false` means the OS couldn't be asked, so nothing is claimed.
 */
async function liveSessionsIn(worktree, opts = {}) {
  const dir = opts.dir || defaultRegistryDir();
  const startTimes = opts.startTimes || procStart.startTimes;
  const exclude = opts.exclude || {};
  const excludedPids = new Set(Array.isArray(exclude.pids) ? exclude.pids : []);
  const excludedIds = new Set(Array.isArray(exclude.sessionIds) ? exclude.sessionIds : []);
  const unknown = { format: 'unknown', verified: false, sessions: [] };

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return unknown;
  }

  const docs = [];
  let jsonFiles = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;           // never the .key files
    jsonFiles++;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (doc && typeof doc === 'object' && typeof doc.pid === 'number' &&
          typeof doc.cwd === 'string' && typeof doc.procStart === 'string') docs.push(doc);
    } catch { /* unreadable or mid-write: skipped */ }
  }
  if (jsonFiles > 0 && docs.length === 0) return unknown;
  // `verified` means every live session here is accounted for (Dexter, PR #71
  // F7). A file we couldn't read, or one without the fields we read, may be a
  // session we can't see -- mid-write, or a format that has moved on beside an
  // old leftover -- so the answer is only as good as "not verified".
  const allRead = docs.length === jsonFiles;

  const ours = gitDirOf(worktree);
  if (!ours) return { format: 'ok', verified: allRead, sessions: [] };

  const candidates = docs.filter(d =>
    validPid(d.pid) &&
    !excludedPids.has(d.pid) &&
    !(typeof d.sessionId === 'string' && excludedIds.has(d.sessionId)) &&
    samePath(gitDirOf(d.cwd), ours));
  if (candidates.length === 0) return { format: 'ok', verified: allRead, sessions: [] };

  const starts = await startTimes([...new Set(candidates.map(d => d.pid))]);
  if (starts === null) return { format: 'ok', verified: false, sessions: [] };
  // A live candidate whose start time the OS won't give can't be confirmed as
  // the session its file describes -- dropped, and the answer not verified.
  const allConfirmable = candidates.every(d => starts.get(d.pid) !== null);

  const sessions = candidates
    .filter(d => starts.get(d.pid) === d.procStart)   // alive, and the same process
    .map(d => ({
      pid: d.pid,
      sessionId: strOrNull(d.sessionId),
      status: strOrNull(d.status),
      startedAt: finiteOrNull(d.startedAt),
    }));
  return { format: 'ok', verified: allRead && allConfirmable, sessions };
}

module.exports = { liveSessionsIn, defaultRegistryDir };
