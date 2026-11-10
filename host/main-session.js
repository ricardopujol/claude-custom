'use strict';
/**
 * Which session is a lane's MAIN session (BACKLOG #166; Dexter 1 / Miguel Y4 on PR #250; documentation/DESIGN_TABS_SESSIONS.md 3.1).
 *
 * `claude --continue` takes the folder's NEWEST conversation, and a side session (plan mode) writes its transcript in the same
 * folder, so a main tab could come back as the side chat. Ricardo's intent is that a lane's main tab resumes ITS OWN conversation, so
 * the main host records the session id its SessionStart hook reports, per folder, and the next main session is started with
 * `--resume <that id>`, when the CLI's store still has its transcript. No recorded id (a lane that never ran a main session under
 * this build, a side-only folder) means a FRESH session: never `--continue` blindly.
 *
 *   <install>\.harness\state\main-sessions.json   { version: 1, sessions: { <normPath(folder)>: { id, at } } }
 *
 * Only a main host writes it (a side host and a shell host never do). A /clear starts a new session and the hook says so, so the
 * record follows it. Bounded; a file that isn't understood reads as "none recorded" and is rewritten by the next record.
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');
const { normPath } = require('./project-layout');
const { hasTranscript, isSessionId } = require('./continue-flag');

const MAX_SESSIONS = 200;

function readSessions(file, readText) {
  try {
    const raw = JSON.parse(readText(file));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) return {};
    const s = raw.sessions;
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch { return {}; }
}

/** The id recorded for this folder's main session, or null. Strict: only a well-formed id comes out. */
function readMainSession(file, cwd, { readText = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const key = normPath(cwd);
  if (key === null || typeof file !== 'string' || file === '') return null;
  const e = readSessions(file, readText)[key];
  return e && typeof e === 'object' && isSessionId(e.id) ? e.id : null;
}

/** Record the main session's id for this folder. `{ ok: true }` or `{ ok: false, error }`; never a throw. */
function recordMainSession({ file, cwd, sessionId, now = Date.now,
  readText = (f) => fs.readFileSync(f, 'utf8'), writeText = (f, body) => writeFileAtomic(f, body), mkdir = (d) => fs.mkdirSync(d, { recursive: true }) } = {}) {
  const key = normPath(cwd);
  if (key === null || !isSessionId(sessionId) || typeof file !== 'string' || file === '') return { ok: false, error: 'nothing to record' };
  try {
    const sessions = readSessions(file, readText);
    sessions[key] = { id: sessionId, at: now() };
    const kept = Object.entries(sessions)
      .filter(([k, v]) => typeof k === 'string' && v && isSessionId(v.id))
      .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0)).slice(0, MAX_SESSIONS);
    mkdir(path.dirname(file));
    writeText(file, JSON.stringify({ version: 1, sessions: Object.fromEntries(kept) }, null, 2) + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/**
 * The session id a main session should be started with `--resume`, or null (start fresh): the recorded id, when its transcript is
 * in the CLI's store. `store` is host/continue-flag.js's options (projectsDir, env, homeDir, fsImpl, log).
 */
function resumeIdFor({ file, cwd, store = {}, readText } = {}) {
  const id = readMainSession(file, cwd, readText ? { readText } : undefined);
  if (id === null) return null;
  return hasTranscript(cwd, id, store) ? id : null;
}

module.exports = { readMainSession, recordMainSession, resumeIdFor };
