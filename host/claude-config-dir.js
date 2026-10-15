'use strict';
/**
 * The CLI's own config dir. The CLI honours CLAUDE_CONFIG_DIR: when it's set, transcripts, credentials, agents,
 * settings and the session registry live under it, not under ~/.claude. A reader that guesses ~/.claude reads
 * nothing (BACKLOG #23). Every reader of the CLI's own state goes through here.
 *
 * Measured against the real CLI (verify/probe-config-dir.js, 2026-10-06), and matched:
 *   - empty or whitespace-only means unset (the default, ~/.claude);
 *   - any other value is used AS GIVEN. It is not trimmed: the CLI kept a trailing space (it made a folder named
 *     "cfg "), and Node's fs sees that the same way the CLI's does;
 *   - a RELATIVE value (".cc", "..\cc", "D:cc") is anchored against the directory the CLI was started in. That's
 *     the tab's folder, not the host process's cwd, so the host registers its tab cwd once (setConfigAnchor) and
 *     every reader then lands where that tab's `claude` writes. Always absolute, never empty.
 */
const os = require('os');
const path = require('path');

let anchor = null;

/** The directory the tab's `claude` runs in. Call once at host boot; null clears it (tests). */
function setConfigAnchor(dir) {
  anchor = typeof dir === 'string' && dir !== '' ? dir : null;
}

/**
 * `env` present means THAT env (undefined = no env, as callers like claudeHomeOf have always meant it); no `env`
 * key at all reads the live process.env. `cwd` overrides the registered anchor for a relative value.
 */
function claudeConfigDir(opts = {}) {
  const env = 'env' in opts ? opts.env : process.env;
  const v = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : '';
  if (!v.trim()) return path.join(opts.home || os.homedir(), '.claude');
  if (path.isAbsolute(v)) return v;
  return path.resolve(opts.cwd || anchor || process.cwd(), v);
}

function claudeProjectsDir(opts) {
  return path.join(claudeConfigDir(opts), 'projects');
}

module.exports = { claudeConfigDir, claudeProjectsDir, setConfigAnchor };
