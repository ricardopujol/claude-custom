'use strict';
/**
 * The paused set, kept on disk (BACKLOG #19, PR #158 Miguel Y4 / Dexter 8): a crash of the app, the quit watchdog's kill or a power loss
 * to the Electron process skips will-quit, and a process left suspended with nobody who knows about it stays frozen. So each app instance
 * writes what it has paused to `paused-<ownPid>.json`; the next start reads the files of owners that are no longer running, wakes those
 * processes (every one proved again by its start time, so a reused pid is never touched) and removes the file.
 *
 * ONE FILE PER OWNER, because two windows share the folder: a window must never wake what ANOTHER LIVE window paused. An owner is dead
 * only when `isAlive(pid)` says so; a pid that Windows has handed to another process reads alive, and then the file is simply left (the
 * safe direction: nothing is woken that might be someone's).
 *
 * `save(list)` is atomic (host/atomic-write.js) and removes the file when nothing is paused. Everything it does is caught: persistence
 * is a safety net and must never break a Pause.
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const PREFIX = 'paused-';
const NAME = /^paused-(\d+)\.json$/;
const isStart = s => typeof s === 'string' && /^\d+$/.test(s);
const isEntry = e => !!e && Number.isInteger(e.pid) && e.pid > 0 && isStart(e.start)
  && Array.isArray(e.pids) && e.pids.length > 0 && e.pids.every(p => p && Number.isInteger(p.pid) && p.pid > 0 && isStart(p.start));

function createPausePersist({ dir, ownPid, isAlive = () => true, log = () => {}, fsx = fs } = {}) {
  const fileOf = pid => path.join(dir, `${PREFIX}${pid}.json`);

  return {
    save(list) {
      try {
        const entries = (Array.isArray(list) ? list : []).filter(isEntry)
          .map(e => ({ pid: e.pid, start: e.start, name: typeof e.name === 'string' ? e.name : '', since: typeof e.since === 'number' ? e.since : null, pids: e.pids.map(p => ({ pid: p.pid, start: p.start })) }));
        if (entries.length === 0) { try { fsx.unlinkSync(fileOf(ownPid)); } catch { /* none */ } return; }
        fsx.mkdirSync(dir, { recursive: true });
        writeFileAtomic(fileOf(ownPid), JSON.stringify({ ownPid, entries }));
      } catch (err) { log('[pause] could not save the paused set:', err && err.message); }
    },
    /** The entries of every file whose owner is gone, and those files removed. A file that cannot be read is left alone. Never this owner's own. */
    takeDead() {
      const out = [];
      let names = [];
      try { names = fsx.readdirSync(dir); } catch { return out; }
      for (const name of names) {
        const m = NAME.exec(name);
        if (!m || Number(m[1]) === ownPid || isAlive(Number(m[1])) !== false) continue;
        const file = path.join(dir, name);
        try {
          const doc = JSON.parse(fsx.readFileSync(file, 'utf8'));
          for (const e of (doc && Array.isArray(doc.entries) ? doc.entries : [])) if (isEntry(e)) out.push(e);
          fsx.unlinkSync(file);
        } catch (err) { log('[pause] could not read', name, err && err.message); }
      }
      return out;
    },
  };
}

module.exports = { createPausePersist };
