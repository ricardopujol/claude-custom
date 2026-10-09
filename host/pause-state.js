'use strict';
/**
 * Which processes the Resources panel has paused (BACKLOG #19). The panel's Pause suspends a process and everything below it
 * (host/process-suspend.js); this remembers WHAT was suspended, so that Resume wakes exactly that set and the row can say
 * "paused" with the time. Pure bookkeeping: it touches no OS.
 *
 * THE INVARIANTS (test/pause-state.test.js states them as properties):
 *   - a process is paused at most once (a second Pause is refused, and keeps the first time);
 *   - Resume takes a paused process once (`take`); a failed resume puts it back (`restore`) rather than forgetting it;
 *   - every pause ends in a Resume or an explicit end. `reconcile` finds those on each new sample, PER MEMBER (PR #158 Dexter 6): an
 *     entry ends only when NO member of its set is still alive with its proved start. If the root went but members are still alive
 *     (suspended orphans), the entry ends with those members listed in `alive`, so the caller wakes them rather than forgetting them.
 *     A table that could not be read ends nothing;
 *   - nothing is "paused" that was not paused through `add`.
 *
 * WRITE-AHEAD (PR #158 Dexter R2-2). An entry is recorded BEFORE its suspend script runs (`pending`: it MAY be suspended) and leaves only after
 * the wake is confirmed (`remove`), never before: every change goes through `onChange`, and what is on disk always names everything that may be
 * frozen. A pending entry is not shown as paused (`list()` carries the flag), blocks a second pause, and is not reconciled.
 *
 * A process is named by pid AND start time (Windows reuses pids): the key is `<pid>:<start>`. `onChange(list)` is told after every
 * change (the paused set is kept on disk, host/pause-persist.js).
 */

const { sameStart } = require('./resource-tree');

const isStart = s => typeof s === 'string' && /^\d+$/.test(s);
const validPid = pid => Number.isInteger(pid) && pid > 0;

function keyOf(pid, start) {
  return validPid(pid) && isStart(start) ? `${pid}:${start}` : null;
}

function createPauseStore({ now = Date.now, onChange = () => {} } = {}) {
  const entries = new Map();   // key -> { pid, start, name, since, pids: [{ pid, start }] }
  const changed = () => { try { onChange([...entries].map(([key, e]) => ({ key, ...e }))); } catch { /* persistence must never break a pause */ } };

  // `pids` is everything suspended with the root, root included: the set a Resume must wake. A narrowed set (what is still suspended after a
  // failed wake) may have lost its root: `rootInSet: false`.
  function valid(e, { rootInSet = true } = {}) {
    if (!e || keyOf(e.pid, e.start) === null || !Array.isArray(e.pids) || e.pids.length === 0) return false;
    if (!e.pids.every(p => p && keyOf(p.pid, p.start) !== null)) return false;
    return !rootInSet || e.pids.some(p => p.pid === e.pid && p.start === e.start);
  }

  return {
    add(e, { rootInSet = true, pending = false } = {}) {
      if (!valid(e, { rootInSet })) return { ok: false, reason: 'invalid' };
      const key = keyOf(e.pid, e.start);
      if (entries.has(key)) return { ok: false, reason: 'already' };
      const since = typeof e.since === 'number' ? e.since : now();
      entries.set(key, { pid: e.pid, start: e.start, name: typeof e.name === 'string' ? e.name : '', since, pending: pending === true, pids: e.pids.map(p => ({ pid: p.pid, start: p.start })) });
      changed();
      return { ok: true, since };
    },
    /** The entry, as it is now (a copy), or null. */
    peek(pid, start) {
      const e = entries.get(keyOf(pid, start));
      return e ? { ...e, pids: e.pids.map(p => ({ ...p })) } : null;
    },
    /** A pending entry whose suspend answered: it is paused now, with the set that was really suspended. */
    confirm(pid, start, pids) {
      const key = keyOf(pid, start);
      const e = key === null ? undefined : entries.get(key);
      if (!e || !Array.isArray(pids) || pids.length === 0 || !pids.every(p => p && keyOf(p.pid, p.start) !== null)) return false;
      entries.set(key, { ...e, pending: false, orphan: false, pids: pids.map(p => ({ pid: p.pid, start: p.start })) });
      changed();
      return true;
    },
    /** What is STILL suspended after a wake that did not complete: the entry keeps only those (root-less if need be), confirmed, no longer an orphan in flight. No members: it is removed. */
    narrow(pid, start, pids) {
      const key = keyOf(pid, start);
      const e = key === null ? undefined : entries.get(key);
      if (!e) return false;
      const keep = (Array.isArray(pids) ? pids : []).filter(p => p && keyOf(p.pid, p.start) !== null);
      if (keep.length === 0) entries.delete(key);
      else entries.set(key, { ...e, pending: false, orphan: false, pids: keep.map(p => ({ pid: p.pid, start: p.start })) });
      changed();
      return true;
    },
    /** The wake is confirmed (or there was nothing to wake): only now does the entry leave. */
    remove(pid, start) {
      const key = keyOf(pid, start);
      if (key === null || !entries.delete(key)) return false;
      changed();
      return true;
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
      changed();
      return e;
    },
    /** Put back an entry `take` handed out (its resume did not go through): same time, still paused. */
    restore(e) {
      // Narrowed to what is still suspended after a partial resume, so the root may be gone from the set.
      if (!valid(e, { rootInSet: false })) return;
      const key = keyOf(e.pid, e.start);
      if (!entries.has(key)) { entries.set(key, e); changed(); }
    },
    /**
     * The processes in a freshly read table. An entry whose root is alive keeps the members that are (narrowed when some left); one with
     * NO member alive ends; one whose root left but whose members are alive ends with `alive: [members]` for the caller to wake.
     * -> [{ ...entry, key, how: 'gone' | 'reused', alive: [{ pid, start }] }]
     */
    reconcile(procs) {
      if (!Array.isArray(procs)) return [];
      const byPid = new Map(procs.filter(p => p && Number.isInteger(p.pid)).map(p => [p.pid, p]));
      const aliveMember = m => { const p = byPid.get(m.pid); return !!p && sameStart(m.start, p.start); };
      const ended = [];
      let touched = false;
      for (const [key, e] of [...entries]) {
        if (e.pending === true) continue;           // its suspend has not answered: nothing is known yet
        const alive = e.pids.filter(aliveMember);
        const root = byPid.get(e.pid);
        const rootAlive = !!root && sameStart(e.start, root.start);
        if (rootAlive && alive.length > 0) {
          if (alive.length !== e.pids.length) { entries.set(key, { ...e, pids: alive }); touched = true; }
          continue;
        }
        if (alive.length > 0) {
          // The root left while members are still suspended: the entry STAYS (flagged, narrowed to them) until their wake is confirmed, and is handed
          // back once; a wake that did not complete clears the flag (`narrow`), so the next sample hands it back again.
          if (e.orphan === true) continue;
          entries.set(key, { ...e, orphan: true, pids: alive });
        } else entries.delete(key);
        touched = true;
        ended.push({ ...e, key, how: root && !rootAlive ? 'reused' : 'gone', alive });
      }
      if (touched) changed();
      return ended;
    },
    list: () => [...entries].map(([key, e]) => ({ key, ...e })),
    /** What the panel shows as paused: not the entries still waiting for their suspend to answer. */
    listConfirmed: () => [...entries].filter(([, e]) => e.pending !== true).map(([key, e]) => ({ key, ...e })),
  };
}

module.exports = { createPauseStore, keyOf };
