'use strict';
/**
 * Leftovers (BACKLOG #74 item 6): what the Resources panel lists at the top when something is left behind, which of
 * those rows the app can PROVE it started, and the 15-minute auto-stop of the proven probe windows. Pure except
 * createReaper's injected seams; no OS, no clock of its own.
 *
 * FOUR KINDS, each with what can be said about it:
 *   stuck      Electron processes with 1 thread and 0 handles, in two samples running: an exit that cannot finish.
 *              Shown only; a terminating process ignores TerminateProcess, so nothing here tries (#74 A). A ledgered
 *              probe window in that state is a stuck row too, never a probe row that "stops in 0 min" for hours.
 *   probes     ledger 'probe-window' roots (host/pid-ledger.js) still running whose launcher is gone. PROVABLE (a
 *              Stop button) and REAPABLE (stopped on its own 15 minutes after the app first saw the launcher gone).
 *   shells     ledger 'agent-shell' roots, provable (a Stop button) but NEVER stopped on their own: a shell can outlive
 *              the host that recorded it and still belong to a live session (verify/reap-probes.js, PR #130 Dexter #8,
 *              and PR #132 Dexter F3). PLUS any shell that has run under one of this app's claude sessions for an hour:
 *              shown only, nothing records that the agent which started it has finished.
 *   mcp        a session's MCP server (the topmost process whose command line names one) with the memory of its whole
 *              subtree, listed when it is at least MCP_MIN_BYTES. Shown only. WHY SIZE AND NOT "NEVER CALLED" (the
 *              fallback Ricardo allowed): the calls are in the session's transcript (`mcp__<server>__<tool>` tool_use
 *              lines), which runs to hundreds of MB, nothing maps a process to its transcript, and re-reading
 *              transcripts per sample is exactly the CPU cost PR #131 removed.
 *
 * THE PROOF (host/background-hosts.js's rule): a pid alone proves nothing on Windows, it is reused. A ledger row is ours
 * only if the table's start time for that pid is the one written at launch (compared within a tick: CIM and Get-Process
 * differ by up to 9 ticks, MEASURED 2026-10-08 over 319 processes, so host/resource-tree.js sameStart), and the kill
 * proves it AGAIN, exactly, on a held handle (host/kill-tree.js killProven) with the LEDGER's start.
 *
 * THE LAUNCHER is judged by the one source-independent fact: its pid is not in the table at all. A listed pid reads as
 * ALIVE whatever its start says (PR #132 Dexter F1: the table's start comes from CIM and the ledger's from Get-Process,
 * and a DST fall-back hour could put them 3600 s apart, which "different start = pid reused = gone" would turn into
 * the death of a live launcher). Doubt keeps. The kill's own re-check (createReaper's `launcherGone`) uses Get-Process
 * with exact equality, the ledger's own source.
 *
 * THE 15 MINUTES start when the app first SEES the launcher gone (createTracker), not at the window's creation: a probe
 * made twenty minutes ago whose launcher left a second ago is not stopped on the next sample (PR #132 Miguel S3).
 */

const tree = require('./resource-tree');
const { displayName } = require('./resource-label');

const REAP_AFTER_MS = 15 * 60_000;
const SHELL_SHOWN_AFTER_MS = 60 * 60_000;
const MCP_MIN_BYTES = 100 * 1024 * 1024;
const STUCK_MIN_SAMPLES = 2;
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

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function isStr(v) { return typeof v === 'string'; }
const lower = s => (isStr(s) ? s.toLowerCase() : '');
const keyOf = r => `${r.pid}:${r.start}`;

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

const isStuck = p => lower(p.name) === 'electron.exe' && p.threads === 1 && p.handles === 0;

// Does any ancestor of p (by guarded parent links: a parent never starts after its child) belong to `set`?
function hasAncestorIn(p, set, byPid) {
  const seen = new Set([p.pid]);
  let cur = p;
  for (;;) {
    const parent = byPid.get(cur.ppid);
    if (!parent || seen.has(parent.pid)) return false;
    if (isStr(parent.start) && isStr(cur.start) && BigInt(parent.start) > BigInt(cur.start)) return false;
    if (set.has(parent.pid)) return true;
    seen.add(parent.pid);
    cur = parent;
  }
}

const byBytes = (a, b) => ((b.bytes || 0) - (a.bytes || 0)) || (a.pid - b.pid);

/**
 * find({ procs, mem: Map<pid, bytes>, ledger: [entry], attribution: tree.attribute(...), ownPid, protect: [pid], now }) ->
 *   { stuck, probes, shells, mcp }, each [row]
 * row: { kind, pid, start, name, what, label, bytes (null: not measured), ageMs (null: unknown),
 *        provable (proven ours, launcher gone: a Stop button), reapable (provable AND a probe window: the 15-minute
 *        auto-stop), nested (inside another row's subtree, so its memory is already counted there), entry?, session? }
 * `protect` are pids that must never die with a row: this window's tab hosts (their subtree holding one is refused).
 */
function find({
  procs, mem = new Map(), ledger = [], attribution = null, ownPid, protect = [], now = Date.now(),
  shellShownAfterMs = SHELL_SHOWN_AFTER_MS, mcpMinBytes = MCP_MIN_BYTES,
}) {
  const table = Array.isArray(procs) ? procs : [];
  const byPid = new Map(table.map(p => [p.pid, p]));
  const out = { stuck: [], probes: [], shells: [], mcp: [] };
  const taken = new Set();
  const guarded = new Set([ownPid, ...(Array.isArray(protect) ? protect : [])].filter(Number.isInteger));

  for (const e of Array.isArray(ledger) ? ledger : []) {
    const p = byPid.get(e.pid);
    if (!p || taken.has(p.pid) || !tree.sameStart(p.start, e.start)) continue;
    if (isStuck(p)) continue;                                   // a stuck exit is a stuck row, never a kill target
    if (!e.launcher || byPid.has(e.launcher.pid)) continue;    // no record, or any listed pid: alive (doubt keeps)
    if (tree.descendants(table, e.pid).some(d => guarded.has(d.pid))) continue;
    taken.add(p.pid);
    out[e.kind === 'agent-shell' ? 'shells' : 'probes'].push({
      kind: e.kind, pid: p.pid, start: e.start, name: p.name, what: e.label || displayName(p.cmd, p.name), label: e.label || '',
      bytes: subtreeBytes(table, p.pid, mem),
      ageMs: isNum(e.createdAt) ? Math.max(0, now - e.createdAt) : ageFromStart(p.start, now),
      provable: true, reapable: e.kind !== 'agent-shell', entry: e,
    });
  }

  for (const p of table) {
    if (taken.has(p.pid) || !isStuck(p)) continue;
    taken.add(p.pid);
    out.stuck.push({
      kind: 'stuck', pid: p.pid, start: p.start, name: p.name, what: 'Electron', label: '',
      bytes: isNum(mem.get(p.pid)) ? mem.get(p.pid) : null, ageMs: ageFromStart(p.start, now), provable: false, reapable: false,
    });
  }

  const sessionOf = new Map();
  const buckets = attribution && attribution.pidBucket ? attribution.pidBucket : new Map();
  for (const [pid, id] of buckets) if (id.startsWith('session:')) sessionOf.set(pid, id);
  const mcpPids = new Set(table.filter(p => sessionOf.has(p.pid) && MCP_CMD.test(isStr(p.cmd) ? p.cmd : '')).map(p => p.pid));
  const shellPids = new Set(table.filter(p => sessionOf.has(p.pid) && SHELL_IMAGES.has(lower(p.name))).map(p => p.pid));
  // Topmost only: a shell inside a shell (or inside a make that runs one), or the watchdog an MCP server started, is
  // part of its ancestor's row, however many processes sit between them (PR #132 Dexter F7).
  for (const p of table) {
    if (taken.has(p.pid)) continue;
    if (mcpPids.has(p.pid) && !hasAncestorIn(p, mcpPids, byPid)) {
      const bytes = subtreeBytes(table, p.pid, mem);
      if (!isNum(bytes) || bytes < mcpMinBytes) continue;
      taken.add(p.pid);
      out.mcp.push({ kind: 'mcp', pid: p.pid, start: p.start, name: p.name, what: mcpName(p.cmd, p.name), label: '', bytes, ageMs: ageFromStart(p.start, now), provable: false, reapable: false, session: sessionOf.get(p.pid) });
    } else if (shellPids.has(p.pid) && !hasAncestorIn(p, shellPids, byPid)) {
      const age = ageFromStart(p.start, now);
      if (age === null || age < shellShownAfterMs) continue;
      taken.add(p.pid);
      out.shells.push({ kind: 'shell', pid: p.pid, start: p.start, name: p.name, what: p.name, label: '', bytes: subtreeBytes(table, p.pid, mem), ageMs: age, provable: false, reapable: false, session: sessionOf.get(p.pid) });
    }
  }

  // A row inside another row's subtree: its memory is counted there, so a total must not add it again (PR #132 Dexter F7).
  const rows = Object.values(out).flat();
  const inside = new Map(rows.map(r => [r.pid, new Set(tree.descendants(table, r.pid).map(d => d.pid))]));
  for (const r of rows) r.nested = rows.some(o => o !== r && inside.get(o.pid).has(r.pid));
  for (const k of Object.keys(out)) out[k].sort(byBytes);
  return out;
}

/**
 * The memory of what the rows hold, each process once: the rows that are not inside another row. `complete` is false when
 * any counted row had no figure (the total is then "at least").
 */
function totalBytes(rows) {
  let bytes = 0;
  let measured = false;
  let complete = true;
  for (const r of rows) {
    if (r.nested === true) continue;
    if (isNum(r.bytes)) { bytes += r.bytes; measured = true; } else complete = false;
  }
  return { bytes: measured ? bytes : null, complete };
}

/**
 * What the app remembers between samples (it is the only state `find` has to be given): when it FIRST saw each provable
 * row's launcher gone (`goneSince`, the start of the 15 minutes), and how many samples in a row a stuck Electron has
 * been seen (`advance: false` for a sample taken off the cadence, which must not count as one more; a process mid-exit must not flash in the section for one sample: PR #132 Miguel S2). A row that is not in
 * this sample is forgotten, so a launcher that comes back starts the count again. `stamp` edits and returns `found`.
 */
function createTracker({ now = Date.now } = {}) {
  let gone = new Map();
  let stuck = new Map();
  return {
    stamp(found, { advance = true } = {}) {
      const t = now();
      const nextGone = new Map();
      const nextStuck = new Map();
      for (const r of [...found.probes, ...found.shells]) {
        if (r.provable !== true) continue;
        const k = keyOf(r);
        r.goneSince = gone.has(k) ? gone.get(k) : t;
        nextGone.set(k, r.goneSince);
      }
      found.stuck = found.stuck.filter((r) => {
        const k = keyOf(r);
        const n = (stuck.get(k) || 0) + (advance ? 1 : 0);
        nextStuck.set(k, n);
        return n >= STUCK_MIN_SAMPLES;
      });
      gone = nextGone;
      stuck = nextStuck;
      return found;
    },
  };
}

/**
 * The rows the 15-minute auto-stop may end: PROBE WINDOWS that are provable and whose launcher was first seen gone at
 * least minAgeMs ago. A row with no `goneSince` (never stamped) never qualifies. Agent shells never do.
 */
function reapSet(found, { now = Date.now(), minAgeMs = REAP_AFTER_MS } = {}) {
  return (found.probes || []).filter(r => r.provable === true && r.reapable === true && r.entry
    && isNum(r.goneSince) && now - r.goneSince >= minAgeMs);
}

/**
 * What travels to the page: the rows without their ledger entry (it holds the launcher's pid and start), each auto-stop row
 * with the ms left before it goes (0: on the next sample), and what was stopped. null when there is nothing to show, so the
 * section is not drawn.
 */
function present(found, stopped, { now = Date.now(), taskLogs = [], deleted = [] } = {}) {
  const strip = (r) => {
    const { entry, goneSince, ...rest } = r;
    const left = r.reapable === true && r.provable === true && isNum(goneSince) ? Math.max(0, REAP_AFTER_MS - (now - goneSince)) : null;
    return { ...rest, reapInMs: left };
  };
  const out = { stuck: found.stuck.map(strip), probes: found.probes.map(strip), shells: found.shells.map(strip), mcp: found.mcp.map(strip), stopped: (stopped || []).map(s => ({ ...s })), reapAfterMs: REAP_AFTER_MS,
    // big task-output files (host/task-logs.js): the rows without their paths, and the files deleted lately
    taskLogs: taskLogs.map(({ paths, mtimeMs, dev, ino, ...r }) => r), deleted: deleted.map(d => ({ ...d })) };
  const any = out.stuck.length + out.probes.length + out.shells.length + out.mcp.length + out.stopped.length + out.taskLogs.length + out.deleted.length;
  return any ? out : null;
}

const yieldTurn = () => new Promise(resolve => setImmediate(resolve));

/**
 * The stop's memory and its one action. Seams (all may be async):
 *   kill(pid, start) -> 'killed' | 'gone' | 'mismatch' | 'failed' | 'unknown'   host/kill-tree.js killProvenAsync, the only thing that ends a process
 *   launcherGone(entry) -> true only when the launcher is PROVEN gone right now (Get-Process, exact start); anything else keeps the row
 *   isRunning(pid, start) -> true | false | null   a 'gone' from the kill is believed (and tombstoned) only if this says false
 *   removeEntries(entries)   the ledger tombstones
 * Each kill waits one macrotask first (the main process must keep painting: PR #132 Dexter F2 + Miguel I1), re-proves the
 * launcher, and is never retried inside retryAfterMs. 'gone' and 'mismatch' tombstone the entry (it can never be reaped
 * again); 'failed' and 'unknown' keep it. One run at a time: an automatic run that finds one going does nothing, a manual
 * stop waits its turn.
 */
function createReaper({
  kill, launcherGone = async () => false, isRunning = async () => null, removeEntries = () => ({ ok: true }),
  now = Date.now, log = () => {}, retryAfterMs = RETRY_AFTER_MS,
}) {
  const done = [];
  const tried = new Map();      // `${pid}:${start}` -> when it was last attempted; forgotten once the row is not in the table
  let tail = Promise.resolve();
  let busy = 0;
  const trim = () => {
    const t = now();
    for (let i = done.length - 1; i >= 0; i--) if (t - done[i].at >= STOPPED_KEEP_MS) done.splice(i, 1);
    while (done.length > STOPPED_KEEP_MAX) done.shift();
  };

  // One row: 'killed' | 'gone' | 'mismatch' | 'failed' | 'unknown' | 'kept' (the launcher is not proven gone)
  async function stopOne(r) {
    await yieldTurn();
    let proven = false;
    try { proven = (await launcherGone(r.entry)) === true; } catch (err) { log('[leftovers] launcher check threw for', r.pid, ':', (err && err.message) || err); }
    if (!proven) return 'kept';
    let status;
    try { status = await kill(r.pid, r.start); } catch (err) { log('[leftovers] kill threw for', r.pid, ':', (err && err.message) || err); return 'failed'; }
    if (status === 'gone') {
      let running = null;
      try { running = await isRunning(r.pid, r.start); } catch { /* unknown */ }
      if (running !== false) return 'unknown';                  // the kill's "gone" may be a failed lookup: keep the entry
    }
    return status;
  }

  async function stopRows(rows, by) {
    const stopped = [];
    const finished = [];
    for (const r of rows) {
      tried.set(keyOf(r), now());
      const status = await stopOne(r);
      if (status === 'killed' || status === 'gone' || status === 'mismatch') { finished.push(r); tried.set(keyOf(r), Infinity); }
      if (status === 'killed') {
        const s = { kind: r.kind, pid: r.pid, name: r.name, what: r.what, label: r.label, bytes: r.bytes, at: now(), status, by };
        stopped.push(s);
        done.push(s);
      }
      if (status === 'failed' || status === 'unknown') log('[leftovers] pid', r.pid, 'was not stopped:', status);
    }
    if (finished.length) {
      const res = removeEntries(finished.map(r => r.entry));
      if (res && res.ok === false) log('[leftovers] ledger tombstones not written:', res.error);
    }
    return { stopped, results: rows.map(r => ({ pid: r.pid, start: r.start, stopped: stopped.some(s => s.pid === r.pid) })) };
  }

  const queued = (fn) => {
    busy++;
    const p = tail.then(async () => { try { return await fn(); } finally { busy--; } });
    tail = p.then(() => {}, () => {});
    return p;
  };

  return {
    /** The automatic stop: the proven probe windows past their 15 minutes. Never starts a second run, and never kills inside the caller's turn. */
    run(found) {
      if (busy > 0) return Promise.resolve([]);
      const live = new Set(Object.values(found).flat().map(keyOf));
      for (const k of [...tried.keys()]) if (!live.has(k)) tried.delete(k);
      return queued(async () => {
        const rows = reapSet(found, { now: now() }).filter((r) => { const last = tried.get(keyOf(r)); return last === undefined || now() - last >= retryAfterMs; });
        const res = await stopRows(rows, 'auto');
        trim();
        return res.stopped;
      });
    },
    /** A Stop the person asked for, on rows that are provable now (the caller picks them from the latest sample). */
    stop(rows) { return queued(async () => { const res = await stopRows(rows.filter(r => r.provable === true && r.entry), 'you'); trim(); return res; }); },
    stopped() { trim(); return done.map(s => ({ ...s })); },
  };
}

module.exports = { find, totalBytes, createTracker, reapSet, present, createReaper, ftToMs, REAP_AFTER_MS, SHELL_SHOWN_AFTER_MS, MCP_MIN_BYTES, STUCK_MIN_SAMPLES };
