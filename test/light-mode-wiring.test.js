'use strict';
/**
 * Backlog #25, the host's wiring, pinned from its source (host/host.js is a script that starts a pty, so it can't be
 * required). Miguel PR #148 #3: "the theme is read AFTER the new-project seed" is exactly the ordering bug that would
 * be silent.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8').replace(/\r\n/g, '\n');
const at = (needle, from = 0) => {
  const i = HOST.indexOf(needle, from);
  assert.notStrictEqual(i, -1, `host.js has ${needle}`);
  return i;
};

test('the CLI theme is read after the new-project seed, and the settings file is written after it', () => {
  const seed = at('seedLookIfNew({');
  const launch = at('const LAUNCH_CLI_THEME =', seed);
  const write = at('writeHarnessSettings(HARNESS_DIR', launch);
  const args = at('const ARGS_OPTIONS =', write);
  assert.ok(seed < launch && launch < write && write < args);
  assert.match(HOST.slice(write, args), /theme: LAUNCH_CLI_THEME/);
});

test('the launched theme travels in every style message and in the hello', () => {
  assert.match(HOST.slice(at('function currentStyle()'), at('function currentStyle()') + 400), /cliTheme: RUNNING_CLI_THEME/);
  assert.match(HOST, /look: styleResolved\.look, cliTheme: RUNNING_CLI_THEME/);
});

test('the set-mode control message goes to setMode with the host\'s project root and is announced on success', () => {
  const i = at("msg.action === 'set-mode'");
  const body = HOST.slice(i, i + 700);
  assert.match(body, /setMode\(\{ cwd: STATE_ROOT, mode: msg\.mode/);
  assert.match(body, /refuse\(r\.reason\)/);
  assert.match(body, /announce\(\)/);
});

test('the running CLI theme is what the CLI was given, or else the person\'s own', () => {
  assert.match(HOST, /findUserTheme\(\{ configDir: claudeConfigDir\(\), cwd: CWD \}\)/);
  assert.match(HOST, /const LAUNCH_CLI_THEME = cliThemeFor\(readLook\(STATE_ROOT\), USER_CLI_THEME\)/);
  assert.match(HOST, /const RUNNING_CLI_THEME = LAUNCH_CLI_THEME \|\| USER_CLI_THEME/);
});
