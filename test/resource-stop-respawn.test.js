'use strict';
/**
 * PR #113 review round 2 (Dexter N1, N2): Stop ends a process that RESTARTS ITS CHILD on exit, and one that started
 * children after the process table was read. Real processes this test starts itself (Windows only), each ended by its
 * own pid at the end.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { tmpDir } = require('./tmp-dir');
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

// Polls instead of sleeping: true as soon as `f()` is truthy, and a failure naming `what` only after a generous deadline.
async function waitFor(f, what, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (f()) return; await sleep(100); }
  assert.fail(`timed out waiting for ${what}`);
}

// The supervisor is a PowerShell script, not node: a node parent's children are in libuv's kill-on-close job and die with it,
// which is not what a shell loop, a make or a Python supervisor does. Every child's pid is appended to `file`.
//   'respawn': one child, started again every time it exits.
//   'gated':   one child at once, then THREE MORE only once the `go` file exists, so a test decides exactly when "late" is.
const JS = 'setTimeout(function(){},90000)';
function supervisor(file, mode, go) {
  const start = `$p=Start-Process -FilePath '${process.execPath}' -ArgumentList '-e','${JS}' -PassThru -WindowStyle Hidden;Add-Content '${file}' $p.Id`;
  const body = mode === 'respawn'
    ? `while($true){${start};$p.WaitForExit()}`
    : `${start};while(-not (Test-Path '${go}')){Start-Sleep -Milliseconds 100};1..3|ForEach-Object{${start}};Start-Sleep 90`;
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', body], { stdio: 'ignore', windowsHide: true });
}
const pidsIn = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number) : []);

test('N1 real: Stop on a supervisor that restarts its child leaves NO process of that tree running', { skip: !WIN, timeout: 240000 }, async () => {
  const file = path.join(tmpDir('cc-respawn-'), 'pids.txt');
  const sup = supervisor(file, 'respawn');
  const mine = new Set([sup.pid]);
  try {
    await waitFor(() => pidsIn(file).length >= 1, 'the supervisor\'s first child');
    const set = await killSetOf(createExec(60000), sup.pid);
    assert.strictEqual(set[0].pid, sup.pid, 'the supervisor is killed first');
    assert.ok(set.length >= 2, 'the table saw its child');
    const res = await K.killVerified(set, { exec: createExec(60000) });
    assert.strictEqual(res[0].status, 'killed', JSON.stringify(res));
    for (const p of pidsIn(file)) mine.add(p);
    await waitFor(() => [...mine].every(p => !alive(p)), 'every process of the tree to be gone', 30000);
    await sleep(1000);                       // a respawn, if the parent were still alive, would land in this second
    for (const p of pidsIn(file)) mine.add(p);
    assert.deepStrictEqual([...mine].filter(alive), [], 'nothing the supervisor started is still running (a respawned child was orphaned)');
  } finally {
    for (const p of mine) { try { process.kill(p); } catch { /* gone */ } }
  }
});

test('N2 real: children the target started AFTER the table was read are ended too', { skip: !WIN, timeout: 240000 }, async () => {
  const dir = tmpDir('cc-late-');
  const file = path.join(dir, 'pids.txt');
  const go = path.join(dir, 'go');
  const sup = supervisor(file, 'gated', go);
  const mine = new Set([sup.pid]);
  try {
    await waitFor(() => pidsIn(file).length >= 1, 'the first child');
    const set = await killSetOf(createExec(60000), sup.pid);      // the table is read BEFORE the late children exist
    const known = new Set(set.map(t => t.pid));
    assert.ok(known.has(pidsIn(file)[0]), 'the first child is in the set');
    fs.writeFileSync(go, 'go');
    await waitFor(() => pidsIn(file).length >= 4, 'the three late children to be started');
    const late = pidsIn(file).filter(x => !known.has(x));
    assert.strictEqual(late.length, 3, 'the fixture started three children the set does not hold');
    for (const x of pidsIn(file)) mine.add(x);
    const res = await K.killVerified(set, { exec: createExec(60000) });
    assert.strictEqual(res[0].status, 'killed', JSON.stringify(res));
    await waitFor(() => [...mine].every(x => !alive(x)), 'a child started after the table read to be ended', 30000);
  } finally {
    for (const x of mine) { try { process.kill(x); } catch { /* gone */ } }
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

test('N2 real: a protected process (a host by its command line) started under the target refuses the whole Stop, nothing ends', { skip: !WIN, timeout: 240000 }, async () => {
  const file = path.join(tmpDir('cc-prot-'), 'pids.txt');
  const body = `$p=Start-Process -FilePath '${process.execPath}' -ArgumentList '-e','${JS}','host/host.js' -PassThru -WindowStyle Hidden;Add-Content '${file}' $p.Id;Start-Sleep 90`;
  const sup = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', body], { stdio: 'ignore', windowsHide: true });
  const mine = new Set([sup.pid]);
  try {
    await waitFor(() => pidsIn(file).length >= 1, 'the child');
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
