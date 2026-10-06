'use strict';
/**
 * BACKLOG #72: the "survives a POSIX shell" tests failed in every full-suite run from PowerShell and passed
 * when run from Git Bash. Not load: PATH. From PowerShell `bash` is C:\Windows\System32\bash.exe, the WSL
 * launcher, which with no distro exits 1 with "execvpe(/bin/bash) failed" and r.error null, so the tests'
 * `if (r.error) return` skip never fired and they asserted on an empty stdout. A shell is believed only once
 * it has run something and printed it back.
 */
const test = require('node:test');
const assert = require('node:assert');
const { findPosixShell, posixShell } = require('./posix-shell');

// A candidate that STARTS and exits non-zero, as the WSL launcher does: `node -c "printf ok"` checks the
// syntax of a file that does not exist and exits 1 with r.error null.
const startsButFails = process.execPath;

test('a candidate that starts but exits non-zero is not a POSIX shell (the WSL launcher, BACKLOG #72)', () => {
  assert.strictEqual(findPosixShell([startsButFails]), null);
});

test('a candidate that cannot be started at all is skipped, and the next one is tried', () => {
  const found = posixShell();
  if (!found) return;   // nothing to be the "next one" on this machine; the test above still holds
  assert.strictEqual(findPosixShell(['C:/no/such/bash.exe', startsButFails, found]), found);
});

test('what posixShell() returns really runs a POSIX command and prints its output', (t) => {
  const sh = posixShell();
  if (!sh) { t.skip('no POSIX shell on this machine'); return; }
  const r = require('child_process').spawnSync(sh, ['-c', 'printf "%s|%s" "$((1+1))" a\\ b'], { encoding: 'utf8' });
  assert.strictEqual(r.stdout, '2|a b');
});

test('on Windows with Git installed, a shell is found whatever bash PATH resolves first', { skip: process.platform !== 'win32' }, () => {
  // The PowerShell case: Git's usr\bin is not on PATH, so `bash` alone is the WSL launcher.
  const git = require('child_process').spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (git.error || git.status !== 0) return;   // no Git: nothing to locate
  assert.ok(posixShell(), 'Git for Windows is installed, but no POSIX shell was found');
});
