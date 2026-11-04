'use strict';
/**
 * #129: end a tab's host BY PID when its stop message failed. The identity file the host wrote names its pid and its OS start time
 * (host/host-identity.js writeIdentity: pid, processStartedAt); the kill proves both again on a held handle (host/kill-tree.js
 * killProvenAsync), because a pid alone proves nothing on Windows: it is reused.
 *
 *   identities() -> [{ port, parsed, unreadable? }] | null   this build's identity files (host/background-hosts.js identitiesIn); null: can't list
 *   kill(pid, start) -> Promise<'killed'|'gone'|'mismatch'|'failed'|'unknown'>
 *
 * Resolves the kill's word. 'gone' is also what no file for the port means (the host removes its file on its way out); anything that
 * can't be proved ('unknown') kills nothing. Never rejects.
 */
function createStopByPid({ identities, kill }) {
  return async function stopByPid(port) {
    try {
      const entries = identities();
      if (!Array.isArray(entries)) return 'unknown';
      const hit = entries.find(e => e && e.port === port);
      if (!hit) return 'gone';
      const p = hit.parsed;
      if (!p || typeof p !== 'object') return 'unknown';
      if (!Number.isInteger(p.pid) || p.pid <= 0 || typeof p.processStartedAt !== 'string' || !/^\d+$/.test(p.processStartedAt)) return 'unknown';
      const outcome = await kill(p.pid, p.processStartedAt);
      return typeof outcome === 'string' ? outcome : 'unknown';
    } catch (err) {
      return 'unknown';
    }
  };
}

module.exports = { createStopByPid };
