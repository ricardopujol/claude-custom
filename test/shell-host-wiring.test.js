'use strict';
/**
 * BACKLOG #119 A5: how host/host.js and app/main.js are wired for a shell host. host.js is a module-scope script that can't be
 * required, so, as test/side-session-wiring.test.js does, this pins the lines the behaviour rests on; verify/probe-shell-tab.js
 * runs the real thing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');

test('host.js: the shell flag is read once, before the hook helper is looked for, and a shell host has no helper', () => {
  assert.match(HOST, /const SHELL = isShellEnv\(process\.env\);\s*\nconst helperExists = !SHELL && fs\.existsSync\(HELPER_PATH\);/);
});

test('host.js: a shell host takes no session lock', () => {
  assert.match(HOST, /const SESSION_LOCK = SIDE \|\| SHELL \? null : lockPathFor\(CWD\);/);
});

test('host.js: the pty runs the picked shell with its (empty) arguments, not claude with claude\'s', () => {
  assert.match(HOST, /const SHELL_TARGET = SHELL \? pickShell\(process\.env\) : null;/);
  assert.match(HOST, /const spawnPty = \(\) => pty\.spawn\(SHELL \? SHELL_TARGET\.bin : CLAUDE_BIN, SHELL \? SHELL_TARGET\.args : ARGS, \{/);
});

test('host.js: a shell\'s environment goes through shellEnv and gets no provider, no mod token and no harness session marker', () => {
  const spawn = HOST.slice(HOST.indexOf('const spawnPty = () => pty.spawn('), HOST.indexOf('trackExit(term);'));
  const from = spawn.indexOf('env: SHELL');
  assert.ok(from > 0, 'the env is chosen by SHELL');
  const shellBranch = spawn.slice(from, spawn.indexOf('\n      : {', from));
  assert.match(shellBranch, /shellEnv\(cleanEnv\(\)\)/);
  assert.doesNotMatch(shellBranch, /providerEnv|MOD_TOKEN|CLAUDE_CUSTOM_SESSION/);
  assert.match(spawn.slice(spawn.indexOf('\n      : {', from)), /providerEnv/, 'claude\'s own branch still has them');
});

test('host.js: every identity the host writes says whether it is a shell host, as well as a side host', () => {
  const writes = HOST.match(/writeIdentity\(\{[^}]*\}\)/g) || [];
  assert.ok(writes.length >= 3, `found ${writes.length} writeIdentity calls`);
  for (const w of writes) assert.match(w, /\.\.\.identityFor\(\)/, w);
  assert.match(HOST, /const identityFor = \(\) => identityFields\(\{ side: SIDE, shell: SHELL, sessionId \}\);/);
});

test('host.js: a shell that fails to spawn ENDS the host through the same exit path as an exited shell (Dexter 1)', () => {
  const start = HOST.slice(HOST.indexOf('function startSession()'), HOST.indexOf('trackExit(term);'));
  assert.match(start, /const started = startShellPty\(spawnPty\);\s*\n\s*if \(!started\.term\) \{/);
  assert.match(start, /endHost\(started\.frame\.exitCode, started\.frame\.signal, \{ error: started\.frame\.error \}\);\s*\n\s*return;/);
  assert.match(start, /\} else \{\s*\n\s*term = spawnPty\(\);/, 'claude keeps the plain spawn');
  const end = HOST.slice(HOST.indexOf('function endHost('));
  assert.match(end, /releaseSessionLock\(SESSION_LOCK, lockOwner\)[\s\S]*type: 'exit', exitCode, signal, \.\.\.extra[\s\S]*process\.exit\(exitCode \?\? 0\)/);
  assert.match(HOST, /t\.onExit\(\(\{ exitCode, signal \}\) => \{[\s\S]{0,200}endHost\(exitCode, signal\);/);
});

test('host.js: a shell host polls no quota, asks for none on attach, and loads no mod', () => {
  assert.match(HOST, /const quotaTimer = SHELL \? null : setInterval\(/);
  assert.match(HOST, /if \(!SHELL\) refreshQuota\(\)/);
  assert.match(HOST, /if \(!lastQuota && !SHELL\) \{/);
  assert.match(HOST, /async function prepareMod\(\) \{\s*\n[^\n]*\n\s*if \(SHELL\) \{ setModStatus\(/);
});

test('host.js: a shell host runs no "another claude session in this worktree" check', () => {
  assert.match(HOST, /async function refreshTerminals\(\) \{[^\n]*\n[^\n]*\n\s*if \(SHELL \|\| terminalsRunning\) return;/);
});

test('main.js: a shell tab\'s host is spawned with the shell flag, and found as a shell host through a port of its own', () => {
  assert.match(MAIN, /hostEnv\(process\.env, \{ cwd: tab\.cwd, port, token, project: HOST_PROJECT, side: tab\.side === true, shell: tab\.shell === true \}\)/);
  assert.match(MAIN, /resolvePort\(\{ cwd: tab\.cwd, occupantAt, side, kind: tab\.shell === true \? 'shell' : undefined \}\)/);
  const choose = MAIN.slice(MAIN.indexOf('async function chooseHostPort'), MAIN.indexOf('function spawnHost'));
  assert.match(choose, /const side = tab\.side === true;/);
  assert.match(choose, /const companion = side \|\| tab\.shell === true;/);
  assert.match(choose, /if \(!companion && EXPLICIT_PORT\)/);
});

test('main.js: the tab menu offers Open shell here, and its click opens it on the branch tab the menu names', () => {
  const menu = MAIN.slice(MAIN.indexOf("ipcMain.on('strip:contextMenu'"), MAIN.indexOf("ipcMain.on('strip:plus'"));
  assert.match(menu, /tabShell\.shellMenu\(key\)/);
  assert.match(menu, /label: shellState\.enabled \? shellState\.label : `\$\{shellState\.label\} \(\$\{shellState\.why\}\)`/);
  assert.match(menu, /tabShell\.openShell\(shellState\.target\)/);
  assert.match(menu, /if \(isShellKey\(key\)\) \{ Menu\.buildFromTemplate\(\[shellItem\]\)/);
  assert.match(menu, /sideItem,\s*\n\s*shellItem,/, 'the shell item sits right after the side item on a branch tab');
});

test('main.js: the + menu offers a Shell tab for the selected lane', () => {
  const plus = MAIN.slice(MAIN.indexOf("ipcMain.on('strip:plus'"), MAIN.indexOf("ipcMain.on('strip:plus'") + 2500);
  assert.match(plus, /m\.shell\.enabled \? m\.shell\.label : `\$\{m\.shell\.label\} \(\$\{m\.shell\.why\}\)`/);
  assert.match(plus, /tabShell\.openShell\(m\.shell\.target\)/);
});

test('main.js: the probe driver can open a shell by the branch tab\'s label', () => {
  assert.match(MAIN, /async shellOpen\(label\)/);
  assert.match(MAIN, /tabShell\.openShell\(key\)/);
});

test('main.js: the identity files are searched for shell hosts as well as side hosts', () => {
  assert.match(MAIN, /shellHosts: \(\) => shellHostsOf\(ownIdentities\(\)\)/);
});
