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
   Samples stream to --out (default .harness/host-footprint.jsonl) as JSON lines, one per host per tick, so a
   run that is interrupted still leaves its data. Exit code is 0 unless no host was ever found.

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
  else if (floorSlopeMBPerHour > LEAK_FLOOR_MB_PER_HOUR && floorRiseMB > LEAK_FLOOR_RISE_MB) verdict = 'leak';
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

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}

async function main() {
  const sumFile = arg('summarise', null);
  if (sumFile) {
    report(fs.readFileSync(sumFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    return 0;
  }
  const minutes = Number(arg('minutes', 60));
  const intervalS = Number(arg('interval', 30));
  const only = process.argv.reduce((a, v, i, all) => (v === '--pid' ? a.concat(Number(all[i + 1])) : a), []);
  const out = arg('out', path.join(__dirname, '..', '.harness', 'host-footprint.jsonl'));
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

module.exports = { summarise, parseHosts, floorSlope, parseQuery };
