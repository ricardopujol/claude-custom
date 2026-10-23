'use strict';
/**
 * verify/probe-account-profiles.js launches a real window and real hosts, so the properties that keep it safe are pinned as source
 * assertions (it is not run by `npm test`), in the style of test/probe-side-session-hygiene.test.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const PROBE = strip(fs.readFileSync(path.join(__dirname, '..', 'verify', 'probe-account-profiles.js'), 'utf8'));

test('nothing can bill: every host\'s claude is cmd.exe, and the window launch has no ELECTRON_RUN_AS_NODE or inherited config dir', () => {
  assert.ok(PROBE.includes(String.raw`CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe'`));
  // a .cmd stub as claude hangs the host's stop under Electron (measured), so the probe never uses one
  assert.doesNotMatch(PROBE, /claude-stub|\.cmd['"`]/);
  assert.match(PROBE, /delete env\.ELECTRON_RUN_AS_NODE/);
  assert.match(PROBE, /delete env\.CLAUDE_CUSTOM_PORT/);
  assert.match(PROBE, /delete env\.CLAUDE_CUSTOM_TOKEN/);
  assert.match(PROBE, /delete env\.CLAUDE_CONFIG_DIR/, 'the default profile must see no config dir of the launching shell\'s');
});

test('it never touches the real state: profiles, registry, portraits, uploads and user data are temp', () => {
  assert.match(PROBE, /CLAUDE_CUSTOM_PROFILES_DIR: profilesDir/);
  assert.match(PROBE, /const profilesDir = path\.join\(tmp, 'profiles'\)/);
  for (const k of ['CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS']) {
    assert.ok(PROBE.includes(`${k}: path.join(tmp,`), k);
  }
  assert.match(PROBE, /--user-data-dir=\$\{userData\}/);
  assert.doesNotMatch(PROBE, /rmSync\([^)]*\.harness/);
  assert.doesNotMatch(PROBE, /unlinkSync\([^)]*hosts/);
});

test('every process it starts is ended through the registry and by pid AND start time, never by name', () => {
  assert.match(PROBE, /require\('\.\/lib\/process-hygiene'\)/);
  assert.match(PROBE, /hygiene\.install\(\)/);
  assert.match(PROBE, /hygiene\.registerChild\(child\)/);
  assert.match(PROBE, /hygiene\.addCleanup\(killEverything\)/);
  assert.match(PROBE, /hygiene\._emergencyCleanup\('done'\)/);
  assert.match(PROBE, /seenPids\.endAll\(\)/);
  assert.doesNotMatch(PROBE, /taskkill|\/IM\b|process\.kill\([^,)]+,\s*['"]SIG|Stop-Process|killall|pkill/i);
});

test('the Electron launch goes through the lock-taking launcher', () => {
  assert.match(PROBE, /require\('\.\/lib\/launch-electron'\)/);
  assert.match(PROBE, /spawnElectron\(/);
});
