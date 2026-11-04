'use strict';
/**
 * #129: end a tab's host BY PID when its stop message failed. The identity file the host wrote names its pid and its OS start time
 * (host/host-identity.js writeIdentity: pid, processStartedAt); the kill proves both again on a held handle (host/kill-tree.js
 * killProvenAsync), because a pid alone proves nothing on Windows: it is reused.
 *
 * THE PROOF BINDS TO THE TAB, NOT TO THE PORT (PR #231 Dexter 1 / Miguel B1). A port is only a place: a dead tab's old port can be
 * another folder's host now, and its file is a perfectly valid one. So the file is trusted only when it names the host THIS tab
 * has: the same folder (compared as the shell compares folders) and the same kind (branch, side or shell), and the file's own port is
 * the one its name says. Anything else is a 'stranger', and nothing is killed.
 *
 *   identities() -> [{ port, parsed, unreadable? }] | null   this build's identity files (host/background-hosts.js identitiesIn); null: can't list
 *   kill(pid, start) -> Promise<'killed'|'gone'|'mismatch'|'failed'|'unknown'>
 *   ownPids          pids that are never killed: this process and the one that started it (host/stop-holder.js's rule)
 *
 *   stopByPid(port, { cwd, side, shell }) resolves one word:
 *     killed | gone | mismatch | failed | unknown   the kill's own
 *     nofile     no file names the port (the shell decides what that means: a host that is still starting has none yet)
 *     stranger   the file names another folder or kind of host: not this tab's, so not ours to end
 *     unknown    nothing could be proved: unreadable file, no start time, a file that isn't its name's, own pid. Nothing is killed.
 * Never rejects.
 */
const { normPath } = require('./project-layout');

function createStopByPid({ identities, kill, ownPids = [] }) {
  return async function stopByPid(port, who) {
    try {
      const entries = identities();
      if (!Array.isArray(entries)) return 'unknown';
      if (!who || typeof who !== 'object' || typeof who.cwd !== 'string' || who.cwd === '') return 'unknown';
      const hit = entries.find(e => e && e.port === port);
      if (!hit) return 'nofile';
      const p = hit.parsed;
      if (!p || typeof p !== 'object') return 'unknown';
      if (Number(p.port) !== port) return 'unknown';
      if (typeof p.cwd !== 'string' || normPath(p.cwd) !== normPath(who.cwd)) return 'stranger';
      if ((p.side === true) !== (who.side === true)) return 'stranger';
      if ((p.kind === 'shell') !== (who.shell === true)) return 'stranger';
      if (!Number.isInteger(p.pid) || p.pid <= 0 || typeof p.processStartedAt !== 'string' || !/^\d+$/.test(p.processStartedAt)) return 'unknown';
      if (ownPids.includes(p.pid)) return 'unknown';
      const outcome = await kill(p.pid, p.processStartedAt);
      return typeof outcome === 'string' ? outcome : 'unknown';
    } catch {
      return 'unknown';
    }
  };
}

module.exports = { createStopByPid };
