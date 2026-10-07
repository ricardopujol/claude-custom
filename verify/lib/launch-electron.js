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

const defaultSelfStart = createSelfStartTime();
const live = new Set();            // handles not yet stopped, for the exit / signal sweep
let sweepInstalled = false;

function installSweep() {
  if (sweepInstalled) return;
  sweepInstalled = true;
  // Synchronous: 'exit' handlers cannot await. A kill by PID, then done.
  const sweep = () => { for (const h of [...live]) { try { killPidTree(h.pid); } catch { /* gone */ } live.delete(h); } };
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
    try { killFn(child.pid); } catch { /* gone */ }
    live.delete(handle);
    throw new Error(`launchElectron: could not read the start time of pid ${child.pid}; killed it rather than leave an unproven process`);
  }
  handle.start = start;
  let launcherStart = null;
  try { launcherStart = await selfStart(); } catch { /* the launcher is then recorded as unknown, i.e. no launcher */ }
  ledger.appendEntry(ledgerFile, {
    pid: child.pid, start, kind, label, createdAt: Date.now(),
    launcher: typeof launcherStart === 'string' ? { pid: process.pid, start: launcherStart } : null,
  });
  handle.stop = (o) => stopElectron(handle, o);
  return handle;
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
  if (polite) {
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

module.exports = { cleanElectronEnv, launchElectron, stopElectron, waitForExit, sleep };
