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
