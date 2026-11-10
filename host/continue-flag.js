'use strict';
/**
 * Reading the CLI's own session store (BACKLOG #166; documentation/DESIGN_TABS_SESSIONS.md 3.1): is there a conversation for
 * `claude` to resume in this folder? The founding bet: never edit the CLI's state, only read it.
 *
 * MEASURED against the real CLI (2.1.322, verify/probe-continue.js): `claude -p --continue` with nothing to continue just starts
 * fresh, but the INTERACTIVE CLI (what a tab runs) prints "No conversation found to continue" and EXITS 1. So a resume is asked
 * for only when this store proves the transcript exists, and every doubt answers FALSE (a fresh session: nothing lost but a resume,
 * and no error screen; the opposite of host/recent.js hasClaudeHistory, which answers true so a look is never written over history).
 *
 * Transcripts live at <config dir>\projects\<project dir name>\<session>.jsonl (host/project-dir.js names the folder,
 * host/claude-config-dir.js the root, CLAUDE_CONFIG_DIR is honoured). A transcript counts when a user or assistant entry is near its
 * start; an empty file or one of bookkeeping lines only does not. Sub-folders (a session's subagents) are not looked at.
 *
 * `--continue` takes the folder's NEWEST conversation, and a side session writes its transcript in the same folder (plan mode), so
 * the host resumes by the main session's OWN id instead (host/main-session.js): hasTranscript(cwd, id) is its check.
 * hasConversation (any transcript) is kept for the probe, which compares it with what the CLI really resumes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeProjectsDir } = require('./claude-config-dir');
const { projectDirName } = require('./project-dir');

// Past this length the CLI may shorten the folder name and add a hash that projectDirName can't reproduce (host/recent.js, Dexter F6).
const MAX_UNSHORTENED_NAME = 200;
// How much of a transcript is read: the first user entry is near its start, and a transcript can be megabytes.
const HEAD_BYTES = 64 * 1024;
const MESSAGE = /"type"\s*:\s*"(?:user|assistant)"/;
// A session id as the CLI makes them (a uuid); anything else never reaches a path or an argument.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,80}$/;
const isSessionId = (id) => typeof id === 'string' && SESSION_ID.test(id);

function headOf(file, fsImpl) {
  let fd = null;
  try {
    fd = fsImpl.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fsImpl.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch { /* nothing to do */ } }
  }
}

/**
 * Walks this folder's transcripts; `wants(name)` picks which files to look at. true on the first one with a message.
 * One unreadable transcript (a scan holding it) never hides another; a store that can't be listed proves nothing.
 * `log(line)` hears about the doubts: a store that can't be read, and a folder that has transcripts none of which matched
 * (the CLI's format may have moved, and a silent "no" would stop every resume for ever).
 */
function scan(cwd, wants, { projectsDir, env = process.env, homeDir = os.homedir(), fsImpl = fs, log = () => {} } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) return false;
  const want = projectDirName(cwd).toLowerCase();
  if (want.length > MAX_UNSHORTENED_NAME) return false;
  let candidates = 0;
  try {
    const root = projectsDir || claudeProjectsDir({ env, home: homeDir });
    for (const d of fsImpl.readdirSync(root, { withFileTypes: true })) {
      if (d.isFile() || d.name.toLowerCase() !== want) continue;      // a junction is not isDirectory() on its Dirent: only a plain file is skipped
      const dir = path.join(root, d.name);
      for (const f of fsImpl.readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.jsonl') || !wants(f.name)) continue;
        candidates++;
        try { if (MESSAGE.test(headOf(path.join(dir, f.name), fsImpl))) return true; } catch (err) {
          log(`[continue] can't read ${f.name}: ${(err && err.code) || (err && err.message)}`);
        }
      }
    }
  } catch (err) {
    log(`[continue] can't read the session store: ${(err && err.code) || (err && err.message)}`);
    return false;
  }
  if (candidates > 0) log(`[continue] ${candidates} transcript(s) in the store and none has a user or assistant entry near its start: the CLI's format may have changed`);
  return false;
}

/** Any conversation in the folder (a side session's counts). The probe compares this with what the CLI really resumes. */
function hasConversation(cwd, opts) { return scan(cwd, () => true, opts); }

/** The transcript of THIS session id is in the folder's store, with a message in it. An id that isn't one never matches. */
function hasTranscript(cwd, id, opts) {
  if (!isSessionId(id)) return false;
  const name = `${id}.jsonl`.toLowerCase();
  return scan(cwd, (n) => n.toLowerCase() === name, opts);
}

module.exports = { hasConversation, hasTranscript, isSessionId };
