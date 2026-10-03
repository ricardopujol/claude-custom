'use strict';
/**
 * verify/probe-video-background.js launches a real window, real hosts and a media decoder, so the
 * properties that keep it safe are pinned as source assertions (it is not run by `npm test`; it
 * needs Electron and ffmpeg), in the style of test/probe-worktree-tabs-hygiene.test.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const PROBE = strip(fs.readFileSync(path.join(__dirname, '..', 'verify', 'probe-video-background.js'), 'utf8'));

test('nothing can bill, and nothing inherits a launcher\'s environment', () => {
  assert.ok(PROBE.includes(String.raw`CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe'`));
  assert.match(PROBE, /delete env\.ELECTRON_RUN_AS_NODE/);
  assert.match(PROBE, /k\.startsWith\('CLAUDE_CUSTOM_'\) && !keep\.includes\(k\)\) delete env\[k\]/);
});

test('it never touches the real state: registry, portraits, uploads and user data are temp', () => {
  for (const k of ['CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS']) {
    assert.ok(PROBE.includes(`${k}: path.join(tmp,`), k);
  }
  assert.match(PROBE, /--user-data-dir=\$\{userData\}/);
  assert.doesNotMatch(PROBE, /rmSync\([^)]*\.harness/);
  assert.doesNotMatch(PROBE, /unlinkSync\([^)]*hosts/);
});

test('it kills only PIDs it started: never a process by name', () => {
  assert.doesNotMatch(PROBE, /taskkill/i);
  assert.doesNotMatch(PROBE, /Stop-Process/i);
  assert.doesNotMatch(PROBE, /\/IM\b/);
  assert.match(PROBE, /hygiene\.registerSpawnedTree\(child\.pid\)/);
  assert.match(PROBE, /killPidTree\(pid\)/);
});

test('every process it starts is cleaned up on every exit path, including Ctrl+C', () => {
  assert.match(PROBE, /require\('\.\/lib\/process-hygiene'\)/);
  assert.match(PROBE, /hygiene\.install\(\)/);
  assert.match(PROBE, /hygiene\.addCleanup\(killEverything\)/);
  assert.match(PROBE, /hygiene\._emergencyCleanup\('done'\)/);
});

test('it downloads nothing: the media is generated locally', () => {
  assert.doesNotMatch(PROBE, /https?:\/\/(?!example\.invalid)/);
  assert.doesNotMatch(PROBE, /require\('https?'\)|fetch\(/);
  assert.match(PROBE, /spawnSync\('ffmpeg'/);
});

test('a run that fails is a FAILURE with a summary line', () => {
  assert.match(PROBE, /check\(\) failed|check\(s\) failed/);
  assert.match(PROBE, /process\.exit\(failures \? 1 : 0\)/);
});
