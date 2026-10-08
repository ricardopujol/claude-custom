'use strict';
/**
 * verify/probe-terminal-bar.js launches a real window and real hosts, and verify/probe-bedtime-signal.js (with
 * --capture) a real billed CLI, so the properties that keep them safe are pinned as source assertions (they are
 * not run by `npm test`), in the style of test/probe-worktree-occupancy-hygiene.test.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const read = (f) => strip(fs.readFileSync(path.join(__dirname, '..', 'verify', f), 'utf8'));
const BAR = read('probe-terminal-bar.js');
const SIGNAL = read('probe-bedtime-signal.js');

test('the bar probe cannot bill: every host\'s claude is cmd.exe, and the window launch has no ELECTRON_RUN_AS_NODE', () => {
  assert.ok(BAR.includes(String.raw`CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe'`));
  assert.match(BAR, /delete env\.ELECTRON_RUN_AS_NODE/);
  assert.match(BAR, /k\.startsWith\('CLAUDE_CUSTOM_'\) && !PASSED_ENV\.includes\(k\)\) delete env\[k\]/);
});

test('the bar probe never touches the real state: registry, portraits, uploads and user data are temp', () => {
  for (const k of ['CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS']) assert.ok(BAR.includes(`${k}: path.join(tmp,`), k);
  assert.match(BAR, /--user-data-dir=\$\{userData\}/);
  assert.doesNotMatch(BAR, /rmSync\([^)]*\.harness/);
  assert.doesNotMatch(BAR, /unlinkSync\([^)]*hosts/);
});

test('every process the bar probe starts is cleaned up on every exit path, including Ctrl+C', () => {
  assert.match(BAR, /hygiene\.install\(\)/);
  assert.match(BAR, /hygiene\.registerChild\(child\)/);
  assert.match(BAR, /hygiene\.addCleanup\(killEverything\)/);
  assert.match(BAR, /hygiene\._emergencyCleanup\('done'\)/);
});

test('the bar probe kills by PID only, and only hosts whose folder is inside its own temp folder: never by name', () => {
  assert.match(BAR, /killPidTree\(pid\)/);
  assert.match(BAR, /startsWith\(inside\)/);
  assert.doesNotMatch(BAR, /taskkill|Stop-Process|pkill|killall|\/IM\b/i);
});

test('a bar probe run that never got going is a FAILURE, not a pass, and there is a summary line', () => {
  assert.match(BAR, /process\.exit\(failures \? 1 : 0\)/);
  assert.match(BAR, /check\(s\) failed/);
  assert.match(BAR, /FAIL  probe crashed/);
});

test('the signal probe\'s real capture is opt-in, never bills a key, and ends only the pty it started, by PID', () => {
  assert.match(SIGNAL, /process\.argv\.includes\('--capture'\)/);
  assert.match(SIGNAL, /delete env\.ANTHROPIC_API_KEY/);
  assert.match(SIGNAL, /delete env\.ELECTRON_RUN_AS_NODE/);
  assert.match(SIGNAL, /k\.startsWith\('CLAUDE_CUSTOM_'\)/);
  assert.match(SIGNAL, /killChildTree\(term\)/);
  assert.doesNotMatch(SIGNAL, /taskkill|Stop-Process|pkill|killall|\/IM\b/i);
});

test('the signal probe\'s default mode is the free replay, and the fixture is written atomically (never opened with w first)', () => {
  const main = SIGNAL.slice(SIGNAL.lastIndexOf("if (process.argv.includes('--capture'))"));
  assert.match(main, /else \{\s*replay\(\);/);
  assert.match(SIGNAL, /fs\.renameSync\(tmpFile, FIXTURE\)/);
  assert.doesNotMatch(SIGNAL, /writeFileSync\(FIXTURE/);
});

test('G8: the signal probe capture never runs in the repo root, never skips permissions, and finds claude without a hard-coded path', () => {
  assert.doesNotMatch(SIGNAL, /dangerously-skip-permissions/);
  assert.doesNotMatch(SIGNAL, /process\.env\.APPDATA/);
  assert.match(SIGNAL, /cwd: work/);
  assert.doesNotMatch(SIGNAL, /cwd: ROOT/);
  assert.match(SIGNAL, /permissions: \{ allow: \['ScheduleWakeup'\] \}/);
  assert.match(SIGNAL, /npm', \['root', '-g'\]/);
});

test('F6: the anchor probe runs the real CLI in a temp folder, skips no permissions, bills no key, and ends only its own pty by PID', () => {
  const ANCHOR = read('probe-prompt-anchor.js');
  assert.match(ANCHOR, /cwd: work/);
  assert.doesNotMatch(ANCHOR, /dangerously-skip-permissions/);
  assert.match(ANCHOR, /delete env\.ANTHROPIC_API_KEY/);
  assert.match(ANCHOR, /delete env\.ELECTRON_RUN_AS_NODE/);
  assert.match(ANCHOR, /killChildTree\(p\)/);
  assert.match(ANCHOR, /npm', \['root', '-g'\]/);
  assert.doesNotMatch(ANCHOR, /taskkill|Stop-Process|pkill|killall|\/IM\b/i);
});
