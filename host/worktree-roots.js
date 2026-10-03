'use strict';
/**
 * The worktree folders `git worktree list` knows, cached, for the occupancy producer
 * (host/occupancy-producer.js, backlog #44 + #47).
 *
 * EVERY listed worktree is a root, a worktree nested under `dev\` (a subagent's own isolation worktree,
 * `dev\.claude\worktrees\*`) included: that is exactly where an agent can be working. host/worktree-list.js
 * tabWorktrees is narrower on purpose (what may get a TAB); a claim in a folder that has no tab draws
 * nothing on the strip and still shows on the agent's card. A prunable worktree (its folder is gone) and a
 * bare repo are not places an agent works, so they aren't roots.
 *
 *   get()      the cached roots, synchronously (the host's own folder until the first answer)
 *   stale()    older than ttlMs, never answered, or the last ask failed
 *   refresh()  Promise<roots>; overlapping calls share one git run, and a new run waits minGapMs after the
 *              last one so a failing git can't be hammered by a busy agent
 *
 * A failure keeps the last good list (logged once); an answer that names no worktree at all is read as a
 * failure, never as "there are none".
 */

const path = require('path');
const { execFile } = require('child_process');
const { parsePorcelain } = require('./worktree-list');
const { samePath } = require('./project-layout');

function rootsFromPorcelain(text) {
  return parsePorcelain(text)
    .filter(e => e && !e.bare && !e.prunable && typeof e.path === 'string' && e.path !== '')
    .map(e => path.resolve(e.path));
}

function gitRun(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

function createRootsProvider({
  cwd, run = (args) => gitRun(args, cwd), now = Date.now, ttlMs = 15000, minGapMs = 2000, log = () => {},
} = {}) {
  const own = path.resolve(cwd);
  let roots = [own];
  let okAt = null;
  let attemptedAt = null;
  let inflight = null;
  let loggedFailure = false;

  function stale() {
    return okAt === null || now() - okAt >= ttlMs;
  }

  function refresh() {
    if (inflight) return inflight;
    if (attemptedAt !== null && now() - attemptedAt < minGapMs) return Promise.resolve(roots);
    attemptedAt = now();
    inflight = (async () => {
      try {
        const found = rootsFromPorcelain(await run(['-C', own, 'worktree', 'list', '--porcelain']));
        if (found.length === 0) throw new Error('git listed no worktree');
        if (!found.some(p => samePath(p, own))) found.unshift(own);
        roots = found;
        okAt = now();
        loggedFailure = false;
      } catch (err) {
        if (!loggedFailure) { loggedFailure = true; log('[occupancy] could not list worktrees:', err && err.message); }
      } finally {
        inflight = null;
      }
      return roots;
    })();
    return inflight;
  }

  return { get: () => roots.slice(), stale, refresh };
}

module.exports = { createRootsProvider, rootsFromPorcelain };
