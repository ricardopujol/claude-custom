'use strict';
// BACKLOG #121: a host told to stop must free what it holds BEFORE it tears the pty down, and must exit even when that teardown
// blocks. The teardown is synchronous native work (taskkill, node-pty's kill), so a JS timer can't bound it: the watchdog is a
// separate process (a worker thread doesn't start while the main thread is blocked), and the test below blocks a real process's event loop to prove it.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');

const { runShutdown, armWatchdog, SHUTDOWN_BOUND_MS } = require('../host/bounded-shutdown');

test('everything the host holds is released before the teardown starts, in order, and the watchdog is armed before it too', () => {
  const calls = [];
  runShutdown({
    release: [() => calls.push('lock'), () => calls.push('lease'), () => calls.push('identity')],
    teardown: [() => calls.push('pty'), () => calls.push('servers')],
    arm: (ms) => { calls.push('arm:' + ms); return () => calls.push('disarm'); },
  });
  assert.deepStrictEqual(calls, ['lock', 'lease', 'identity', 'arm:' + SHUTDOWN_BOUND_MS, 'pty', 'servers', 'disarm']);
});

test('a release or teardown step that throws never skips the others', () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), fc.array(fc.boolean(), { maxLength: 6 }), (rel, tear) => {
    let ran = 0;
    const mk = (throws) => () => { ran += 1; if (throws) throw new Error('x'); };
    runShutdown({ release: rel.map(mk), teardown: tear.map(mk), arm: () => () => {} });
    assert.strictEqual(ran, rel.length + tear.length);
  }));
});

test('the bound has margin over a cold stop (7.8 s measured) and is finite', () => {
  assert.ok(SHUTDOWN_BOUND_MS >= 8000 && SHUTDOWN_BOUND_MS <= 30000);
});

test('a host whose teardown blocks the event loop for good still releases first and exits within the bound', async () => {
  const dir = tmpDir('cc-bounded-');
  const logFile = path.join(dir, 'host.log');
  const marks = path.join(dir, 'marks.txt');
  const script = `
    const { runShutdown } = require(${JSON.stringify(path.join(__dirname, '..', 'host', 'bounded-shutdown'))});
    const fs = require('fs');
    runShutdown({
      boundMs: 400, logFile: ${JSON.stringify(logFile)},
      release: [() => fs.appendFileSync(${JSON.stringify(marks)}, 'released\\n')],
      teardown: [() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }],   // never returns
    });
    fs.appendFileSync(${JSON.stringify(marks)}, 'REACHED-AFTER-TEARDOWN\\n');
  `;
  const t0 = Date.now();
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true });
  const code = await new Promise((resolve) => {
    const guard = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve('HUNG'); }, 8000);   // kill-ok(held-handle): the child this test spawned
    child.on('exit', (c) => { clearTimeout(guard); resolve(c === null ? 'killed' : c); });
  });
  assert.notStrictEqual(code, 'HUNG', 'the process must end by itself');
  assert.ok(Date.now() - t0 < 6000);
  const m = fs.readFileSync(marks, 'utf8');
  assert.match(m, /released/);
  assert.doesNotMatch(m, /REACHED-AFTER-TEARDOWN/);
  assert.match(fs.readFileSync(logFile, 'utf8'), /\[host\] shutdown: the pty teardown did not finish within 400 ms; exiting anyway/);
});

test('a fast teardown disarms the watchdog: the process it guarded is left alone', async () => {
  const dir = tmpDir('cc-bounded-');
  const logFile = path.join(dir, 'host.log');
  const guarded = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const disarm = armWatchdog({ boundMs: 150, logFile, pid: guarded.pid });
    disarm();
    await new Promise((r) => setTimeout(r, 700));
    assert.strictEqual(guarded.exitCode, null);
    assert.strictEqual(fs.existsSync(logFile), false);
  } finally {
    guarded.kill();   // kill-ok(held-handle): the child this test spawned
  }
});
