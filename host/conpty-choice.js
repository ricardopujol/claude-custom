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
 *                   passes the host's OSC reply through to the program's stdin (verify/probe-osc-7501.js: 41 of 41 rounds
 *                   with the 7501 reply first).
 * So the session runs on the bundled one. CLAUDE_CUSTOM_CONPTY=builtin goes back to the OS's, which keeps every session
 * working as before and loses the 7501 state (the dots then fall back to the hooks). It is documented in this repo's CLAUDE.md.
 * node-pty must be >= 1.1.0: 1.0.x ignores `useConptyDll` and would silently run on the OS's ConPTY (package.json pins ^1.1.0).
 *
 * If the bundled files are not there (a packaging mistake, a stripped install) the choice falls back to the OS's ConPTY with a
 * reason, instead of letting pty.spawn throw "Cannot find conpty.dll" and the session never start (PR #201 Miguel R2).
 * A packager must keep conpty\ (conpty.dll and OpenConsole.exe) OUTSIDE any asar archive: the dll is loaded by real path.
 *
 * `hostAnswersQueries`: with the bundled ConPTY the terminal's queries (DA1, cursor position) reach the host unanswered, so a host
 * with no window must answer them itself. With the OS's ConPTY conhost already does, and a second answer would be a duplicate.
 */
const fs = require('fs');
const path = require('path');

function bundledFilesPresent({ exists = fs.existsSync, nodePtyDir, arch = process.arch } = {}) {
  let dir = nodePtyDir;
  if (!dir) { try { dir = path.dirname(path.dirname(require.resolve('node-pty'))); } catch { return false; } }
  return [path.join(dir, 'build', 'Release', 'conpty'), path.join(dir, 'prebuilds', `win32-${arch}`, 'conpty')]
    .some((d) => exists(path.join(d, 'conpty.dll')) && exists(path.join(d, 'OpenConsole.exe')));
}

/** -> { options, backend: 'bundled' | 'builtin', hostAnswersQueries, reason } */
function choosePtyBackend({ env = process.env, platform = process.platform, present = () => bundledFilesPresent() } = {}) {
  if (platform !== 'win32') return { options: {}, backend: 'builtin', hostAnswersQueries: false, reason: null };
  if (String((env && env.CLAUDE_CUSTOM_CONPTY) || '').toLowerCase() === 'builtin') {
    return { options: {}, backend: 'builtin', hostAnswersQueries: false, reason: 'CLAUDE_CUSTOM_CONPTY=builtin' };
  }
  if (!present()) {
    return { options: {}, backend: 'builtin', hostAnswersQueries: false, reason: "node-pty's bundled ConPTY (conpty.dll, OpenConsole.exe) is missing, so the OS's ConPTY is used and the CLI's status protocol is off" };
  }
  return { options: { useConptyDll: true }, backend: 'bundled', hostAnswersQueries: true, reason: null };
}

module.exports = { choosePtyBackend, bundledFilesPresent };
