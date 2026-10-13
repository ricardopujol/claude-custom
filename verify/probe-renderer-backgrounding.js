'use strict';
/**
 * verify/probe-renderer-backgrounding.js -- does a NEW tab window reach its host while the E-cores are busy?
 *
 *   node verify/probe-renderer-backgrounding.js [--seconds 60]
 *
 * WHY (2026-10-13, the Katana, i7-13620H: 6 P-cores + 4 E-cores). Chromium starts every renderer as a background
 * process (Idle priority, EcoQoS) and Windows schedules EcoQoS threads on the E-cores. With those at 100% (Defender,
 * WMI, telemetry, every open window's resource sampler) a new window's strip and tab pages sat at `loading: true` with
 * an empty URL for over 60 s while the P-cores idled: a blank window whose tab never connected. app/main.js now appends
 * `disable-renderer-backgrounding`; measured then, the same launch connected in ~8 s.
 *
 * WHAT IT DOES. A throwaway container project (`<tmp>\proj\dev`, git init), the real app in tabs mode on it with
 * cmd.exe as the "claude" binary and its own user-data dir, then the time from launch to the host logging
 * `client attached` for that folder. It prints the E-cores' load at the time, because a pass on an idle machine
 * proves nothing about the starved case: run it with several windows open, or while something busy runs.
 *
 * .harness/host.log IS SHARED by every host on this install, so the probe matches its own host by the `cwd` line and
 * takes the first `client attached` after it. Another host attaching in the same instant could be mistaken for it;
 * re-run if the number looks too good.
 *
 * Exit 0: connected within the limit. Exit 1: never connected (the bug). Exit 2: the probe itself failed.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The E-cores' busy %, from the same counter set Task Manager reads. Logical CPUs 12-15 on the Katana; on another
// CPU the last four are printed and labelled as such.
function eCoreLoad() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-Counter '\\Processor Information(0,*)\\% Processor Time' -SampleInterval 1 -MaxSamples 1).CounterSamples | "
      + "Where-Object { $_.InstanceName -notmatch '_Total' } | Sort-Object { [int]($_.InstanceName -split ',')[1] } | "
      + "Select-Object -Last 4 | ForEach-Object { '{0}={1:N0}%' -f $_.InstanceName, $_.CookedValue }"],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return out.trim().split(/\r?\n/).join(' ');
  } catch (err) { return `unreadable (${err.message})`; }
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

// Our host's port: the `listening on` line that follows our own `cwd` line.
function ourHost(text, dev) {
  const at = text.indexOf(`[host] cwd           : ${dev}`);
  if (at === -1) return null;
  const after = text.slice(at);
  const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(after);
  return { port: m ? Number(m[1]) : null, attached: /\[host\] client attached/.test(after) };
}

async function stopOurHost(port) {
  if (!port) return 'no port seen';
  let id;
  try { id = JSON.parse(fs.readFileSync(path.join(HOSTS_DIR, `${port}.json`), 'utf8')); } catch { return 'no identity file'; }
  if (!Number.isInteger(id.pid) || typeof id.processStartedAt !== 'string') return 'identity without a proof';
  return killProvenAsync(id.pid, id.processStartedAt);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-bg-'));
  const dev = path.join(tmp, 'proj', 'dev');
  fs.mkdirSync(dev, { recursive: true });
  execFileSync('git', ['-C', dev, 'init', '-q', '-b', 'develop'], { windowsHide: true });
  execFileSync('git', ['-C', dev, '-c', 'user.email=probe@example.invalid', '-c', 'user.name=probe', 'commit', '-q', '--allow-empty', '-m', 'init'], { windowsHide: true });

  console.log(`[probe] E-cores before launch: ${eCoreLoad()}`);
  const offset = fs.existsSync(HOST_LOG) ? fs.statSync(HOST_LOG).size : 0;
  const t0 = Date.now();
  const handle = await launchElectron({
    electronPath: require(path.join(ROOT, 'node_modules', 'electron')),
    args: [ROOT, `--user-data-dir=${path.join(tmp, 'user-data')}`],
    cwd: ROOT,
    extraEnv: { CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe', CLAUDE_CUSTOM_CWD: dev },
    label: 'probe-renderer-backgrounding',
    stdio: 'ignore',
  });

  let seen = null;
  while (Date.now() - t0 < LIMIT_S * 1000) {
    seen = ourHost(readLogFrom(offset), dev);
    if (seen && seen.attached) break;
    await sleep(250);
  }
  const ms = Date.now() - t0;
  const connected = !!(seen && seen.attached);
  console.log(connected
    ? `[probe] PASS: the tab connected to its host ${(ms / 1000).toFixed(1)} s after launch`
    : `[probe] FAIL: no connection in ${LIMIT_S} s (${seen ? `host on ${seen.port} started` : 'host never started'})`);
  console.log(`[probe] E-cores now: ${eCoreLoad()}`);

  // A killed tree takes well over the default 5 s to finish exiting while the E-cores are saturated (measured: `stuck`
  // at 5 s, gone shortly after), so the grace is long enough not to report a false `stuck`.
  const how = await handle.stop({ politeMs: 0, graceMs: 20000 });
  console.log(`[probe] window stopped: ${how.how}; stub host: ${await stopOurHost(seen && seen.port)}`);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  process.exit(connected ? 0 : 1);
})().catch((err) => { console.error('[probe] failed:', err && err.stack); process.exit(2); });
