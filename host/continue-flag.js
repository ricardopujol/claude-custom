'use strict';
/**
 * Does a folder have an earlier conversation for `claude --continue` to pick up? (BACKLOG #166; documentation/DESIGN_TABS_SESSIONS.md 3.1)
 *
 * MEASURED against the real CLI (2.1.322, verify/probe-continue.js): `claude -p --continue` with nothing to continue just starts
 * fresh, but the INTERACTIVE CLI (what a tab runs) prints "No conversation found to continue" and EXITS 1. A lane's main session is
 * asked to continue only when this says there is something, so a new lane comes up as a fresh session with no error screen.
 *
 * The CLI's own session store is the truth (the founding bet: never edit its state, only read it): transcripts live at
 * <config dir>\projects\<project dir name>\<session>.jsonl (host/project-dir.js names the folder, host/claude-config-dir.js the root,
 * and CLAUDE_CONFIG_DIR is honoured). A conversation is a transcript with at least one user or assistant entry near its start;
 * an empty file, or one of bookkeeping lines only, is not one. Sub-folders (a session's subagents) are not looked at.
 *
 * Every doubt answers FALSE, the opposite of host/recent.js hasClaudeHistory (which answers true so a look is never written over a
 * project's history): here a wrong "no" costs a resume (the person can /resume), a wrong "yes" costs an error screen and a dead tab.
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
 * @param cwd   the folder the session runs in
 * @param opts  { projectsDir, env, homeDir, fsImpl }: the CLI's projects dir (default: the config dir's), for tests
 */
function hasConversation(cwd, { projectsDir, env = process.env, homeDir = os.homedir(), fsImpl = fs } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) return false;
  const want = projectDirName(cwd).toLowerCase();
  if (want.length > MAX_UNSHORTENED_NAME) return false;
  try {
    const root = projectsDir || claudeProjectsDir({ env, home: homeDir });
    for (const d of fsImpl.readdirSync(root, { withFileTypes: true })) {
      if (d.isFile() || d.name.toLowerCase() !== want) continue;      // a junction is not isDirectory() on its Dirent: only a plain file is skipped
      const dir = path.join(root, d.name);
      for (const f of fsImpl.readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        if (MESSAGE.test(headOf(path.join(dir, f.name), fsImpl))) return true;
      }
    }
  } catch { /* a store that can't be read proves nothing: no conversation */ }
  return false;
}

module.exports = { hasConversation };
