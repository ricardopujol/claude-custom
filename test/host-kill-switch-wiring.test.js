'use strict';
/**
 * host.js's half of the kill switch and the night budget (documentation/PLAN_SAFETY_NET.md lane 2; the behaviour is
 * host/kill-switch.js's, tested in test/kill-switch.test.js). Source assertions in the style of test/host-schedules-wiring.test.js,
 * because host.js can't be loaded by a unit test.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8').replace(/\r\n/g, '\n');   // the file is CRLF on Windows checkouts

function block(startMarker, endMarker) {
  const at = HOST.indexOf(startMarker);
  assert.ok(at !== -1, `missing: ${startMarker}`);
  const end = HOST.indexOf(endMarker, at + startMarker.length);
  assert.ok(end !== -1, `missing end: ${endMarker}`);
  return HOST.slice(at, end);
}

test('the kill switch module is required by name', () => {
  assert.match(HOST, /const \{ stopAllHome, sentinelsFor, watch: watchKillSwitch, createNightBudget, createStopper, createLinger, loadAnchor, saveAnchor, NIGHT_BUDGET_MS \} = require\('\.\/kill-switch'\);/);
});

test('the sentinels: STOP-ALL from the home folder (or the probe seam), the project STOP from STATE_ROOT, never a hard-coded user', () => {
  const b = block('const KILL_SWITCH_PATHS = ', '\n');
  assert.match(b, /sentinelsFor\(\{ claudeHome: stopAllHome\(\{ seam: seams\.claudeHome, home: os\.homedir\(\) \}\), stateRoot: STATE_ROOT \}\)/);
  assert.doesNotMatch(b, /Users[\\/]|STOP-ALL'|\.claude-custom/i, 'the paths are built by host/kill-switch.js, not spelled here');
});

test('the stopper kills the tracked pty through pty-stop and kill-tree\'s killChildTree, never by name', () => {
  const b = block('const killStop = createStopper({', '\n});');
  assert.match(b, /term: \(\) => term,/);
  assert.match(b, /stopPty,/);
  assert.match(b, /killChildTree,/);
  assert.match(b, /log: \(line\) => console\.log\(line\)/, 'host.log hears it');
  assert.match(b, /sayInTab\(state\.text\)/, 'the tab says it');
  assert.match(b, /broadcastControl\(\{ type: 'killSwitch', killSwitch: state \}\)/, 'and the diagnostics pane');
  assert.doesNotMatch(b, /taskkill|killPidTree|\/IM/);
});

test('the watch trips the stopper: a kill when a session runs, a refusal when none does', () => {
  const b = block('const killSwitch = watchKillSwitch({', '\n});');
  assert.match(b, /sentinelPaths: KILL_SWITCH_PATHS/);
  assert.match(b, /killStop\.stop\(\{ kind: term \? 'tripped' : 'refused', sentinel, scope \}\)/);
});

test('the watch clears a refusal when the file is gone and restarts the held-back session under the lock, like the boot', () => {
  const w = block('const killSwitch = watchKillSwitch({', '\n});');
  assert.match(w, /onClear: \(\) => \{ if \(killStop\.clearRefused\(\)\) restartAfterRefusal\(\); \},/);
  const b = block('async function restartAfterRefusal() {', '\n}\n');
  assert.match(b, /if \(term \|\| lockBusy \|\| !lockOwner\) return;/);
  assert.match(b, /gateFromAcquire\(await acquireSessionLock\(SESSION_LOCK, lockOwner\)\)/, 'the lock the refusal released is taken again');
  assert.match(b, /if \(g\.start\) startSession\(\);/);
  assert.match(b, /finally \{\s*lockBusy = false;/);
});

test('startSession refuses to spawn claude while a sentinel exists or after this host was stopped, BEFORE pty.spawn', () => {
  const b = block('function startSession() {', '\n}\n');
  const check = b.indexOf('killSwitch.check();');
  const refuse = b.indexOf('if (killStop.state() !== null) {');
  const spawn = b.indexOf('term = pty.spawn(');
  assert.ok(check !== -1 && refuse !== -1 && spawn !== -1);
  assert.ok(check < refuse && refuse < spawn, 'checked, then refused, then (only otherwise) spawned');
  const refusal = b.slice(refuse, b.indexOf('\n  }\n', refuse));
  assert.match(refusal, /releaseSessionLock\(SESSION_LOCK, lockOwner\)/, 'a host that runs nothing holds no worktree');
  assert.match(refusal, /return;/);
});

test('the night budget follows the night\'s payload and stops the session at its deadline', () => {
  const b = block('const nightBudget = createNightBudget({', '\n});');
  assert.match(b, /nightNow: \(\) => night\.payload\(\)/, 'asked again at the deadline');
  assert.match(b, /load: \(\) => loadAnchor\(NIGHT_ANCHOR_FILE\)/, 'a replaced host keeps the first night deadline');
  assert.match(b, /save: \(anchor\) => saveAnchor\(NIGHT_ANCHOR_FILE, anchor, \{ write: \(f, data\) => writeFileAtomic\(f, data\) \}\)/, 'written atomically');
  assert.match(HOST, /const NIGHT_ANCHOR_FILE = path\.join\(STATE_ROOT, '\.claude-custom', 'night-anchor\.json'\);/);
  assert.match(b, /killStop\.stop\(\{ kind: 'night-budget', startedAt, budgetMs: NIGHT_BUDGET_MS \}\)/);
  const n = block('const night = createNightStatus({', '\n});');
  assert.match(n, /nightBudget\.update\(payload\)/);
  assert.ok(HOST.indexOf('const nightBudget = createNightBudget({') < HOST.indexOf('const night = createNightStatus({'), 'built before the night that feeds it');
});

test('a host the kill switch stopped, with no session and no window, goes after the grace', () => {
  const b = block('function checkIdle() {', '\n}\n');
  assert.match(b, /killLinger\.update\(killStop\.state\(\) !== null && term === null, clients\.size\)/);
  assert.match(b, /shutdown\(\);\s*process\.exit\(0\);/);
});

test('the hello carries the stop, so a window that attaches later still learns why', () => {
  const b = block("type: 'hello',", '\n  });');
  assert.match(b, /killSwitch: killStop\.state\(\),/);
});

test('shutdown stops the watch and the budget', () => {
  const b = block('function shutdown({ removeIdentity = true } = {}) {', '\n}\n');
  assert.match(b, /killSwitch\.stop\(\)/);
  assert.match(b, /nightBudget\.stop\(\)/);
});

test('sayInTab writes into the headless screen (replayed on attach) and to every open window', () => {
  const b = block('function sayInTab(text) {', '\n}\n');
  assert.match(b, /termState\.write\(line\)/);
  assert.match(b, /ws\.send\(frame, \{ binary: true \}\)/);
});

// --- the window's half: the diagnostics pane says it (app/renderer.js) ------------------------------------------------

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');

test('the renderer logs the stop in the diagnostics pane, from the frame and from the hello, once per stop', () => {
  const at = RENDERER.indexOf('function noteKillSwitch(stop) {');
  assert.ok(at !== -1);
  const b = RENDERER.slice(at, RENDERER.indexOf('\n}\n', at));
  assert.match(b, /logLine\('kill switch', stop\.text\)/);
  assert.match(b, /lastKillSwitchLogged/);
  const handle = RENDERER.slice(RENDERER.indexOf('function handleControl(msg) {'));
  assert.match(handle, /if \(msg\.type === 'killSwitch'\) \{ noteKillSwitch\(msg\.killSwitch\); return; \}/);
  const hello = handle.slice(handle.indexOf("if (msg.type === 'hello') {"), handle.indexOf("if (msg.type === 'hello') {") + 400);
  assert.match(hello, /noteKillSwitch\(msg\.killSwitch\);/);
});
