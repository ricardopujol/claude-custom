'use strict';
/* BACKLOG #74 D -- what does a claude-custom host process cost over time, and is it a leak or churn?

   READ-ONLY. It samples `electron.exe ... host\host.js` processes through one Win32_Process query per
   tick (private bytes, working set, kernel+user CPU time, handle and thread count). It never opens a
   handle to the host, never attaches, never signals. Safe to point at the host of the window you are
   using.

   USAGE
     node verify/probe-host-footprint.js                      every host, 60 min, every 30 s
     node verify/probe-host-footprint.js --pid 276 --minutes 10 --interval 10
     node verify/probe-host-footprint.js --summarise .harness/host-footprint.jsonl
   Samples stream to --out (default .harness/host-footprint-<yyyymmdd-hhmmss>.jsonl, one file per run) as JSON
   lines, one per host per tick, so a run that is interrupted still leaves its data; --summarise skips a torn
   last line. An explicit --out that already holds samples is refused unless --force. A bad --minutes,
   --interval (minimum 1 s) or --pid exits 2 with a usage line. Otherwise the exit code is 0 unless no host
   was ever found.

   WHAT THE SAMPLER COSTS. Each tick spawns one `powershell` and runs one CIM query: about 1 CPU-second
   (a real sample measured ~2.3 s wall-clock over ~430 processes). At the default 30 s interval that's
   roughly 3 % of one core, on the machine but NOT in the host's own CPU-seconds, which come from the host's
   kernel+user times. Use a longer --interval when the machine is busy.

   LEAK vs CHURN. A host was seen swinging 743 -> 317 MB inside a minute. That is garbage collection,
   not a leak, and a last-minus-first comparison cannot tell them apart. The verdict therefore reads the
   FLOOR of the series (the minimum of each time window): a floor that keeps rising is a leak, a high
   swing around a flat floor is churn. CPU is reported as the delta over the run scaled to an hour, not
   the lifetime total. */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MB = 1048576;
const HOUR_MS = 3600000;
const WINDOWS = 6;
const MIN_TREND_MS = 10 * 60000;
const LEAK_FLOOR_MB_PER_HOUR = 30;
const LEAK_FLOOR_RISE_MB = 25;
const CHURN_SWING_MB = 50;
const FLOOR_STEP_NOISE_MB = 2;   // a window-to-window floor change smaller than this is GC jitter, not a rise

// ---- pure helpers (unit-tested in test/probe-host-footprint.test.js) ----

/** Electron processes whose command line ends in host\host.js (quoted or not). */
function parseHosts(rows) {
  return rows.filter((r) => /^electron\.exe$/i.test(r.Name || '')
    && typeof r.CommandLine === 'string'
    && /[\\/]host[\\/]host\.js"?\s*$/i.test(r.CommandLine));
}

function slope(points) {                 // least-squares y per x
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0; let den = 0;
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  return den === 0 ? 0 : num / den;
}

/** The minimum of each time window, as {x: ms, y: MB}; windows with no sample are skipped. */
function floors(samples) {
  const t0 = samples[0].t;
  const span = samples[samples.length - 1].t - t0;
  const mins = new Map();
  for (const s of samples) {
    const w = span === 0 ? 0 : Math.min(WINDOWS - 1, Math.floor(((s.t - t0) / span) * WINDOWS));
    const prev = mins.get(w);
    if (!prev || s.priv < prev.y * MB) mins.set(w, { x: s.t, y: s.priv / MB });
  }
  return [...mins.keys()].sort((a, b) => a - b).map((w) => mins.get(w));
}

/** MB per hour that the series' floor is rising (negative = falling). */
function floorSlope(samples) {
  if (samples.length < 2) return 0;
  return slope(floors(samples)) * HOUR_MS;
}

/**
 * "Keeps rising": most window-to-window floor steps go up, in the run as a whole AND in its later half. A fitted
 * slope can't do this alone: one warm-up step (200 -> 300 MB at minute 8, then flat) fits 85.7 MB/h (Dexter F3,
 * PR #131). A step changes one delta; a leak changes most of them.
 */
function floorKeepsRising(fl) {
  const deltas = [];
  for (let i = 1; i < fl.length; i++) deltas.push(fl[i].y - fl[i - 1].y);
  const mostlyUp = (ds) => ds.length > 0 && ds.filter((d) => d > FLOOR_STEP_NOISE_MB).length * 2 > ds.length;
  return mostlyUp(deltas) && mostlyUp(deltas.slice(Math.floor(deltas.length / 2)));
}

function summarise(samples) {
  const unknown = { verdict: 'unknown', cpuPerHour: null, samples: samples.length };
  if (samples.length < 2) return unknown;
  const first = samples[0]; const last = samples[samples.length - 1];
  const spanMs = last.t - first.t;
  if (spanMs <= 0) return unknown;
  const privMB = samples.map((s) => s.priv / MB);
  const minMB = Math.min(...privMB); const maxMB = Math.max(...privMB);
  const fl = floors(samples);
  const floorSlopeMBPerHour = slope(fl) * HOUR_MS;
  const floorRiseMB = fl[fl.length - 1].y - fl[0].y;
  let verdict = 'stable';
  if (spanMs < MIN_TREND_MS) verdict = 'too-short';
  else if (floorSlopeMBPerHour > LEAK_FLOOR_MB_PER_HOUR && floorRiseMB > LEAK_FLOOR_RISE_MB
    && floorKeepsRising(fl)) verdict = 'leak';
  else if (maxMB - minMB > CHURN_SWING_MB) verdict = 'churn';
  return {
    verdict,
    samples: samples.length,
    minutes: spanMs / 60000,
    startMB: privMB[0], endMB: privMB[privMB.length - 1], minMB, maxMB,
    floorSlopeMBPerHour,
    cpuPerHour: ((last.cpu - first.cpu) / spanMs) * HOUR_MS,
    handlesEnd: last.handles, threadsEnd: last.threads,
  };
}

// ---- sampling ----

const PS = [
  '$ErrorActionPreference="SilentlyContinue";',
  "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -match 'host[\\\\/]host\\.js\"?\\s*$' } | ForEach-Object {",
  '[pscustomobject]@{ProcessId=$_.ProcessId;Name=$_.Name;CommandLine=$_.CommandLine;',
  'CreationDate=[string]$_.CreationDate;PrivatePageCount=[double]$_.PrivatePageCount;',
  'WorkingSetSize=[double]$_.WorkingSetSize;Kernel=[double]$_.KernelModeTime;User=[double]$_.UserModeTime;',
  'HandleCount=$_.HandleCount;ThreadCount=$_.ThreadCount} } | ConvertTo-Json -Compress',
].join(' ');

function queryElectron() {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return parseQuery(r.stdout);
}

/** PowerShell's JSON to rows; truncated or garbled output is "no rows this tick", not a crash. */
function parseQuery(text) {
  const out = String(text || '').trim();
  if (!out) return [];
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

function toSample(row, t) {
  return {
    t, pid: row.ProcessId, started: row.CreationDate,
    priv: row.PrivatePageCount, ws: row.WorkingSetSize,
    cpu: (row.Kernel + row.User) / 1e7,
    handles: row.HandleCount, threads: row.ThreadCount,
  };
}

function groupByHost(lines) {
  const by = new Map();
  for (const s of lines) {
    const k = `${s.pid}@${s.started}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s);
  }
  return by;
}

function report(lines) {
  for (const [k, samples] of groupByHost(lines)) {
    const r = summarise(samples);
    const f = (n, d = 0) => (typeof n === 'number' ? n.toFixed(d) : 'n/a');
    console.log(`host ${k}: ${r.verdict.toUpperCase()}  ${f(r.startMB)} -> ${f(r.endMB)} MB `
      + `(min ${f(r.minMB)}, max ${f(r.maxMB)}), floor slope ${f(r.floorSlopeMBPerHour, 1)} MB/h, `
      + `CPU ${f(r.cpuPerHour, 0)} s/h, ${r.handlesEnd} handles, ${r.threadsEnd} threads, `
      + `${f(r.minutes, 1)} min, ${r.samples} samples`);
  }
}

/** JSON-lines samples; a half-written last line from an interrupted run (or any garbled line) is skipped. */
function parseSampleLines(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn or garbled: not a sample */ }
  }
  return rows;
}

const MIN_INTERVAL_S = 1;   // below this the PowerShell query respawns back to back (see the cost note above)
const USAGE = 'usage: probe-host-footprint.js [--pid N]... [--minutes M>0] [--interval S>=1] [--out file [--force]]'
  + ' | --summarise file';
const stamp = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, '0')).join('')
  + '-' + [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');

/**
 * The command line, validated once. Returns { error } for a bad value instead of letting it reach the loop:
 * `Number('abc')` is NaN, which made the run's end NaN and the loop never break (Miguel M1, PR #131). The
 * default --out is per run, so a new run never truncates an old one's samples (Miguel M7).
 */
function parseArgs(argv, now = new Date()) {
  const value = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? null : v;
  };
  const positive = (name, dflt, min) => {
    const v = value(name);
    if (v === undefined) return dflt;
    const n = Number(v);
    return v !== null && Number.isFinite(n) && n >= min && n > 0 ? n : { error: `--${name} needs a number ${min ? '>= ' + min : '> 0'}, got ${v === null ? 'nothing' : JSON.stringify(v)}` };
  };
  const sumFile = value('summarise');
  if (sumFile === null) return { error: '--summarise needs a file' };
  if (sumFile !== undefined) return { summarise: sumFile };
  const minutes = positive('minutes', 60, 0);
  if (minutes.error) return minutes;
  const intervalS = positive('interval', 30, MIN_INTERVAL_S);
  if (intervalS.error) return intervalS;
  const pids = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--pid') continue;
    const n = Number(argv[i + 1]);
    if (!Number.isInteger(n) || n <= 0) return { error: `--pid needs a process id, got ${JSON.stringify(argv[i + 1] || 'nothing')}` };
    pids.push(n);
  }
  const out = value('out');
  if (out === null) return { error: '--out needs a file' };
  return {
    minutes, intervalS, pids, force: argv.includes('--force'),
    explicitOut: out !== undefined,
    out: out !== undefined ? out : path.join(__dirname, '..', '.harness', `host-footprint-${stamp(now)}.jsonl`),
  };
}

/** An explicit --out that already holds samples is not truncated unless --force says so. */
function overwriteRefusal(opts, sizeOf) {
  if (!opts.explicitOut || opts.force) return null;
  const size = sizeOf(opts.out);
  return typeof size === 'number' && size > 0
    ? `${opts.out} already holds ${size} bytes of samples; pass --force to overwrite it, or choose another --out`
    : null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) { console.error(`${opts.error}\n${USAGE}`); return 2; }
  if (opts.summarise) {
    report(parseSampleLines(fs.readFileSync(opts.summarise, 'utf8')));
    return 0;
  }
  const { minutes, intervalS, out } = opts;
  const only = opts.pids;
  const refusal = overwriteRefusal(opts, (f) => { try { return fs.statSync(f).size; } catch { return null; } });
  if (refusal) { console.error(refusal); return 2; }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, '');
  const lines = [];
  const end = Date.now() + minutes * 60000;
  let seen = 0;
  for (;;) {
    const now = Date.now();
    let hosts = parseHosts(queryElectron());
    if (only.length) hosts = hosts.filter((h) => only.includes(h.ProcessId));
    for (const h of hosts) {
      const s = toSample(h, now);
      lines.push(s); fs.appendFileSync(out, JSON.stringify(s) + '\n'); seen++;
    }
    if (Date.now() + intervalS * 1000 > end) break;
    await new Promise((r) => setTimeout(r, intervalS * 1000));
  }
  report(lines);
  console.log('samples ->', out);
  return seen > 0 ? 0 : 1;
}

if (require.main === module) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}

module.exports = { summarise, parseHosts, floorSlope, parseQuery, parseArgs, parseSampleLines, overwriteRefusal };
