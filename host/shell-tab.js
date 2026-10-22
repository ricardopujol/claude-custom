'use strict';
/**
 * Plain shell tabs (BACKLOG #119 A5, documentation/handoffs/CURRENT-feat-shell-tabs-7501.md).
 *
 * A branch tab's menu opens a shell in the tab's folder: a HOST of its own on its own port whose pty runs the person's shell
 * (host/launch-target.js pickShell) instead of `claude`. It is told so by CLAUDE_CUSTOM_SHELL_HOST=1 (not CLAUDE_CUSTOM_SHELL,
 * which is the person's choice of WHICH shell). A shell host takes no session lock, no hooks, no quota poll and no mod; its only
 * state feed is OSC 7501 (a program that speaks it, like Codex or cargo, gets a dot and a toast) and the exit of its process.
 *   - its identity file says `kind: 'shell'`, so the port walk never mistakes it for the folder's own host or its side host
 *     (host/handshake.js) and a reopened window adopts it as the shell tab (app/tab-shell.js adoptCompanion);
 *   - in the tab shell it is a tab of its own, keyed by its branch tab's key plus SHELL_SUFFIX: a character no Windows path can
 *     contain ends it, so a shell key never equals a branch key or a side key.
 */

const SHELL_SUFFIX = '|shell';
// host/side-session.js SIDE_SUFFIX, repeated: side-session.js requires this file for its own checks, so this one can't require it back.
// test/shell-tab.test.js pins that the two agree.
const COMPANION_SUFFIXES = Object.freeze(['|side', SHELL_SUFFIX]);
const SHELL_HOST_ENV = 'CLAUDE_CUSTOM_SHELL_HOST';

const nonEmpty = s => typeof s === 'string' && s !== '';

/** Does this key end in a companion suffix (a side tab's or a shell tab's)? A branch tab's never does. */
function isCompanionKey(k) {
  return nonEmpty(k) && COMPANION_SUFFIXES.some(s => k.length > s.length && k.endsWith(s));
}

function isShellKey(k) {
  return nonEmpty(k) && k.length > SHELL_SUFFIX.length && k.endsWith(SHELL_SUFFIX);
}

/** The shell tab's key for a branch tab's key; null for no key and for a key that is already a companion's. */
function shellKeyOf(parentKey) {
  if (!nonEmpty(parentKey) || isCompanionKey(parentKey)) return null;
  return parentKey + SHELL_SUFFIX;
}

/** The branch tab's key a shell key belongs to; null for anything that is not a shell key. */
function parentKeyOfShell(k) {
  return isShellKey(k) ? k.slice(0, -SHELL_SUFFIX.length) : null;
}

/** What the shell tab says: its branch tab's label, then " · shell". */
function shellLabel(label) {
  return `${label} · shell`;
}

/** Is this host's environment a shell host's? Only the exact string "1" (anything else is an ordinary host). */
function isShellEnv(env) {
  return !!env && env[SHELL_HOST_ENV] === '1';
}

/**
 * [{ port, cwd }] of the shell hosts among `identities` (host/background-hosts.js identitiesIn): what a window looks for when it
 * opens. NULL when that can't be told (no list, or an identity file that couldn't be READ: it may be a live shell host's), as
 * host/side-session.js sideHostsOf does: "couldn't read" is not "nothing there".
 */
function shellHostsOf(identities) {
  if (!Array.isArray(identities) || identities.some(e => e && e.unreadable === true)) return null;
  const out = [];
  for (const e of identities) {
    const p = e && typeof e === 'object' ? e.parsed : null;
    if (p && p.kind === 'shell' && nonEmpty(p.cwd) && Number.isInteger(e.port) && e.port > 0) out.push({ port: e.port, cwd: p.cwd });
  }
  return out;
}

/**
 * Start the shell's pty. A spawn that throws (node-pty: "File not found", error 193 for a file Windows can't run) is not an error to
 * propagate: the host must END like an exited shell, so the answer is the exit frame to send. -> { term } | { term: null, frame, message }.
 */
function startShellPty(spawn) {
  try {
    return { term: spawn() };
  } catch (err) {
    const raw = err && typeof err.message === 'string' ? err.message : typeof err === 'string' ? err : '';
    const message = raw !== '' ? raw : 'the shell could not be started';
    return { term: null, frame: { type: 'exit', exitCode: 1, signal: null, error: message }, message };
  }
}

/** The role fields of every writeIdentity call (host/host-identity.js): one place, so no call forgets `kind`. */
function identityFields({ side, shell, sessionId }) {
  return { side: side === true, kind: shell === true ? 'shell' : undefined, sessionId: side === true ? sessionId : undefined };
}

module.exports = { startShellPty, identityFields, SHELL_SUFFIX, COMPANION_SUFFIXES, SHELL_HOST_ENV, isCompanionKey, isShellKey, shellKeyOf, parentKeyOfShell, shellLabel, isShellEnv, shellHostsOf };
