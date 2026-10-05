'use strict';
/**
 * The Resources panel's sampler (BACKLOG #63, documentation/DESIGN_RESOURCE_PANEL.md "How it's built"): the thin
 * OS shell around host/resource-sample.js. ONE PowerShell/CIM call per sample, on a 10 s cadence.
 *
 * MEASURED (PLAN_RESOURCE_PANEL.md, 2026-10-04, 472 processes): a full sample takes about 1.7 s warm and 233 KB of
 * JSON; the one cold call took 11.4 s. So the timeout is 20 s, and the cadence is a GAP after a sample ends, not
 * a fixed rate: a slow sample can never be piled on by the next.
 *
 * Two modes, by what is being looked at (`policy`): the full sample (process table, per-process CPU counters,
 * machine) runs only while the panel is shown; the machine-only sample (the idle counter, memory) runs for the top
 * bar's chip. Neither starts while another is in flight. Hiding the panel forgets the process-tree samples, so
 * showing it again starts at "measuring…" instead of drawing a stale tree.
 *
 * A failed sample (timeout, a bad document) keeps the last good one and counts. `stale` is "last updated N s
 * ago"; after three in a row `expired` is true and the view shows "—". A good sample resets it.
 */

const path = require('path');
const { execFile } = require('child_process');
const { parseSample } = require('./resource-sample');

const INTERVAL_MS = 10000;
const TIMEOUT_MS = 20000;
const EXPIRE_AFTER = 3;
// By absolute path: a bare powershell.exe is looked up in the cwd first (host/proc-start.js, Miguel G1).
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const FULL_PART = `
$procs = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; cmd=$_.CommandLine; start=$(if ($_.CreationDate) { [string]$_.CreationDate.ToFileTimeUtc() } else { $null }) } })
$perf = @(Get-CimInstance Win32_PerfRawData_PerfProc_Process | ForEach-Object { [pscustomobject]@{ pid=$_.IDProcess; cpu=[string]$_.PercentProcessorTime; ts=[string]$_.Timestamp_Sys100NS; wsp=[string]$_.WorkingSetPrivate } })
`;

// The 100 ns counters travel as strings: Timestamp_Sys100NS is about 1.3e17, past 2^53.
function scriptFor(mode) {
  if (mode !== 'full' && mode !== 'machine') throw new TypeError(`resource sampler: unknown mode ${mode}`);
  return `$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$procs=@(); $perf=@()
${mode === 'full' ? FULL_PART : ''}
$cpu = Get-CimInstance Win32_PerfRawData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' } | ForEach-Object { [pscustomobject]@{ idle=[string]$_.PercentProcessorTime; ts=[string]$_.TimeStamp_Sys100NS } }
$os = Get-CimInstance Win32_OperatingSystem | ForEach-Object { [pscustomobject]@{ totalKb=$_.TotalVisibleMemorySize; freeKb=$_.FreePhysicalMemory } }
[pscustomobject]@{ procs=$procs; perf=$perf; cpu=$cpu; os=$os } | ConvertTo-Json -Compress -Depth 4
'END'`;
}

/** `exec(script) -> Promise<string>`: powershell.exe with its own timeout. The END sentinel, not the exit code, says it finished. */
function createExec(timeoutMs = TIMEOUT_MS) {
  return function exec(script) {
    let child = null;
    const done = new Promise((resolve, reject) => {
      child = execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1048576 },
        (err, stdout) => {
          if (err && !stdout) reject(err);
          else resolve(String(stdout || ''));
        });
    });
    // Ends THIS powershell.exe by its own handle (sampler.stop() on quit), never by name.
    done.kill = () => { try { if (child) child.kill(); } catch { /* already gone */ } };
    return done;
  };
}

/** What a sample costs, by what is being looked at: 'full' | 'machine' | null. */
function policy(wanted) {
  if (!wanted || typeof wanted !== 'object') return null;
  if (wanted.panel === true) return 'full';
  return wanted.chip === true ? 'machine' : null;
}

/**
 * createSampler({ exec, cores, onUpdate, intervalMs, now, setTimer, clearTimer }) ->
 *   { start, stop, setWanted({ panel, chip }), sampleNow() -> procs | null, snapshot() }
 * onUpdate gets the snapshot after every sample, good or failed:
 *   { mode, sample, prev, machine: { last, prev }, failures, lastGoodAt, stale, expired }
 */
function createSampler({
  exec = createExec(), cores, onUpdate = () => {}, intervalMs = INTERVAL_MS,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {},
} = {}) {
  let wanted = { panel: false, chip: false };
  let started = false;
  let timer = null;
  let running = null;
  let again = false;
  let failures = 0;
  let lastGoodAt = null;
  let last = null;      // the latest full sample, and the one before it
  let prev = null;
  let lastAny = null;   // the latest sample of either mode (machine CPU is a delta of these)
  let prevAny = null;
  let lastMode = null;
  let inFlight = null;  // the exec promise running now (it can be killed by its own pid on stop)

  const snapshot = () => ({
    mode: lastMode, sample: last, prev, machine: { last: lastAny, prev: prevAny },
    failures, lastGoodAt, stale: failures > 0, expired: failures >= EXPIRE_AFTER,
  });
  // A listener that throws must not stop sampling, and must not go unseen either.
  const emit = () => { try { onUpdate(snapshot()); } catch (err) { log('[resources] update listener threw:', (err && err.stack) || err); } };

  function take(mode) {
    if (running) return running;
    running = (async () => {
      let dropped = false;
      try {
        inFlight = exec(scriptFor(mode));
        const s = parseSample(await inFlight, now());
        if (!s) throw new Error('the sample did not parse');
        // A sample that finishes after what it was for stopped being wanted is DROPPED (Dexter, PR #113 finding 6):
        // written back it would resurrect `last` while hidden, and the next show would draw the whole hidden period's
        // average as the current figure instead of starting at "measuring...".
        const now_ = policy(wanted);
        if (!started || now_ === null) { dropped = true; } else {
          failures = 0;
          lastGoodAt = s.at;
          lastMode = mode;
          if (mode === 'full' && now_ === 'full') { prev = last; last = s; }
          prevAny = lastAny;
          lastAny = s;
        }
      } catch {
        if (started && policy(wanted) !== null) failures++; else dropped = true;
      } finally {
        running = null;
        inFlight = null;
      }
      if (!dropped) emit();
    })();
    return running;
  }

  function schedule(delay) {
    if (timer) clearTimer(timer);
    timer = null;
    if (!started || policy(wanted) === null) return;
    timer = setTimer(tick, delay);
  }

  function tick() {
    timer = null;
    const mode = policy(wanted);
    if (!started || mode === null) return;
    take(mode).then(() => {
      const wake = again;
      again = false;
      schedule(wake ? 0 : intervalMs);
    });
  }

  function wake() {
    if (!started || policy(wanted) === null) { schedule(0); return; }
    if (running) { again = true; return; }
    if (timer) clearTimer(timer);
    timer = null;
    tick();
  }

  return {
    start() { started = true; wake(); },
    stop() {
      started = false;
      if (timer) clearTimer(timer);
      timer = null;
      if (inFlight && typeof inFlight.kill === 'function') inFlight.kill();
    },
    setWanted(next) {
      const before = policy(wanted);
      wanted = { panel: !!(next && next.panel), chip: !!(next && next.chip) };
      const after = policy(wanted);
      if (after !== 'full') { prev = null; last = null; }
      // Nothing is being sampled: the machine pair is forgotten too, so the first sample after a pause (a minimised
      // window) is "—", not the average of the whole gap shown as the machine's CPU now (Dexter finding 7).
      if (after === null) { prevAny = null; lastAny = null; }
      if (after === before && timer) return;
      wake();
    },
    // Stop's re-read: a sample taken after the click, never one already in flight.
    async sampleNow() {
      if (running) await running;
      const before = last;
      await take('full');
      return failures === 0 && last && last !== before ? last.procs : null;
    },
    snapshot,
  };
}

module.exports = { createSampler, createExec, scriptFor, policy, INTERVAL_MS, TIMEOUT_MS, EXPIRE_AFTER };
