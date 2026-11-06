'use strict';
/**
 * verify/lib/spinner.js (BACKLOG #113 M1): the --load spinners of verify/probe-renderer-backgrounding.js end themselves
 * when the probe that started them is gone, or at their cap. Real processes, each spinning one core for well under a
 * second, every one capped so a failing test can't leave one running.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const { spinnerSource } = require('../verify/lib/spinner');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function goneWithin(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await new Promise(r => setTimeout(r, 50)); }
  return !alive(pid);
}

test('spinnerSource refuses a missing parent or cap, and names both in the source', () => {
  for (const [p, m] of [[0, 1000], [-1, 1000], [null, 1000], [12, 0], [12, -5], [12, 1.5], [12, undefined]]) {
    assert.throws(() => spinnerSource(p, m), /spinnerSource/, `${p} ${m}`);
  }
  const s = spinnerSource(4321, 9000);
  assert.match(s, /const p=4321,end=Date\.now\(\)\+9000;/);
  assert.match(s, /process\.kill\(p,0\)/, 'liveness only, never a signal');
  assert.doesNotMatch(s, /for\(;;\)\{\}/, 'no bare busy loop that never looks up');
});

test('#113 M1: a spinner ends itself once the process that started it is gone (a hard-killed probe leaves nothing spinning)', async () => {
  const lib = path.join(__dirname, '..', 'verify', 'lib', 'spinner.js');
  // The "probe": starts one spinner on its own pid (capped at 15 s), prints the spinner's pid, then exits without stopping it.
  const probe = `const {spawn}=require('child_process');const {spinnerSource}=require(${JSON.stringify(lib)});`
    + `const c=spawn(process.execPath,['-e',spinnerSource(process.pid,15000)],{stdio:'ignore',windowsHide:true});`
    + 'c.unref();console.log(c.pid);setTimeout(()=>process.exit(0),300);';
  const p = spawn(process.execPath, ['-e', probe], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => p.on('exit', r));
  const pid = Number(out.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, `the probe printed its spinner's pid (${out})`);
  assert.strictEqual(await goneWithin(pid, 5000), true, `spinner ${pid} still running 5 s after its probe exited`);
});

test('#113 M1: a spinner whose parent lives ends at its cap', async () => {
  const c = spawn(process.execPath, ['-e', spinnerSource(process.pid, 300)], { stdio: 'ignore', windowsHide: true });
  try {
    assert.strictEqual(await goneWithin(c.pid, 5000), true, 'still running well past its 300 ms cap');
  } finally {
    if (c.exitCode === null && c.signalCode === null) c.kill();   // our own handle: only if the assertion failed
  }
});
