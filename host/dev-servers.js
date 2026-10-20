'use strict';
/**
 * The dev servers of a worktree (BACKLOG #119 A4): which listening TCP ports are its own, and which processes own them. Pure: it reads
 * the one table a PowerShell call printed (SCRIPT) and answers; app/dev-servers-service.js owns the call and the clock.
 *
 * WHICH PORTS ARE "THIS WORKTREE'S". host/port-blocks.js gives each worktree a block of BLOCK ports from `base` (WORKTREE_PORT_BASE in
 * the environment of its `claude`), so a server started with that variable lands inside it. A listener inside the block counts whoever
 * owns it. A listener OUTSIDE the block counts only when a process of this tab's own session owns it (a descendant of the session's
 * host, found with the start-time-guarded walk of host/resource-tree.js), because a server that ignored the variable and took 3000
 * is still the one this session started. Those are listed apart, so the panel can dim them.
 *
 * WHAT IS LEFT OUT. A listener on an address only another computer can reach (a LAN address, link-local) is not on localhost, so
 * Preview could not open it: not listed. The session host itself (its own control port) and the `claude` process are not dev servers.
 */

const { BLOCK, RANGE_START, RANGE_LAST_BASE } = require('./port-blocks');
const { descendants } = require('./resource-tree');

const INTERVAL_MS = 10000;                 // like the Resources panel's panel level (host/poller-policy.js CADENCE.panel)
const NAME_MAX = 40;
const REACHABLE = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);

// One PowerShell call: the listeners, and the process table the session join walks. The shell keeps state between calls
// (host/persistent-powershell.js), so the whole thing runs in its own scope and leaves nothing behind. Process rows are cut to what
// the join needs; `start` is the FILETIME string host/resource-tree.js guards a reused pid with.
//
// THE LISTENERS COME FROM netstat, NOT Get-NetTCPConnection. MEASURED 2026-10-19 in the persistent shell on the dev machine (46 listeners,
// 477 processes): Get-NetTCPConnection -State Listen took 961 ms a call, netstat -ano 8 ms (the process table, 376 ms, is then the rest of it).
// A listener is a line whose FOREIGN address ends in :0 (an established or closing connection has a real foreign port), which does not depend on
// the word the OS prints for the state ("LISTENING" is translated).
const SCRIPT = String.raw`& {
  $ErrorActionPreference = 'SilentlyContinue'
  $ns = Join-Path $env:SystemRoot 'System32\NETSTAT.EXE'
  $l = @(foreach ($v in 'TCP', 'TCPv6') { & $ns -ano -p $v | ForEach-Object { if ($_ -match '^\s*TCP\s+(\S+):(\d+)\s+\S+:0\s+\S+\s+(\d+)\s*$') { [pscustomobject]@{ port=[int]$matches[2]; addr=([string]$matches[1]).Trim('[', ']'); pid=[int]$matches[3] } } } })
  $p =@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name; start=$(if ($_.CreationDate) { [string]$_.CreationDate.ToFileTimeUtc() } else { $null }) } })
  [pscustomobject]@{ listeners=$l; procs=$p } | ConvertTo-Json -Compress -Depth 4
  'END'
}
`;

const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
const isPid = (n) => Number.isInteger(n) && n >= 0;
const asList = (v) => (Array.isArray(v) ? v : (v !== null && typeof v === 'object' ? [v] : []));

/** SCRIPT's output -> { ok: true, listeners: [{ port, pid, addr }], procs: [{ pid, ppid, name, start }] } | { ok: false }. Strict types; a bad row is dropped. */
function parseTable(text) {
  if (typeof text !== 'string') return { ok: false };
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 2 || lines[lines.length - 1] !== 'END') return { ok: false };
  let doc;
  try { doc = JSON.parse(lines.slice(0, -1).join('\n')); } catch { return { ok: false }; }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || !('listeners' in doc) || !('procs' in doc)) return { ok: false };

  const seen = new Set();
  const listeners = [];
  for (const l of asList(doc.listeners)) {
    if (l === null || typeof l !== 'object' || !isPort(l.port) || !isPid(l.pid) || typeof l.addr !== 'string' || !REACHABLE.has(l.addr)) continue;
    if (seen.has(l.port)) continue;
    seen.add(l.port);
    listeners.push({ port: l.port, pid: l.pid, addr: l.addr });
  }
  const procs = [];
  for (const p of asList(doc.procs)) {
    if (p === null || typeof p !== 'object' || !isPid(p.pid) || !isPid(p.ppid) || typeof p.name !== 'string') continue;
    procs.push({ pid: p.pid, ppid: p.ppid, name: p.name, start: typeof p.start === 'string' ? p.start : null });
  }
  return { ok: true, listeners, procs };
}

const validBase = (b) => Number.isInteger(b) && b >= RANGE_START && b <= RANGE_LAST_BASE && (b - RANGE_START) % BLOCK === 0;

/** Is `port` one of the BLOCK ports from `base`? A worktree with no block (base not a real block start) owns none. */
function inBlock(port, base) {
  return validBase(base) && Number.isInteger(port) && port >= base && port < base + BLOCK;
}

const label = (p) => {
  if (!p || typeof p.name !== 'string' || p.name === '') return 'unknown';
  const n = p.name.replace(/\.exe$/i, '');
  return n.length > NAME_MAX ? n.slice(0, NAME_MAX) : (n || 'unknown');
};

/**
 * buildState({ listeners, procs, base, hostPid }) -> { base, inBlock: [row], outside: [row] }, rows { port, pid, name } by port.
 * `hostPid` is the tab's session host (null when unknown): the root the child-of-session join walks from.
 */
function buildState({ listeners, procs, base, hostPid } = {}) {
  const list = Array.isArray(listeners) ? listeners : [];
  const table = Array.isArray(procs) ? procs : [];
  const byPid = new Map();
  for (const p of table) if (p && !byPid.has(p.pid)) byPid.set(p.pid, p);
  const mine = Number.isInteger(hostPid) && hostPid > 0 ? new Set(descendants(table, hostPid).map(p => p.pid)) : new Set();

  const inside = [];
  const outside = [];
  const taken = new Set();
  for (const l of list) {
    if (!l || !Number.isInteger(l.port) || !Number.isInteger(l.pid) || taken.has(l.port)) continue;
    const proc = byPid.get(l.pid);
    const row = { port: l.port, pid: l.pid, name: label(proc) };
    if (l.pid === hostPid) continue;
    if (inBlock(l.port, base)) { taken.add(l.port); inside.push(row); continue; }
    if (mine.has(l.pid) && !(proc && /^claude/i.test(proc.name))) { taken.add(l.port); outside.push(row); }
  }
  const byPort = (a, b) => a.port - b.port;
  return { base: validBase(base) ? base : null, inBlock: inside.sort(byPort), outside: outside.sort(byPort) };
}

/** Sample only while a window is in view (a real `false` for minimised) and there is a session to attribute to. */
function wanted({ minimised, tabs } = {}) {
  return minimised === false && Number.isInteger(tabs) && tabs > 0;
}

module.exports = { SCRIPT, INTERVAL_MS, parseTable, inBlock, buildState, wanted };
