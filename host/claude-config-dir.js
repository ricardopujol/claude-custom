'use strict';
/**
 * The CLI's own config dir. The CLI honours CLAUDE_CONFIG_DIR: when it's set, transcripts, credentials, agents,
 * settings and the session registry live under it, not under ~/.claude. A reader that guesses ~/.claude reads
 * nothing (BACKLOG #23). Every reader of the CLI's own state goes through here.
 *
 * A blank or whitespace value means unset, and a non-string never counts, so this never returns an empty path.
 */
const os = require('os');
const path = require('path');

function claudeConfigDir({ env = process.env, home } = {}) {
  const v = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  return v || path.join(home || os.homedir(), '.claude');
}

function claudeProjectsDir(opts) {
  return path.join(claudeConfigDir(opts), 'projects');
}

module.exports = { claudeConfigDir, claudeProjectsDir };
