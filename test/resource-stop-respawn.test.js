'use strict';
/**
 * PR #113 review round 2 (Dexter N1, N2): Stop ends a process that RESTARTS ITS CHILD on exit, and one that started
 * children after the process table was read. Real processes this test starts itself (Windows only), each ended by its
 * own pid at the end.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const K = require('../host/resource-kill');
const T = require('../host/resource-tree');
const { createExec, scriptFor } = require('../host/resource-sampler');
const { parseSample } = require('../host/resource-sample');

const WIN = process.platform === 'win32';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const IDLE = 'setTimeout(() => {}, 90000)';

/** The kill set of `pid` out of a real table read, as Stop builds it. */
async function killSetOf(exec, pid) {
  const s = parseSample(await exec(scriptFor('full')), Date.now());
  assert.ok(s, 'the table did not parse');
  return T.killSet(s.procs, pid);
}

// `mode` 'respawn': one child, started again every time it exits. 'spawn': a new child every 300 ms (up to 8).
function supervisor(file, mode) {
  const src = mode === 'respawn'
    ? `const {spawn}=require('child_process'),fs=require('fs');const r=()=>{const c=spawn(process.execPath,['-e',${JSON.stringify(IDLE)}],{stdio:'ignore',windowsHide:true});fs.appendFileSync(${JSON.stringify(file)},c.pid+'\\n');c.on('exit',r)};r();${IDLE}`
    : `const {spawn}=require('child_process'),fs=require('fs');let n=0;const t=setInterval(()=>{if(++n>8)return clearInterval(t);const c=spawn(process.execPath,['-e',${JSON.stringify(IDLE)}],{stdio:'ignore',windowsHide:true});fs.appendFileSync(${JSON.stringify(file)},c.pid+'\\n')},300);${IDLE}`;
  return spawn(process.execPath, ['-e', src], { stdio: 'ignore', windowsHide: true });
}
const pidsIn = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number) : []);

test('N1 real: Stop on a supervisor that restarts its child leaves NO process of that tree running', { skip: !WIN, timeout: 120000 }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-respawn-')), 'pids.txt');
  const sup = supervisor(file, 'respawn');
  const mine = new Set([sup.pid]);
  try {
    await sleep(1500);
    const set = await killSetOf(createExec(60000), sup.pid);
    assert.strictEqual(set[0].pid, sup.pid, 'the supervisor is killed first');
    assert.ok(set.length >= 2, 'the table saw its child');
    for (const p of pidsIn(file)) mine.add(p);
    const res = await K.killVerified(set, { exec: createExec(60000) });
    assert.strictEqual(res[0].status, 'killed', JSON.stringify(res));
    await sleep(1500);
    for (const p of pidsIn(file)) mine.add(p);
    const survivors = [...mine].filter(alive);
    assert.deepStrictEqual(survivors, [], 'nothing the supervisor started is still running (a respawned child was orphaned)');
  } finally {
    for (const p of mine) { try { process.kill(p); } catch { /* gone */ } }
  }
});
