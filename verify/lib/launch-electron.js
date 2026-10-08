'use strict';
/**
 * The one way a verify/ probe starts an Electron (BACKLOG #74 B). Measured cause: a probe's node exits or is killed
 * before it has closed its window, and the Electron it started (a tree of 5-8 processes, 230+ MB) is left running with
 * nothing to stop it. So the launcher
 *   - strips ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* from the child's environment (CLAUDE.md traps), adding
 *     back only what the probe names;
 *   - records the root PID and its START TIME in the ledger (host/pid-ledger.js), with this process as launcher, so
 *     verify/reap-probes.js can find it if this process dies first;
 *   - stops politely first (the probe's own quit/close), waits, then kills the tree BY PID (host/kill-tree.js),
 *     never by name; and does that again from process 'exit' and SIGINT/SIGTERM, so a probe that dies still stops it.
 * An Electron whose start time cannot be read is killed at once and the launch fails: an unproven process is one
 * nothing could safely reap.
 */
const { spawn } = require('child_process');
const { killPidTree } = require('../../host/kill-tree');
const { startTimes: realStartTimes, createSelfStartTime } = require('../../host/proc-start');
const ledger = require('../../host/pid-ledger');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function cleanElectronEnv(env = process.env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('CLAUDE_CUSTOM_')) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined) delete out[k]; else out[k] = v;
  }
  return out;
}

/**
 * The env for spawnElectron, the drop-in: the probe built `childEnv` from process.env, so a CLAUDE_CUSTOM_* with the
 * parent's own value came from the tab this probe runs in and goes; one the probe added or changed is its own and stays.
 * ELECTRON_RUN_AS_NODE always goes. No childEnv means spawn's default, the parent's env.
 * Value equality cannot tell "inherited" from "set by the probe to the same value" (PR #130 review, Dexter #7 = Miguel
 * S2: CLAUDE_CUSTOM_CWD = REPO run from a tab of that same worktree), so the names in `keep` are the probe's own and stay.
 */
function probeEnv(childEnv, parentEnv = process.env, keep = []) {
  const out = {};
  for (const [k, v] of Object.entries(childEnv || parentEnv)) {
    if (k === 'ELECTRON_RUN_AS_NODE') continue;
    if (k.startsWith('CLAUDE_CUSTOM_') && parentEnv[k] === v && !keep.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

const defaultSelfStart = createSelfStartTime();
const live = new Set();            // handles not yet stopped, for the exit / signal sweep
let sweepInstalled = false;

// Synchronous: 'exit' handlers cannot await. A kill by PID of each child still running, then done.
function sweepLive() {
  for (const h of [...live]) {
    live.delete(h);
    if (h.exited) continue;
    try { (h.killFn || killPidTree)(h.pid); } catch { /* gone */ }   // kill-ok: the default killFn, called only while the child's handle is held
  }
}

// The exit / signal sweep. A signal handler runs once and exits only when nothing else listens for that signal
// (PR #130 review, Miguel S3): a probe with its own handler keeps control of its exit and its async cleanup.
function installSweep(proc = process) {
  if (proc === process) { if (sweepInstalled) return; sweepInstalled = true; }
  proc.on('exit', sweepLive);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    proc.once(sig, () => {
      sweepLive();
      if (proc.listenerCount(sig) === 0) proc.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}

// Both launch functions track a child the same way (PR #130 review, Miguel S4): in the sweep while it runs, and out of
// the sweep and the ledger the moment it exits.
function track(child, { killFn, ledgerFile, label = '' }) {
  const handle = { child, pid: child.pid, killFn, ledgerFile, label };
  live.add(handle);
  child.on('exit', () => {
    handle.exited = true;
    live.delete(handle);
    forget(ledgerFile, handle);
  });
  return handle;
}

// Prove the child by its start time, then record it. 'recorded' | 'unrecorded' (no ledger, or its lock refused) |
// 'exited-early' (gone before its start could be read: no kill, the pid may be reused) | 'exited' (gone before the
// line was written) | 'unproven' (start unreadable: killed, nothing could safely reap it later).
async function prove(handle, { startTimes, selfStart, killFn, ledgerFile, kind, label }) {
  const { child } = handle;
  let start = null;
  try { const starts = await startTimes([child.pid]); start = starts && starts.get(child.pid); } catch { /* unproven */ }
  if (typeof start !== 'string') {
    live.delete(handle);
    if (handle.exited) return 'exited-early';
    console.log(`[launch-electron] could not read the start time of pid ${child.pid}; killing it rather than leave an unproven process`);
    try { killFn(child.pid); } catch { /* gone */ }
    return 'unproven';
  }
  handle.start = start;
  let launcherStart = null;
  try { launcherStart = await selfStart(); } catch { /* recorded with an unknown start: alive while this pid runs */ }
  if (handle.exited) return 'exited';
  if (!ledgerFile) return 'unrecorded';
  return record(ledgerFile, handle, {
    pid: child.pid, start, kind, label, createdAt: Date.now(),
    launcher: { pid: process.pid, start: typeof launcherStart === 'string' ? launcherStart : null },
  }) ? 'recorded' : 'unrecorded';
}

async function launchElectron({
  electronPath, args = [], env = process.env, extraEnv = {}, cwd, label = '', kind = 'probe-window',
  ledgerFile = ledger.defaultLedgerFile(), spawnFn = spawn, startTimes = realStartTimes,
  selfStart = defaultSelfStart, killFn = killPidTree, install = true, stdio,   // kill-ok: the default killFn, called only while the child's handle is held
} = {}) {
  const exe = electronPath || require('electron');
  if (install) installSweep();
  const opts = { env: cleanElectronEnv(env, extraEnv) };
  if (cwd) opts.cwd = cwd;
  if (stdio) opts.stdio = stdio;
  const child = spawnFn(exe, args, opts);
  const handle = track(child, { killFn, ledgerFile, label });
  const proof = await prove(handle, { startTimes, selfStart, killFn, ledgerFile, kind, label });
  if (proof === 'exited-early') throw new Error(`launchElectron: pid ${child.pid} exited before its start time could be read`);
  if (proof === 'unproven') throw new Error(`launchElectron: could not read the start time of pid ${child.pid}; killed it rather than leave an unproven process`);
  handle.stop = (o) => stopElectron(handle, o);
  return handle;
}

/**
 * The drop-in for the probes' own `spawn(electron, args, opts)`: same signature, returns the ChildProcess at once, so
 * a probe's stop logic stays as it is. Around it: probeEnv's env, the exit / signal sweep, and a ledger entry once the
 * start time is read (`child.ledgered` resolves true), removed when the child exits. An unreadable start time kills the
 * child (unless it already left: its pid may be reused) and `child.ledgered` resolves false.
 */
function spawnElectron(exe, args = [], opts = {}, {
  spawnFn = spawn, startTimes = realStartTimes, selfStart = defaultSelfStart, killFn = killPidTree,   // kill-ok: the default killFn, called only while the child's handle is held
  ledgerFile = ledger.defaultLedgerFile(), install = true, label = '', kind = 'probe-window', parentEnv = process.env,
  keepEnv = [],
} = {}) {
  if (install) installSweep();
  const child = spawnFn(exe, args, { ...opts, env: probeEnv(opts.env, parentEnv, keepEnv) });
  const handle = track(child, { killFn, ledgerFile, label });
  child.ledgered = prove(handle, { startTimes, selfStart, killFn, ledgerFile, kind, label })
    .then(p => p === 'recorded' || (p === 'unrecorded' && !ledgerFile));
  return child;
}

// A launch's ledger line goes when its process does: a tombstone matched on pid AND start (host/pid-ledger.js). A
// failure is said, not swallowed; the line then stays for the reaper, which prunes it once the process is gone.
function forget(ledgerFile, handle) {
  if (!ledgerFile || !handle.recorded) return;
  const r = ledger.removeEntries(ledgerFile, [{ pid: handle.pid, start: handle.start }]);
  if (r.ok) handle.recorded = false;
  else console.log(`[launch-electron] could not remove pid ${handle.pid} from the ledger (${r.error}); the reaper will prune it`);
}

// Write the ledger line; false (and said) if the ledger lock could not be had: the child is then unrecorded, and only
// this process's exit sweep stops it.
function record(ledgerFile, handle, entry) {
  try { ledger.appendEntry(ledgerFile, entry); handle.recorded = true; return true; } catch (err) {
    console.log(`[launch-electron] could not record pid ${handle.pid} in the ledger (${err && (err.code || err.message)}); only this process's exit sweep will stop it`);
    return false;
  }
}

function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null && child.exitCode !== undefined) return resolve(true);
    const t = setTimeout(() => { child.removeListener('exit', on); resolve(false); }, ms);
    const on = () => { clearTimeout(t); resolve(true); };
    child.once('exit', on);
  });
}

/**
 * Polite first (`polite()`: the probe's own quit command or a window close), wait politeMs; if it is still there, kill
 * the tree by pid and wait graceMs. The ledger entry goes only when the root is gone: a root that would not die stays
 * recorded so the reaper can try again.
 */
async function stopElectron(handle, { polite, killFn = handle.killFn || killPidTree, politeMs = 15000, graceMs = 5000, ledgerFile = handle.ledgerFile } = {}) {   // kill-ok: the default killFn, called only while the child's handle is held
  const { child, pid } = handle;
  let how = null;
  // Already gone: no kill, its pid may belong to someone else by now.
  if (handle.exited || (child.exitCode !== null && child.exitCode !== undefined)) how = 'gone';
  else if (polite) {
    try { polite(); } catch (err) { console.log(`[launch-electron] polite step failed: ${err && err.message}`); }
    if (await waitForExit(child, politeMs)) how = 'polite';
  }
  if (!how) {
    try { killFn(pid); } catch (err) { console.log(`[launch-electron] kill ${pid} failed: ${err && err.message}`); }
    how = (await waitForExit(child, graceMs)) ? 'killed' : 'stuck';
  }
  if (how !== 'stuck') {
    live.delete(handle);
    forget(ledgerFile, handle);
  }
  return { how };
}

module.exports = { cleanElectronEnv, probeEnv, launchElectron, spawnElectron, stopElectron, sweepLive, installSweep, waitForExit, sleep };
