'use strict';
/**
 * verify/probe-renderer-backgrounding.js -- does a NEW tab window reach its host while the E-cores are busy?
 *
 *   node verify/probe-renderer-backgrounding.js [--seconds 60] [--load]
 *
 * WHY: test/renderer-backgrounding-wiring.test.js's header (E-core starvation of background renderers, 2026-10-13).
 *
 * WHAT IT DOES. A throwaway container project (`<tmp>\proj\dev`, git init), the real app in tabs mode on it with
 * cmd.exe as the "claude" binary and its own user-data dir, then the time from launch to the host logging
 * `client attached`. A pass only means something while the E-cores are saturated, so the probe reads their load at the
 * end and calls the run INCONCLUSIVE below 80%.
 *
 * --load makes the starved case itself instead of waiting for it: one spinning node per E-core (the last four logical
 * CPUs), each BelowNormal + EcoQoS, which Windows keeps on the E-cores and ranks above an Idle renderer. Stopped by PID
 * when the run ends. The P-cores stay free, so the rest of the machine is unaffected.
 *
 * .harness/host.log IS SHARED by every host on this install, and `client attached` names no port. The probe finds its
 * own host by the `cwd` line, then takes the first `client attached` after that host's own `listening on` line.
 * Another host attaching in the same instant could still be mistaken for it; re-run if the number looks too good.
 *
 * Exit 0: connected under load. Exit 1: never connected (the bug). Exit 2: the probe failed. Exit 3: inconclusive
 * (connected, but the E-cores weren't busy enough to show the starved case).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchElectron } = require('./lib/launch-electron');
const { killProvenAsync } = require('../host/kill-tree');

const ROOT = path.join(__dirname, '..');
const HOST_LOG = path.join(ROOT, '.harness', 'host.log');
const HOSTS_DIR = path.join(ROOT, '.harness', 'hosts');
const argSeconds = process.argv.indexOf('--seconds');
const LIMIT_S = argSeconds !== -1 ? Number(process.argv[argSeconds + 1]) : 60;
const BUSY_PCT = 80;
const LOAD = process.argv.includes('--load');
const E_CORES = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The last four logical CPUs' busy % (the E-cores on the Katana), as { text, avg }; avg is null when unreadable.
function eCoreLoad() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-Counter '\\Processor Information(0,*)\\% Processor Time' -SampleInterval 1 -MaxSamples 1).CounterSamples | "
      + "Where-Object { $_.InstanceName -notmatch '_Total' } | Sort-Object { [int]($_.InstanceName -split ',')[1] } | "
      + "Select-Object -Last 4 | ForEach-Object { '{0}={1:N0}' -f $_.InstanceName, $_.CookedValue }"],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const rows = out.trim().split(/\r?\n/);
    const vals = rows.map((r) => Number(r.split('=')[1]));
    if (vals.length === 0 || vals.some((v) => !Number.isFinite(v))) return { text: out.trim(), avg: null };
    return { text: rows.map((r) => `${r}%`).join(' '), avg: vals.reduce((a, b) => a + b, 0) / vals.length };
  } catch (err) { return { text: `unreadable (${err.message})`, avg: null }; }
}

function readLogFrom(offset) {
  try {
    const fd = fs.openSync(HOST_LOG, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, size - offset));
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

// Our host: its `cwd` line, then its own `listening on` line, then the first `client attached` after that.
function ourHost(text, dev) {
  const at = text.indexOf(`[host] cwd           : ${dev}`);
  if (at === -1) return null;
  const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(text.slice(at));
  if (!m) return { port: null, attached: false };
  const afterListening = text.slice(at + m.index + m[0].length);
  return { port: Number(m[1]), attached: /\[host\] client attached/.test(afterListening) };
}

// One spinner per E-core, each switched to BelowNormal + EcoQoS (ProcessPowerThrottling, execution speed) by PowerShell.
// `kids` is the caller's list, filled before the PowerShell step, so a refusal there still leaves them for its finally.
function startLoad(kids) {
  const { spawn } = require('child_process');
  for (let i = 0; i < E_CORES; i++) kids.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));
  const pids = kids.map((k) => k.pid).join(',');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Eco { [StructLayout(LayoutKind.Sequential)] public struct S { public uint V, C, St; }
[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, int p);
[DllImport("kernel32.dll")] public static extern bool SetProcessInformation(IntPtr h, int c, ref S s, int n);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
public static bool On(int pid) { var h = OpenProcess(0x0200, false, pid); var s = new S { V = 1, C = 1, St = 1 };
  bool ok = SetProcessInformation(h, 4, ref s, Marshal.SizeOf(s)); CloseHandle(h); return ok; } }
"@
foreach ($p in @(${pids})) { (Get-Process -Id $p).PriorityClass = 'BelowNormal'; if (-not [Eco]::On($p)) { throw "EcoQoS refused for $p" } }`],
  { windowsHide: true, timeout: 30000 });
}

async function stopOurHost(port) {
  if (!port) return 'no port seen';
  let id;
  try { id = JSON.parse(fs.readFileSync(path.join(HOSTS_DIR, `${port}.json`), 'utf8')); } catch { return 'no identity file'; }
  if (!Number.isInteger(id.pid) || typeof id.processStartedAt !== 'string') return 'identity without a proof';
  return killProvenAsync(id.pid, id.processStartedAt);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-bg-'));
  let handle = null;
  let seen = null;
  const load = [];
  try {
    if (LOAD) { startLoad(load); await sleep(3000); console.log(`[probe] --load: ${load.length} EcoQoS spinners started`); }
    const dev = path.join(tmp, 'proj', 'dev');
    fs.mkdirSync(dev, { recursive: true });
    execFileSync('git', ['-C', dev, 'init', '-q', '-b', 'develop'], { windowsHide: true });
    execFileSync('git', ['-C', dev, '-c', 'user.email=probe@example.invalid', '-c', 'user.name=probe', 'commit', '-q', '--allow-empty', '-m', 'init'], { windowsHide: true });

    const offset = fs.existsSync(HOST_LOG) ? fs.statSync(HOST_LOG).size : 0;
    const t0 = Date.now();
    handle = await launchElectron({
      electronPath: require(path.join(ROOT, 'node_modules', 'electron')),
      args: [ROOT, `--user-data-dir=${path.join(tmp, 'user-data')}`],
      cwd: ROOT,
      extraEnv: { CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe', CLAUDE_CUSTOM_CWD: dev },
      label: 'probe-renderer-backgrounding',
      stdio: 'ignore',
    });

    while (Date.now() - t0 < LIMIT_S * 1000) {
      seen = ourHost(readLogFrom(offset), dev);
      if (seen && seen.attached) break;
      await sleep(250);
    }
    const ms = Date.now() - t0;
    const eLoad = eCoreLoad();
    console.log(`[probe] E-cores: ${eLoad.text}`);
    if (!(seen && seen.attached)) {
      console.log(`[probe] FAIL: no connection in ${LIMIT_S} s (${seen ? `host on ${seen.port} started` : 'host never started'})`);
      return 1;
    }
    if (eLoad.avg === null || eLoad.avg < BUSY_PCT) {
      console.log(`[probe] INCONCLUSIVE: connected in ${(ms / 1000).toFixed(1)} s, but the E-cores averaged under ${BUSY_PCT}%, so the starved case wasn't tested`);
      return 3;
    }
    console.log(`[probe] PASS: the tab connected to its host ${(ms / 1000).toFixed(1)} s after launch, E-cores ~${eLoad.avg.toFixed(0)}%`);
    return 0;
  } finally {
    for (const k of load) { try { k.kill(); } catch { /* gone */ } }   // our own ChildProcess handles: killed by PID
    // A killed tree takes well over the default 5 s to finish exiting while the E-cores are saturated (measured: `stuck`
    // at 5 s, gone shortly after), so the grace is long enough not to report a false `stuck`.
    if (handle) console.log(`[probe] window stopped: ${(await handle.stop({ politeMs: 0, graceMs: 20000 })).how}`);
    console.log(`[probe] stub host: ${await stopOurHost(seen && seen.port)}`);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  }
}

main().then((code) => process.exit(code), (err) => { console.error('[probe] failed:', err && err.stack); process.exit(2); });
