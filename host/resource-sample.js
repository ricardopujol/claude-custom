'use strict';
/**
 * The pure half of the resource sampler (BACKLOG #63, documentation/DESIGN_RESOURCE_PANEL.md): the one CIM
 * sample parsed, and CPU percentages worked out from two of them. No OS, no clock, no Electron.
 *
 * THE RULE THIS FILE EXISTS FOR (CLAUDE.md, the `Number(null)` trap): a figure that was not measured is `null`,
 * never 0. A first sample, a zero or backwards clock, a counter that went down, a pid that was reused between
 * samples: each is `null`. The view shows "—" or "measuring…" for it, never a confident zero.
 *
 * The sample (host/resource-sampler.js's script) is one JSON document plus an `END` line:
 *   { procs: [{ pid, ppid, name, cmd, start, priv }],      start = FILETIME string, priv = private bytes
 *     perf:  [{ pid, cpu, ts }],                          cpu = processor time, ts = Timestamp_Sys100NS (100 ns)
 *     cpu:   { idle, ts },                                PerfOS_Processor _Total: the IDLE counter, core-averaged
 *     os:    { totalKb, freeKb } }
 * `Timestamp_Sys100NS` is about 1.3e17, past 2^53, so the counters travel as strings and are BigInt here: a plain
 * JSON number would round the delta.
 */

const BOM_AT_START = new RegExp('^' + String.fromCharCode(0xfeff));
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const digits = v => (typeof v === 'string' && /^\d+$/.test(v)) || (Number.isSafeInteger(v) && v >= 0);
const big = v => BigInt(v);
const posInt = v => Number.isInteger(v) && v > 0;

function parseProc(r) {
  if (!isObject(r) || !posInt(r.pid)) return null;
  return {
    pid: r.pid,
    ppid: Number.isInteger(r.ppid) && r.ppid >= 0 ? r.ppid : 0,
    name: typeof r.name === 'string' ? r.name : '',
    cmd: typeof r.cmd === 'string' && r.cmd !== '' ? r.cmd : null,
    // An unknown start (a process of another user, an elevated one) stays null: nothing can be proved about it.
    start: digits(r.start) ? String(r.start) : null,
    priv: typeof r.priv === 'number' && Number.isFinite(r.priv) && r.priv >= 0 ? r.priv : null,
  };
}

/** A sample, or null when it did not run to its end or is not what the script prints. `at` is the caller's clock. */
function parseSample(text, at) {
  if (typeof text !== 'string') return null;
  const body = text.replace(BOM_AT_START, '').trimEnd();
  if (!body.endsWith('END')) return null;
  let doc;
  try { doc = JSON.parse(body.slice(0, -3)); } catch { return null; }
  if (!isObject(doc) || !Array.isArray(doc.procs) || !Array.isArray(doc.perf)) return null;

  const procs = doc.procs.map(parseProc).filter(Boolean);
  const perf = new Map();
  for (const r of doc.perf) {
    if (isObject(r) && Number.isInteger(r.pid) && r.pid >= 0 && digits(r.cpu) && digits(r.ts)) {
      perf.set(r.pid, { cpu: big(r.cpu), ts: big(r.ts) });
    }
  }
  const c = doc.cpu;
  const cpuTotal = isObject(c) && digits(c.idle) && digits(c.ts) ? { idle: big(c.idle), ts: big(c.ts) } : null;
  const o = doc.os;
  const os = isObject(o) && Number.isFinite(o.totalKb) && Number.isFinite(o.freeKb) && o.totalKb > 0 && o.freeKb >= 0
    ? { totalBytes: o.totalKb * 1024, freeBytes: o.freeKb * 1024 } : null;
  return { at, procs, perf, cpuTotal, os };
}

const startOf = (sample, pid) => {
  const p = sample && Array.isArray(sample.procs) ? sample.procs.find(x => x.pid === pid) : null;
  return p ? p.start : null;
};

/**
 * CPU % of the whole machine per pid in `next`: processor-time delta / (wall delta x cores) x 100.
 * `null` for a pid that has no usable delta (see the file header); never 0 for "unknown".
 */
function cpuPercents(prev, next, cores) {
  const out = new Map();
  if (!next || !(next.perf instanceof Map)) return out;
  const usable = prev && prev.perf instanceof Map && typeof cores === 'number' && Number.isFinite(cores) && cores > 0;
  for (const [pid, n] of next.perf) {
    out.set(pid, null);
    if (!usable) continue;
    const p = prev.perf.get(pid);
    if (!p) continue;
    const dWall = n.ts - p.ts;
    const dCpu = n.cpu - p.cpu;
    if (dWall <= 0n || dCpu < 0n) continue;
    // A pid that exists in both samples under two start times is two processes: no delta between them.
    const a = startOf(prev, pid);
    const b = startOf(next, pid);
    if (a !== null && b !== null && a !== b) continue;
    out.set(pid, (Number(dCpu) / (Number(dWall) * cores)) * 100);
  }
  return out;
}

/** Machine CPU %: 100 x (1 - idle delta / wall delta), clamped to 0..100. Null when it can't be told. */
function machineCpu(prev, next) {
  const a = prev && prev.cpuTotal;
  const b = next && next.cpuTotal;
  if (!a || !b) return null;
  const dWall = b.ts - a.ts;
  const dIdle = b.idle - a.idle;
  if (dWall <= 0n || dIdle < 0n) return null;
  const busy = 100 * (1 - Number(dIdle) / Number(dWall));
  return Math.min(100, Math.max(0, busy));
}

/** { usedBytes, totalBytes } (physical: total minus free), or null. */
function machineMemory(sample) {
  const os = sample && sample.os;
  if (!os || !(os.totalBytes > 0) || !(os.freeBytes >= 0) || os.freeBytes > os.totalBytes) return null;
  return { usedBytes: os.totalBytes - os.freeBytes, totalBytes: os.totalBytes };
}

module.exports = { parseSample, cpuPercents, machineCpu, machineMemory };
