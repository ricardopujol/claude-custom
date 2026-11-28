'use strict';
/**
 * Jiandu Home's launch (documentation/DESIGN_PROJECT_HUB.md H3; plan documentation/PLAN_PROJECT_HUB.md H-PR2): `claude-custom --home`
 * opens Home and no project; `claude-custom <folder>` still opens that folder directly.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { parseCli, homeEnv, HOME_FLAG } = require('../host/launch-target');

test('--home alone is the home command', () => {
  assert.deepStrictEqual(parseCli(['--home'], { cwd: 'C:\\x' }), { cmd: 'home' });
});

test('--home with a folder or with --stop is refused, never half done', () => {
  assert.throws(() => parseCli(['--home', 'C:\\p'], { cwd: 'C:\\x' }), /--home opens Home: name no folder/);
  assert.throws(() => parseCli(['--stop', '--home'], { cwd: 'C:\\x' }), /--home and --stop/);
});

test('a folder still opens that folder (no Home), and help still wins', () => {
  assert.deepStrictEqual(parseCli(['C:\\p'], { cwd: 'C:\\x' }), { cmd: 'open', arg: 'C:\\p' });
  assert.deepStrictEqual(parseCli(['--home', '--help'], { cwd: 'C:\\x' }), { cmd: 'help' });
});

test('bin/claude-custom.js: --home spawns the install\'s electron on homeEnv, with no folder check; --help names --home', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'bin', 'claude-custom.js'), 'utf8');
  assert.match(src, /if \(cli\.cmd === 'home'\) \{\s*spawnApp\(homeEnv\(process\.env\)\);\s*return;\s*\}/);
  assert.match(src, /claude-custom --home/);
  assert.match(src, /function spawnApp\(env\) \{[\s\S]*?spawn\(electron, \[INSTALL_DIR\], \{[\s\S]*?env,/);
});

test('scripts/open-jiandu-home.vbs: runs the launcher with --home and no console window, from its own install or the dev one', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'open-jiandu-home.vbs'), 'utf8');
  assert.match(src, /ws\.Run "node """ & launcher & """ --home", 0, False/);
  assert.match(src, /launcher = fso\.BuildPath\(here, "bin\\claude-custom\.js"\)/);
  assert.match(src, /If Not fso\.FileExists\(launcher\) Then launcher = fso\.BuildPath\(install, "bin\\claude-custom\.js"\)/);
  assert.doesNotMatch(src, /BrowseForFolder/, 'no folder dialog: Home is the list');
});

test('PR #263 Miguel Y4: the launcher names no user folder (%USERPROFILE%), and a missing launcher says so in a MsgBox', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'open-jiandu-home.vbs'), 'utf8');
  assert.doesNotMatch(src, /C:\\Users\\/i, 'no hard-coded user folder');
  assert.match(src, /install = ws\.ExpandEnvironmentStrings\("%USERPROFILE%\\VibeCode\\claude-custom\\dev"\)/);
  const at = src.search(/If Not fso\.FileExists\(launcher\) Then\r?\n/);
  assert.ok(at !== -1, 'a second check, after the fallback');
  const rest = src.slice(at);
  assert.match(rest, /MsgBox "Jiandu Home could not start: there is no launcher at " & launcher/);
  assert.match(rest, /WScript\.Quit 1/);
  assert.ok(rest.indexOf('WScript.Quit 1') < rest.indexOf('ws.Run'), 'it quits before it runs anything');
});

test('homeEnv: the launch env on the user\'s home folder, with the home flag; nothing of the harness inherited', () => {
  const env = homeEnv({ PATH: 'p', CLAUDE_CUSTOM_PORT: '9', CLAUDE_CUSTOM_HOME: '0', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CUSTOM_SHELL: 'pwsh' });
  assert.deepStrictEqual(env, { PATH: 'p', CLAUDE_CUSTOM_SHELL: 'pwsh', CLAUDE_CUSTOM_CWD: os.homedir(), [HOME_FLAG]: '1' });
  assert.strictEqual(HOME_FLAG, 'CLAUDE_CUSTOM_HOME');
});
