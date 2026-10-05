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
    let launched = null;       // the first thing the pty launched: the CLI's root by POSITION, whatever its image is called
    for (const p of walkFrom(ix, hostPid)) {
      if (pidBucket.has(p.pid)) continue;
      if (p.pid === hostPid || roleOf(p) === 'conpty') { add(hostsBucket, p.pid); continue; }
      add(id, p.pid);
      if (claudePid === null && roleOf(p) === 'claude') claudePid = p.pid;
      if (launched === null && p.ppid === hostPid) launched = p.pid;
    }
    if (claudePid === null) claudePid = launched;
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
 * a host process here AND the process must have started when the file says (`processStartedAt`, a FILETIME). A claim
 * with no start time (written before that field existed) proves nothing about WHICH process now holds its pid, and a
 * reused pid would be believed (Dexter, PR #113 finding 12), so it is not accepted.
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
    if (!sameStart(c.processStartedAt, p.start)) continue;
    seen.add(c.pid);
    out.push({ pid: c.pid, port: c.port, cwd: c.cwd });
  }
  return out;
}

const isProtectedRole = role => role === 'host' || role === 'claude' || role === 'conpty' || role.startsWith('electron:');

/**
 * Why `pid` must not be stopped from the panel, or null when it may be (BACKLOG #63, PR #113 Dexter findings 2 and 11).
 * Protection is by POSITION as well as by image name:
 *   'gone'       not in the table
 *   'not-ours'   not a (guarded) descendant of one of `hostPids`, the session hosts of this window's tabs
 *   'protected'  the process IS claude, a host, a ConPTY or Electron; or it is a DIRECT child of a session host (the
 *                process the pty launched: claude.exe in production, `cmd.exe ...` under CLAUDE_CUSTOM_BIN, a
 *                launcher in front of the CLI); or anything that dies with it is protected: its subtree holds
 *                Electron, a host, claude, a ConPTY or a direct child of a host (an `npm start` that runs a window).
 */
function stopBlock(procs, pid, hostPids) {
  const ix = indexOf(procs);
  const me = ix.byPid.get(pid);
  if (!me) return 'gone';
  if (isProtectedRole(roleOf(me))) return 'protected';
  let under = false;
  let direct = false;
  const hosts = new Set(Array.isArray(hostPids) ? hostPids : []);
  for (const h of hosts) {
    if (h === pid || !ix.byPid.has(h)) continue;
    if (!walkFrom(ix, h).some(p => p.pid === pid)) continue;
    under = true;
    if ((ix.kids.get(h) || []).some(k => k.pid === pid)) direct = true;
  }
  if (!under) return 'not-ours';
  if (direct) return 'protected';
  const directOfHosts = new Set();
  for (const h of hosts) for (const k of ix.kids.get(h) || []) directOfHosts.add(k.pid);
  const sub = walkFrom(ix, pid);
  // A console host BELOW the target is just the hidden console of something it started (windowsHide, execa's default), so it
  // does not count: the session's own ConPTY is protected by position (a direct child of the host), not by its image name.
  if (sub.some(p => (isProtectedRole(roleOf(p)) && roleOf(p) !== 'conpty') || hosts.has(p.pid) || directOfHosts.has(p.pid))) return 'protected';
  return null;
}

/** The processes that die with `pid`, ROOT FIRST (a parent that restarts a child on exit must be dead before the child is touched), each with the start time to re-prove it by: exactly the guarded subtree, never a bare tree kill. */
function killSet(procs, pid) {
  return walkFrom(indexOf(procs), pid).map(p => ({ pid: p.pid, start: p.start, name: p.name }));
}

module.exports = { roleOf, descendants, attribute, namesInstall, provenHosts, stopBlock, killSet, isProtectedRole, sameStart };
