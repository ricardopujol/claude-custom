'use strict';
/**
 * The Resources panel's view model (BACKLOG #63, documentation/DESIGN_RESOURCE_PANEL.md "What it shows"): one
 * sample, the CPU deltas against the one before it, the attribution (host/resource-tree.js) and this window's tab
 * list, joined into the shape app/resources-display.js draws. Pure.
 *
 *   buildModel({ sample, prev, cores, tabs, hosts, installDirs, ownPid, labelOf }) ->
 *     { measuring, machine: { cpu, mem, ours: { cpu, bytes } },
 *       project: { cpu, bytes, rows: [session], self: { cpu, bytes, parts: [{ id, label, cpu, bytes, count }] } },
 *       windows: [{ rootPid, label, cpu, bytes, sessions }],
 *       background: { cpu, bytes, sessions } | null }
 *   session: { key, label, hostPid, cpu, bytes, claude: { pid, cpu, bytes } | null, children: [child], more: { count, underOnePct } }
 *   child:   { pid, name, cmd, cpu, bytes, start, canStop }
 *
 * `cpu` is `null` when nothing in it was measured (the first sample): the view says "measuring…", never 0.
 * `bytes` is the private working set (physical RAM, Task Manager's Memory column), always a number on a row; null on a child with no figure. `tabs` is [{ key, label, hostPid | null }]; `hosts` the proven
 * session hosts [{ pid, cwd }]; `labelOf(cwd)` names a project folder.
 */

const sample = require('./resource-sample');
const tree = require('./resource-tree');

const CMD_MAX = 60;
const CHILDREN_SHOWN = 3;
const PROTECTED = role => role === 'host' || role === 'claude' || role === 'conpty' || role.startsWith('electron:');

const basename = (cwd) => {
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(cwd);
};

/** The command line without the executable (quoted or not); the process name when there are no arguments. Clipped. */
function shortCmd(cmd, name) {
  const fallback = typeof name === 'string' && name !== '' ? name : '?';
  if (typeof cmd !== 'string' || cmd.trim() === '') return fallback;
  const text = cmd.trim();
  let rest;
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1);
    rest = close < 0 ? '' : text.slice(close + 1);
  } else {
    const space = text.search(/\s/);
    rest = space < 0 ? '' : text.slice(space);
  }
  rest = rest.trim();
  if (rest === '') return fallback;
  if (rest.length > CMD_MAX) rest = shortenFirstPath(rest);
  return rest.length > CMD_MAX ? `${rest.slice(0, CMD_MAX - 1)}…` : rest;
}

// A line too long for the row: its first argument is usually a script path, and what tells two processes apart is the
// file name at the END of it ("…\burn.js"), not the folders in front. Only the first argument is touched.
function shortenFirstPath(rest) {
  const m = /^(?:"([^"]+)"|(\S+))([\s\S]*)$/.exec(rest);
  if (!m) return rest;
  const token = m[1] !== undefined ? m[1] : m[2];
  const base = token.split(/[\\/]/).filter(Boolean).pop();
  if (!/[\\/]/.test(token) || !base || base === token) return rest;
  return `…\\${base}${m[3]}`;
}

// A figure that is null when none of its parts was measured; the sum of the ones that were otherwise.
function sumCpu(pids, cpus) {
  let total = 0;
  let any = false;
  for (const pid of pids) {
    const v = cpus.get(pid);
    if (typeof v === 'number' && Number.isFinite(v)) { total += v; any = true; }
  }
  return any ? total : null;
}
// Memory is each process's PRIVATE WORKING SET (Task Manager's Memory column, `WorkingSetPrivate` in the perf row): physical
// RAM, the same unit as the machine's "in use". `mem` maps pid -> bytes; a pid with no figure adds nothing (and shows "—" alone).
function sumBytes(pids, mem) {
  let total = 0;
  for (const pid of pids) {
    const v = mem.get(pid);
    if (typeof v === 'number') total += v;
  }
  return total;
}
const figures = (pids, cpus, mem) => ({ cpu: sumCpu(pids, cpus), bytes: sumBytes(pids, mem) });

const cpuOf = (cpus, pid) => (cpus && cpus.has(pid) ? cpus.get(pid) : null);

/**
 * The top 3 of `pids` (minus claude) by CPU, then memory, and what is left over. `canStop(pid)` is the Stop guard's own
 * verdict (host/resource-tree.js stopBlock) so a button is offered only where Stop can succeed; the default is the
 * image-name rule alone. An unknown memory figure is null ("—"), never 0.
 */
function childrenOf(procs, pids, cpus, claudePid, canStop = (pid, p) => !PROTECTED(tree.roleOf(p)), mem = new Map()) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const rows = pids.filter(pid => pid !== claudePid && byPid.has(pid)).map((pid) => {
    const p = byPid.get(pid);
    return {
      pid, name: p.name, cmd: shortCmd(p.cmd, p.name), cpu: cpuOf(cpus, pid),
      bytes: typeof mem.get(pid) === 'number' ? mem.get(pid) : null, start: p.start,
    };
  });
  rows.sort((a, b) => {
    const an = a.cpu === null ? 1 : 0;
    const bn = b.cpu === null ? 1 : 0;
    return (an - bn) || ((b.cpu || 0) - (a.cpu || 0)) || ((b.bytes || 0) - (a.bytes || 0)) || (a.pid - b.pid);
  });
  const rest = rows.slice(CHILDREN_SHOWN);
  const shown = rows.slice(0, CHILDREN_SHOWN).map(r => ({ ...r, canStop: canStop(r.pid, byPid.get(r.pid)) === true }));
  return {
    children: shown,
    more: { count: rest.length, underOnePct: rest.every(r => typeof r.cpu === 'number' && r.cpu < 1) },
  };
}

const PARTS = [['main', 'Electron main'], ['renderers', 'Renderers'], ['hosts', 'Session hosts']];

function buildModel({ sample: next, prev = null, cores, tabs = [], hosts = [], installDirs = [], ownPid, labelOf = basename }) {
  const procs = next.procs;
  const mem = new Map([...next.perf].filter(([, v]) => typeof v.ws === 'number').map(([pid, v]) => [pid, v.ws]));
  const cpus = sample.cpuPercents(prev, next, cores);
  const tabList = Array.isArray(tabs) ? tabs : [];
  const tabHosts = new Set(tabList.map(t => t && t.hostPid).filter(Number.isInteger));
  const cwdOf = new Map((Array.isArray(hosts) ? hosts : []).map(h => [h.pid, h.cwd]));
  const a = tree.attribute(procs, {
    hosts: (Array.isArray(hosts) ? hosts : []).map(h => (tabHosts.has(h.pid) ? { pid: h.pid, owner: ownPid } : { pid: h.pid })),
    installDirs, ownPids: [ownPid],
  });
  const pidsOf = id => a.buckets.get(id) || [];

  // Stop is offered only on a tab's own session, and only where the guard would allow it (the same predicate).
  const sessionRow = (s, key, label, stoppable) => {
    const pids = pidsOf(`session:${s.hostPid}`);
    const canStop = stoppable ? (pid) => tree.stopBlock(procs, pid, [s.hostPid]) === null : () => false;
    const { children, more } = childrenOf(procs, pids, cpus, s.claudePid, canStop, mem);
    const claude = s.claudePid === null ? null
      : { pid: s.claudePid, cpu: cpuOf(cpus, s.claudePid), bytes: sumBytes([s.claudePid], mem) };
    return { key, label, hostPid: s.hostPid, ...figures(pids, cpus, mem), claude, children, more };
  };

  // This window: a row per tab whose host is in the table, then any session it owns that has no tab.
  const mine = a.sessions.filter(s => s.owner === ownPid);
  const rows = [];
  const used = new Set();
  for (const t of tabList) {
    const s = t && mine.find(x => x.hostPid === t.hostPid);
    if (!s || used.has(s.hostPid)) continue;
    used.add(s.hostPid);
    rows.push(sessionRow(s, t.key, t.label, true));
  }
  for (const s of mine) {
    if (used.has(s.hostPid)) continue;
    const cwd = cwdOf.get(s.hostPid);
    rows.push(sessionRow(s, `host:${s.hostPid}`, cwd ? labelOf(cwd) : `session ${s.hostPid}`, false));
  }

  const parts = PARTS.map(([id, label]) => {
    const pids = pidsOf(`win:${ownPid}:${id}`);
    return { id, label, count: pids.length, ...figures(pids, cpus, mem) };
  });
  const selfPids = parts.flatMap(p => pidsOf(`win:${ownPid}:${p.id}`));
  const self = { ...figures(selfPids, cpus, mem), parts };

  const projectPids = [...rows.flatMap(r => pidsOf(`session:${r.hostPid}`)), ...selfPids];
  const project = { ...figures(projectPids, cpus, mem), rows, self };

  const windows = a.windows.filter(w => w.rootPid !== ownPid).map((w) => {
    const owned = a.sessions.filter(s => s.owner === w.rootPid);
    const pids = [...PARTS.flatMap(([id]) => pidsOf(`win:${w.rootPid}:${id}`)), ...owned.flatMap(s => pidsOf(`session:${s.hostPid}`))];
    const names = [...new Set(owned.map(s => cwdOf.get(s.hostPid)).filter(Boolean).map(labelOf))];
    return { rootPid: w.rootPid, label: names.length ? names.join(', ') : `claude-custom (pid ${w.rootPid})`, sessions: owned.length, ...figures(pids, cpus, mem) };
  });

  const orphans = a.sessions.filter(s => s.owner === null);
  const bgPids = [...pidsOf('background:hosts'), ...orphans.flatMap(s => pidsOf(`session:${s.hostPid}`))];
  const background = orphans.length ? { sessions: orphans.length, ...figures(bgPids, cpus, mem) } : null;

  const everyPid = [...a.pidBucket.keys()];
  return {
    measuring: !prev,
    machine: { cpu: sample.machineCpu(prev, next), mem: sample.machineMemory(next), ours: figures(everyPid, cpus, mem) },
    project, windows, background,
  };
}

module.exports = { buildModel, shortCmd, childrenOf, CHILDREN_SHOWN };
