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

// One dispatch branch, `if (msg.type === '<type>') {` to its closing brace at
// the same indent. Line endings normalised (a CRLF checkout made an earlier
// '\n'-only end marker miss, and the slice ran to the end of the file --
// Miguel, PR #76 I5), and an end that isn't found FAILS.
function dispatchBranch(type) {
  const src = HOST.replace(/\r\n/g, '\n');
  const open = `    if (msg.type === '${type}') {\n`;
  const at = src.indexOf(open);
  assert.ok(at !== -1, `host.js must dispatch ${type}`);
  const end = src.indexOf('\n    }\n', at);
  assert.ok(end !== -1, `the ${type} branch must close`);
  const branch = src.slice(at, end);
  assert.ok(branch.length < 1500, `the ${type} slice is one branch, not the rest of host.js`);
  return branch;
}

test('Stop that session: dispatched only for a blocked host with no session', () => {
  const branch = dispatchBranch('lock-stop-holder');
  assert.match(branch, /lockState\.state !== 'blocked' \|\| term !== null/, 'only a blocked window with no session of its own');
  assert.match(branch, /stopLockHolder\(msg\.holder\)/, 'the holder the PANE showed, not whatever this host holds now (Dexter F6)');
});

test('a click while the lock is busy is answered, never dropped (Dexter F4)', () => {
  for (const type of ['lock-stop-holder', 'lock-override']) {
    const branch = dispatchBranch(type);
    assert.match(branch, /if \(lockBusy\) \{[\s\S]*?sendControl\(ws, \{ type: 'lock-note'/, `${type} answers a busy lock`);
  }
});

test('stopLockHolder: one at a time, proven by the OS too, logged, then re-checked and answered', () => {
  const body = fnBody('stopLockHolder');
  assert.match(body, /if \(lockBusy\) return/, 'one stop, re-check or override at a time');
  assert.match(body, /lockBusy = true/);
  assert.match(body, /shown: holder/);
  assert.match(body, /windowCount/, 'a holder that can\'t be asked is counted by the OS (Dexter F1)');
  assert.match(body, /finally \{\s*lockBusy = false;/);
  // Miguel I2: the log names the pid, how it ended and why the controls were skipped.
  assert.match(body, /console\.log\(`\[host\] Stop that session: \$\{r\.outcome\}[^`]*\$\{shownPid\}[^`]*\$\{r\.how/);
  assert.match(body, /r\.reason/);
  // Re-checked BEFORE the answer: the re-check's repaint clears the note.
  assert.match(body, /STOP_RECHECKS\.has\(r\.outcome\)\) await recheckLock\(\);\s*broadcastControl\(\{ type: 'lock-note'/);
});

test('stop-if-idle: the holder counts its windows and stops in ONE step (Dexter F2)', () => {
  const branch = dispatchBranch('stop-if-idle');
  assert.match(branch, /idleStopVerdict\(\{ windows: targets\.length, lastWindowLeftAt, now: Date\.now\(\) \}\)/);
  assert.match(branch, /const targets = raiseTargets\(clients, ws\)/, 'the asking client is not a window');
  // Refused: its windows come forward and the asker is told; nothing ends.
  const refused = branch.slice(0, branch.indexOf('shutdown()'));
  assert.match(refused, /if \(!v\.stop\) \{[\s\S]*for \(const w of targets\) sendControl\(w, \{ type: 'raise' \}\)[\s\S]*stopped: false[\s\S]*return;/);
  // Stopped: the answer is flushed before the host goes.
  assert.match(branch, /ws\.send\(JSON\.stringify\(\{ type: 'stop-if-idle', stopped: true \}\), \(\) => \{[\s\S]*shutdown\(\)/);
});

test('a window leaving starts the grace; a one-shot control client does not', () => {
  const src = HOST.replace(/\r\n/g, '\n');
  // (ws, req): the URL says whether it is a one-shot control client (PR #93 Dexter F8)
  assert.match(src, /wss\.on\('connection', \(ws, req\) => \{\n  clients\.add\(ws\);\n  ws\.openedAt = Date\.now\(\);/);
  const close = src.slice(src.indexOf("  ws.on('close', () => {"), src.indexOf('\n  });\n', src.indexOf("  ws.on('close', () => {")));
  assert.match(close, /if \(leftAsWindow\(ws\.openedAt, Date\.now\(\)\)\) lastWindowLeftAt = Date\.now\(\);/);
});
