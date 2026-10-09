'use strict';
/**
 * The environment a tab's host is spawned with.
 *
 * A DENYLIST here, where launch-target.js's `launchEnv` is a WILDCARD, because
 * the two sit on different boundaries.
 *   - launcher -> window (`launchEnv`): the window is a fresh start and must
 *     inherit nothing of the harness's own, so every `CLAUDE_CUSTOM_*` goes.
 *   - window -> host (here): the host READS install-level and probe-level knobs
 *     from what it inherits -- CLAUDE_CUSTOM_BIN (the probes point it at a stub
 *     so nothing bills; dropping it would spawn the real `claude`),
 *     _HELPER, _HOOK_DEBUG, _REGISTRY, _PORTRAITS, _UPLOADS, _BACKGROUNDS,
 *     _VAULT_PROBE. A wildcard would silently cut all of them.
 * What must not travel is one tab's IDENTITY: its folder, port, token, session
 * and project. Those are PER_TAB_KEYS; they are dropped from the base and the
 * tab's own values are set fresh, so one tab's token can never reach another.
 * A new per-tab key must be added to PER_TAB_KEYS.
 */

const { stateRoot } = require('./project-layout');

const PER_TAB_KEYS = Object.freeze([
  'CLAUDE_CUSTOM_CWD',
  'CLAUDE_CUSTOM_PORT',
  'CLAUDE_CUSTOM_TOKEN',
  'CLAUDE_CUSTOM_SESSION_ID',
  'CLAUDE_CUSTOM_SIDE_TAB',
  // #81: this host is a tab's read-only side session. Per-tab identity: a side host's flag must never reach the next one.
  'CLAUDE_CUSTOM_SIDE_SESSION',
  'CLAUDE_CUSTOM_PROJECT_ROOT',
  'CLAUDE_CUSTOM_PROJECT_STATE',
]);

const nonEmpty = v => typeof v === 'string' && v.length > 0;

function hostEnv(baseEnv, { cwd, port, token, project, side = false } = {}) {
  if (!nonEmpty(cwd)) throw new Error('hostEnv: cwd must be a non-empty string');
  if (!nonEmpty(token)) throw new Error('hostEnv: token must be a non-empty string');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`hostEnv: port must be an integer in 1-65535, got ${String(port)}`);
  }
  const state = project ? stateRoot(project) : null;
  if (!project || !nonEmpty(project.root) || !nonEmpty(state)) {
    throw new Error('hostEnv: project must carry a root and a dev folder');
  }

  const out = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (!PER_TAB_KEYS.includes(k)) out[k] = v;
  }
  out.ELECTRON_RUN_AS_NODE = '1';
  out.CLAUDE_CUSTOM_CWD = cwd;
  out.CLAUDE_CUSTOM_PORT = String(port);
  out.CLAUDE_CUSTOM_TOKEN = token;
  out.CLAUDE_CUSTOM_PROJECT_ROOT = project.root;
  out.CLAUDE_CUSTOM_PROJECT_STATE = state;
  if (side === true) out.CLAUDE_CUSTOM_SIDE_SESSION = '1';
  return out;
}

module.exports = { hostEnv, PER_TAB_KEYS };
