'use strict';
/**
 * "Is this machine on battery?" for the summary scheduler (backlog #39, DESIGN_SLAVE_MODE_SUMMARY.md decision 3).
 *
 *   createPowerProbe({ platform, run, now }) -> { onBattery() -> Promise<true | false | null> }
 *
 * true: on battery.  false: on mains, or no battery at all (a desktop).  null: couldn't tell.
 * The scheduler pauses only for a real `true`; null runs, so a probe that fails can't switch the feature off silently.
 *
 * A host is plain Node, so Electron's powerMonitor isn't there: on Windows this asks WMI (Win32_Battery.BatteryStatus,
 * 1 = discharging, 4 = low, 5 = critical) through PowerShell. It's asked at most once a minute and only when a job is
 * about to start, so an idle tab never spawns anything. Other platforms say null rather than guess.
 */

const { execFile } = require('child_process');
const { POWERSHELL } = require('./proc-start');

const TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;
const DISCHARGING = new Set([1, 4, 5]);

/** Win32_Battery's BatteryStatus text -> on battery?; '' (no battery) is false; anything else is null. */
function parseBatteryStatus(out) {
  if (typeof out !== 'string') return null;
  const s = out.trim();
  if (s === '') return false;
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  if (n < 1 || n > 11) return null;
  return DISCHARGING.has(n);
}

const runFile = (file, args, opts) => new Promise((resolve, reject) => {
  execFile(file, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

function createPowerProbe({ platform = process.platform, run = runFile, now = Date.now } = {}) {
  let cached = null;       // { at, value }
  let inFlight = null;

  async function ask() {
    try {
      const out = await run(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 -ExpandProperty BatteryStatus)',
      ], { timeout: TIMEOUT_MS, windowsHide: true });
      return parseBatteryStatus(out);
    } catch {
      return null;
    }
  }

  async function onBattery() {
    if (platform !== 'win32') return null;
    if (cached && now() - cached.at < TTL_MS) return cached.value;
    if (inFlight) return inFlight;
    inFlight = ask().then((value) => {
      if (value !== null) cached = { at: now(), value };
      return value;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  return { onBattery };
}

module.exports = { createPowerProbe, parseBatteryStatus, TTL_MS };
