'use strict';
/**
 * The paused set, kept on disk (BACKLOG #19, PR #158 Miguel Y4 / Dexter 8, R2-2, R2-3, R2-7): a crash of the app, the quit watchdog's kill or a power
 * loss to the Electron process skips will-quit, and a process left suspended with nobody who knows about it stays frozen. So each app instance writes
 * what it MAY have suspended to `paused-<ownPid>-<ownStart>.json` (the store is written ahead: host/pause-state.js), and any later instance reads the
 * files of owners that are no longer running, wakes those processes (every one proved again by its start time, so a reused pid is never touched)
 * and only then removes the file.
 *
 * AN OWNER IS A PID AND A START TIME (R2-3). A relaunch that Windows gave the dead owner's pid is a different owner: its own file has another name,
 * and the stale one is found and woken, never overwritten or deleted. `ownerState(pid)` answers 'absent' (not running), the running process's start
 * time (a string), or null (could not be told); an owner is dead only when absent, or running with a start that is not the file's. Unknown is alive:
 * nothing is woken that might be another live window's.
 *
 * REMOVAL WAITS FOR THE WAKE (R2-7). `takeDead()` returns { entries, release }: the caller records the entries in its own store, wakes them, and calls
 * `release()` only after; a throw before that leaves the files. A live window runs this on a timer too, so a sibling that died later is swept.
 *
 * `save(list)` is atomic (host/atomic-write.js) and removes this owner's file when nothing is recorded. Persistence is a safety net and must never
 * break a Pause: every failure is caught and logged.
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const NAME = /^paused-(\d+)-(\d+|unknown)\.json$/;
const isStart = s => typeof s === 'string' && /^\d+$/.test(s);
const isEntry = e => !!e && Number.isInteger(e.pid) && e.pid > 0 && isStart(e.start)
  && Array.isArray(e.pids) && e.pids.length > 0 && e.pids.every(p => p && Number.isInteger(p.pid) && p.pid > 0 && isStart(p.start));

function createPausePersist({ dir, ownPid, ownStart, ownerState = async () => null, log = () => {}, fsx = fs } = {}) {
  const startPart = isStart(ownStart) ? ownStart : 'unknown';
  const fileOf = (pid, start) => path.join(dir, `paused-${pid}-${start}.json`);
  const own = fileOf(ownPid, startPart);

  return {
    save(list) {
      try {
        const entries = (Array.isArray(list) ? list : []).filter(isEntry)
          .map(e => ({ pid: e.pid, start: e.start, name: typeof e.name === 'string' ? e.name : '', since: typeof e.since === 'number' ? e.since : null, pids: e.pids.map(p => ({ pid: p.pid, start: p.start })) }));
        if (entries.length === 0) { try { fsx.unlinkSync(own); } catch { /* none */ } return; }
        fsx.mkdirSync(dir, { recursive: true });
        writeFileAtomic(own, JSON.stringify({ ownPid, ownStart: startPart, entries }));
      } catch (err) { log('[pause] could not save the paused set:', err && err.message); }
    },
    /** -> { entries, release() }: the entries of every file whose owner is dead. Nothing is removed until `release()`. A file that cannot be read is left alone. */
    async takeDead() {
      const entries = [];
      const files = [];
      let names = [];
      try { names = fsx.readdirSync(dir); } catch { return { entries, release() {} }; }
      for (const name of names) {
        const m = NAME.exec(name);
        if (!m || (Number(m[1]) === ownPid && m[2] === startPart)) continue;
        let state = null;
        try { state = await ownerState(Number(m[1])); } catch { state = null; }
        // An owner whose own start was never read ('unknown') can't be told from a reused pid: dead only when its pid isn't running (N2).
        const dead = state === 'absent' || (isStart(state) && isStart(m[2]) && state !== m[2]);
        if (!dead) continue;
        const file = path.join(dir, name);
        let doc;
        try { doc = JSON.parse(fsx.readFileSync(file, 'utf8')); } catch (err) { log('[pause] could not read', name, err && err.message); continue; }
        for (const e of (doc && Array.isArray(doc.entries) ? doc.entries : [])) if (isEntry(e)) entries.push(e);
        files.push(file);
      }
      return {
        entries,
        release() { for (const file of files) { try { fsx.unlinkSync(file); } catch (err) { log('[pause] could not remove', path.basename(file), err && err.message); } } },
      };
    },
  };
}

module.exports = { createPausePersist };
