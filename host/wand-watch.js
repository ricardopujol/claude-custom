'use strict';
/**
 * Tell this host when something the wand shows changes underneath it (BACKLOG #51): its own state file
 * (`wand.json`, install-wide, so another host's edit must reach THIS host's windows) and the skill
 * directories the CLI reads (a skill added or removed while the harness runs).
 *
 * The host/loadout-watch.js pattern, kept as one small generic copy rather than three:
 *   - watch the DIRECTORY, not the file. The store writes by rename, which replaces the inode; a watch
 *     on the file itself goes deaf after the first write on some platforms.
 *   - filter with `match(filename)` (a null filename, which some platforms send, is "maybe").
 *   - DEBOUNCE: one write is several events (temp file, rename).
 *   - RE-ARM on error: a watcher that died silently is a panel that never refreshes again.
 *
 * AND the two differences a skills directory brings:
 *   - it may NOT EXIST yet (a project with no .claude/skills, a machine with no plugins), and it
 *     belongs to the CLI: watching it must never create it. `create: true` is for our own state dir
 *     only. A missing directory is retried every `rearmMs`, and when it appears that fires onChange
 *     once, since skills may have arrived with it.
 *   - it is RECURSIVE (`skills/<name>/SKILL.md`). A platform that refuses a recursive watch gets a plain
 *     one rather than none.
 *
 * The callback is told nothing but "look again"; whether anything really changed is the caller's job.
 */
const fs = require('fs');
const path = require('path');

function watchDir({ dir, match, onChange, create = false, recursive = false, debounceMs = 150,
  rearmMs = 2000, watch = fs.watch } = {}) {
  if (!dir) throw new Error('watchDir: dir is required');
  if (typeof match !== 'function') throw new Error('watchDir: match is required');
  if (typeof onChange !== 'function') throw new Error('watchDir: onChange is required');

  let watcher = null;
  let timer = null;
  let rearm = null;
  let closed = false;
  let waited = false;     // the directory was missing at least once

  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (closed) return;
      try { onChange(); } catch { /* a bad callback must not kill the watcher */ }
    }, debounceMs);
  };

  const later = () => {
    if (closed) return;
    clearTimeout(rearm);
    rearm = setTimeout(arm, rearmMs);
  };

  function arm() {
    if (closed) return;
    if (create) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the watch below will say */ }
    } else {
      let there = false;
      try { there = fs.statSync(dir).isDirectory(); } catch { /* not there yet */ }
      if (!there) { waited = true; later(); return; }
    }
    const onEvent = (_event, filename) => {
      if (filename === null || filename === undefined || match(String(filename))) fire();
    };
    try {
      try {
        watcher = watch(dir, { recursive }, onEvent);
      } catch (err) {
        if (!recursive) throw err;
        watcher = watch(dir, { recursive: false }, onEvent);
      }
      watcher.on('error', () => {
        try { watcher.close(); } catch { /* already dead */ }
        watcher = null;
        later();
        fire();                       // something may have changed while the watcher was down
      });
      // The directory appeared after we started looking for it: skills may have come with it.
      if (waited) { waited = false; fire(); }
    } catch {
      watcher = null;
      later();
    }
  }

  arm();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(rearm);
      try { if (watcher) watcher.close(); } catch { /* already closed */ }
    },
    path: path.resolve(dir),
  };
}

module.exports = { watchDir };
