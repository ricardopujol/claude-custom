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
    seen.sweep = spawnSync(cmd, [...args.slice(0, 3), args[3].replace(from, () => to)], o);
    return seen.sweep;
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
