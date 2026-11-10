'use strict';
/**
 * The environment a session's pty is started with (host/host.js startSession), for each kind of session the host starts: the
 * branch's `claude`, a side session's `claude`, and a shell tab's program. Pure, so it can be tested; host.js only supplies the parts.
 *
 *   ptyEnv({ kind: 'branch' | 'side' | 'shell', base, shellEnv, sessionEnv, providerEnv, modEnv }) -> env
 *
 *   base         cleanEnv(): the person's environment without the harness's own variables
 *   shellEnv     host/launch-target.js shellEnv, applied to `base` for a shell tab only
 *   sessionEnv   the worktree's own (WORKTREE_NAME, COMPOSE_PROJECT_NAME, WORKTREE_PORT_BASE; Extension X3)
 *   providerEnv  the provider's (a claude session only)
 *   modEnv       the mod server's port and token (a claude session only; {} when the mod server isn't up)
 *
 * HARNESS_SESSION_ENV goes into every kind and wins over anything inherited (BACKLOG #74 F (2), Ricardo 2026-11-06: "Only inside
 * claude-custom"): PYTHON_BASIC_REPL=1, so a Python REPL started with no console (an agent's background shell) gets EOF and exits
 * instead of looping into a multi-GB task-output file. Only the env handed to pty.spawn: nothing is set user-wide, and his own
 * terminals and Python prompt outside the app don't change.
 */

const HARNESS_SESSION_ENV = Object.freeze({ PYTHON_BASIC_REPL: '1' });

function ptyEnv({ kind, base = {}, shellEnv = (e) => e, sessionEnv = {}, providerEnv = {}, modEnv = {} } = {}) {
  const term = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  if (kind === 'shell') {
    // A5: an arbitrary program gets the person's environment and the worktree's, and none of the harness's own.
    return { ...shellEnv({ ...base }), ...term, ...sessionEnv, ...HARNESS_SESSION_ENV };
  }
  return {
    ...base,
    ...term,
    // Marks this session as harness-hosted; the hook bridge keys off it later.
    CLAUDE_CUSTOM_SESSION: '1',
    ...modEnv,
    ...sessionEnv,
    ...providerEnv,
    ...HARNESS_SESSION_ENV,
  };
}

module.exports = { ptyEnv, HARNESS_SESSION_ENV };
