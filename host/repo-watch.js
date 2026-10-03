'use strict';
/**
 * The Files tab's live refresh (#45): a debounced, re-arming watch of the worktree, so a file Claude writes
 * appears in the tree, and a file changed under an open reader raises the Reload bar, without a reload.
 *
 *   watchRepo(root, onChange, deps) -> { close() }
 *
 * It is host/global-watch.js (debounce, re-arm after a dead watcher, never throws, best effort) with three
 * differences, each a hazard of watching a whole worktree:
 *   - RECURSIVE (Windows and macOS support it natively), so a write three folders down is seen.
 *   - FILTERED. A worktree has folders that change constantly and mean nothing to the listing: `.git`,
 *     `node_modules`, and this app's own `.harness` / `.stryker-tmp`. An event in one never arms the timer,
 *     so an `npm install` or a git operation doesn't keep the debounce from ever firing.
 *   - NEVER CREATES THE FOLDER. global-watch makes its folder if missing, because the first global picture
 *     is the case that matters there. Here a missing folder is a DELETED worktree, and a watcher must not
 *     conjure it back.
 * 300ms of quiet before onChange: Claude's Edit is a handful of events, and git ls-files costs a process.
 */
const fs = require('fs');
const { watchGlobalDir } = require('./global-watch');

const IGNORED = new Set(['.git', 'node_modules', '.harness', '.stryker-tmp']);
const DEBOUNCE_MS = 300;

/** Is this event's file somewhere under a folder the listing doesn't care about? */
function ignoredEvent(filename) {
  if (typeof filename !== 'string' || filename === '') return false;     // unnamed: can't tell, so keep it
  return filename.split(/[\\/]/).some(seg => IGNORED.has(seg));
}

// global-watch's own messages talk about "the global picture folder" and a dead watcher retries every
// second: said here in this module's words, and at most once a minute, so a deleted worktree isn't a log flood.
const LOG_EVERY_MS = 60 * 1000;
function throttledLog(write, now) {
  let last = -Infinity;
  return (...args) => {
    const t = now();
    if (t - last < LOG_EVERY_MS) return;
    last = t;
    const detail = args.length > 1 ? String(args[args.length - 1]) : '';
    write(`[host] the worktree watch (Files tab) has a problem${detail ? `: ${detail}` : ''}; the tree still refreshes when it is opened`);
  };
}

function watchRepo(root, onChange, deps = {}) {
  const fsWatch = deps.fsWatch || fs.watch;
  const log = throttledLog(deps.log || console.log, deps.now || Date.now);
  return watchGlobalDir(root, onChange, {
    watch: (dir, handler) => fsWatch(dir, { recursive: true }, (eventType, filename) => {
      if (ignoredEvent(filename === null || filename === undefined ? filename : String(filename))) return;
      handler(eventType, filename);
    }),
    mkdirSync: () => {},
    delayMs: DEBOUNCE_MS,
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    log,
  });
}

module.exports = { watchRepo, ignoredEvent, IGNORED, DEBOUNCE_MS, LOG_EVERY_MS };
