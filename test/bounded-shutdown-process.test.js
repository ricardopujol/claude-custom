'use strict';
// BACKLOG #121 (PR #217): the REAL-PROCESS tests of the shutdown watchdog, split from bounded-shutdown.test.js so that file stays in Stryker's
// command (a hung child counts as a kill there). Run by hand: node --test test/bounded-shutdown-process.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./tmp-dir');
const { armWatchdog } = require('../host/bounded-shutdown');

// A process that arms the watchdog with its own start time, then runs `steps` (source text), as the host does.
function runBlocked(dir, body) {
  const script = `
    (async () => {
      const fs = require('fs');
      const { runShutdown } = require(${JSON.stringify(path.join(__dirname, '..', 'host', 'bounded-shutdown'))});
      const start = await require(${JSON.stringify(path.join(__dirname, '..', 'host', 'proc-start'))}).createSelfStartTime()();
      ${body}
    })();
  `;
  const t0 = Date.now();
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true });
  return new Promise((resolve) => {
    const guard = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ code: 'HUNG', ms: Date.now() - t0 }); }, 15000);   // kill-ok(held-handle): the child this test spawned
    child.on('exit', (c) => { clearTimeout(guard); resolve({ code: c === null ? 'killed' : c, ms: Date.now() - t0 }); });
  });
}

const BLOCK = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);";   // never returns

test('a host whose teardown blocks the event loop for good exits within the bound, and the steps after the block never run', async () => {
  const dir = tmpDir('cc-bounded-');
  const logFile = path.join(dir, 'host.log');
  const marks = path.join(dir, 'marks.txt');
  const { code, ms } = await runBlocked(dir, `
    runShutdown({ boundMs: 400, logFile: ${JSON.stringify(logFile)}, start, steps: [
      () => fs.appendFileSync(${JSON.stringify(marks)}, 'pty-started\\n'),
      () => { ${BLOCK} },
      () => fs.appendFileSync(${JSON.stringify(marks)}, 'REACHED-AFTER-TEARDOWN\\n'),
    ] });`);
  assert.notStrictEqual(code, 'HUNG', 'the process must end by itself');
  assert.ok(ms < 14000);
  const m = fs.readFileSync(marks, 'utf8');
  assert.match(m, /pty-started/);
  assert.doesNotMatch(m, /REACHED-AFTER-TEARDOWN/);
  assert.match(fs.readFileSync(logFile, 'utf8'), /\[host\] shutdown: the shutdown did not finish within 400 ms; exiting anyway/);
});

test('the kill switch stopper\'s kill is bounded too: a blocking stopPty under the same watchdog still ends the host (PR #217 Dexter F4)', async () => {
  const dir = tmpDir('cc-bounded-');
  const logFile = path.join(dir, 'host.log');
  const { code } = await runBlocked(dir, `
    const { createStopper } = require(${JSON.stringify(path.join(__dirname, '..', 'host', 'kill-switch'))});
    const bounded = (t, o) => runShutdown({ boundMs: 400, logFile: ${JSON.stringify(logFile)}, start, steps: [() => { ${BLOCK} }] });
    createStopper({ term: () => ({ pid: 1 }), stopPty: bounded, killChildTree: () => {} }).stop({ kind: 'tripped', sentinel: 's', scope: 'all' });
    fs.appendFileSync(${JSON.stringify(path.join(dir, 'after.txt'))}, 'REACHED');`);
  assert.notStrictEqual(code, 'HUNG');
  assert.strictEqual(fs.existsSync(path.join(dir, 'after.txt')), false);
  assert.match(fs.readFileSync(logFile, 'utf8'), /did not finish within 400 ms/);
});


test('a disarmed watchdog ends at once and leaves the process it guarded alone, writing nothing (Miguel 1)', async () => {
  const dir = tmpDir('cc-bounded-');
  const logFile = path.join(dir, 'host.log');
  const guarded = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const disarm = armWatchdog({ boundMs: 4000, logFile, pid: guarded.pid });
    assert.ok(Number.isInteger(disarm.pid), 'the disarm handle names the watchdog');
    disarm();
    // The watchdog must be GONE (not merely quiet): poll for its exit, well past startup under load.
    const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
    const until = Date.now() + 5000;
    while (alive(disarm.pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(alive(disarm.pid), false, 'the watchdog exited after disarm');
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(guarded.exitCode, null);
    assert.strictEqual(fs.existsSync(logFile), false);
  } finally {
    guarded.kill();   // kill-ok(held-handle): the child this test spawned
  }
});

test('disarm kills the watchdog\'s whole tree by its pid, so a killProven already started dies with it (PR #217 round 2 N2)', () => {
  const guarded = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const killed = [];
    const disarm = armWatchdog({ boundMs: 60000, pid: guarded.pid, killTree: (p) => killed.push(p) });
    assert.ok(Number.isInteger(disarm.pid));
    disarm();
    assert.deepStrictEqual(killed, [disarm.pid]);
  } finally { guarded.kill(); }   // kill-ok(held-handle): the child this test spawned
});
