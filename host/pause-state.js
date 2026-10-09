'use strict';
/**
 * Which processes the Resources panel has paused (BACKLOG #19). The panel's Pause suspends a process and everything below it
 * (host/process-suspend.js); this remembers WHAT was suspended, so that Resume wakes exactly that set and the row can say
 * "paused" with the time. Pure bookkeeping: it touches no OS.
 *
 * THE INVARIANTS (test/pause-state.test.js states them as properties):
 *   - a process is paused at most once (a second Pause is refused, and keeps the first time);
 *   - Resume takes a paused process once (`take`); a failed resume puts it back (`restore`) rather than forgetting it;
 *   - every pause ends in a Resume or an explicit end: the process left the table ('gone'), or its pid is another process now
 *     ('reused'). `reconcile` finds those on each new sample. A table that could not be read ends nothing;
 *   - nothing is "paused" that was not paused through `add`.
 *
 * A process is named by pid AND start time (Windows reuses pids): the key is `<pid>:<start>`.
 */

const { sameStart } = require('./resource-tree');

const isStart = s => typeof s === 'string' && /^\d+$/.test(s);
const validPid = pid => Number.isInteger(pid) && pid > 0;

function keyOf(pid, start) {
  return validPid(pid) && isStart(start) ? `${pid}:${start}` : null;
}

function createPauseStore({ now = Date.now } = {}) {
  const entries = new Map();   // key -> { pid, start, name, since, pids: [{ pid, start }] }

  // `pids` is everything suspended with the root, root included: the set a Resume must wake.
  function valid(e, { rootInSet = true } = {}) {
    if (!e || keyOf(e.pid, e.start) === null || !Array.isArray(e.pids) || e.pids.length === 0) return false;
    if (!e.pids.every(p => p && keyOf(p.pid, p.start) !== null)) return false;
    return !rootInSet || e.pids.some(p => p.pid === e.pid && p.start === e.start);
  }

  return {
    add(e) {
      if (!valid(e)) return { ok: false, reason: 'invalid' };
      const key = keyOf(e.pid, e.start);
      if (entries.has(key)) return { ok: false, reason: 'already' };
      entries.set(key, { pid: e.pid, start: e.start, name: typeof e.name === 'string' ? e.name : '', since: now(), pids: e.pids.map(p => ({ pid: p.pid, start: p.start })) });
      return { ok: true };
    },
    isPaused: (pid, start) => entries.has(keyOf(pid, start)),
    /** Is any of these processes ({ pid, start }) already suspended by an entry (whatever its root)? Suspending it again would need a second resume. */
    holdsAny(targets) {
      if (!Array.isArray(targets)) return false;
      const held = new Set([...entries.values()].flatMap(e => e.pids.map(p => keyOf(p.pid, p.start))));
      return targets.some(t => t && held.has(keyOf(t.pid, t.start)));
    },
    /** The paused entry, removed; null when it is not paused. A second call for the same process gets null. */
    take(pid, start) {
      const key = keyOf(pid, start);
      const e = key === null ? undefined : entries.get(key);
      if (!e) return null;
      entries.delete(key);
      return e;
    },
    /** Put back an entry `take` handed out (its resume did not go through): same time, still paused. */
    restore(e) {
      // Narrowed to what is still suspended after a partial resume, so the root may be gone from the set.
      if (!valid(e, { rootInSet: false })) return;
      const key = keyOf(e.pid, e.start);
      if (!entries.has(key)) entries.set(key, e);
    },
    /** The processes in a freshly read table; the entries that left it or changed are removed and returned with how they ended. */
    reconcile(procs) {
      if (!Array.isArray(procs)) return [];
      const byPid = new Map(procs.filter(p => p && Number.isInteger(p.pid)).map(p => [p.pid, p]));
      const ended = [];
      for (const [key, e] of [...entries]) {
        const p = byPid.get(e.pid);
        const how = !p ? 'gone' : (sameStart(e.start, p.start) ? null : 'reused');
        if (how === null) continue;
        entries.delete(key);
        ended.push({ ...e, key, how });
      }
      return ended;
    },
    list: () => [...entries].map(([key, e]) => ({ key, ...e })),
  };
}

module.exports = { createPauseStore, keyOf };
