'use strict';
/**
 * "One window per project", the launch-time orchestration and the owner's life cycle (DESIGN_TABS_SESSIONS.md 3.3). Out of app/main.js
 * with every effect handed in (PR #247 Miguel I2), so each path is a test and not a regex over main.js.
 *
 *   createWindowClaim(deps) -> { run(), markReady(), stop(), accepting() }
 *
 * run() is called once, before this process makes a window. It answers 'exit' (another window owns the project and has accepted this
 * launch: end without a window) or 'proceed' (make the window). The paths:
 *
 *   live owner accepts          'exit'
 *   owner refuses / unreachable  'proceed', and this window takes the owner file over (a closing owner, a build from before the pipe)
 *   no owner / dead / unproven   'proceed' (the file is ours only when claim published it)
 *   pipe can't listen            'proceed', and a file published for a window nobody can reach is released at once
 *   any throw                    'proceed': the old behaviour, never a crash
 *
 * THE OWNER SAYS NO WHEN IT IS NOT A WINDOW TO HAND LAUNCHES TO (Dexter 1 + 5, Miguel B1 + I1): accepting() is false after stop()
 * (called on before-quit, before a dialog that ends the process, and when startup throws) and, while the window has not finished
 * starting, once readyBoundMs have passed. A launch that is told no opens its own window and takes the file over, so a close followed
 * by a reopen, or a start that failed, never leaves a project with no window.
 *
 * stop() is idempotent: it releases the owner file (only while it still names THIS process, pid and start time) and closes the pipe.
 *
 * deps: enabled, stateRoot, pid, ownStart() -> start|null, startTimes, project, launchCwd, explicitPort,
 *       listen, claim, send, takeOver, release, forwardedCwd (host/window-owner.js, host/window-focus.js),
 *       act(msg) (what the window does with a launch: focus, select the lane), onExit(fn) (run fn when the process exits),
 *       now, readyBoundMs, log.
 */

const DEFAULT_READY_BOUND_MS = 180_000;

function createWindowClaim(deps) {
  const {
    enabled, stateRoot, pid, ownStart, startTimes, project, launchCwd, explicitPort,
    listen, claim, send, takeOver, release, forwardedCwd, act, onExit,
  } = deps;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const readyBoundMs = Number.isFinite(deps.readyBoundMs) ? deps.readyBoundMs : DEFAULT_READY_BOUND_MS;

  const t0 = now();
  let pipe = null;
  let self = { pid, start: null };
  let ready = false;
  let stopped = false;
  let released = false;
  let readyResolve;
  const readyPromise = new Promise((resolve) => { readyResolve = resolve; });

  const accepting = () => !stopped && (ready || now() - t0 < readyBoundMs);

  function releaseFile() {
    if (released) return;
    released = true;
    try { release({ stateRoot, selfPid: pid, selfStart: self.start }); } catch { /* the proof copes with a leftover */ }
  }

  function markReady() { ready = true; readyResolve(); }

  function stop() {
    if (stopped) return;
    stopped = true;
    releaseFile();
    readyResolve();                      // anything waiting on the window being ready is let go (it checks `stopped`)
    const p = pipe;
    pipe = null;
    if (p) Promise.resolve().then(() => p.close()).catch(() => {});
  }

  // A launch came in and was answered 'accepted': act once this window is up (never for one that is quitting).
  async function onLaunch(msg) {
    await readyPromise;
    if (stopped) return;
    await act(msg);
  }

  async function run() {
    if (!enabled) return 'proceed';
    try {
      pipe = await listen({ pid, onFocus: onLaunch, accepting, log }).catch((err) => {
        log(`[main] one window: no launch pipe (${err && err.message})`);
        return null;
      });
      self = { pid, start: await ownStart() };
      const r = await claim({ stateRoot, self, startTimes });
      let published = r.published === true;
      if (r.action === 'focus') {
        const msg = {};
        const cwd = forwardedCwd(launchCwd, project);
        if (cwd) msg.cwd = cwd;
        if (Number.isInteger(explicitPort)) msg.port = explicitPort;
        const told = await send({ pid: r.owner.pid, msg });
        if (told && told.ok === true) {
          log(`[main] one window: this project's window (pid ${r.owner.pid}) has it; this launch ends`);
          const p = pipe;
          pipe = null;
          if (p) await Promise.resolve().then(() => p.close()).catch(() => {});
          return 'exit';
        }
        // A proven owner that won't take it (closing, or a build from before the pipe): a window of its own, which then owns the file.
        const why = told && typeof told.error === 'string' ? told.error : 'no usable answer';
        log(`[main] one window: owner pid ${r.owner.pid} did not accept (${why}); opening a window and taking the owner file over`);
        published = takeOver({ stateRoot, self }) === true;
      }
      if (published && !pipe) releaseFile();     // a file naming a window nobody can reach
      else if (published) onExit(releaseFile);   // gone with the process, however it ends (app.exit skips will-quit)
      return 'proceed';
    } catch (err) {
      log(`[main] one window: the check failed, opening a window: ${err && err.message}`);
      return 'proceed';
    }
  }

  return { run, markReady, stop, accepting };
}

module.exports = { createWindowClaim, DEFAULT_READY_BOUND_MS };
