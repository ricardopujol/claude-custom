'use strict';
/**
 * The Resources panel's sampler (BACKLOG #63, documentation/DESIGN_RESOURCE_PANEL.md "How it's built"): the thin
 * OS shell around host/resource-sample.js. ONE PowerShell/CIM call per sample, on a 10 s cadence.
 *
 * MEASURED (PLAN_RESOURCE_PANEL.md, 2026-10-04, 472 processes): a full sample takes about 1.7 s warm and 233 KB of
 * JSON; the one cold call took 11.4 s. So the timeout is 20 s, and the cadence is a GAP after a sample ends, not
 * a fixed rate: a slow sample can never be piled on by the next.
 *
 * Two modes, by what is wanted (`policy`): the full sample (process table, per-process CPU counters, machine) when
 * `panel` is wanted; the machine-only sample (the idle counter, memory) when only `chip` is. Neither starts while another
 * is in flight. Since Round 3 Q1 (PR #113) app/resources-service.js asks for both together (the tree is sampled always, and
 * stops only while minimised), so it never asks for the machine-only mode today. That mode stays on purpose: it is this
 * component's tested contract (the cheaper sample: no process table), and a caller that wants only the chip needs
 * no change here. Withdrawing the want forgets the samples, so the next one starts at "measuring…" instead of drawing a stale tree.
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
$procs = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; cmd=$_.CommandLine; threads=$_.ThreadCount; handles=$_.HandleCount; start=$(if ($_.CreationDate) { [string]$_.CreationDate.ToFileTimeUtc() } else { $null }) } })
$perf = @(Get-CimInstance Win32_PerfRawData_PerfProc_Process | ForEach-Object { [pscustomobject]@{ pid=$_.IDProcess; cpu=[string]$_.PercentProcessorTime; ts=[string]$_.Timestamp_Sys100NS; wsp=[string]$_.WorkingSetPrivate } })
`;

// The GPU counters (BACKLOG #82), in BOTH modes: the chip shows GPU busy %, so the machine-only sample needs them too. Raw classes, not
// Get-Counter: one CIM query each, and the busy time is a 100 ns tick count like the CPU ones, so a delta of two samples is the busy %.
// MEASURED on the dev machine (PR #82): the three queries take about 0.35 s together and add 712 engine rows, 58 process-memory rows
// and 2 adapter rows to the JSON, about 83 KB (full sample 1.7 s -> 2.4 s median, machine-only 0.7 s -> 1.1 s).
// ISOLATION: each query has its own 3 s operation timeout, so a wedged GPU provider (a driver reset) costs that query and leaves
// the GPU part empty (the sample's gpu is then null, every figure "unknown"); the CPU and memory figures of the same call are not lost.
// Windows has no counter for the adapters' total memory: the display class's driver keys carry HardwareInformation.qwMemorySize (a
// REG_QWORD, or 8 bytes on some drivers) and MatchingDeviceId; the present display devices come from Win32_VideoController. The
// join, and "only present adapters", is host/resource-gpu.js's. The backslashes are doubled for the template literal.
const GPU_PART = `
$ge = @(Get-CimInstance -OperationTimeoutSec 3 Win32_PerfRawData_GPUPerformanceCounters_GPUEngine | ForEach-Object { [pscustomobject]@{ n=$_.Name; u=[string]$_.UtilizationPercentage; t=[string]$_.Timestamp_Sys100NS } })
$gp = @(Get-CimInstance -OperationTimeoutSec 3 Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory | ForEach-Object { [pscustomobject]@{ n=$_.Name; d=[string]$_.LocalUsage } })
$ga = @(Get-CimInstance -OperationTimeoutSec 3 Win32_PerfRawData_GPUPerformanceCounters_GPUAdapterMemory | ForEach-Object { [pscustomobject]@{ n=$_.Name; d=[string]$_.DedicatedUsage } })
$gd = @()
foreach ($k in @(Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}')) {
  if ($k.PSChildName -notmatch '^[0-9]{4}$') { continue }
  $q = $k.GetValue('HardwareInformation.qwMemorySize')
  if ($q -is [byte[]] -and $q.Length -ge 8) { $q = [BitConverter]::ToInt64($q, 0) }
  if ($q -is [long] -and $q -gt 0) { $gd += [pscustomobject]@{ m=[string]$k.GetValue('MatchingDeviceId'); b=[string]$q } }
}
$gn = @(Get-CimInstance -OperationTimeoutSec 3 Win32_VideoController | ForEach-Object { [string]$_.PNPDeviceID })
$gpu = [pscustomobject]@{ eng=$ge; pm=$gp; am=$ga; ad=$gd; pn=$gn }
`;

// The 100 ns counters travel as strings: Timestamp_Sys100NS is about 1.3e17, past 2^53.
function scriptFor(mode) {
  if (mode !== 'full' && mode !== 'machine') throw new TypeError(`resource sampler: unknown mode ${mode}`);
  return `$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$procs=@(); $perf=@(); $gpu=$null
${mode === 'full' ? FULL_PART : ''}${GPU_PART}
$cpu = Get-CimInstance Win32_PerfRawData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' } | ForEach-Object { [pscustomobject]@{ idle=[string]$_.PercentProcessorTime; ts=[string]$_.TimeStamp_Sys100NS } }
$os = Get-CimInstance Win32_OperatingSystem | ForEach-Object { [pscustomobject]@{ totalKb=$_.TotalVisibleMemorySize; freeKb=$_.FreePhysicalMemory } }
[pscustomobject]@{ procs=$procs; perf=$perf; cpu=$cpu; os=$os; gpu=$gpu } | ConvertTo-Json -Compress -Depth 5
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
 *   { mode, sample, prev, machine: { last, prev }, failures, lastGoodAt, stale, expired, adhoc? }
 * `adhoc` marks the sample Stop asked for off the cadence: it is shown, but it is not one of the 10 s steps the warning counts.
 *
 * `fetch(mode, adhoc) -> Promise<{ text, at, mode }>` (BACKLOG #100 c) replaces `exec` when the samples come from elsewhere
 * (host/shared-sampler.js: one poller for every window). The text is parsed with the time it was TAKEN, `at`, and `mode` says
 * what it holds. The cadence is then the source's, not this timer's, so a cadence take is a long WAIT for the next sample, and an
 * off-cadence one (`adhoc`) must not queue behind it: it runs beside it.
 */
function createSampler({
  exec = createExec(), fetch = null, cores, onUpdate = () => {}, intervalMs = INTERVAL_MS,
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
  let adhocRunning = null;   // with a fetch: the off-cadence take, which does not wait for the cadence one
  let adhocFlight = null;

  const snapshot = () => ({
    mode: lastMode, sample: last, prev, machine: { last: lastAny, prev: prevAny },
    failures, lastGoodAt, stale: failures > 0, expired: failures >= EXPIRE_AFTER,
  });
  // A listener that throws must not stop sampling, and must not go unseen either.
  const emit = (adhoc = false) => { try { onUpdate(adhoc ? { ...snapshot(), adhoc: true } : snapshot()); } catch (err) { log('[resources] update listener threw:', (err && err.stack) || err); } };

  function take(mode, adhoc = false) {
    const side = adhoc && fetch !== null;
    if (side ? adhocRunning : running) return side ? adhocRunning : running;
    const p = (async () => {
      let dropped = false;
      try {
        const flight = fetch ? fetch(mode, adhoc) : exec(scriptFor(mode));
        if (side) adhocFlight = flight; else inFlight = flight;
        const got = await flight;
        const s = fetch ? parseSample(got.text, got.at) : parseSample(got, now());
        if (!s) throw new Error('the sample did not parse');
        // What the sample HOLDS, when the source says (a shared one may hold the fuller kind than was asked for).
        const held = fetch && (got.mode === 'full' || got.mode === 'machine') ? got.mode : mode;
        // A sample that finishes after what it was for stopped being wanted is DROPPED (Dexter, PR #113 finding 6):
        // written back it would resurrect `last` while hidden, and the next show would draw the whole hidden period's
        // average as the current figure instead of starting at "measuring...".
        const now_ = policy(wanted);
        if (!started || now_ === null) { dropped = true; } else {
          failures = 0;
          lastGoodAt = s.at;
          lastMode = held;
          if (held === 'full' && now_ === 'full') { prev = last; last = s; }
          prevAny = lastAny;
          lastAny = s;
        }
      } catch {
        if (started && policy(wanted) !== null) failures++; else dropped = true;
      } finally {
        if (side) { adhocRunning = null; adhocFlight = null; } else { running = null; inFlight = null; }
      }
      if (!dropped) emit(adhoc);
    })();
    if (side) adhocRunning = p; else running = p;
    return p;
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
      if (adhocFlight && typeof adhocFlight.kill === 'function') adhocFlight.kill();
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
      if (running && fetch === null) await running;
      const before = last;
      await take('full', true);
      return failures === 0 && last && last !== before ? last.procs : null;
    },
    snapshot,
  };
}

module.exports = { createSampler, createExec, scriptFor, policy, INTERVAL_MS, TIMEOUT_MS, EXPIRE_AFTER };
