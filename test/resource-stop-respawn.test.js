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

/** The kill set of `pid` out of a real table read, as Stop builds it. */
async function killSetOf(exec, pid) {
  const s = parseSample(await exec(scriptFor('full')), Date.now());
  assert.ok(s, 'the table did not parse');
  return T.killSet(s.procs, pid);
}

// The supervisor is a PowerShell script, not node: a node parent's children are in libuv's kill-on-close job and die with it,
// which is not what a shell loop, a make or a Python supervisor does. `mode` 'respawn': one child, started again every time
// it exits. 'spawn': a new child every 300 ms (up to 20).
const JS = 'setTimeout(function(){},90000)';
function supervisor(file, mode) {
  const start = `$p=Start-Process -FilePath '${process.execPath}' -ArgumentList '-e','${JS}' -PassThru -WindowStyle Hidden;Add-Content '${file}' $p.Id`;
  const body = mode === 'respawn'
    ? `while($true){${start};$p.WaitForExit()}`
    : `1..20|ForEach-Object{${start};Start-Sleep -Milliseconds 300};Start-Sleep 90`;
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', body], { stdio: 'ignore', windowsHide: true });
}
const pidsIn = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number) : []);

test('N1 real: Stop on a supervisor that restarts its child leaves NO process of that tree running', { skip: !WIN, timeout: 120000 }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-respawn-')), 'pids.txt');
  const sup = supervisor(file, 'respawn');
  const mine = new Set([sup.pid]);
  try {
    await sleep(3000);
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

test('N2 real: children the target started AFTER the table was read are ended too', { skip: !WIN, timeout: 120000 }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-late-')), 'pids.txt');
  const sup = supervisor(file, 'spawn');
  const mine = new Set([sup.pid]);
  try {
    await sleep(2000);
    const set = await killSetOf(createExec(60000), sup.pid);
    await sleep(1500);
    const known = new Set(set.map(t => t.pid));
    const late = pidsIn(file).filter(p => !known.has(p));
    assert.ok(late.length > 0, 'the fixture must start children after the table read');
    const res = await K.killVerified(set, { exec: createExec(60000) });
    assert.strictEqual(res[0].status, 'killed', JSON.stringify(res));
    await sleep(1500);
    for (const p of pidsIn(file)) mine.add(p);
    assert.deepStrictEqual([...mine].filter(alive), [], 'a child started after the table read survived the Stop');
  } finally {
    for (const p of mine) { try { process.kill(p); } catch { /* gone */ } }
  }
});

test('N2: the kill script lists the target\'s live children itself, refuses a protected one, and never takes a console host', () => {
  const s = K.killScript([{ pid: 40, start: '1000' }, { pid: 41, start: '1100' }]);
  assert.match(s, /Win32_Process/, 'it reads the live table in the kill call');
  assert.match(s, /\$c\.st -lt \$curStart/, 'the start-time ordering guard');
  assert.match(s, /host\[\\\\\/\]host\\\.js/, 'a session host by command line is protected');
  assert.match(s, /claude\*/);
  assert.match(s, /electron\.exe/);
  assert.match(s, /conhost\.exe/);
  assert.ok(s.indexOf('failed a protected process') < s.indexOf('$r = K 40 1000'), 'the refusal is decided before anything is ended');
  assert.ok(s.indexOf('$r = K 40 1000') < s.indexOf('K 41 1100'), 'root first');
});

test('N2: processes the script found and ended (or could not end) are reported as extras, not dropped', () => {
  const r = K.parseKillOutput('40 killed\n41 killed\n77 killed\n78 failed Access is denied\nEND', [{ pid: 40 }, { pid: 41 }]);
  assert.deepStrictEqual(r, [
    { pid: 40, status: 'killed' }, { pid: 41, status: 'killed' },
    { pid: 77, status: 'killed', extra: true }, { pid: 78, status: 'failed', extra: true, text: 'Access is denied' },
  ]);
  assert.deepStrictEqual(K.parseKillOutput('40 killed\n77 killed', [{ pid: 40 }]).map(x => x.status), ['failed'], 'no END: nothing believed, no extras');
});

test('N2 real: a protected process (a host by its command line) started under the target refuses the whole Stop, nothing ends', { skip: !WIN, timeout: 120000 }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prot-')), 'pids.txt');
  const body = `$p=Start-Process -FilePath '${process.execPath}' -ArgumentList '-e','${JS}','host/host.js' -PassThru -WindowStyle Hidden;Add-Content '${file}' $p.Id;Start-Sleep 90`;
  const sup = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', body], { stdio: 'ignore', windowsHide: true });
  const mine = new Set([sup.pid]);
  try {
    await sleep(3000);
    const parent = { pid: sup.pid, start: String((await killSetOf(createExec(60000), sup.pid))[0].start) };
    const res = await K.killVerified([parent], { exec: createExec(60000) });
    for (const p of pidsIn(file)) mine.add(p);
    assert.strictEqual(res[0].status, 'failed', JSON.stringify(res));
    assert.match(res[0].text, /protected/);
    assert.deepStrictEqual([...mine].filter(p => !alive(p)), [], 'nothing was ended');
  } finally {
    for (const p of mine) { try { process.kill(p); } catch { /* gone */ } }
  }
});
