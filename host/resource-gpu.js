'use strict';
/**
 * The GPU half of the resource sample (BACKLOG #82): the GPU counters parsed, and busy % / memory worked out from them. No OS,
 * no clock, no Electron. host/resource-sampler.js reads three WMI raw classes in the same PowerShell call as everything else
 * (no new poller): GPU Engine (UtilizationPercentage), GPU Process Memory and GPU Adapter Memory, plus the adapters' memory
 * size from the registry (Windows has no counter for the total).
 *
 * THE RULE THIS FILE EXISTS FOR (CLAUDE.md, the `Number(null)` trap): a figure that was not measured is `null`, never 0. A
 * counter class that could not be read, a first sample, an engine instance that is new, a counter that went backwards, a pid
 * that was reused between samples: each is `null`. The view shows "—" for it.
 *
 * The document (`gpu` in the sample's JSON; counters travel as strings, they are 100 ns ticks):
 *   { eng: [{ n, u, t }],   n = "pid_<pid>_luid_0x..._0x..._phys_0_eng_<n>_engtype_<type>", u = busy time, t = Timestamp_Sys100NS
 *     pm:  [{ n, d }],      n = "pid_<pid>_luid_..._phys_0", d = LocalUsage in bytes (one row per pid and adapter). LocalUsage, not
 *                           DedicatedUsage: Task Manager's per-process "Dedicated GPU memory" is Local (dwm.exe read 5.7 GB Dedicated against
 *                           0.5 GB Local, on an adapter with 4.5 GB in use in all); the two agree for a process that has no virtual reservation
 *     am:  [{ n, d }],      n = "luid_..._phys_0", d = DedicatedUsage in bytes
 *     total: "<bytes>" | null }   the sum of the display adapters' dedicated memory
 */

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const digits = v => (typeof v === 'string' && /^\d+$/.test(v)) || (Number.isSafeInteger(v) && v >= 0);
const isNum = v => typeof v === 'number' && Number.isFinite(v);

const LUID = '0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+';
const ENGINE_NAME = new RegExp(`^pid_(\\d+)_luid_(${LUID})_phys_\\d+_eng_\\d+_engtype_(.+)$`);
const PROC_MEM_NAME = new RegExp(`^pid_(\\d+)_luid_${LUID}_phys_\\d+$`);
const ADAPTER_NAME = new RegExp(`^luid_${LUID}_phys_\\d+$`);

const rowsOf = (v, key) => (Array.isArray(v) ? v.filter(r => isObject(r) && typeof r.n === 'string' && digits(r[key])) : []);

/** The GPU part of a parsed sample, or null when the counters could not be read at all (nothing is then "0"). */
function parseGpu(doc) {
  if (!isObject(doc)) return null;
  // an engine instance: the pid it belongs to, the (adapter, engine type) it adds up under, and its two counters
  const engines = new Map();
  for (const r of rowsOf(doc.eng, 'u')) {
    const m = ENGINE_NAME.exec(r.n);
    if (!m || !digits(r.t)) continue;
    engines.set(r.n, { pid: Number(m[1]), group: `${m[2]}|${m[3]}`, u: BigInt(r.u), ts: BigInt(r.t) });
  }
  if (engines.size === 0) return null;

  // dedicated memory per pid, summed over the adapters it has memory on; null when the class gave no rows
  let procMem = null;
  for (const r of rowsOf(doc.pm, 'd')) {
    const m = PROC_MEM_NAME.exec(r.n);
    if (!m) continue;
    if (!procMem) procMem = new Map();
    procMem.set(Number(m[1]), (procMem.get(Number(m[1])) || 0) + Number(r.d));
  }

  let used = null;
  for (const r of rowsOf(doc.am, 'd')) {
    if (ADAPTER_NAME.test(r.n)) used = (used || 0) + Number(r.d);
  }
  const total = digits(doc.total) && Number(doc.total) > 0 ? Number(doc.total) : null;
  // a total smaller than what is in use is a stale or wrong registry entry: unknown, not a clipped figure
  const mem = used === null ? null : { usedBytes: used, totalBytes: total !== null && used <= total ? total : null };
  return { engines, procMem, mem };
}

const startMap = s => (s && Array.isArray(s.procs) && s.procs.length ? new Map(s.procs.map(p => [p.pid, p.start])) : null);

/**
 * Busy % per pid and overall, from two samples. An engine instance's busy % is its busy-time delta over the wall delta. A pid's
 * figure is the busiest engine type's sum over its instances (what Task Manager shows), the overall figure the busiest
 * (adapter, engine type) over every pid's instances. `byPid` has `null` for a pid with an instance that has no usable delta;
 * `busy` is `null` when no instance has one.
 */
function gpuBusy(prev, next) {
  const byPid = new Map();
  const a = prev && prev.gpu;
  const b = next && next.gpu;
  if (!a || !b) return { busy: null, byPid };
  const starts = [startMap(prev), startMap(next)];
  const reused = pid => !!starts[0] && !!starts[1] && starts[0].has(pid) && starts[1].has(pid)
    && starts[0].get(pid) !== null && starts[1].get(pid) !== null && starts[0].get(pid) !== starts[1].get(pid);
  const overall = new Map();          // group -> summed %
  const perPid = new Map();           // pid -> { groups: Map(group -> %), bad }
  for (const [name, n] of b.engines) {
    const p = a.engines.get(name);
    const rec = perPid.get(n.pid) || { groups: new Map(), bad: false };
    perPid.set(n.pid, rec);
    const dWall = p ? n.ts - p.ts : 0n;
    const dBusy = p ? n.u - p.u : -1n;
    if (!p || dWall <= 0n || dBusy < 0n || reused(n.pid)) { rec.bad = true; continue; }
    const pct = Math.min(100, (Number(dBusy) / Number(dWall)) * 100);
    rec.groups.set(n.group, (rec.groups.get(n.group) || 0) + pct);
    overall.set(n.group, (overall.get(n.group) || 0) + pct);
  }
  for (const [pid, rec] of perPid) {
    byPid.set(pid, rec.bad || rec.groups.size === 0 ? null : Math.min(100, Math.max(...rec.groups.values())));
  }
  return { busy: overall.size === 0 ? null : Math.min(100, Math.max(...overall.values())), byPid };
}

const PROCS_SHOWN = 10;

/**
 * The processes holding GPU memory, biggest first: `{ rows: [{ pid, name, bytes, busy }], more }`. `name` is the image name
 * from the sample's process table (`PID n` when the table has none, as in the machine-only sample). A process holding nothing
 * is not listed. `busy` is null when it could not be measured.
 */
function gpuProcs(next, byPid) {
  const g = next && next.gpu;
  if (!g || !g.procMem) return { rows: [], more: 0 };
  const names = new Map((next.procs || []).map(p => [p.pid, p.name]));
  const all = [...g.procMem].filter(([, bytes]) => bytes > 0)
    .map(([pid, bytes]) => ({ pid, name: names.get(pid) || `PID ${pid}`, bytes, busy: byPid.has(pid) ? byPid.get(pid) : null }))
    .sort((x, y) => y.bytes - x.bytes || x.pid - y.pid);
  return { rows: all.slice(0, PROCS_SHOWN), more: Math.max(0, all.length - PROCS_SHOWN) };
}

/**
 * Everything the machine and the Resources tab show about the GPU, from the sample and the one before it:
 * `{ busy, mem: { usedBytes, totalBytes | null } | null, procs: { rows, more } }`. Always an object; unknown parts are null.
 */
function buildGpu(prev, next) {
  const { busy, byPid } = gpuBusy(prev, next);
  const g = next && next.gpu;
  return {
    busy: isNum(busy) ? busy : null,
    mem: g && g.mem ? { usedBytes: g.mem.usedBytes, totalBytes: g.mem.totalBytes } : null,
    procs: gpuProcs(next, byPid),
  };
}

module.exports = { parseGpu, gpuBusy, gpuProcs, buildGpu, PROCS_SHOWN };
