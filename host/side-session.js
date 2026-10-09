'use strict';
/**
 * The standing read-only side session (BACKLOG #81, documentation/DESIGN_ROUND_2026-10-09B.md).
 *
 * A tab's menu opens a second real `claude` in the same folder, in the CLI's own plan mode (it can read and answer, it
 * can't write). It is a HOST of its own on its own port, told so by CLAUDE_CUSTOM_SIDE=1:
 *   - claude runs with `--permission-mode plan` and not `--dangerously-skip-permissions` (host/settings-writer.js);
 *   - it takes no session lock, so it never holds the worktree's writer role (host/host.js);
 *   - its identity file says `side: true`, so the port walk never mistakes it for the folder's own host
 *     (host/handshake.js, host/port-for-project.js);
 *   - the claims its subagents make carry role "reader" (host/agent-occupancy.js).
 *
 * In the tab shell it is a tab of its own, keyed by its branch tab's key plus SIDE_SUFFIX. The suffix ends in a character
 * no Windows path can contain, and a branch tab's key is a normalised path, so a side key never equals a branch key.
 */

const SIDE_SUFFIX = '|side';
const SIDE_ENV = 'CLAUDE_CUSTOM_SIDE';
const SIDE_PERMISSION_MODE = 'plan';

const nonEmpty = s => typeof s === 'string' && s !== '';

function isSideKey(k) {
  return nonEmpty(k) && k.length > SIDE_SUFFIX.length && k.endsWith(SIDE_SUFFIX);
}

/** The side tab's key for a branch tab's key; null for no key and for a key that is already a side's. */
function sideKeyOf(parentKey) {
  if (!nonEmpty(parentKey) || isSideKey(parentKey)) return null;
  return parentKey + SIDE_SUFFIX;
}

/** The branch tab's key a side key belongs to; null for anything that is not a side key. */
function parentKeyOf(k) {
  return isSideKey(k) ? k.slice(0, -SIDE_SUFFIX.length) : null;
}

/** What the side tab says: its branch tab's label, then " · side". */
function sideLabel(label) {
  return `${label} · side`;
}

/** Is this host's environment a side host's? Only the exact string "1" (anything else is an ordinary host). */
function isSideEnv(env) {
  return !!env && env[SIDE_ENV] === '1';
}

module.exports = { SIDE_SUFFIX, SIDE_ENV, SIDE_PERMISSION_MODE, isSideKey, sideKeyOf, parentKeyOf, sideLabel, isSideEnv };
