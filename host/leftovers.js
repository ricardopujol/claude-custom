'use strict';
/**
 * Leftovers (BACKLOG #74 item 6): what the Resources panel lists at the top when something is left behind, which of
 * those rows the app can PROVE it started, and the 15-minute auto-reap of the proven ones. Pure except createReaper's
 * injected kill; no OS, no clock of its own.
 *
 * FOUR KINDS, each with what can be said about it:
 *   stuck      Electron processes with 1 thread and 0 handles: an exit that cannot finish. Shown only; a terminating
 *              process ignores TerminateProcess, and they are not ours to kill (#74 A).
 *   probes     ledger 'probe-window' roots (host/pid-ledger.js) still running whose launcher is gone.
 *   shells     ledger 'agent-shell' roots, the same rule; PLUS any shell that has run under one of this app's claude
 *              sessions for an hour or more. The second sort is SHOWN ONLY: nothing records that the agent which
 *              started it has finished (no SubagentStop carries a task or pid), and a long background task of a live
 *              agent looks the same. A shell the app cannot prove is finished is never stopped.
 *   mcp        a session's MCP servers (the topmost process whose command line names an MCP server), with the memory
 *              of its whole subtree. Shown only: a live session uses them.
 *
 * THE PROOF (host/pid-ledger.js's rule, host/background-hosts.js's before it): a pid alone proves nothing on Windows,
 * it is reused. A ledger row is ours only if the table's start time for that pid is the one written at launch
 * (compared within a tick: CIM and Get-Process differ by one, host/resource-tree.js sameStart), and it is a leftover
 * only if its launcher is gone. Doubt keeps: an unreadable start, a missing launcher record and a launcher whose start
 * could not be read all count as alive. The kill proves the start AGAIN on a held handle (host/kill-tree.js killProven)
 * with the LEDGER's start, so the sample's age never matters to safety.
 */

const tree = require('./resource-tree');
const { displayName } = require('./resource-label');

const REAP_AFTER_MS = 15 * 60_000;
const SHELL_SHOWN_AFTER_MS = 60 * 60_000;
const STOPPED_KEEP_MS = 60 * 60_000;
const STOPPED_KEEP_MAX = 10;
const RETRY_AFTER_MS = 5 * 60_000;
const SHELL_IMAGES = new Set(['bash.exe', 'sh.exe']);
const MCP_CMD = /(?:^|[\s"'\\/@_-])mcp(?:$|[\s"'\\/._-])|modelcontextprotocol/i;

// The package or module an MCP server runs ("chrome-devtools-mcp", "reaper_mcp"); what the row reads when no name has "mcp" in it.
const mcpName = (cmd, name) => {
  const m = /([A-Za-z0-9@_-]*mcp[A-Za-z0-9_-]*)/i.exec(isStr(cmd) ? cmd : '');
  return m ? m[1] : displayName(cmd, name);
};

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isStr = v => typeof v === 'string';
const lower = s => (isStr(s) ? s.toLowerCase() : '');

// A FILETIME string (100 ns since 1601) as wall-clock ms; null when it is not one.
function ftToMs(ft) {
  if (!isStr(ft) || !/^\d+$/.test(ft)) return null;
  return Number((BigInt(ft) - 116444736000000000n) / 10000n);
}
const ageFromStart = (start, now) => { const ms = ftToMs(start); return ms === null ? null : Math.max(0, now - ms); };

function subtreeBytes(procs, pid, mem) {
  let total = 0;
  let any = false;
  for (const p of tree.descendants(procs, pid)) {
    const v = mem.get(p.pid);
    if (isNum(v)) { total += v; any = true; }
  }
  return any ? total : null;
}

// Doubt keeps. true: alive or unknown; false: provably gone (absent, or another process holds its pid).
function launcherAlive(entry, byPid) {
  const l = entry.launcher;
  if (!l) return true;
  const p = byPid.get(l.pid);
  if (!p) return false;
  if (l.start === null || p.start === null) return true;
  return tree.sameStart(p.start, l.start);
}

const byBytes = (a, b) => ((b.bytes || 0) - (a.bytes || 0)) || (a.pid - b.pid);

/**
 * find({ procs, mem: Map<pid, bytes>, ledger: [entry], attribution: tree.attribute(...), ownPid, now }) ->
 *   { stuck, probes, shells, mcp }, each [row]
 * row: { kind, pid, start, name, label, bytes (null: not measured), ageMs (null: unknown), reapable, entry?, session? }
 * `reapable` means PROVEN ours and its launcher gone; whether it is old enough is reapSet's question.
 */
function find({ procs, mem = new Map(), ledger = [], attribution = null, ownPid, now = Date.now(), shellShownAfterMs = SHELL_SHOWN_AFTER_MS }) {
  const table = Array.isArray(procs) ? procs : [];
  const byPid = new Map(table.map(p => [p.pid, p]));
  const out = { stuck: [], probes: [], shells: [], mcp: [] };
  const taken = new Set();

  // The ledger rows: proven by start time, launcher gone, and never this app or anything it runs inside.
  for (const e of Array.isArray(ledger) ? ledger : []) {
    const p = byPid.get(e.pid);
    if (!p || taken.has(p.pid) || !tree.sameStart(p.start, e.start)) continue;
    if (launcherAlive(e, byPid)) continue;
    if (e.pid === ownPid || tree.descendants(table, e.pid).some(d => d.pid === ownPid)) continue;
    taken.add(p.pid);
    const row = {
      kind: e.kind, pid: p.pid, start: e.start, name: p.name, what: e.label || displayName(p.cmd, p.name), label: e.label || '', bytes: subtreeBytes(table, p.pid, mem),
      ageMs: isNum(e.createdAt) ? Math.max(0, now - e.createdAt) : ageFromStart(p.start, now), reapable: true, entry: e,
    };
    (e.kind === 'agent-shell' ? out.shells : out.probes).push(row);
  }

  for (const p of table) {
    if (taken.has(p.pid)) continue;
    if (lower(p.name) === 'electron.exe' && p.threads === 1 && p.handles === 0) {
      taken.add(p.pid);
      out.stuck.push({ kind: 'stuck', pid: p.pid, start: p.start, name: p.name, what: 'Electron', label: '', bytes: isNum(mem.get(p.pid)) ? mem.get(p.pid) : null, ageMs: ageFromStart(p.start, now), reapable: false });
    }
  }

  const sessionOf = new Map();
  const buckets = attribution && attribution.pidBucket ? attribution.pidBucket : new Map();
  for (const [pid, id] of buckets) if (id.startsWith('session:')) sessionOf.set(pid, id);
  const mcpPids = new Set(table.filter(p => sessionOf.has(p.pid) && MCP_CMD.test(isStr(p.cmd) ? p.cmd : '')).map(p => p.pid));
  const shellPids = new Set(table.filter(p => sessionOf.has(p.pid) && SHELL_IMAGES.has(lower(p.name))).map(p => p.pid));
  // Topmost only: a shell inside a shell, or the watchdog an MCP server started, is part of its parent's row.
  for (const p of table) {
    if (taken.has(p.pid)) continue;
    const inSession = sessionOf.get(p.pid);
    if (mcpPids.has(p.pid) && !mcpPids.has(p.ppid)) {
      taken.add(p.pid);
      out.mcp.push({ kind: 'mcp', pid: p.pid, start: p.start, name: p.name, what: mcpName(p.cmd, p.name), label: '', bytes: subtreeBytes(table, p.pid, mem), ageMs: ageFromStart(p.start, now), reapable: false, session: inSession });
    } else if (shellPids.has(p.pid) && !shellPids.has(p.ppid)) {
      const age = ageFromStart(p.start, now);
      if (age === null || age < shellShownAfterMs) continue;
      taken.add(p.pid);
      out.shells.push({ kind: 'shell', pid: p.pid, start: p.start, name: p.name, what: p.name, label: '', bytes: subtreeBytes(table, p.pid, mem), ageMs: age, reapable: false, session: inSession });
    }
  }
  for (const k of Object.keys(out)) out[k].sort(byBytes);
  return out;
}

/** The rows the auto-reap may stop: proven (`reapable`) and created at least minAgeMs ago by the ledger's own clock. An undated entry never qualifies. */
function reapSet(found, { now = Date.now(), minAgeMs = REAP_AFTER_MS } = {}) {
  const rows = [...(found.probes || []), ...(found.shells || [])];
  return rows.filter(r => r.reapable === true && r.entry && isNum(r.entry.createdAt) && now - r.entry.createdAt >= minAgeMs);
}

/**
 * What travels to the page: the rows without their ledger entry (it holds the launcher's pid and start), each proven row
 * with the ms left before the auto-reap stops it (0: on the next sample), and what was stopped. null when there is
 * nothing to show, so the section is not drawn.
 */
function present(found, stopped, { now = Date.now() } = {}) {
  const strip = (r) => {
    const { entry, ...rest } = r;
    const left = r.reapable === true && entry && isNum(entry.createdAt) ? Math.max(0, REAP_AFTER_MS - (now - entry.createdAt)) : null;
    return { ...rest, reapInMs: left };
  };
  const out = { stuck: found.stuck.map(strip), probes: found.probes.map(strip), shells: found.shells.map(strip), mcp: found.mcp.map(strip), stopped: (stopped || []).map(s => ({ ...s })), reapAfterMs: REAP_AFTER_MS };
  const any = out.stuck.length + out.probes.length + out.shells.length + out.mcp.length + out.stopped.length;
  return any ? out : null;
}

/**
 * The auto-reap's memory and its one action. `kill(pid, start) -> 'killed' | 'gone' | 'mismatch' | 'failed' | 'unknown'`
 * (host/kill-tree.js killProven, possibly async) is the only thing that ends a process; `removeEntries(entries)` writes
 * the ledger tombstones. A process that is 'gone' or whose pid 'mismatch'es can never be reaped again, so its entry is
 * tombstoned; 'failed' and 'unknown' are kept and tried again only after retryAfterMs. One run at a time.
 */
function createReaper({ kill, removeEntries = () => ({ ok: true }), now = Date.now, log = () => {}, retryAfterMs = RETRY_AFTER_MS }) {
  const done = [];
  const tried = new Map();      // `${pid}:${start}` -> when it was last attempted
  let running = false;
  const key = r => `${r.pid}:${r.start}`;
  const trim = () => {
    const t = now();
    for (let i = done.length - 1; i >= 0; i--) if (t - done[i].at >= STOPPED_KEEP_MS) done.splice(i, 1);
    while (done.length > STOPPED_KEEP_MAX) done.shift();
  };
  return {
    async run(found) {
      if (running) return [];
      running = true;
      const stopped = [];
      try {
        const finished = [];
        for (const r of reapSet(found, { now: now() })) {
          const last = tried.get(key(r));
          if (last !== undefined && now() - last < retryAfterMs) continue;
          tried.set(key(r), now());
          let status;
          try { status = await kill(r.pid, r.start); } catch (err) { log('[leftovers] kill threw for', r.pid, ':', (err && err.message) || err); continue; }
          if (status === 'killed' || status === 'gone' || status === 'mismatch') finished.push(r);
          if (status === 'killed') {
            const s = { kind: r.kind, pid: r.pid, name: r.name, what: r.what, label: r.label, bytes: r.bytes, at: now(), status };
            stopped.push(s);
            done.push(s);
          }
          if (status === 'killed' || status === 'gone' || status === 'mismatch') tried.set(key(r), Infinity);
        }
        if (finished.length) {
          const res = removeEntries(finished.map(r => r.entry));
          if (res && res.ok === false) log('[leftovers] ledger tombstones not written:', res.error);
        }
      } finally { running = false; }
      trim();
      return stopped;
    },
    stopped() { trim(); return done.map(s => ({ ...s })); },
  };
}

module.exports = { find, reapSet, present, createReaper, ftToMs, REAP_AFTER_MS, SHELL_SHOWN_AFTER_MS };
