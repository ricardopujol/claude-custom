'use strict';
/**
 * The Resources panel's Stop button (BACKLOG #63, documentation/DESIGN_RESOURCE_PANEL.md "Stop"). It acts on a
 * PID, never on a name: the 2026-10-02 `taskkill /IM node.exe` killed every claude-custom host on the machine.
 *
 * `stopDecision` is the guard, pure. It refuses unless the pid is
 *   - a real pid and a FILETIME start time (what the panel read when it drew the row),
 *   - still in a freshly read table, with that SAME start time (Windows reuses pids; the start time is the proof),
 *   - a (start-time-guarded) descendant of one of THIS window's session hosts, and
 *   - not protected BY POSITION or by image: claude, a host, a ConPTY, Electron, a direct child of a session host (what
 *     the pty launched), or anything with one of those in its subtree (host/resource-tree.js stopBlock). Closing the
 *     tab is how a session ends.
 * When it says yes it also returns the exact set to end, LEAF FIRST (resource-tree.js killSet): the guarded subtree,
 * not a bare `taskkill /T`, which could reach processes the guard never judged.
 *
 * `stop` re-reads the table, asks the guard, then hands the set to a kill that RE-PROVES each process (pid and start
 * time, through a handle) at the moment it ends it (host/resource-kill.js). The table read takes 1.7-11 s (measured),
 * so the proof in it is old by then: the re-proof at the kill is the one that counts.
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

  const block = tree.stopBlock(procs, pid, sessionHostPids);
  if (block) return { ok: false, reason: block };
  return { ok: true, target: { pid, name: me.name, start: me.start }, kill: tree.killSet(procs, pid) };
}

/**
 * stop(request, { readProcs: async () -> procs | null, hostPids: (procs) -> [pid],
 *                 kill: async ([{ pid, start, name }]) -> [{ pid, status: 'killed'|'gone'|'reused'|'failed', text? }] })
 *   -> { ok: true, pid, name } | { ok: false, reason, text }
 * The kill's answer is believed only as far as it goes: the TARGET must be reported killed, or the Stop did not happen.
 */
async function stop(request, { readProcs, hostPids, kill }) {
  let procs;
  try { procs = await readProcs(); } catch { procs = null; }
  if (!Array.isArray(procs)) return { ok: false, reason: 'unreadable', text: reasonText('unreadable') };
  const d = stopDecision(request, procs, { sessionHostPids: hostPids(procs) });
  if (!d.ok) return { ok: false, reason: d.reason, text: reasonText(d.reason) };

  let results;
  try { results = await kill(d.kill); } catch (err) {
    return { ok: false, reason: 'kill-failed', text: `${reasonText('kill-failed')}: ${(err && err.message) || err}` };
  }
  const mine = Array.isArray(results) ? results.find(r => r && r.pid === d.target.pid) : null;
  if (mine && mine.status === 'killed') return { ok: true, pid: d.target.pid, name: d.target.name };
  if (mine && mine.status === 'gone') return { ok: false, reason: 'gone', text: reasonText('gone') };
  if (mine && mine.status === 'reused') return { ok: false, reason: 'reused', text: reasonText('reused') };
  const why = mine && mine.text ? `: ${mine.text}` : '';
  return { ok: false, reason: 'kill-failed', text: `${reasonText('kill-failed')}${why}` };
}

module.exports = { stopDecision, stop, reasonText };
