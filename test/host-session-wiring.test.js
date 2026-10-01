'use strict';
/**
 * host.js's session wiring (PR 1b review round, Miguel Y4): the parts of the
 * session lock that live in host.js itself, which no unit test can load.
 * Source assertions in the style of test/control.test.js's scan of
 * dispatchControl; the behaviour is also exercised end to end by
 * verify/probe-session-lock-host.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

function fnBody(name) {
  const start = HOST.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `host.js must define ${name}`);
  return HOST.slice(start, HOST.indexOf('\n}', start));
}

test('R1: the pty starts at the size the window last asked for, not a fixed 120x30', () => {
  // Miguel, PR #71 R1 (blocking): a resize that arrives while the session is
  // blocked (or still booting) only reaches termState, so a session started
  // afterwards at a literal 120x30 is out of step with termState and with the
  // window's own xterm until the next resize.
  const body = fnBody('startSession');
  assert.match(body, /termState\.size\(\)/, 'startSession must read the current size from termState');
  assert.doesNotMatch(body, /cols:\s*\d|rows:\s*\d/, 'no literal dimensions in the spawn');
});

function bootBlock() {
  const start = HOST.indexOf('// --- boot: the session lock');
  assert.ok(start !== -1, 'host.js must have the boot block');
  return HOST.slice(start);
}

test('Y1: boot records the lock verdict before anything else can throw', () => {
  // Miguel, PR #71 Y1: the verdict was only recorded after the port block and
  // env were worked out, so an error there left lockState 'pending' and the
  // catch started a session over a BLOCKED verdict.
  const boot = bootBlock();
  const acquired = boot.indexOf('acquireSessionLock(');
  const recorded = boot.indexOf('setLockState(gate.lock)');
  assert.ok(acquired !== -1 && recorded > acquired, 'the verdict is recorded right after acquire');
  for (const later of ['worktreeEnv(', 'allocatePortBlock(']) {
    const at = boot.indexOf(later);
    assert.ok(at === -1 || at > recorded, `${later} runs only after the verdict is recorded`);
  }
});

test('Y1: boot\'s catch asks gateOnBootError and never throws out of itself', () => {
  const boot = bootBlock();
  const katch = boot.slice(boot.indexOf('.catch('), boot.indexOf('.finally('));
  assert.match(katch, /gateOnBootError\(lockState\)/);
  assert.match(katch, /try\s*\{[^}]*startSession\(\)/, 'a startSession that throws in the catch is caught');
});

function dispatchBranch(type) {
  const start = HOST.indexOf(`if (msg.type === '${type}')`);
  assert.ok(start !== -1, `dispatchControl must handle ${type}`);
  return HOST.slice(start, HOST.indexOf('if (msg.type ===', start + 10));
}

test('F1: Open anyway re-acquires the lock before it starts anything', () => {
  // Dexter, PR #71 F1: overriding a lock whose holder had gone started an
  // unlocked session, and the next window then took the free lock and started
  // claude #2 without being blocked.
  assert.match(dispatchBranch('lock-override'), /overrideSession\(\)/);
  const body = fnBody('overrideSession');
  const acquire = body.indexOf('acquireSessionLock(');
  const decide = body.indexOf('gateAfterRecheck(');
  const start = body.indexOf('startSession()');
  assert.ok(acquire !== -1 && decide !== -1 && start > acquire && start > decide,
    'acquire and gateAfterRecheck come before startSession');
});

test('F1: a blocked or overridden host re-checks the lock on the timer', () => {
  const body = fnBody('recheckLock');
  assert.match(body, /acquireSessionLock\(/);
  assert.match(body, /gateRecheck\(/);
  const timer = HOST.slice(HOST.indexOf('const branchTimer = setInterval('), HOST.indexOf('branchTimer.unref()'));
  assert.match(timer, /recheckLock\(\)/);
});

test('F1: one re-check or override at a time', () => {
  for (const fn of ['overrideSession', 'recheckLock']) assert.match(fnBody(fn), /lockBusy/, `${fn} honours lockBusy`);
});

test('Y3/F2: idle exit runs on the timer and on close, through the idle watch', () => {
  const body = fnBody('checkIdle');
  assert.match(body, /idleWatch\.update\(/);
  const timer = HOST.slice(HOST.indexOf('const branchTimer = setInterval('), HOST.indexOf('branchTimer.unref()'));
  assert.match(timer, /checkIdle\(\)/, 'a host whose window never connects still gets checked');
  const close = HOST.slice(HOST.indexOf("ws.on('close'"), HOST.indexOf('});', HOST.indexOf("ws.on('close'")));
  assert.match(close, /checkIdle\(\)/);
  assert.doesNotMatch(close, /setTimeout\(/, 'no fixed wait racing a reopening window');
});

test('Y2: a blocked host allocates no port block -- the env is worked out when a session starts', () => {
  assert.match(fnBody('startSession'), /workOutSessionEnv\(\)/);
  assert.match(fnBody('workOutSessionEnv'), /allocatePortBlock\(/);
  assert.doesNotMatch(bootBlock(), /allocatePortBlock\(|workOutSessionEnv\(/);
});

test('F8: the terminal check re-reads the lock holder, so its own claude is never "another session"', () => {
  assert.match(fnBody('refreshTerminals'), /readHolder\(SESSION_LOCK\)/);
});

test('the lock owner names this host\'s install dir', () => {
  assert.match(HOST, /lockOwner = \{[^}]*install: path\.join\(__dirname, '\.\.'\)/);
});

test('F2 (Dexter, PR #75): the token files are written only AFTER the bind succeeds', () => {
  // A host that loses the bind (EADDRINUSE) must not have overwritten the
  // winner's hosts/<port>.token. Retry after a slow start spawns exactly such
  // a loser, and a clobbered file makes every later connect a 403.
  const call = HOST.indexOf('writeTokenFiles();');
  assert.ok(call !== -1, 'host.js must call writeTokenFiles()');
  const listening = HOST.indexOf("wss.on('listening'");
  const errorHandler = HOST.indexOf("wss.on('error'");
  assert.ok(listening !== -1 && call > listening && call < errorHandler,
    'writeTokenFiles() must be called inside the wss.on("listening") handler');
  const between = HOST.slice(listening, call);
  assert.ok(!between.includes('\n});'), 'and still inside that handler, not after it');
  // And nothing writes them at module load, before the bind.
  assert.strictEqual(HOST.split('writeFileSync(PORT_TOKEN_FILE').length - 1, 1,
    'PORT_TOKEN_FILE is written in exactly one place');
  const fn = HOST.indexOf('function writeTokenFiles(');
  assert.ok(fn !== -1 && HOST.indexOf('writeFileSync(PORT_TOKEN_FILE') > fn);
  assert.ok(HOST.indexOf('writeFileSync(PORT_TOKEN_FILE') < HOST.indexOf('new WebSocketServer('),
    'the write lives in the helper, which is defined above but only CALLED after listening');
});

test('Stop that session: dispatched only for a blocked host with no session, one at a time', () => {
  const at = HOST.indexOf("msg.type === 'lock-stop-holder'");
  assert.ok(at !== -1, 'host.js must dispatch lock-stop-holder');
  const branch = HOST.slice(at, HOST.indexOf('return;\n    }', at));
  assert.match(branch, /lockState\.state !== 'blocked'/, 'only a blocked window may stop the holder');
  assert.match(branch, /term !== null|term\)/, 'never once this host has a session of its own');
  assert.match(branch, /stopLockHolder\(\)/);

  const body = fnBody('stopLockHolder');
  assert.match(body, /if \(lockBusy\b/, 'one stop, re-check or override at a time');
  assert.match(body, /lockBusy = true/);
  assert.match(body, /shown: lockState\.holder/, 'only the holder the pane showed');
  assert.match(body, /broadcastControl\(\{ type: 'lock-stop'/, 'the pane is told what came of it');
  assert.match(body, /finally \{\s*lockBusy = false;/);
  // Once the holder is gone (or the lock changed), re-check at once rather
  // than leave the pane up for up to 30 s.
  assert.match(HOST, /STOP_RECHECKS\.has\(r\.outcome\)[\s\S]{0,80}recheckLock\(\)/);
});
