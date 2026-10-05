'use strict';
/**
 * Who owns which process (BACKLOG #63, documentation/DESIGN_RESOURCE_PANEL.md "Tree attribution"). Pure: it works
 * on the process table one sample read (host/resource-sample.js `procs`), and touches no OS.
 *
 * A process table is built from ParentProcessId, and Windows REUSES pids. So every edge is guarded by start-time
 * ordering: a child must have started at or after its parent, and a child whose start time is unknown is not
 * attributed at all (nothing can be proved about it). A reused pid can therefore not adopt someone else's
 * processes, and a corrupt table with a cycle in it still terminates.
 *
 * THE BUCKETS. Every pid lands in at most one:
 *   session:<hostPid>     claude and everything it started. NOT the host or its ConPTY: those are claude-custom's.
 *   win:<root>:main       a window's Electron main process, and anything else it started (a git call, the sampler)
 *   win:<root>:renderers  its renderer, GPU, utility and other Chromium processes
 *   win:<root>:hosts      its session hosts and their ConPTYs
 *   background:hosts      the hosts and ConPTYs of sessions no window owns
 * A "window" is an Electron main process whose command line names a claude-custom install, or one the caller
 * names (its own pid: `electron .` has no path in it). Windows are claimed innermost first, so a window launched
 * from inside a session (a probe) is its own window, not part of that session.
 */

const isStr = s => typeof s === 'string';

/** 'host' | 'claude' | 'conpty' | 'electron:main' | 'electron:<type>' | 'other' (same split as verify/probe-memory-footprint.js). */
function roleOf(p) {
  const cmd = isStr(p.cmd) ? p.cmd : '';
  const name = isStr(p.name) ? p.name.toLowerCase() : '';
  if (/host[\\/]host\.js/.test(cmd)) return 'host';
  if (name.startsWith('claude')) return 'claude';
  if (name === 'conhost.exe' || name === 'openconsole.exe') return 'conpty';
  const type = (cmd.match(/--type=([a-z-]+)/) || [])[1];
  if (name === 'electron.exe') return type ? `electron:${type}` : 'electron:main';
  return 'other';
}

// FILETIME strings compare as BigInt. A child must not start before its parent.
function startedAfter(parent, child) {
  if (!isStr(parent.start) || !isStr(child.start)) return false;
  try { return BigInt(child.start) >= BigInt(parent.start); } catch { return false; }
}

function indexOf(procs) {
  const byPid = new Map();
  for (const p of Array.isArray(procs) ? procs : []) if (p && !byPid.has(p.pid)) byPid.set(p.pid, p);
  const kids = new Map();
  for (const p of byPid.values()) {
    const parent = byPid.get(p.ppid);
    if (!parent || parent === p || !startedAfter(parent, p)) continue;
    if (!kids.has(parent.pid)) kids.set(parent.pid, []);
    kids.get(parent.pid).push(p);
  }
  return { byPid, kids };
}

function walkFrom(ix, rootPid) {
  const root = ix.byPid.get(rootPid);
  if (!root) return [];
  const out = [root];
  const seen = new Set([root.pid]);
  for (let i = 0; i < out.length; i++) {
    for (const k of ix.kids.get(out[i].pid) || []) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid);
      out.push(k);
    }
  }
  return out;
}

/** Every process reachable from rootPid, root first, each once; [] when rootPid is not in the table. */
function descendants(procs, rootPid) { return walkFrom(indexOf(procs), rootPid); }

const norm = s => String(s).toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namesInstall(cmd, installDirs) {
  if (!isStr(cmd)) return false;
  const text = norm(cmd);
  return installDirs.some((dir) => {
    if (!isStr(dir) || dir === '') return false;
    return new RegExp(`(^|[\\s"'])${escapeRe(norm(dir))}(?=$|["'\\s])`).test(text);
  });
}

/**
 * attribute(procs, { hosts: [{ pid }], installDirs: [path], ownPids: [pid] }) ->
 *   { buckets: Map<id, pid[]>, pidBucket: Map<pid, id>,
 *     sessions: [{ hostPid, owner: rootPid | null, claudePid | null }], windows: [{ rootPid }] }
 * `hosts` are the host pids the caller has proven (identity file + start time); one that is not a host process in
 * this table is ignored. A host may name its `owner` (a window's root pid): a tab attached to a host an EARLIER
 * window started has no parent link to this window, but it is this window's session all the same.
 */
function attribute(procs, { hosts = [], installDirs = [], ownPids = [] } = {}) {
  const ix = indexOf(procs);
  const buckets = new Map();
  const pidBucket = new Map();
  const add = (id, pid) => {
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(pid);
    pidBucket.set(pid, id);
  };
  const ensure = (id) => { if (!buckets.has(id)) buckets.set(id, []); };

  const forced = new Map();
  for (const h of Array.isArray(hosts) ? hosts : []) {
    if (h && Number.isInteger(h.owner) && !forced.has(h.pid)) forced.set(h.pid, h.owner);
  }
  const hostPids = [...new Set((Array.isArray(hosts) ? hosts : []).map(h => h && h.pid))]
    .filter(pid => ix.byPid.has(pid) && roleOf(ix.byPid.get(pid)) === 'host')
    .sort((a, b) => a - b);
  const sessions = [];

  const claimSession = (hostPid, owner, hostsBucket) => {
    const id = `session:${hostPid}`;
    ensure(id);
    let claudePid = null;
    for (const p of walkFrom(ix, hostPid)) {
      if (pidBucket.has(p.pid)) continue;
      if (p.pid === hostPid || roleOf(p) === 'conpty') { add(hostsBucket, p.pid); continue; }
      add(id, p.pid);
      if (claudePid === null && roleOf(p) === 'claude') claudePid = p.pid;
    }
    sessions.push({ hostPid, owner, claudePid });
  };

  const own = new Set(Array.isArray(ownPids) ? ownPids : []);
  const roots = [...ix.byPid.values()]
    .filter(p => roleOf(p) === 'electron:main' && (own.has(p.pid) || namesInstall(p.cmd, installDirs)))
    .map(p => ({ rootPid: p.pid, size: walkFrom(ix, p.pid).length }))
    .sort((a, b) => (a.size - b.size) || (a.rootPid - b.rootPid));

  for (const { rootPid } of roots) {
    const tree = walkFrom(ix, rootPid);
    const inTree = new Set(tree.map(p => p.pid));
    for (const hostPid of hostPids) {
      if (pidBucket.has(hostPid)) continue;
      if (inTree.has(hostPid) || forced.get(hostPid) === rootPid) claimSession(hostPid, rootPid, `win:${rootPid}:hosts`);
    }
    for (const p of tree) {
      if (pidBucket.has(p.pid)) continue;
      const role = roleOf(p);
      if (role === 'host' || role === 'conpty') add(`win:${rootPid}:hosts`, p.pid);
      else if (role === 'electron:main' || !role.startsWith('electron:')) add(`win:${rootPid}:main`, p.pid);
      else add(`win:${rootPid}:renderers`, p.pid);
    }
  }
  for (const hostPid of hostPids) {
    if (!pidBucket.has(hostPid)) claimSession(hostPid, null, 'background:hosts');
  }

  sessions.sort((a, b) => a.hostPid - b.hostPid);
  return {
    buckets, pidBucket, sessions,
    windows: roots.map(r => ({ rootPid: r.rootPid })).sort((a, b) => a.rootPid - b.rootPid),
  };
}

/**
 * The claims (identity files: { pid, port, cwd, processStartedAt? }) that are a live host in THIS table. A file
 * outlives its host and Windows reuses pids (host/background-hosts.js), so a claim is only a claim: its pid must be
 * a host process here, and when the file carries the host's OS start time (`processStartedAt`, a FILETIME) the
 * process must have started then. A claim older than that field is accepted on the role alone.
 *
 * The two start times come from different queries (the identity file's from Get-Process, this table's from CIM
 * CreationDate) and MEASURED to differ by one 100 ns tick for the same process (134355977388659781 against
 * ...780), so they are compared within 10 ms, not for equality. A reused pid starts far later than that.
 */
const START_SLACK = 100000n;      // 10 ms in 100 ns ticks
function sameStart(a, b) {
  if (!isStr(a) || !isStr(b) || !/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
  const d = BigInt(a) - BigInt(b);
  return (d < 0n ? -d : d) <= START_SLACK;
}

function provenHosts(procs, claims) {
  const byPid = new Map((Array.isArray(procs) ? procs : []).map(p => [p.pid, p]));
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(claims) ? claims : []) {
    const p = c && byPid.get(c.pid);
    if (!p || seen.has(c.pid) || roleOf(p) !== 'host') continue;
    if (c.processStartedAt !== undefined && !sameStart(c.processStartedAt, p.start)) continue;
    seen.add(c.pid);
    out.push({ pid: c.pid, port: c.port, cwd: c.cwd });
  }
  return out;
}

module.exports = { roleOf, descendants, attribute, namesInstall, provenHosts };
