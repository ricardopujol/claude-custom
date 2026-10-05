'use strict';
/**
 * The Resources panel's Stop button (BACKLOG #63, documentation/DESIGN_RESOURCE_PANEL.md "Stop"). It acts on a
 * PID, never on a name: the 2026-10-02 `taskkill /IM node.exe` killed every claude-custom host on the machine.
 *
 * `stopDecision` is the guard, pure. It refuses unless the pid is
 *   - a real pid and a FILETIME start time (what the panel read when it drew the row),
 *   - still in a freshly read table, with that SAME start time (Windows reuses pids; the start time is the proof),
 *   - a descendant (start-time-guarded, host/resource-tree.js) of one of THIS window's session hosts, and
 *   - not claude, a session host, a ConPTY or an Electron process: closing the tab is how a session ends.
 * `stop` re-reads the table, asks the guard, then kills that pid's tree through host/kill-tree.js killPidTree.
 * The re-read and the kill are not atomic; the window is a few milliseconds, and the start-time proof was taken
 * in the same read the decision used.
 */

const tree = require('./resource-tree');

const TEXT = {
  invalid: 'that is not a process this panel can stop',
  gone: 'Already exited',
  reused: 'that PID now belongs to a different process',
  protected: 'closing the tab ends a session; this process is part of it',
  'not-ours': 'it is not one of this window\'s session processes',
  unreadable: 'the process list could not be read',
  'kill-failed': 'the stop did not go through',
};
const reasonText = reason => TEXT[reason] || 'it could not be stopped';

function stopDecision(request, procs, { sessionHostPids = [] } = {}) {
  const pid = request && request.pid;
  const startTime = request && request.startTime;
  if (!Number.isInteger(pid) || pid <= 0 || typeof startTime !== 'string' || !/^\d+$/.test(startTime)) {
    return { ok: false, reason: 'invalid' };
  }
  const me = (Array.isArray(procs) ? procs : []).find(p => p && p.pid === pid);
  if (!me) return { ok: false, reason: 'gone' };
  if (me.start !== startTime) return { ok: false, reason: 'reused' };

  const role = tree.roleOf(me);
  if (role === 'host' || role === 'claude' || role === 'conpty' || role.startsWith('electron:')) {
    return { ok: false, reason: 'protected' };
  }
  const under = (Array.isArray(sessionHostPids) ? sessionHostPids : [])
    .some(h => h !== pid && tree.descendants(procs, h).some(p => p.pid === pid));
  if (!under) return { ok: false, reason: 'not-ours' };
  return { ok: true, target: { pid, name: me.name, start: me.start } };
}

/**
 * stop(request, { readProcs: async () -> procs | null, hostPids: (procs) -> [pid], kill: (pid) -> void })
 *   -> { ok: true, pid, name } | { ok: false, reason, text }
 */
async function stop(request, { readProcs, hostPids, kill }) {
  let procs;
  try { procs = await readProcs(); } catch { procs = null; }
  if (!Array.isArray(procs)) return { ok: false, reason: 'unreadable', text: reasonText('unreadable') };
  const d = stopDecision(request, procs, { sessionHostPids: hostPids(procs) });
  if (!d.ok) return { ok: false, reason: d.reason, text: reasonText(d.reason) };
  try { kill(d.target.pid); } catch (err) {
    return { ok: false, reason: 'kill-failed', text: `${reasonText('kill-failed')}: ${(err && err.message) || err}` };
  }
  return { ok: true, pid: d.target.pid, name: d.target.name };
}

module.exports = { stopDecision, stop, reasonText };
