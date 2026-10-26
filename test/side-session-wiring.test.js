'use strict';
/**
 * BACKLOG #81: the wiring that no function test can see, as source assertions on app/main.js and host/host.js (they
 * need Electron and a pty, so a unit test can't run them; the real-window probe, verify/probe-side-session.js, does).
 * The pieces themselves are tested in test/side-session.test.js and test/tab-shell-side.test.js.
 *
 * Deliberately NOT in Stryker's command: it asserts on the text of product modules.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const HOST = read('host', 'host.js');
const MAIN = read('app', 'main.js');
const PRELOAD = read('app', 'preload-strip.js');

test('host.js: a side host builds claude\'s args with the side option, from the environment flag', () => {
  assert.match(HOST, /const SIDE = isSideEnv\(process\.env\);/);
  assert.match(HOST, /const ARGS_OPTIONS = \{ settingsFile, helperExists, canvasMcp, side: SIDE \};/);
  assert.match(HOST, /let ARGS = buildClaudeArgs\(ARGS_OPTIONS\);/);
});

test('host.js: a side host takes no session lock, so it never holds the worktree\'s writer role', () => {
  assert.match(HOST, /const SESSION_LOCK = SIDE \? null : lockPathFor\(CWD\);/);
});

test('host.js: every identity the host writes says whether it is a side host', () => {
  const writes = HOST.match(/writeIdentity\(\{[^}]*\}\)/g) || [];
  assert.ok(writes.length >= 3, `found ${writes.length} writeIdentity calls`);
  for (const w of writes) assert.match(w, /side: SIDE/, w);
});

test('host.js: a side host\'s subagents claim worktrees as readers', () => {
  assert.match(HOST, /role: SIDE \? 'reader' : undefined/);
});

test('main.js: a side tab\'s host is spawned with the side flag, and found as a side host, never through the window\'s explicit port', () => {
  assert.match(MAIN, /hostEnv\(process\.env, \{ cwd: tab\.cwd, port, token, project: HOST_PROJECT, side: tab\.side === true \}\)/);
  assert.match(MAIN, /resolvePort\(\{ cwd: tab\.cwd, occupantAt, side \}\)/);
  const choose = MAIN.slice(MAIN.indexOf('async function chooseHostPort'), MAIN.indexOf('function spawnHost'));
  assert.match(choose, /const side = tab\.side === true;/);
  assert.match(choose, /if \(!side && EXPLICIT_PORT\)/);
});

test('main.js: the tab menu offers the side session, and its click opens it on the branch tab it names', () => {
  const menu = MAIN.slice(MAIN.indexOf("ipcMain.on('strip:contextMenu'"), MAIN.indexOf("ipcMain.on('strip:plus'"));
  assert.match(menu, /tabShell\.sideMenu\(key\)/);
  assert.match(menu, /label: side\.enabled \? side\.label : `\$\{side\.label\} \(\$\{side\.why\}\)`/);
  assert.match(menu, /enabled: side\.enabled/);
  assert.match(menu, /tabShell\.openSide\(side\.target\)/);
});

test('main.js: the probe driver can open a side session by the branch tab\'s label', () => {
  assert.match(MAIN, /async sideOpen\(label\)/);
  assert.match(MAIN, /tabShell\.openSide\(key\)/);
});

test('the strip bridge needs nothing new: the side item rides the existing contextMenu channel', () => {
  assert.match(PRELOAD, /contextMenu/);
});
