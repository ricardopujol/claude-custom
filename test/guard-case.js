'use strict';
/**
 * The one exemption both kill rules share (test/kill-by-handle.test.js, test/verify-electron-contract.test.js): a kill
 * string that is a CASE handed to the shell-guard hook under test (verify/probe-shell-guard.js), for the hook to refuse,
 * never run by the probe itself. It counts only on a line that
 *   1. carries `// kill-ok(guard-case): <reason>`,
 *   2. is a class-b deny case, `deny('b', '<tool>', '<id>', '<command>');`, and
 *   3. whose command names the canary process cc-probe-canary and no other target.
 * Any other kill, anywhere under verify/ (the rest of probe-shell-guard.js included), is still a violation.
 */
const ANNOTATION = /\/\/.*\bkill-ok\(guard-case\):[ \t]*\S/;
const CASE_LINE = /^\s*deny\('b', '\w+', '[\w-]+', '([^'\n]*)'\);/;
// what is left of the command once the canary name is taken out must not name a process
const NAMED_TARGET = /\/IM\s+[^\s/-]|-Name\s+[^\s-]|Get-Process\s+[A-Za-z]|\b(?:pkill|killall)\s+[^\s-]|\w\.exe\b|IMAGENAME/i;

function isGuardCaseLine(line) {
  if (!ANNOTATION.test(line)) return false;
  const m = CASE_LINE.exec(line);
  if (!m || !/\bcc-probe-canary\b/.test(m[1])) return false;
  return !NAMED_TARGET.test(m[1].replace(/\bcc-probe-canary(?:\.exe)?\b/g, ''));
}

module.exports = { isGuardCaseLine };
