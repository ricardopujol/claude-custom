'use strict';
/**
 * The statusLine relay and how the settings file wires it.
 *
 * WHY statusLine: its stdin document carries model.id and effort.level and is
 * MEASURED to re-fire ~1s after /model and /effort with no turn
 * (verify/probe-top-bar-truth.js) -- the only truth FF12 can resolve a switch
 * against that is causally downstream of the switch.
 *
 * WHY a relay and not just a second statusLine: `--settings` replaces a
 * single-valued key WHOLESALE (verify/probe-settings.js), so the harness's
 * statusLine REPLACES the user's. The relay forwards the document to the host
 * and then runs the user's own command on the same stdin, passing its output
 * through -- the user's status line keeps rendering exactly as before.
 *
 * THIS FILE holds the tests that run the relay, a user command or a hung process tree for real (split out of test/status-relay.test.js,
 * release-gate lane 2026-10-09): they take ~30 s and a Stryker timeout counts as a kill, so they stay out of the mutation command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { buildHarnessSettings, findUserStatusLine } = require('../host/settings-writer');
const { createHookBridge } = require('../host/hook-bridge');
const { tmpDir } = require('./tmp-dir');
const { posixShell } = require('./posix-shell');

const RELAY = path.join(__dirname, '..', 'host', 'status-relay.js');
const opts = { helperPath: 'C:/h/hook-helper.exe', pipeName: '\\\\.\\pipe\\claude-custom-abc' };
const relayOpts = (userStatusLine) => ({
  ...opts,
  statusRelay: { nodePath: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'C:\\cc\\host\\status-relay.js', userStatusLine },
});
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

// --- settings ---------------------------------------------------------------

test('the relay command survives a real POSIX shell with its arguments intact', (t) => {
  const { spawnSync } = require('child_process');
  // Not spawnSync('bash'): from PowerShell that is the WSL launcher, which fails without an error (BACKLOG #72).
  const sh = posixShell();
  if (!sh) { t.skip('no POSIX shell on this machine'); return; }
  const user = { type: 'command', command: 'node "C:\\a b\\s.js"', padding: 0 };
  const cmd = buildHarnessSettings(relayOpts(user)).statusLine.command;
  // Replace the program with printf so the shell shows what it would pass.
  const argsOnly = cmd.replace(/^"[^"]*"/, 'printf "%s\\n"');
  const r = spawnSync(sh, ['-c', argsOnly], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const argv = r.stdout.trim().split('\n');
  assert.strictEqual(argv[0], 'C:/cc/host/status-relay.js');
  assert.strictEqual(argv[argv.indexOf('--pipe') + 1], 'claude-custom-abc');
  assert.strictEqual(Buffer.from(argv[argv.indexOf('--then') + 1], 'base64').toString('utf8'), user.command);
});

// --- the relay, end to end ---------------------------------------------------

function runRelay(args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RELAY, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
    child.stdin.end(input);
  });
}
let n = 0;
const pipeName = () => `cc-relay-test-${process.pid}-${n++}`;
const DOC = JSON.stringify({ model: { id: 'claude-sonnet-5' }, effort: { level: 'high' } });

test('the relay forwards the document to the host as a Status event', async () => {
  const name = pipeName();
  const bridge = createHookBridge({ pipeName: `\\\\.\\pipe\\${name}` });
  await bridge.listening;
  // A deadline, or a relay that never forwards hangs the suite instead of
  // failing it.
  const got = new Promise(r => {
    bridge.once('event', r);
    setTimeout(() => r(null), 3000).unref();
  });
  const res = await runRelay(['--pipe', name], DOC);
  const ev = await got;
  await bridge.close();
  assert.ok(ev, 'no Status event reached the host within 3s');
  assert.strictEqual(ev.event, 'Status');
  assert.strictEqual(ev.payload.model.id, 'claude-sonnet-5');
  assert.strictEqual(res.code, 0);
});

test("the user's command gets the same stdin, and its output is the status line", async () => {
  const name = pipeName();
  const bridge = createHookBridge({ pipeName: `\\\\.\\pipe\\${name}` });
  await bridge.listening;
  const echo = `"${process.execPath}" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('USER:'+JSON.parse(s).model.id))"`;
  const res = await runRelay(['--pipe', name, '--then', b64(echo)], DOC);
  await bridge.close();
  assert.strictEqual(res.out, 'USER:claude-sonnet-5');
});

test("no host listening: the user's status line still renders", async () => {
  // Process start-up (the relay, then cmd.exe, then the user's node) is what a
  // wall-clock bound here really measured, and it blew 5 s under full-suite
  // load. "Promptly" is asserted deterministically in the next test instead.
  const echo = `"${process.execPath}" -e "process.stdout.write('still here')"`;
  const t0 = Date.now();
  const res = await runRelay(['--pipe', pipeName(), '--then', b64(echo)], DOC);
  // A catastrophic-stall tripwire only (a relay awaiting something it shouldn't);
  // process start-up under load is well inside it.
  assert.ok(Date.now() - t0 < 30000, `the relay took ${Date.now() - t0} ms with no host listening`);
  assert.strictEqual(res.out, 'still here');
  assert.strictEqual(res.code, 0);
});

test('unparseable stdin is not forwarded, and the user command still runs', async () => {
  const name = pipeName();
  const bridge = createHookBridge({ pipeName: `\\\\.\\pipe\\${name}` });
  await bridge.listening;
  let events = 0;
  bridge.on('event', () => { events++; });
  const echo = `"${process.execPath}" -e "process.stdout.write('ok')"`;
  const res = await runRelay(['--pipe', name, '--then', b64(echo)], 'not json');
  await new Promise(r => setTimeout(r, 200));
  await bridge.close();
  assert.strictEqual(events, 0);
  assert.strictEqual(res.out, 'ok');
});

// --- a user command that never exits (Dexter r2 N6) ---------------------------

const { runUser, forward } = require('../host/status-relay');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A pid file read mid-write must not become a truncated pid that process.kill then aims at some other process (Miguel G1).
const readPid = (file) => { const s = fs.readFileSync(file, 'utf8'); return /^\d+$/.test(s) ? Number(s) : false; };

test("a hung user statusLine is killed, grandchild and all, and the relay still exits", { timeout: 120000 }, async (t) => {
  // shell:true puts a shell between the relay and the user's command. Killing
  // only the shell (child.kill) leaves the real command running, one more
  // orphan every time the status line re-fires.
  //
  // BACKLOG #72: the timeout is fired by hand, once the command has written its
  // pid. On the wall clock a loaded machine took longer than the 1.5 s timeout
  // to get it started, the kill landed on a cmd.exe that had not created it
  // yet, and the test failed reading a pid file nobody wrote (ENOENT).
  const dir = tmpDir('relay-hang');
  const pidFile = path.join(dir, 'pid').replace(/\\/g, '/');
  const hang = `"${process.execPath}" -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ran = runUser(b64(hang), DOC, { timeoutMs: 1500 });
  const pid = await waitUntil(() => readPid(pidFile), 'the user command to start', 60000);
  t.mock.timers.tick(1500);
  // Resolving at all is "the relay does not wait on a hung command": it never exits by itself.
  assert.notStrictEqual(await ran, 0, 'a killed command is not a success');
  t.mock.timers.reset();
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) { gone = !alive(pid); if (!gone) await new Promise(r => setTimeout(r, 150)); }
  if (!gone) try { process.kill(pid); } catch {}
  assert.ok(gone, `the user's command (pid ${pid}) is still running`);
});

test('a user command that finishes in time is not killed', async () => {
  const quick = `"${process.execPath}" -e "process.exit(0)"`;
  assert.strictEqual(await runUser(b64(quick), DOC, { timeoutMs: 5000 }), 0);
});

test('the whole relay SCRIPT exits promptly on a hung user command (Miguel #51 1)', { timeout: 120000 }, async () => {
  // "Promptly" is the relay ending, with the command's output closed: a relay
  // stuck on a hung command, or an orphan holding its stdout open (the #72
  // race, MEASURED at 685 s), never closes. The bound is generous on purpose:
  // the worst legitimate path is the 5 s timeout plus the sweep (6.4 s measured
  // under one full-suite run, a 20 s sweep timeout at worst), and a tight
  // bound flaked (Miguel Y3). 60 s still tells that from a 685 s hold.
  const dir = tmpDir('relay-hang-script');
  const pidFile = path.join(dir, 'pid').replace(/\\/g, '/');
  const hang = `"${process.execPath}" -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`;
  const t0 = Date.now();
  const res = await runRelay(['--pipe', pipeName(), '--then', b64(hang)], DOC);
  assert.ok(Date.now() - t0 < 60000, `the relay took ${Date.now() - t0} ms to exit on a hung command`);
  assert.notStrictEqual(res.code, 0);
  const pid = readPid(pidFile);
  assert.ok(pid, 'the user command never wrote its pid');
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) { gone = !alive(pid); if (!gone) await new Promise(r => setTimeout(r, 150)); }
  if (!gone) try { process.kill(pid); } catch {}
  assert.ok(gone, `the user's command (pid ${pid}) outlived the relay`);
});

// BACKLOG #72. Polls with setInterval, which the tests that mock setTimeout leave real.
function waitUntil(f, what, ms = 30000) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const iv = setInterval(() => {
      let v; try { v = f(); } catch { v = false; }
      if (v) { clearInterval(iv); resolve(v); } else if (Date.now() > end) { clearInterval(iv); reject(new Error(`timed out waiting for ${what}`)); }
    }, 50);
  });
}

// Every live node.exe whose command line carries `marker` (a table read, so it sees orphans whose parent is gone).
// A failed or timed-out read throws, never an EMPTY list that would read as "nothing left running" (Miguel Y2).
const { markedPids, reapMarked, reapDeadOwners, SLEEPER_SRC } = require('../verify/lib/reap-marked');
const { spawnerSource } = require('../verify/lib/spawner-source');

// BACKLOG #74 G: this test's sleepers once outlived a killed `npm test` by the thousand. Markers are
// `cc72-<this pid>-<time>`: reaped in `finally`, on exit, and (a killed run's leftovers) by the next run's first test.
const RUN_MARKERS = [];
process.on('exit', () => { for (const m of RUN_MARKERS) { try { reapMarked(m); } catch { /* best effort at exit */ } } });

test('#72: a user command that is still starting processes while it is killed leaves none of them running', { skip: process.platform !== 'win32', timeout: 120000 }, async (t) => {
  try { reapDeadOwners('cc72'); reapDeadOwners('cc72s'); } catch { /* a leftover sweep must never fail the test */ }
  // taskkill /T reads the tree once and then ends it. A process the tree started after that read (cmd.exe still
  // creating the user's command, under load) outlived the kill, and kept the relay's stdout open: MEASURED, a relay
  // whose grandchild was created during the kill was waited on for 685 s. This command starts a new process every
  // 25 ms, so a kill that reads the tree only once loses one every time.
  const dir = tmpDir('relay-spawner');
  const marker = `cc72-${process.pid}-${Date.now()}`;          // the sleepers carry this
  const spawnerMarker = `cc72s-${process.pid}-${Date.now()}`;   // the spawner carries this one, so a scan for sleepers cannot match it
  RUN_MARKERS.push(marker, spawnerMarker);
  const ready = path.join(dir, 'ready').replace(/\\/g, '/');
  const spawner = path.join(dir, 'spawner.js');
  fs.writeFileSync(spawner, spawnerSource({ sleeperSrc: SLEEPER_SRC, marker, readyFile: ready, intervalMs: 25, deadlineMs: 170000, parentPid: process.pid, detached: true }));   // the deadline stays past the test's 120 s timeout
  const cmd = `"${process.execPath}" "${spawner.replace(/\\/g, '/')}" ${spawnerMarker}`;
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ran = runUser(b64(cmd), DOC, { timeoutMs: 1500 });
    await waitUntil(() => fs.existsSync(ready), 'the user command to start spawning', 60000);
    // Positive control: the same read must SEE the spawned processes before the kill, or "none left" proves nothing.
    // (the scan matches the sleepers' marker only, never the spawner's own: PR #135 Dexter 4)
    assert.ok(markedPids(marker).length > 0, 'the marker scan finds none of the running spawned processes');
    t.mock.timers.tick(1500);                         // the timeout fires now, mid-spawning
    assert.strictEqual(await ran, 1, 'a killed command is not a success');
    t.mock.timers.reset();
    let left = markedPids(marker);
    for (let i = 0; i < 10 && left.length; i++) { await new Promise(r => setTimeout(r, 300)); left = markedPids(marker); }
    assert.deepStrictEqual(left, [], 'processes the user command started are still running after the kill');
  } finally {
    try { reapMarked(marker); reapMarked(spawnerMarker); } catch { /* cleanup only; the exit hook and the next run's sweep try again */ }
  }
});

// --- the sweep itself, broken on purpose (PR #126 Dexter F1/F2/F4/F5, Miguel Y1) ----
const { killTree, sweepPids } = require('../host/status-relay');
const { spawnSync } = require('child_process');
const onWin = process.platform === 'win32';

// A cmd.exe -> node tree that hangs, as the relay's user command does.
async function hangTree(dir) {
  const pidFile = path.join(dir, 'pid').replace(/\\/g, '/');
  const hang = `"${process.execPath}" -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`;
  const since = Date.now();
  const child = spawn(hang, { shell: true, stdio: 'ignore', windowsHide: true });
  const grandchild = await waitUntil(() => readPid(pidFile), 'the hung command to start', 60000);
  return { child, since, grandchild };
}
// killTree's `run`, with the sweep script edited: `from` must be in it, so a rename of the script cannot make this vacuous.
function sabotaged(from, to, seen) {
  return (cmd, args, o) => {
    if (cmd !== 'powershell.exe') return spawnSync(cmd, args, o);
    assert.ok(args[3].includes(from), `the sweep script no longer contains ${from}`);
    const r = spawnSync(cmd, [...args.slice(0, 3), args[3].replace(from, () => to)], o);
    // The first call is the sweep; the fallback's rescan of the parents it ended is a second one (PR #161 Dexter 2).
    if (!seen.sweep) seen.sweep = r; else (seen.rescans = seen.rescans || []).push(r);
    return r;
  };
}
async function gone(pid) {
  for (let i = 0; i < 30 && alive(pid); i++) await new Promise(r => setTimeout(r, 150));
  return !alive(pid);
}

test('#72 Dexter F1 / Miguel Y1: the sweep fails after the first kill, and the grandchild still dies', { skip: !onWin, timeout: 120000 }, async () => {
  // The root cmd.exe is already dead when the children read fails, so `taskkill /pid <root> /T` finds nothing:
  // the fallback must end the pids the sweep had seen.
  const { child, since, grandchild } = await hangTree(tmpDir('relay-sweep-fail'));
  const seen = {};
  try {
    killTree(child, since, { run: sabotaged('$rows=@(ReadProcs)', '$rows=@(Get-CimInstance Win32_NoSuchClassForTheTest)', seen) });
    assert.strictEqual(seen.sweep.status, 4, 'the sweep did not fail where the test broke it');
    assert.ok(await gone(grandchild), `the grandchild (pid ${grandchild}) survived a failed sweep`);
  } finally { try { process.kill(grandchild); } catch { /* gone */ } }
});

test('#72 Dexter F1: the sweep stalls after the first kill until it is cut off, and the grandchild still dies', { skip: !onWin, timeout: 120000 }, async () => {
  const { child, since, grandchild } = await hangTree(tmpDir('relay-sweep-stall'));
  const seen = {};
  try {
    killTree(child, since, { sweepTimeoutMs: 8000, run: sabotaged('$rows=@(ReadProcs)', '$rows=@(Start-Sleep -Seconds 120)', seen) });
    assert.ok(seen.sweep.error, 'the stalled sweep was not cut off by its timeout');
    assert.ok(await gone(grandchild), `the grandchild (pid ${grandchild}) survived a stalled sweep`);
  } finally { try { process.kill(grandchild); } catch { /* gone */ } }
});

test('#72 Dexter F2: a sweep that hits its level cap with the tree alive does not exit 0, and the tree still dies', { skip: !onWin, timeout: 120000 }, async () => {
  const { child, since, grandchild } = await hangTree(tmpDir('relay-sweep-cap'));
  const seen = {};
  try {
    killTree(child, since, { run: sabotaged('$i -lt 50', '$i -lt 1', seen) });
    assert.strictEqual(seen.sweep.status, 5, 'a capped sweep reported success');
    assert.ok(await gone(grandchild), `the grandchild (pid ${grandchild}) survived a capped sweep`);
  } finally { try { process.kill(grandchild); } catch { /* gone */ } }
});

test('#72 Dexter F4: the root is killed even when the wall clock says it started after the kill was begun', { skip: !onWin, timeout: 120000 }, async () => {
  // A clock stepped back reads every start time as "before since". The root's pid is held by libuv, so it needs no bound.
  const { child, grandchild } = await hangTree(tmpDir('relay-sweep-clock'));
  try {
    killTree(child, Date.now() + 3600 * 1000);
    assert.ok(await gone(child.pid), `the root (pid ${child.pid}) survived`);
  } finally { try { process.kill(grandchild); } catch { /* gone */ } }
});

test('#72 Dexter F5: a command that already exited leaves its background child alone, as taskkill /T always did', { skip: !onWin, timeout: 120000 }, async () => {
  // The timer can fire in the same tick the command finishes. Its `start /b` refresher is meant to outlive it.
  const dir = tmpDir('relay-sweep-exited');
  const pidFile = path.join(dir, 'pid').replace(/\\/g, '/');
  const bg = `start "" /b "${process.execPath}" -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`;
  const since = Date.now();
  const child = spawn(bg, { shell: true, stdio: 'ignore', windowsHide: true });
  const exited = new Promise(r => child.on('exit', r));
  const refresher = await waitUntil(() => readPid(pidFile), 'the background refresher to start', 60000);
  try {
    await exited;
    killTree(child, since);
    assert.ok(alive(refresher), `the background child (pid ${refresher}) was killed with a command that had already exited`);
  } finally { try { process.kill(refresher); } catch { /* gone */ } }
});

// --- BACKLOG #73, Dexter release S7-1 / S7-2: the sweep's parent link and its pending set, with the real PowerShell -------------------
const READ_PROCS = 'function ReadProcs{Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 8}';
const sweepLines = (stdout) => String(stdout || '').split(/\r?\n/).filter(l => /^ALIVE/.test(l));

test('#73 S7-1 (Dexter): a pid the sweep already ENDED is not in its last ALIVE line, even though the sweep then failed', { skip: !onWin, timeout: 120000 }, async () => {
  // cmd.exe (root) -> node (the grandchild). The 3rd table read fails: by then both are ended. The last `ALIVE` line must be empty,
  // or the fallback would re-kill a pid that Windows may have handed to someone else.
  const { child, since, grandchild } = await hangTree(tmpDir('relay-sweep-ended'));
  const seen = {};
  const batched = [];
  const failThird = `$script:n=0\nfunction ReadProcs{$script:n++;if($script:n -ge 3){throw 'broken on purpose'};Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 8}`;
  try {
    killTree(child, since, { proveBatch: (items) => { batched.push(items); return new Map(); }, run: sabotaged(READ_PROCS, failThird, seen) });
    // (killTree swallows what a stub throws, so the stub records and the test asserts)
    assert.deepStrictEqual(batched, [], 'nothing was pending, so nothing is proven or killed');
    assert.strictEqual(seen.sweep.status, 4, 'the sweep did not fail where the test broke it');
    assert.ok(await gone(grandchild), `the grandchild (pid ${grandchild}) survived`);
    const lines = sweepLines(seen.sweep.stdout);
    assert.ok(lines.length >= 2, `expected the snapshot line and the last line, got ${JSON.stringify(lines)}`);
    assert.ok(sweepPids(seen.sweep.stdout).every(t => t.pid !== grandchild), `the ended grandchild ${grandchild} is still pending in ${JSON.stringify(lines[lines.length - 1])}`);
    assert.ok(lines[0].includes(`${grandchild}:`), 'the snapshot line did list the grandchild, with its start');
  } finally { try { process.kill(grandchild); } catch { /* gone */ } }
});

test('#73 S7-2 (Dexter): the Z / P / C reuse sequence -- a child that STARTED BEFORE its named parent is not adopted', { skip: !onWin, timeout: 120000 }, async () => {
  // P (pid 2000000001) started Z (2000000002, ppid P) and exited; the pid was reused for C, a real child of the root. Z's start is
  // BEFORE C's, so it cannot be C's child. W (2000000003) started after C: a real child. since-based code adopted Z.
  const root = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const seen = {};
  const t0 = Date.now();
  const row = (id, ppid, ms) => `[pscustomobject]@{ProcessId=${id};ParentProcessId=${ppid};CreationDate=([DateTimeOffset]::FromUnixTimeMilliseconds(${t0 + ms}).UtcDateTime)}`;
  const synthetic = `function ReadProcs{@(${row(root.pid, 1, -60000)},${row(2000000001, root.pid, 500)},${row(2000000002, 2000000001, 100)},${row(2000000003, 2000000001, 700)})}`;
  try {
    killTree(root, t0, { proveBatch: () => new Map(), run: sabotaged(READ_PROCS, synthetic, seen) });
    const first = sweepPids(seen.sweep.stdout.split(/\r?\n/)[0] + '\n').map(t => t.pid);
    assert.deepStrictEqual(first.sort(), [root.pid, 2000000001, 2000000003].sort(), `the snapshot adopted the wrong set: ${seen.sweep.stdout}`);
    assert.ok(!first.includes(2000000002), 'Z (older than the pid it names as its parent) was adopted');
  } finally { try { root.kill(); } catch { /* gone */ } }
});

test('#73 S7-2: a process that started AFTER its named parent was ended is not that parent\'s child (a stranger reused the pid)', { skip: !onWin, timeout: 120000 }, async () => {
  // After the real grandchild is killed, a table row names it as parent but started an hour LATER than its exit: not a child.
  const { child, since, grandchild } = await hangTree(tmpDir('relay-sweep-late'));
  const seen = {};
  const stranger = `$script:n=0;$script:kid=$null\nfunction ReadProcs{$script:n++;$rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 8);if($script:n -eq 2){$script:kid=@($rows | Where-Object { [int]$_.ParentProcessId -eq $root })[0].ProcessId};if($script:n -ge 3 -and $script:kid){$rows+=[pscustomobject]@{ProcessId=2000000005;ParentProcessId=[int]$script:kid;CreationDate=(Get-Date).AddHours(1)}};$rows}`;
  try {
    killTree(child, since, { proveBatch: () => new Map(), run: sabotaged(READ_PROCS, stranger, seen) });
    assert.strictEqual(seen.sweep.status, 0, `the sweep should have finished clean: ${seen.sweep.status}`);
    assert.doesNotMatch(seen.sweep.stdout, /2000000005/, 'a process that started after its parent died was adopted');
    assert.ok(await gone(grandchild));
  } finally { try { process.kill(grandchild); } catch { /* gone */ } }
});

test('#73 F4: the sweep reads no wall clock -- a stepped-back clock (since far in the future) still ends the whole tree', { skip: !onWin, timeout: 120000 }, async () => {
  const { child, grandchild } = await hangTree(tmpDir('relay-sweep-noclock'));
  try {
    killTree(child, Date.now() + 3600 * 1000);
    assert.ok(await gone(child.pid), 'the root survived');
    assert.ok(await gone(grandchild), `the grandchild (pid ${grandchild}) survived a sweep given a future since`);
  } finally { try { process.kill(grandchild); } catch { /* gone */ } }
});

// --- PR #145 Dexter F1 / F2 / F3, Miguel Y1: a parent the sweep did not kill itself bounds nothing; a null date is skipped; a vanished pid is done ---
// Synthetic rows (a ReadProcs of our own), a REAL sleeper as the root, real PowerShell. The synthetic pids sit above any Windows pid.
const synthRow = (id, ppid, ms, t0) => `[pscustomobject]@{ProcessId=${id};ParentProcessId=${ppid};CreationDate=([DateTimeOffset]::FromUnixTimeMilliseconds(${t0 + ms}).UtcDateTime)}`;
const aliveSleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
const pidsOf = (stdout) => sweepLines(stdout).flatMap(l => (l.match(/\d+(?=:)/g) || []).map(Number));

test('#73 F1 / Y1 (Dexter): `a | b` -- b exits, pid 7004 is taken by a stranger S, K(b) is a MISMATCH: S\'s child, started after b died, is NOT adopted', { skip: !onWin, timeout: 120000 }, async () => {
  // The root R is a real sleeper; "b" is the REAL sleeper S (so K sees a live process whose start differs from the one the table gave
  // for b: MISMATCH). S1 names b's pid as its parent and started after S did, so after b died: it is the stranger's child.
  const root = aliveSleeper(); const reuser = aliveSleeper();
  const seen = {};
  const t0 = Date.now();
  const synthetic = `$script:n=0\nfunction ReadProcs{$script:n++;$r=@(${synthRow(root.pid, 1, -3600000, t0)},${synthRow(reuser.pid, root.pid, -1800000, t0)});if($script:n -ge 2){$r+=@(${synthRow(2000000009, reuser.pid, 60000, t0)},${synthRow(2000000008, reuser.pid, -1000, t0)})};$r}`;
  try {
    killTree(root, 0, { proveBatch: () => new Map(), run: sabotaged(READ_PROCS, synthetic, seen) });
    assert.ok(!pidsOf(seen.sweep.stdout).includes(2000000009), `the stranger's child was adopted: ${seen.sweep.stdout}`);
    assert.ok(pidsOf(seen.sweep.stdout).includes(2000000008), `b's own late child (started before the holder of its pid) should be adopted: ${seen.sweep.stdout}`);
    assert.ok(!reuser.killed && reuser.exitCode === null, 'the stranger itself was killed');
  } finally { for (const c of [root, reuser]) { try { c.kill(); } catch { /* gone */ } } }
});

test('#73 F1 (GONE path): a parent that vanished before K, whose pid the next read shows reused, does not adopt the reuser\'s child; one with no bound adopts nothing new', { skip: !onWin, timeout: 120000 }, async () => {
  // P = 2000000001 is not running (K: gone, exit unknown). Read 2 shows a holder of P's pid that started at +400: W (+300) is P's, Z (+500) is the
  // holder's. A second parent Q = 2000000002 has no holder at all: a NEW child of Q (+900) has no bound and is not adopted.
  const root = aliveSleeper();
  const seen = {};
  const t0 = Date.now();
  const synthetic = `$script:n=0\nfunction ReadProcs{$script:n++;$r=@(${synthRow(root.pid, 1, -3600000, t0)},${synthRow(2000000001, root.pid, -1000, t0)},${synthRow(2000000002, root.pid, -900, t0)});if($script:n -ge 2){$r+=@(${synthRow(2000000001, 1, 400, t0)},${synthRow(2000000010, 2000000001, 300, t0)},${synthRow(2000000011, 2000000001, 500, t0)},${synthRow(2000000012, 2000000002, 900, t0)})};$r}`;
  try {
    killTree(root, 0, { proveBatch: () => new Map(), run: sabotaged(READ_PROCS, synthetic, seen) });
    const all = pidsOf(seen.sweep.stdout);
    assert.ok(all.includes(2000000010), `W, P's own child (started before the reuser), should have been adopted: ${seen.sweep.stdout}`);
    assert.ok(!all.includes(2000000011), 'Z, the reuser\'s child, was adopted');
    assert.ok(!all.includes(2000000012), 'a new child of a parent with no known bound was adopted');
  } finally { try { root.kill(); } catch { /* gone */ } }
});

test('#73 F2 (Dexter): one row with a null CreationDate (System Idle Process) does not abort the sweep', { skip: !onWin, timeout: 120000 }, async () => {
  const { child, since, grandchild } = await hangTree(tmpDir('relay-sweep-null'));
  const seen = {};
  const withNull = `function ReadProcs{$r=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 8);$r+[pscustomobject]@{ProcessId=0;ParentProcessId=0;CreationDate=$null}}`;
  try {
    killTree(child, since, { proveBatch: () => new Map(), run: sabotaged(READ_PROCS, withNull, seen) });
    assert.strictEqual(seen.sweep.status, 0, `the sweep failed on a null date: status ${seen.sweep.status}`);
    assert.ok(await gone(grandchild), `the grandchild (pid ${grandchild}) survived`);
  } finally { try { process.kill(grandchild); } catch { /* gone */ } }
});

test('#73 F3 (Dexter): a snapshot-listed process that exits on its own is done -- the sweep still exits 0, not 5', { skip: !onWin, timeout: 120000 }, async () => {
  const root = aliveSleeper();
  const seen = {};
  const batched = [];
  const t0 = Date.now();
  // D (2000000020) is in the snapshot as R's child and is gone from every later read (it ended by itself)
  const synthetic = `$script:n=0\nfunction ReadProcs{$script:n++;$r=@(${synthRow(root.pid, 1, -3600000, t0)});if($script:n -le 1){$r+=@(${synthRow(2000000020, root.pid, -1000, t0)})};$r}`;
  try {
    killTree(root, 0, { proveBatch: (items) => { batched.push(items); return new Map(); }, run: sabotaged(READ_PROCS, synthetic, seen) });
    assert.deepStrictEqual(batched, [], 'a clean sweep proves nothing');
    assert.strictEqual(seen.sweep.status, 0, `a vanished pid made the sweep fail: ${seen.sweep.status}`);
    assert.strictEqual(sweepPids(seen.sweep.stdout).length, 0, 'nothing may be left pending');
  } finally { try { root.kill(); } catch { /* gone */ } }
});

// --- #27: --quiet-when ------------------------------------------------------
// The person moved the status line into the tab header (PLAN_LAYOUT_L2.md):
// the relay still forwards every document, but prints nothing, so the CLI
// drops its status row (MEASURED, verify/probe-footer-rows.js).
const writeChrome = (dir, value) => {
  const file = path.join(dir, 'chrome-global.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};
const ECHO = `"${process.execPath}" -e "process.stdout.write('USER-ROW')"`;

test('#27: statusInHeader true -> the user command does not run and nothing is printed', async () => {
  const file = writeChrome(tmpDir('relay-quiet'), { statusInHeader: true });
  const res = await runRelay(['--pipe', pipeName(), '--then', b64(ECHO), '--quiet-when', file], DOC);
  assert.strictEqual(res.out, '');
  assert.strictEqual(res.code, 0);
});

test('#27: statusInHeader false, missing, or not exactly true -> the user row prints as before', async () => {
  const dir = tmpDir('relay-loud');
  for (const value of [{ statusInHeader: false }, {}, { statusInHeader: 'true' }, { statusInHeader: 1 }, null, [true]]) {
    const file = writeChrome(dir, value);
    const res = await runRelay(['--pipe', pipeName(), '--then', b64(ECHO), '--quiet-when', file], DOC);
    assert.strictEqual(res.out, 'USER-ROW', JSON.stringify(value));
  }
});

test('#27: a missing, corrupt or unreadable toggle file -> the user row prints (fail toward showing)', async () => {
  const dir = tmpDir('relay-bad');
  const corrupt = path.join(dir, 'chrome-global.json');
  fs.writeFileSync(corrupt, '{not json');
  const unreadable = path.join(dir, 'a-directory.json');   // exists, but reading it throws EISDIR
  fs.mkdirSync(unreadable);
  // #67: the DEFAULT is main's to write into the file, never the relay's guess.
  for (const file of [path.join(dir, 'nope.json'), corrupt, unreadable]) {
    const res = await runRelay(['--pipe', pipeName(), '--then', b64(ECHO), '--quiet-when', file], DOC);
    assert.strictEqual(res.out, 'USER-ROW', file);
  }
});

test('#27: quiet still forwards the document to the host', async () => {
  const name = pipeName();
  const bridge = createHookBridge({ pipeName: `\\\\.\\pipe\\${name}` });
  await bridge.listening;
  const got = new Promise(r => { bridge.once('event', r); setTimeout(() => r(null), 3000).unref(); });
  const file = writeChrome(tmpDir('relay-quiet-fwd'), { statusInHeader: true });
  await runRelay(['--pipe', name, '--then', b64(ECHO), '--quiet-when', file], DOC);
  const ev = await got;
  await bridge.close();
  assert.ok(ev && ev.event === 'Status', 'the header needs the document even when the row is quiet');
});

// --- PR #161: the sweep must reach, and end, every process of a still-spawning command even when it is cut off or its reads fail ---
// A still-spawning user command (the #72 spawner, detached sleepers), cut with `intervalMs` 25 until ~150 sleepers are live.
async function spawnerTree(name, { enough = 150 } = {}) {
  const dir = tmpDir(name);
  try { reapDeadOwners('cc161'); reapDeadOwners('cc161s'); } catch { /* a leftover sweep must never fail the test */ }
  const marker = `cc161-${process.pid}-${Date.now()}`;
  const spawnerMarker = `cc161s-${process.pid}-${Date.now()}`;
  RUN_MARKERS.push(marker, spawnerMarker);
  const ready = path.join(dir, 'ready').replace(/\\/g, '/');
  const spawnerFile = path.join(dir, 'spawner.js');
  // kill-test-ok: the sleepers and the spawner carry markers, reaped by cleanup(), the exit hook and the next run's reapDeadOwners
  fs.writeFileSync(spawnerFile, spawnerSource({ sleeperSrc: SLEEPER_SRC, marker, readyFile: ready, intervalMs: 25, deadlineMs: 170000, parentPid: process.pid, detached: true }));
  const child = spawn(`"${process.execPath}" "${spawnerFile.replace(/\\/g, '/')}" ${spawnerMarker}`, { shell: true, stdio: 'ignore', windowsHide: true });
  await waitUntil(() => fs.existsSync(ready), 'the user command to start spawning', 60000);
  await waitUntil(() => markedPids(marker).length >= enough, `about ${enough} sleepers`, 60000);
  const cleanup = () => { try { reapMarked(marker); reapMarked(spawnerMarker); } catch { /* cleanup only; the exit hook and the next run's sweep try again */ } };
  return { child, marker, cleanup };
}
async function noneLeft(marker) {
  let left = markedPids(marker);
  for (let i = 0; i < 10 && left.length; i++) { await new Promise(r => setTimeout(r, 300)); left = markedPids(marker); }
  return left;
}
// `sabotaged` with several edits at once (each `from` must be in the script).
function sabotagedAll(pairs, seen) {
  return (cmd, args, o) => {
    if (cmd !== 'powershell.exe') return spawnSync(cmd, args, o);
    let script = args[3];
    for (const [from, to] of pairs) { assert.ok(script.includes(from), `the sweep script no longer contains ${from}`); script = script.replace(from, () => to); }
    const r = spawnSync(cmd, [...args.slice(0, 3), script], o);
    if (!seen.sweep) seen.sweep = r; else (seen.rescans = seen.rescans || []).push(r);
    return r;
  };
}

test('#72 PR #161 Dexter 1: a sweep cut off after it listed ~150 sleepers still leaves none of them running (the fallback is one proven batch)', { skip: !onWin, timeout: 180000 }, async () => {
  // The F1-stall sabotage: the 3rd table read hangs, the sweep is cut off at 8 s, and everything it listed is the fallback's. One
  // taskkill.exe per pid could not end 200 of them inside the batch's 10 s.
  const { child, marker, cleanup } = await spawnerTree('relay-fallback-batch');
  const seen = {};
  const stallThird = `$script:n=0\nfunction ReadProcs{$script:n++;if($script:n -ge 3){Start-Sleep -Seconds 120};Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 8}`;
  try {
    const before = markedPids(marker).length;
    const t0 = Date.now();
    killTree(child, 0, { sweepTimeoutMs: 8000, run: sabotagedAll([[READ_PROCS, stallThird]], seen) });
    const took = Date.now() - t0;
    assert.ok(seen.sweep.error, `the stalled sweep was not cut off (status ${seen.sweep.status}); the fallback was never exercised`);
    const listed = sweepPids(seen.sweep.stdout).length;
    const left = await noneLeft(marker);
    assert.deepStrictEqual(left, [], `${left.length} of ${before} sleepers survived the fallback (it listed ${listed}; killTree took ${took} ms; sweep stdout ${String(seen.sweep.stdout).split(/\r?\n/).map(l => l.slice(0, 40)).join(' | ')})`);
  } finally { cleanup(); }
});

test('#72 PR #161 Dexter 2: sleepers born between the snapshot and the spawner\'s kill are ended when the read after that kill fails', { skip: !onWin, timeout: 180000 }, async () => {
  // failThird: read 1 is the snapshot, read 2 lists the spawner, read 3 (after the spawner is dead) fails. Every sleeper the spawner
  // started since the snapshot is in no ALIVE line: only a second look under the parents the sweep ended can reach it.
  const { child, marker, cleanup } = await spawnerTree('relay-newborns');
  const seen = {};
  const failThird = `$script:n=0\nfunction ReadProcs{$script:n++;if($script:n -ge 3){throw 'broken on purpose'};Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 8}`;
  try {
    killTree(child, 0, { run: sabotagedAll([[READ_PROCS, failThird]], seen) });
    assert.strictEqual(seen.sweep.status, 4, 'the sweep did not fail where the test broke it');
    assert.match(seen.sweep.stdout, /^ENDED( \d+:\d+:\d+)+\s*$/m, 'the sweep did not say which parents it had ended');
    assert.ok(seen.rescans && seen.rescans.length === 1, 'the fallback did not read the table again');
    const left = await noneLeft(marker);
    assert.deepStrictEqual(left, [], `${left.length} sleepers born after the snapshot survived`);
  } finally { cleanup(); }
});

test('#72 PR #161 Dexter 3: a process we killed whose exit was not seen in time adopts nothing unbounded (a stranger that reused its pid is spared)', { skip: !onWin, timeout: 120000 }, async () => {
  // The S7-2 stranger case with the exit forced to be "not seen": every kill's wait reports "still running". The row 2000000005 names
  // the killed grandchild as its parent but started an hour later; it was adopted as an alive parent's child, and the sweep exited 5.
  const { child, since, grandchild } = await hangTree(tmpDir('relay-sweep-slow-exit'));
  const seen = {};
  const stranger = `$script:n=0;$script:kid=$null\nfunction ReadProcs{$script:n++;$rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 8);if($script:n -eq 2){$script:kid=@($rows | Where-Object { [int]$_.ParentProcessId -eq $root })[0].ProcessId};if($script:n -ge 3 -and $script:kid){$rows+=[pscustomobject]@{ProcessId=2000000005;ParentProcessId=[int]$script:kid;CreationDate=(Get-Date).AddHours(1)}};$rows}`;
  try {
    killTree(child, since, { proveBatch: () => new Map(), run: sabotagedAll([[READ_PROCS, stranger], ['if($r.p.HasExited){', 'if($false){']], seen) });
    assert.doesNotMatch(seen.sweep.stdout, /2000000005/, 'a killed, still-exiting process adopted a stranger\'s child');
    assert.strictEqual(seen.sweep.status, 0, `the sweep should have finished clean: ${seen.sweep.status}`);
    assert.ok(await gone(grandchild));
  } finally { try { process.kill(grandchild); } catch { /* gone */ } }
});

test('#72 PR #161 Dexter 4 / Miguel 1-2: every process of a level is started on before the first of them is waited on', { skip: !onWin, timeout: 120000 }, async () => {
  // cmd.exe -> node (P) -> three sleepers. The sweep's KillStart and KillWait are made to say which pid they touch; the level of the
  // three sleepers must be all KillStart lines, then the KillWait lines. No clock.
  const dir = tmpDir('relay-level-order');
  const pidFile = path.join(dir, 'pids').replace(/\\/g, '/');
  // kill-test-ok: the three sleepers are ended by the sweep under test, and by pid in this test's finally
  const prog = `const{spawn}=require('child_process');const k=[1,2,3].map(()=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}).pid);require('fs').writeFileSync('${pidFile}',k.join(','));setInterval(()=>{},1000)`;
  const child = spawn(`"${process.execPath}" -e "${prog}"`, { shell: true, stdio: 'ignore', windowsHide: true });
  const kids = (await waitUntil(() => { try { return fs.readFileSync(pidFile, 'utf8'); } catch { return false; } }, 'the three sleepers', 60000)).toString().split(',').map(Number);
  const seen = {};
  const sayStart = ['function KillStart($o,$isRoot){', "function KillStart($o,$isRoot){[Console]::Out.WriteLine('KS '+$o.id);"];
  const sayWait = ['function KillWait($r,$ms){', "function KillWait($r,$ms){if($r.p){[Console]::Out.WriteLine('KW '+$r.p.Id)};"];
  try {
    killTree(child, 0, { run: sabotagedAll([sayStart, sayWait], seen) });
    const lines = String(seen.sweep.stdout).split(/\r?\n/).filter(l => /^K[SW] \d+$/.test(l));
    const idx = (tag, pid) => lines.indexOf(`${tag} ${pid}`);
    for (const k of kids) assert.ok(idx('KS', k) >= 0 && idx('KW', k) >= 0, `pid ${k} was not started on and waited on: ${lines.join(', ')}`);
    const lastStart = Math.max(...kids.map(k => idx('KS', k)));
    const firstWait = Math.min(...kids.map(k => idx('KW', k)));
    assert.ok(lastStart < firstWait, `a sleeper was waited on before the whole level had been started on: ${lines.join(', ')}`);
  } finally { for (const k of kids) { try { process.kill(k); } catch { /* gone */ } } }
});

test('#72 PR #161 Dexter R2-1: a spawner we killed whose exit is not seen in time still has its newborns ended, and the sweep is not clean until it has exited', { skip: !onWin, timeout: 180000 }, async () => {
  // The Dexter-3 sabotage (every kill's wait reports "still running") on the #72 spawner tree. A killed-not-exited parent used to fall to
  // the $known-only branch: the sleepers it started after the snapshot were never adopted, and the sweep exited 0, so no fallback ran.
  const { child, marker, cleanup } = await spawnerTree('relay-slow-exit-spawner');
  const seen = {};
  try {
    killTree(child, 0, { run: sabotagedAll([['if($r.p.HasExited){', 'if($false){']], seen) });
    assert.ok(seen.sweep, 'the sweep did not run');
    const left = await noneLeft(marker);
    assert.deepStrictEqual(left, [], `${left.length} sleepers survived (sweep status ${seen.sweep.status}, ${String(seen.sweep.stdout).split(/\r?\n/).length} lines)`);
  } finally { cleanup(); }
});

test('#72 PR #161 Dexter R2-2: a sweep cut off after a level\'s Kill() calls but inside its wait still seeds the rescan with THAT level', { skip: !onWin, timeout: 180000 }, async () => {
  // The 2nd KillWait (the spawner's level) hangs past the sweep's timeout. The ENDED line used to be written after the waits, so the
  // rescan was seeded with the level above (cmd) and the spawner's newborns were in no list.
  const { child, marker, cleanup } = await spawnerTree('relay-cut-in-wait');
  const seen = {};
  const hangSecondWait = 'function KillWait($r,$ms){$script:w++;if($script:w -ge 2){Start-Sleep -Seconds 120};';
  try {
    killTree(child, 0, { sweepTimeoutMs: 8000, run: sabotagedAll([['function KillWait($r,$ms){', hangSecondWait]], seen) });
    assert.ok(seen.sweep.error, 'the sweep was not cut off inside the wait');
    assert.ok((seen.rescans || []).length === 1, 'the fallback did not rescan');
    const left = await noneLeft(marker);
    assert.deepStrictEqual(left, [], `${left.length} sleepers survived a sweep cut off in a wait`);
  } finally { cleanup(); }
});
