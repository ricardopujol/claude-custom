'use strict';
/**
 * A POSIX shell for the tests that ask a real shell what it does with a command line, rather than
 * reasoning about escaping rules (settings-writer.test.js, status-relay.test.js).
 *
 * WHY NOT JUST spawnSync('bash'): which `bash` that finds depends on the shell the suite was started
 * from (BACKLOG #72). From Git Bash it is Git's bash. From PowerShell or cmd it is
 * C:\Windows\System32\bash.exe, the WSL launcher, which with no distro installed STARTS, prints
 * "execvpe(/bin/bash) failed" and exits 1. r.error is null, so the tests' `if (r.error) return` skip
 * never fired and they asserted on an empty stdout: failing in every full-suite run from PowerShell
 * and passing alone from Git Bash, which read as a load flake.
 *
 * So a candidate counts only once it has run a command and printed the output back, and Git's own
 * bash is tried first: on Windows it is the shell Claude Code runs hook and statusLine commands in.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const PROBE_TIMEOUT_MS = 30000;

function works(shell) {
  const r = spawnSync(shell, ['-c', 'printf ok'], { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT_MS });
  return !r.error && r.status === 0 && r.stdout === 'ok';
}

/** The first candidate that really runs a POSIX command, or null. */
function findPosixShell(candidates) {
  return candidates.find(works) || null;
}

// Git for Windows: <root>\mingw64\libexec\git-core is the exec path, and <root>\bin\bash.exe its bash.
function gitBash() {
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT_MS });
  if (r.error || r.status !== 0 || !r.stdout.trim()) return null;
  return path.join(r.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe');
}

function candidates() {
  if (process.platform !== 'win32') return ['bash'];
  return [process.env.CLAUDE_CODE_GIT_BASH_PATH, gitBash(), 'bash'].filter(Boolean);
}

let cached;
/** This machine's POSIX shell, found once per test process; null when there is none. */
function posixShell() {
  if (cached === undefined) cached = findPosixShell(candidates());
  return cached;
}

module.exports = { findPosixShell, posixShell };
