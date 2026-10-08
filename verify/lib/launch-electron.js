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
 */
function probeEnv(childEnv, parentEnv = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(childEnv || parentEnv)) {
    if (k === 'ELECTRON_RUN_AS_NODE') continue;
    if (k.startsWith('CLAUDE_CUSTOM_') && parentEnv[k] === v) continue;
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
    try { (h.killFn || killPidTree)(h.pid); } catch { /* gone */ }
  }
}

function installSweep() {
  if (sweepInstalled) return;
  sweepInstalled = true;
  const sweep = sweepLive;
  process.on('exit', sweep);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { sweep(); process.exit(sig === 'SIGINT' ? 130 : 143); });
  }
}

async function launchElectron({
  electronPath, args = [], env = process.env, extraEnv = {}, cwd, label = '', kind = 'probe-window',
  ledgerFile = ledger.defaultLedgerFile(), spawnFn = spawn, startTimes = realStartTimes,
  selfStart = defaultSelfStart, killFn = killPidTree, install = true, stdio,
} = {}) {
  const exe = electronPath || require('electron');
  if (install) installSweep();
  const opts = { env: cleanElectronEnv(env, extraEnv) };
  if (cwd) opts.cwd = cwd;
  if (stdio) opts.stdio = stdio;
  const child = spawnFn(exe, args, opts);
  const handle = { child, pid: child.pid, label, ledgerFile, killFn };
  live.add(handle);
  child.on('exit', () => { handle.exited = true; });

  const starts = await startTimes([child.pid]);
  const start = starts && starts.get(child.pid);
  if (typeof start !== 'string') {
    live.delete(handle);
    // Gone already: its pid may belong to someone else by now, so no kill.
    if (handle.exited) throw new Error(`launchElectron: pid ${child.pid} exited before its start time could be read`);
    try { killFn(child.pid); } catch { /* gone */ }
    throw new Error(`launchElectron: could not read the start time of pid ${child.pid}; killed it rather than leave an unproven process`);
  }
  handle.start = start;
  let launcherStart = null;
  try { launcherStart = await selfStart(); } catch { /* recorded with an unknown start: alive while this pid runs */ }
  ledger.appendEntry(ledgerFile, {
    pid: child.pid, start, kind, label, createdAt: Date.now(),
    launcher: { pid: process.pid, start: typeof launcherStart === 'string' ? launcherStart : null },
  });
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
  spawnFn = spawn, startTimes = realStartTimes, selfStart = defaultSelfStart, killFn = killPidTree,
  ledgerFile = ledger.defaultLedgerFile(), install = true, label = '', kind = 'probe-window', parentEnv = process.env,
} = {}) {
  if (install) installSweep();
  const child = spawnFn(exe, args, { ...opts, env: probeEnv(opts.env, parentEnv) });
  const handle = { child, pid: child.pid, killFn };
  live.add(handle);
  child.on('exit', () => {
    handle.exited = true;
    live.delete(handle);
    if (handle.recorded && ledgerFile) { try { ledger.removePids(ledgerFile, [handle.pid]); } catch { /* the reaper prunes */ } }
  });
  child.ledgered = (async () => {
    let start = null;
    try { const starts = await startTimes([child.pid]); start = starts && starts.get(child.pid); } catch { /* unproven */ }
    if (handle.exited) return false;
    if (typeof start !== 'string') {
      console.log(`[launch-electron] could not read the start time of pid ${child.pid}; killing it rather than leave an unproven process`);
      live.delete(handle);
      try { killFn(child.pid); } catch { /* gone */ }
      return false;
    }
    let launcherStart = null;
    try { launcherStart = await selfStart(); } catch { /* recorded with an unknown start: alive while this pid runs */ }
    if (handle.exited) return false;
    if (ledgerFile) {
      ledger.appendEntry(ledgerFile, {
        pid: child.pid, start, kind, label, createdAt: Date.now(),
        launcher: { pid: process.pid, start: typeof launcherStart === 'string' ? launcherStart : null },
      });
      handle.recorded = true;
    }
    return true;
  })();
  return child;
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
async function stopElectron(handle, { polite, killFn = handle.killFn || killPidTree, politeMs = 15000, graceMs = 5000, ledgerFile = handle.ledgerFile } = {}) {
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
    if (ledgerFile) { try { ledger.removePids(ledgerFile, [pid]); } catch { /* the reaper prunes stale lines */ } }
  }
  return { how };
}

module.exports = { cleanElectronEnv, probeEnv, launchElectron, spawnElectron, stopElectron, sweepLive, waitForExit, sleep };
