'use strict';
// Where the agent portraits live. They belong to the agent-creator repo, which
// moved from a flat checkout to a worktree layout (portraits now under dev\).
// Both layouts resolve here so the host and the verify scripts agree.
const fs = require('fs');

const FLAT_DIR = 'C:\\Users\\ricar\\VibeCode\\agent-creator\\portraits';
const DEV_DIR = 'C:\\Users\\ricar\\VibeCode\\agent-creator\\dev\\portraits';

// Order: CLAUDE_CUSTOM_PORTRAITS, then the dev path if it exists, then the flat path.
function resolvePortraitsDir(env = process.env, exists = fs.existsSync) {
  if (env.CLAUDE_CUSTOM_PORTRAITS) return env.CLAUDE_CUSTOM_PORTRAITS;
  return exists(DEV_DIR) ? DEV_DIR : FLAT_DIR;
}

module.exports = { resolvePortraitsDir, FLAT_DIR, DEV_DIR };
