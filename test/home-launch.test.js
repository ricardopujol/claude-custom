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

test('homeEnv: the launch env on the user\'s home folder, with the home flag; nothing of the harness inherited', () => {
  const env = homeEnv({ PATH: 'p', CLAUDE_CUSTOM_PORT: '9', CLAUDE_CUSTOM_HOME: '0', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CUSTOM_SHELL: 'pwsh' });
  assert.deepStrictEqual(env, { PATH: 'p', CLAUDE_CUSTOM_SHELL: 'pwsh', CLAUDE_CUSTOM_CWD: os.homedir(), [HOME_FLAG]: '1' });
  assert.strictEqual(HOME_FLAG, 'CLAUDE_CUSTOM_HOME');
});
