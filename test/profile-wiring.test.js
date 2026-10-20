'use strict';
/**
 * BACKLOG #119 A1: the wiring that can't be required in a unit test (host.js spawns a pty, main.js needs Electron, the renderer is a
 * page), pinned as SOURCE assertions in the style of test/host-top-bar.test.js. Coarse on purpose: the decisions live in
 * host/profiles.js, app/profile-service.js, app/profile-display.js and app/tab-shell.js, each tested on its own.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const HOST = read('host', 'host.js');
const MAIN = read('app', 'main.js');
const PRELOAD = read('app', 'preload.js');
const RENDERER = read('app', 'renderer.js');
const HTML = read('app', 'renderer.html');

test('the host says which profile it runs under in its hello, from the env main gave it', () => {
  assert.match(HOST, /const PROFILE_ID = process\.env\.CLAUDE_CUSTOM_PROFILE \|\| 'default'/);
  const hello = HOST.indexOf("type: 'hello'");
  assert.ok(hello !== -1);
  assert.match(HOST.slice(hello, HOST.indexOf('});', hello)), /profile: PROFILE_ID/);
});

test('main builds the host env with the tab\'s profile folder and id', () => {
  assert.match(MAIN, /hostEnv\(process\.env, \{[^}]*\.\.\.profiles\.spawnEnvFor\(tab\)/);
});

test('main hands the shell the profile store: choose, resolve, remember', () => {
  assert.match(MAIN, /profiles: \{ choose: \(t\) => profiles\.choose\(t\), resolve: \(id\) => profiles\.resolve\(id\), remember: \(t, id\) => profiles\.remember\(t, id\) \}/);
});

test('main answers the profile channels only for a tab page, and the host\'s own report reaches the shell', () => {
  for (const ch of ['profiles:state', 'profiles:switch', 'profiles:add', 'profiles:rename', 'profiles:remove', 'profiles:openFolder']) {
    const at = MAIN.indexOf(`ipcMain.handle('${ch}'`);
    assert.ok(at !== -1, ch);
    assert.match(MAIN.slice(at, at + 260), /isTabView\(e\.sender\)/, `${ch} must check the sender is a tab`);
  }
  assert.match(MAIN, /ipcMain\.on\('tab:profile', \(e, id\) => \{ if \(isTabView\(e\.sender\)\) tabShell\.reportProfile\(e\.sender, id\); \}\)/);
});

test('the confirm to restart a live session is a native question in the real app, and a recorded yes under the probe', () => {
  assert.match(MAIN, /if \(PROBE_PORT\) \{ probeProfileAsks\.push\(text\); return true; \}/);
  assert.match(MAIN, /buttons: \['Restart', 'Cancel'\], defaultId: 1, cancelId: 1/);
});

test('the preload exposes the profile calls and the change event, one-way where it can be', () => {
  for (const name of ['profilesState', 'profilesSwitch', 'profilesAdd', 'profilesRename', 'profilesRemove', 'profilesOpenFolder', 'reportProfile', 'onProfilesChanged']) {
    assert.match(PRELOAD, new RegExp(`\\b${name}:`), name);
  }
  assert.match(PRELOAD, /ipcRenderer\.invoke\('profiles:switch'/);
  assert.match(PRELOAD, /ipcRenderer\.send\('tab:profile'/);
});

test('the page loads the profile display before the renderer, and draws a chip beside the model chip', () => {
  assert.ok(HTML.indexOf('./profile-display.js') !== -1 && HTML.indexOf('./profile-display.js') < HTML.indexOf('./renderer.js'));
  assert.match(HTML, /id="tb-profile"/);
  assert.ok(HTML.indexOf('id="tb-profile"') < HTML.indexOf('id="tb-model"'), 'the profile chip sits before the model chip');
  assert.match(HTML, /id="tb-profile-menu"/);
});

test('the renderer reports the hello\'s profile to main, repaints the chip on a change, and routes the pick through main', () => {
  assert.match(RENDERER, /window\.harness\.reportProfile\(msg\.profile\)/);
  assert.match(RENDERER, /profileDisplay\.chipView\(/);
  assert.match(RENDERER, /window\.harness\.profilesSwitch\(/);
  assert.match(RENDERER, /onProfilesChanged\(/);
});

test('the roster\'s empty line is told whether the profile is the default', () => {
  assert.match(RENDERER, /rosterEmptyState\(roster\.size, agentStats, lastAgentStatsPayload, \{ isDefault: /);
});

test('main\'s kill proof for a stuck host is the identity file\'s pid AND OS start time, ended by a proven kill, never by name', () => {
  assert.match(MAIN, /killer: \(port\) => hostKiller\(port\)/);
  const at = MAIN.indexOf('function hostKiller(port)');
  assert.ok(at !== -1);
  const body = MAIN.slice(at, MAIN.indexOf('\nfunction spawnHost', at));
  assert.match(body, /fileFor\(HARNESS_DIR, port\)/);
  assert.match(body, /Number\(raw\.port\) !== port/);
  assert.ok(body.includes(String.raw`/^\d+$/.test(raw.processStartedAt)`), 'only a decimal FILETIME is a proof');
  assert.match(body, /killProvenAsync\(pid, processStartedAt\)/);
  assert.doesNotMatch(body, /taskkill|\/IM\b|Stop-Process/i);
});
