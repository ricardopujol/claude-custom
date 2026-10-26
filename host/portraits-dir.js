'use strict';
// Where the agent portraits live. They belong to the agent-creator repo, which
// moved from a flat checkout to a worktree layout (portraits now under dev\).
// Both layouts resolve here so the host and the verify scripts agree.
// Keep in step with forge/portraits_dir.py and forge/run-states.sh
// (test/portraits-dir.test.js cross-checks the three).
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), 'VibeCode', 'agent-creator');
const FLAT_DIR = path.join(ROOT, 'portraits');
const DEV_DIR = path.join(ROOT, 'dev', 'portraits');
// The file the forge reads from the portraits folder: a dev folder only counts
// once it holds this, so an empty folder (or a plain file) never wins.
const MARKER = 'appearances.yaml';

// Order: CLAUDE_CUSTOM_PORTRAITS, then the dev path if it holds the portraits,
// then the flat path. Call it at every use, not once at load, so a host started
// before the move finds the new folder after it.
function resolvePortraitsDir(env = process.env, exists = fs.existsSync) {
  if (env.CLAUDE_CUSTOM_PORTRAITS) return env.CLAUDE_CUSTOM_PORTRAITS;
  return exists(path.join(DEV_DIR, MARKER)) ? DEV_DIR : FLAT_DIR;
}

module.exports = { resolvePortraitsDir, FLAT_DIR, DEV_DIR, MARKER };
