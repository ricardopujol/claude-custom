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
  assert.match(HOST, /const \{ stopAllHome, sentinelsFor, watch: watchKillSwitch, createNightBudget, createStopper, createLinger, loadAnchorWithLegacy, legacyAnchorFile, saveAnchor, anchorFileFor, NIGHT_BUDGET_MS \} = require\('\.\/kill-switch'\);/);
});

test('the sentinels: STOP-ALL from the home folder (or the probe seam), the project STOP from STATE_ROOT, never a hard-coded user', () => {
  const b = block('const KILL_SWITCH_PATHS = ', '\n');
  assert.match(b, /sentinelsFor\(\{ claudeHome: stopAllHome\(\{ seam: seams\.claudeHome, home: os\.homedir\(\) \}\), stateRoot: STATE_ROOT \}\)/);
  assert.doesNotMatch(b, /Users[\\/]|STOP-ALL'|\.claude-custom/i, 'the paths are built by host/kill-switch.js, not spelled here');
});

test('the stopper kills the tracked pty through pty-stop and kill-tree\'s killChildTree, never by name', () => {
  const b = block('const killStop = createStopper({', '\n});');
  assert.match(b, /term: \(\) => term,/);
  assert.match(b, /stopPty: boundedStopPty,/, 'the same pty-stop, under the shutdown watchdog (PR #217 Dexter F4)');
  assert.match(b, /killChildTree,/);
  assert.match(b, /log: \(line\) => console\.log\(line\)/, 'host.log hears it');
  assert.match(b, /sayInTab\(state\.text\)/, 'the tab says it');
  assert.match(b, /broadcastControl\(\{ type: 'killSwitch', killSwitch: state \}\)/, 'and the diagnostics pane');
  assert.doesNotMatch(b, /taskkill|killPidTree|\/IM/);
});

test('the stopper reads the kill outcome from kill-tree, and an unproven kill is retried on a timer', () => {
  assert.match(HOST, /const \{ killTree, killPidTree, killChildTree, killOutcomeOf, trackedStart, trackExit \} = require\('\.\/kill-tree'\);/);
  const b = block('const killStop = createStopper({', '\n});');
  assert.match(b, /outcomeOf: killOutcomeOf,/);
  assert.match(HOST, /setInterval\(\(\) => \{ try \{ killStop\.retry\(\); \} catch \{[^}]*\} \}, 5000\)\.unref\(\);/);
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
  const spawn = b.indexOf('const spawnPty = () => pty.spawn(');
  assert.ok(check !== -1 && refuse !== -1 && spawn !== -1);
  assert.ok(check < refuse && refuse < spawn, 'checked, then refused, then (only otherwise) spawned');
  const refusal = b.slice(refuse, b.indexOf('\n  }\n', refuse));
  assert.match(refusal, /releaseSessionLock\(SESSION_LOCK, lockOwner\)/, 'a host that runs nothing holds no worktree');
  assert.match(refusal, /return;/);
  assert.strictEqual(HOST.split('pty.spawn(').length - 1, 1, 'one spawn path in host.js, so none can slip past the refusal');
});

test('#127: the session\'s pty is put in a job at spawn, so a trip ends processes whose parent already exited', () => {
  assert.match(HOST, /const \{ createJobGuard, KILL_ANSWER_MS \} = require\('\.\/job-guard'\);/);
  const guard = block('const jobGuard = createJobGuard({', '\n});');
  assert.match(guard, /log: \(line\) => console\.log\(line\),/);
  assert.match(guard, /onOutcome: \(outcome\) => \{ try \{ killStop\.noteJob\(outcome\); \} catch \{/, 'the job\'s answer reaches the stop (PR #235 Miguel S6)');
  assert.ok(HOST.indexOf('const jobGuard = createJobGuard(') < HOST.indexOf('const killStop = createStopper('), 'built before the stopper that ends it');
  const spawnAt = HOST.indexOf('trackExit(term);');
  assert.ok(spawnAt !== -1);
  const after = HOST.slice(spawnAt, HOST.indexOf('wireTerm(term);', spawnAt));
  assert.match(after, /jobGuard\.attach\(\{ pid: term\.pid, startOf: \(\) => trackedStart\(term\), spawnWindow \}\)/, 'attached right after the spawn is tracked, with the pty\'s proven start and its spawn window');
  assert.match(after, /\.catch\(/, 'a rejected attach never breaks the session');
});

test('#127: the spawn window is the clock just before and just after the one pty.spawn, for both the claude and the shell path', () => {
  const b = block('function startSession() {', '\n}\n');
  assert.match(b, /const spawnTimed = \(\) => \{ const before = Date\.now\(\); const t = spawnPty\(\); spawnWindow = \{ before, after: Date\.now\(\) \}; return t; \};/);
  assert.match(b, /startShellPty\(spawnTimed\)/);
  assert.match(b, /term = spawnTimed\(\);/);
  assert.doesNotMatch(b, /startShellPty\(spawnPty\)|term = spawnPty\(\)/, 'no spawn without its window');
});

test('#127: the stopper ends the job (for the stops jobEndsFor names), not the bounded tree kill; the host waits for its answer before it exits (PR #235 Dexter 2, 4)', () => {
  const stopper = block('const killStop = createStopper({', '\n});');
  assert.match(stopper, /endJob: \(\) => jobGuard\.kill\(\),/);
  const stop = block('const boundedStopPty = ', '\n');
  assert.doesNotMatch(stop, /jobGuard/, 'one place asks for the job: the stopper');
  const end = block('function endHost(', '\n}\n');
  assert.match(end, /jobGuard\.leave\(KILL_ANSWER_MS\)\.then\(\(\) => process\.exit\(exitCode \?\? 0\), \(\) => process\.exit\(exitCode \?\? 0\)\);/, 'a KILL in flight is answered before the helper dies with the host, and one left unanswered is said (K4a)');
});

test('the night budget follows the night\'s payload and stops the session at its deadline', () => {
  const b = block('const nightBudget = createNightBudget({', '\n});');
  assert.match(b, /nightNow: \(\) => night\.payload\(\)/, 'asked again at the deadline');
  assert.match(b, /load: \(\) => loadAnchorWithLegacy\(NIGHT_ANCHOR_FILE, legacyAnchorFile\(STATE_ROOT\)\)/, 'a replaced host keeps the first night deadline, an upgraded one too (PR #235 Dexter 9)');
  assert.match(b, /save: \(anchor\) => saveAnchor\(NIGHT_ANCHOR_FILE, anchor, \{ write: \(f, data\) => writeFileAtomic\(f, data\) \}\)/, 'written atomically');
  assert.match(HOST, /const NIGHT_ANCHOR_FILE = anchorFileFor\(\{ stateRoot: STATE_ROOT, worktree: CWD \}\);/, 'keyed by this tab\'s worktree, not the shared state root (#128)');
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
  assert.match(b, /\(\) => killSwitch\.stop\(\)/);
  assert.match(b, /\(\) => nightBudget\.stop\(\)/, 'its own step: runShutdown isolates each, so one stop\'s throw never skips the other');
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
