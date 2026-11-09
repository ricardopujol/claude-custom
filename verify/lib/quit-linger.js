'use strict';
/**
 * The pure parts of verify/probe-quit-linger.js (BACKLOG #74 A), here so each rule the measurement rests on is pinned by
 * test/probe-quit-linger.test.js (PR #242 review: Dexter 1-8, Miguel B1, F1-F6).
 *
 * IDENTITY. A pid alone is not a process: Windows reuses pids within seconds (verify/lib/proc-census.js, measured 2026-10-07). Every
 * row the sampler reports carries the process's start (FILETIME) and name; a tracked process is "still listed" only while a row for
 * its pid has ITS start (compared per microsecond, the precision CIM keeps). A row whose start can't be read counts as ours only when
 * its name matches.
 *
 * ABSENCE IS NOT ZERO (CLAUDE.md). A blank or malformed field parses as null, never 0: a cpu reading that timed out is "not read",
 * a process with no readable threads has no priority range.
 */
const path = require('path');
const { sameStart } = require('./proc-census');

// The type of one row, from its command line (readable only while the process runs normally).
function classify(cmd, isRoot) {
  if (!cmd) return 'unreadable';
  const m = /--type=([^\s"]+)/.exec(cmd);
  if (m) return m[1];
  if (isRoot) return 'browser';
  if (/host[\\/]host\.js/i.test(cmd)) return 'host';
  if (/bounded-watchdog\.js/i.test(cmd)) return 'host-watchdog';
  const s = /([\w.-]+\.js)/.exec(cmd);
  return s ? `node:${s[1]}` : 'node';
}

// A decimal field, strictly: '' / 'abc' / undefined are null (Number('') is 0, the trap).
function num(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

/**
 * One sampler line: `T|<ms>|<pid>,<threads>,<handles>,<privMB>,<basePri>,<ready>,<running>,<minPri>,<maxPri>,<startFT>,<name>|...`
 * with an optional `|cpu,<percent>` field. Returns { t, rows: Map<pid, row>, cpu } or null for a line that isn't a sample.
 */
function parseSampleLine(line) {
  if (typeof line !== 'string') return null;
  const parts = line.trim().split('|');
  if (parts[0] !== 'T') return null;
  const t = num(parts[1]);
  if (t === null) return null;
  const rows = new Map();
  let cpu = null;
  for (const p of parts.slice(2)) {
    if (p.startsWith('cpu,')) { cpu = num(p.slice(4)); continue; }
    const f = p.split(',');
    const pid = num(f[0]);
    if (pid === null) continue;
    rows.set(pid, {
      thr: num(f[1]), hnd: num(f[2]), privMB: num(f[3]), base: num(f[4]), ready: num(f[5]), running: num(f[6]),
      minPri: num(f[7]), maxPri: num(f[8]), start: /^\d+$/.test(String(f[9] || '').trim()) ? String(f[9]).trim() : null,
      name: typeof f[10] === 'string' && f[10].trim() !== '' ? f[10].trim() : null,
    });
  }
  return { t, rows, cpu };
}

const baseName = (n) => String(n || '').toLowerCase().replace(/\.exe$/, '');

/** Is this sampled row the tracked process (pid + start), and not a stranger that took its pid? */
function rowIsTracked(row, tracked) {
  if (!row) return false;
  if (row.start !== null && row.start !== undefined) return sameStart(row.start, tracked.start);
  // The start couldn't be read (a process already exiting may refuse the query): the name is the remaining check.
  return !!row.name && !!tracked.name && baseName(row.name) === baseName(tracked.name);
}

const zombieShaped = (r) => r.thr !== null && r.hnd !== null && r.thr <= 1 && r.hnd === 0;
const show = (v) => (v === null || v === undefined ? '?' : v);

/**
 * Per tracked process ({ pid, start, name, type, privMB }): goneAfterS (seconds after the close at the first sample whose row isn't
 * this process; null = still listed at the last sample), zombieS (the LONGEST stretch of 1 thread / 0 handles: from its first such
 * sample to its last, or to the gone time when it ended by leaving), zombieSeen (any such sample at all), and the path (each change
 * of threads/handles/base priority/ready threads/lowest priority). Samples before t0 are ignored.
 */
function summarise(tracked, samples, t0) {
  return tracked.map((p) => {
    let goneAt = null;
    let from = null;
    let lastZ = null;
    let zombieS = 0;
    let zombieSeen = false;
    const steps = [];
    let last = null;
    const closeRun = (end) => { if (from !== null) zombieS = Math.max(zombieS, (end - from) / 1000); from = null; };
    for (const s of samples) {
      if (s.t < t0) continue;
      const r = s.rows.get(p.pid);
      if (!rowIsTracked(r, p)) { goneAt = (s.t - t0) / 1000; closeRun(s.t); break; }
      const key = `${r.thr}/${r.hnd}/${r.base}/${r.ready}/${r.minPri}`;
      if (key !== last) {
        steps.push(`${((s.t - t0) / 1000).toFixed(2)}s:${show(r.thr)}t/${show(r.hnd)}h/${show(r.privMB)}MB/b${show(r.base)}/r${show(r.ready)}/run${show(r.running)}/p${show(r.minPri)}-${show(r.maxPri)}`);
        last = key;
      }
      if (zombieShaped(r)) { zombieSeen = true; if (from === null) from = s.t; lastZ = s.t; } else closeRun(lastZ === null ? s.t : lastZ);
    }
    if (from !== null) closeRun(lastZ);
    return { pid: p.pid, type: p.type, privMBBefore: p.privMB, goneAfterS: goneAt, zombieS, zombieSeen, path: steps };
  });
}

/**
 * Where the watch stands after the samples so far: 'gone' (a sample at or after t0 in which no tracked process is listed as itself),
 * 'watched' (a sample at least watchMs after t0 has been taken: the still-listed ones were listed then), or null (keep sampling).
 */
function watchState(samples, t0, watchMs, tracked) {
  const after = samples.filter(s => s.t >= t0);
  if (!after.length) return null;
  const lastS = after[after.length - 1];
  if (!tracked.some(p => rowIsTracked(lastS.rows.get(p.pid), p))) return 'gone';
  if (lastS.t - t0 >= watchMs) return 'watched';
  return null;
}

/**
 * Order statistics over censored times: null = still there at the end of the watch, ordered above every number (it is larger than
 * all of them). median = the lower median of all n (Infinity = "> watch"), max likewise, still = how many were censored.
 */
function censoredStats(values) {
  const n = values.length;
  if (!n) return { n: 0, median: null, max: null, still: 0 };
  const sorted = values.map(v => (v === null ? Infinity : v)).sort((a, b) => a - b);
  return { n, median: sorted[Math.floor((n - 1) / 2)], max: sorted[n - 1], still: values.filter(v => v === null).length };
}
const fmtS = (v, watchS) => (v === null || v === undefined ? '-' : v === Infinity ? `>${watchS}` : v.toFixed(2));

/** The app's quit log (app/quit-log.js: `<ms> <step>` lines) as "<s after t0> <step>", in order. */
function readTimeline(text, t0) {
  if (typeof text !== 'string' || typeof t0 !== 'number') return [];
  return text.split(/\r?\n/).map(l => /^(\d+) (.*)$/.exec(l)).filter(Boolean)
    .map(m => `${((Number(m[1]) - t0) / 1000).toFixed(2)}s ${m[2]}`);
}

/** FILETIME (100 ns ticks since 1601, as a BigInt) of a JavaScript ms time; null for a non-number. */
function filetimeOfMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return (BigInt(Math.trunc(ms)) + 11644473600000n) * 10000n;
}

const inside = (p, dir) => typeof p === 'string' && p !== '' && (path.resolve(p).toLowerCase() + path.sep).startsWith(path.resolve(dir).toLowerCase() + path.sep);

/**
 * The hosts this launch may end (PR #242 Dexter 1 / Miguel F3). A process-table row is adopted only when ALL hold:
 *   - it runs THIS worktree's host (`hostScript`, case-insensitive), as electron.exe;
 *   - its parent pid is the launch's root and it started at or after the root (the census tree rule);
 *   - the root is still running (its handle is held, so its pid can't be anyone else's), OR the row started BEFORE the root's exit
 *     (`rootExitMs`): a process that took the root's freed pid only exists after that exit, so neither can its children;
 *   - a host identity file names that pid with THIS probe's mark (`mark`, host/probe-mark.js) and a cwd inside `insideDir`.
 * Returns [{ pid, start }], the start being the row's (recorded now, while the row says it is ours; the kill proves it again).
 */
function adoptableHosts({ rows, ids, rootPid, rootStart, rootAlive, rootExitMs, hostScript, mark, insideDir }) {
  if (!Array.isArray(rows) || !mark || typeof rootStart !== 'string' || !/^\d+$/.test(rootStart) || !hostScript) return [];
  const exitFt = rootAlive ? null : filetimeOfMs(rootExitMs);
  if (!rootAlive && exitFt === null) return [];
  const script = path.resolve(hostScript).toLowerCase();
  const out = [];
  for (const r of rows) {
    if (!r || String(r.name || '').toLowerCase() !== 'electron.exe') continue;
    if (!String(r.cmd || '').toLowerCase().includes(script)) continue;
    if (r.ppid !== rootPid || typeof r.start !== 'string' || !/^\d+$/.test(r.start)) continue;
    if (BigInt(r.start) < BigInt(rootStart)) continue;
    if (!rootAlive && BigInt(r.start) >= exitFt) continue;
    const marked = (ids || []).some(id => id && id.pid === r.pid && id.probeMark === mark && inside(id.cwd, insideDir));
    if (marked) out.push({ pid: r.pid, start: r.start });
  }
  return out;
}

/**
 * A live host on this checkout that is NOT this run's (cwd outside `ownDir`): the probe moves the checkout's
 * .harness/state/layout-*.json, so it refuses to run beside one (Miguel B1; verify/probe-dock-autohide.js's rule).
 * `isLive(id)` is verify/lib/live-host.js isLiveHost (pid AND start time).
 */
async function findForeignHost(ids, ownDir, isLive) {
  for (const id of ids || []) {
    if (!id || !Number.isInteger(id.pid)) continue;
    if (inside(id.cwd, ownDir)) continue;
    if (await isLive(id)) return id;
  }
  return null;
}

/**
 * Did the close start a quit? reply: the driver's win-close answer. answeringAfter: whether the app's JavaScript still answered a
 * `state` command a few seconds after the close (a window hidden to the tray, or a quit held, still answers; a quitting app doesn't).
 */
function closeVerdict(reply, answeringAfter) {
  if (!reply || reply.ok !== true) return { ok: false, why: `the close wasn't done (${reply && reply.error ? reply.error : 'no answer'})` };
  if (answeringAfter) return { ok: false, why: "the app still answered after the close: it didn't quit (hidden to the tray, or the quit was held)" };
  return { ok: true, why: '' };
}

module.exports = {
  classify, num, parseSampleLine, rowIsTracked, summarise, watchState, censoredStats, fmtS, readTimeline, filetimeOfMs,
  adoptableHosts, findForeignHost, closeVerdict,
};
