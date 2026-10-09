'use strict';
/**
 * The GPU half of the resource sample (BACKLOG #82): the GPU counters parsed, and busy % / memory worked out from them. No OS,
 * no clock, no Electron. host/resource-sampler.js reads three WMI raw classes in the same PowerShell call as everything else
 * (no new poller): GPU Engine (UtilizationPercentage), GPU Process Memory and GPU Adapter Memory, plus the adapters' memory
 * size from the registry (Windows has no counter for the total), counted only for adapters that are PRESENT.
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
 *     ad:  [{ m, b }],      the display class's driver keys: m = MatchingDeviceId (a prefix of the device's PNP id), b = qwMemorySize
 *     pn:  [ "<PNPDeviceID>" ] } the display devices that are present now (Win32_VideoController)
 * A driver key outlives its card (a removed or moved GPU keeps its key and its size), so the total is the sum over the keys that
 * match a PRESENT device, and unknown when a present device has no sized key (then "used" would cover an adapter "total" does not).
 */

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const digits = v => (typeof v === 'string' && /^\d+$/.test(v)) || (Number.isSafeInteger(v) && v >= 0);
const isNum = v => typeof v === 'number' && Number.isFinite(v);

const LUID = '0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+';
const ENGINE_NAME = new RegExp(`^pid_(\\d+)_luid_(${LUID})_phys_(\\d+)_eng_(\\d+)_engtype_(.+)$`);
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
    // `engine` is the ENGINE NODE (adapter, physical adapter, engine number): each node has its own 100%
    engines.set(r.n, { pid: Number(m[1]), engine: `${m[2]}|${m[3]}|${m[4]}|${m[5]}`, u: BigInt(r.u), ts: BigInt(r.t) });
  }
  if (engines.size === 0) return null;
  // when the previous query ran: the engine rows of one query share a clock, so the latest is it
  let ts = 0n;
  for (const e of engines.values()) if (e.ts > ts) ts = e.ts;

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
  const total = presentTotal(doc.ad, doc.pn);
  // a total smaller than what is in use is a stale or wrong registry entry: unknown, not a clipped figure
  const mem = used === null ? null : { usedBytes: used, totalBytes: total !== null && used <= total ? total : null };
  return { engines, ts, procMem, mem };
}

/**
 * The adapters' dedicated memory in bytes, from the driver keys of the PRESENT devices only, or null: no present device, a present
 * device with no sized key, or a key that matches no present device is ignored (a card that was removed). A key matches a device when
 * its MatchingDeviceId is a prefix of the device's PNP id, case aside.
 */
function presentTotal(ad, pn) {
  const ids = (Array.isArray(pn) ? pn : []).filter(x => typeof x === 'string' && x !== '').map(x => x.toLowerCase());
  const keys = (Array.isArray(ad) ? ad : []).filter(k => isObject(k) && typeof k.m === 'string' && k.m !== '' && digits(k.b) && Number(k.b) > 0)
    .map(k => ({ m: k.m.toLowerCase(), b: Number(k.b) }));
  if (ids.length === 0) return null;
  let total = 0;
  for (const id of ids) {
    const sized = keys.filter(k => id.startsWith(k.m));
    if (sized.length === 0) return null;
    // two keys for one device (a reinstall): the larger, never both
    total += Math.max(...sized.map(k => k.b));
  }
  return total;
}

const startMap = s => (s && Array.isArray(s.procs) && s.procs.length ? new Map(s.procs.map(p => [p.pid, p.start])) : null);

/**
 * Busy % per pid and overall, from two samples. An engine instance's busy % is its busy-time delta over the wall delta. Each ENGINE
 * NODE (`eng_<n>`) has its own 100%: a pid's figure is its busiest node, the overall figure the busiest node, where the pids that
 * share a node add up (they time-slice it). Two nodes are never added (Task Manager shows the busiest engine; the second adapter
 * here has 17 3D nodes). An instance with no counterpart in the previous sample was created after that query, so its whole counter
 * lies inside the interval: that counter is its delta (a job that started since the last sample is busy, not a 0), measured over the
 * time since the previous query. `byPid` is `null` for a pid with no usable delta (a reused pid, a counter that went back, no clock
 * step); `busy` is `null` when no instance has one. A job that ended since the last sample has no instance left, so its last
 * interval reads low: that is lost, not guessed.
 */
function gpuBusy(prev, next) {
  const byPid = new Map();
  const a = prev && prev.gpu;
  const b = next && next.gpu;
  if (!a || !b) return { busy: null, byPid };
  const starts = [startMap(prev), startMap(next)];
  const reused = pid => !!starts[0] && !!starts[1] && starts[0].has(pid) && starts[1].has(pid)
    && starts[0].get(pid) !== null && starts[1].get(pid) !== null && starts[0].get(pid) !== starts[1].get(pid);
  const overall = new Map();          // engine node -> % summed over the pids that use it
  const perPid = new Map();           // pid -> { nodes: [%], bad }
  for (const [name, n] of b.engines) {
    const p = a.engines.get(name);
    const rec = perPid.get(n.pid) || { nodes: [], bad: false };
    perPid.set(n.pid, rec);
    // present before: the two counters' delta. New since: the counter itself over the time since the previous query.
    const dWall = p ? n.ts - p.ts : n.ts - a.ts;
    const dBusy = p ? n.u - p.u : n.u;
    if (dWall <= 0n || dBusy < 0n || reused(n.pid)) { rec.bad = true; continue; }
    const pct = Math.min(100, (Number(dBusy) / Number(dWall)) * 100);
    rec.nodes.push(pct);
    overall.set(n.engine, Math.min(100, (overall.get(n.engine) || 0) + pct));
  }
  for (const [pid, rec] of perPid) {
    byPid.set(pid, rec.bad || rec.nodes.length === 0 ? null : Math.max(...rec.nodes));
  }
  return { busy: overall.size === 0 ? null : Math.max(...overall.values()), byPid };
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
