'use strict';
/**
 * Which ConPTY the session's pty runs on (Windows only; BACKLOG #116).
 *
 * The OS's own ConPTY (conhost) cannot carry the CLI's Program Status Protocol (OSC 7501). Measured 2026-10-19 on
 * Windows 11 10.0.26200, node-pty 1.1.0, with a program that writes "OSC 7501 ; ? ST" then "CSI c":
 *   OS ConPTY       conhost answers DA1 itself, 3 ms later, and the program's stdin never receives the host's OSC reply
 *                   (conhost's input parser drops it). The CLI sees DA1 before any 7501 answer and marks the protocol
 *                   unsupported for the whole session. No host can fix that: the DA1 answer is made inside conhost.
 *   bundled ConPTY  (node-pty's conpty.dll + OpenConsole.exe, `useConptyDll`) forwards "CSI c" to the host unanswered and
 *                   passes the host's OSC reply through to the program's stdin.
 * So the session runs on the bundled one. CLAUDE_CUSTOM_CONPTY=builtin goes back to the OS's, which keeps every session
 * working as before and loses the 7501 state (the dots then fall back to the hooks).
 */
function ptyWindowsOptions(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return {};
  return String((env && env.CLAUDE_CUSTOM_CONPTY) || '').toLowerCase() === 'builtin' ? {} : { useConptyDll: true };
}

module.exports = { ptyWindowsOptions };
