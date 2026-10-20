'use strict';
/**
 * The pieces PR #203's review found missing, pinned where they are wired: the pty must not inherit ELECTRON_RUN_AS_NODE, the entry
 * runs before anything loads, the launcher can start the installed exe, and `dist` refuses to build without the hook helper.
 * Source assertions in the style of test/renderer-canvas-wiring.test.js, plus the pure pieces run directly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));   // the checkout may be CRLF
const HOST = read('host', 'host.js');
const MAIN = read('app', 'main.js');
const BIN = read('bin', 'claude-custom.js');

test('withoutNodeMode drops ELECTRON_RUN_AS_NODE and touches nothing else, and leaves its input alone', () => {
  const { withoutNodeMode } = require('../host/pty-env');
  const env = { ELECTRON_RUN_AS_NODE: '1', PATH: 'p', CLAUDE_CODE_X: 'y' };
  assert.deepEqual(withoutNodeMode(env), { PATH: 'p', CLAUDE_CODE_X: 'y' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(withoutNodeMode({}), {});
});

test('the host starts as Node (tab-env sets the variable) and its pty gets the environment WITHOUT it', () => {
  assert.match(read('host', 'tab-env.js'), /out\.ELECTRON_RUN_AS_NODE = '1';/);
  assert.match(HOST, /function cleanEnv\(\) \{\s*[^}]*withoutNodeMode\(process\.env\)/);
  const { withoutNodeMode } = require('../host/pty-env');
  assert.equal('ELECTRON_RUN_AS_NODE' in withoutNodeMode({ ELECTRON_RUN_AS_NODE: '1' }), false);
  assert.ok(HOST.includes("env: {\n      ...cleanEnv(),"), 'the pty is spawned with cleanEnv()');
});

test('the first-run checks read the session environment (cleanEnv plus the provider), not the host process env', () => {
  assert.match(HOST, /const checkEnv = \{ \.\.\.cleanEnv\(\), \.\.\.providerEnv \};/);
  assert.match(HOST, /env: checkEnv,/);
  assert.match(HOST, /packaged: !fs\.existsSync\(path\.join\(__dirname, '\.\.', 'helper'\)\)/);
});

test('a side session reports its checks as skipped, done, so Diagnostics never says "running" for good', () => {
  assert.match(HOST, /if \(SIDE\) \{ firstRunState = \{ checks: \[\], banner: null, done: true, skipped: true \}; return; \}/);
});

test('main.js decides its entry before electron loads, and the run-as-Node re-run does not pass the script on', () => {
  const entryAt = MAIN.indexOf("startedAsNode(process.env)");
  const electronAt = MAIN.indexOf("require('electron')");
  assert.ok(entryAt !== -1 && electronAt !== -1 && entryAt < electronAt, 'the Node-mode guard comes first');
  assert.match(MAIN, /spawnSync\(process\.execPath, process\.argv\.slice\(2\)/);
  assert.match(MAIN, /delete env\.ELECTRON_RUN_AS_NODE/);
  assert.match(MAIN, /carryOut\(ENTRY, \{ write: writeFd, exit: \(c\) => process\.exit\(c\) \}\)/);
  assert.match(MAIN, /const LAUNCH_CWD = ENTRY\.cwd;/);
  assert.match(MAIN, /packaged: app\.isPackaged/);
});

test('the launcher starts the checkout electron, or this exe when none is shipped, and prints the one stable version line', () => {
  assert.match(BIN, /electronLaunch\(\{ installDir: INSTALL_DIR, execPath: process\.execPath \}\)/);
  assert.match(BIN, /spawn\(electron, electronArgs,/);
  assert.ok(!/require\(path\.join\(INSTALL_DIR, 'node_modules', 'electron'\)\)/.test(BIN), 'no bare require of a devDependency');
  assert.match(BIN, /versionText\(require\('\.\.\/package\.json'\)\)/);
  assert.match(BIN, /process\.exit\(wrote \? 0 : 1\)/);
});

test('the picker still runs the launcher under the host exe (which is what electronLaunch then re-points at the installed exe)', () => {
  assert.match(HOST, /'bin', 'claude-custom\.js'/);
});

test('checkDistInputs: missing helper, a helper that will not run, and one that runs', () => {
  const { checkDistInputs } = require('../scripts/check-dist-inputs');
  const missing = checkDistInputs({ helper: 'h.exe', exists: () => false, run: () => { throw new Error('not run'); } });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /npm run build:helper/);
  const bad = checkDistInputs({ helper: 'h.exe', exists: () => true, run: () => ({ status: 1 }) });
  assert.equal(bad.ok, false);
  const err = checkDistInputs({ helper: 'h.exe', exists: () => true, run: () => ({ error: new Error('EACCES') }) });
  assert.equal(err.ok, false);
  assert.match(err.message, /EACCES/);
  assert.equal(checkDistInputs({ helper: 'h.exe', exists: () => true, run: () => ({ status: 0 }) }).ok, true);
});

test('package.json: predist runs the check before dist', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts.predist, 'node scripts/check-dist-inputs.js');
});
