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
 * A LAUNCH IS ONLY TOLD ok BY A WINDOW THAT IS READY (PR #247 round 2, Dexter M2): a launch that arrives while the window is still
 * starting is held on the pipe until markReady() (then ok + act), or answered no when the window stops or the start bound passes
 * (then that launch opens its own window), so an owner that ends before it is ready never swallows a launch. resume() undoes stop()
 * for a quit that was cancelled (M1). A refused launch takes the file over only with the bytes it judged, else it claims again (M3).
 *
 * stop() is idempotent: it releases the owner file (only while it still names THIS process, pid and start time) and closes the pipe.
 *
 * deps: enabled, stateRoot, pid, ownStart() -> start|null, startTimes, project, launchCwd, explicitPort,
 *       listen, claim, send, takeOver, release, forwardedCwd (host/window-owner.js, host/window-focus.js),
 *       act(msg) (what the window does with a launch: focus, select the lane), onExit(fn) (run fn when the process exits),
 *       now, readyBoundMs, log.
 */

const DEFAULT_READY_BOUND_MS = 180_000;
const SEND_SLACK_MS = 10_000;       // a launch waits this much longer than the owner may take to be ready

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
  let closing = Promise.resolve();       // the pipe stop() is closing: resume() listens on the same name only after it is gone
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
    if (p) closing = Promise.resolve().then(() => p.close()).catch(() => {});
  }

  // Resolves true once this window is ready for launches; false when it stopped, or its start has not finished within readyBoundMs.
  // The pipe holds a launch on this (never says ok to a window that may still end before it is ready: PR #247 Dexter M2).
  function whenReady() {
    if (stopped) return Promise.resolve(false);
    if (ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(0, readyBoundMs - (now() - t0)));
      if (timer.unref) timer.unref();
      readyPromise.then(() => { clearTimeout(timer); resolve(ready && !stopped); });
    });
  }

  // A launch came in and was answered 'accepted' (so this window is ready): act on it (never for one that is quitting).
  async function onLaunch(msg) {
    await readyPromise;
    if (stopped) return;
    await act(msg);
  }

  const listenOpts = () => ({ pid, onFocus: onLaunch, accepting, whenReady, log });
  let exitHooked = false;
  const hookExit = () => { if (exitHooked) return; exitHooked = true; onExit(releaseFile); };   // gone with the process, however it ends (app.exit skips will-quit)

  async function run() {
    if (!enabled) return 'proceed';
    try {
      pipe = await listen(listenOpts()).catch((err) => {
        log(`[main] one window: no launch pipe (${err && err.message})`);
        return null;
      });
      self = { pid, start: await ownStart() };
      let r = await claim({ stateRoot, self, startTimes });
      let published = r.published === true;
      // A refused launch takes the file over only with the bytes it judged; when another launch took over first, the takeover fails and
      // the claim is made again, which finds that window and hands this launch to it (PR #247 Dexter M3). Bounded: never a loop.
      for (let attempt = 0; r.action === 'focus'; attempt++) {
        const msg = {};
        const cwd = forwardedCwd(launchCwd, project);
        if (cwd) msg.cwd = cwd;
        if (Number.isInteger(explicitPort)) msg.port = explicitPort;
        // Waits as long as the owner may take to be ready, then the owner has said ok (and will act) or no.
        const told = await send({ pid: r.owner.pid, msg, timeoutMs: readyBoundMs + SEND_SLACK_MS });
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
        if (takeOver({ stateRoot, self, judgedText: r.text }) === true) { published = true; break; }
        published = false;
        if (attempt >= 2) break;
        r = await claim({ stateRoot, self, startTimes });
        published = r.published === true;
      }
      if (published && !pipe) releaseFile();     // a file naming a window nobody can reach
      else if (published) hookExit();
      return 'proceed';
    } catch (err) {
      log(`[main] one window: the check failed, opening a window: ${err && err.message}`);
      return 'proceed';
    }
  }

  // A quit that was cancelled (Cancel on the unsaved-text prompt): the window stays, so it is the project's owner again. stop() is hooked
  // to before-quit, which a cancel does not announce (PR #247 Dexter M1). Listens again and claims the file again; if another window took
  // the file meanwhile (a launch during the quit), this one stays unowned: two windows already exist, the file keeps naming the newer.
  async function resume() {
    if (!enabled || !stopped) return;
    stopped = false;
    released = false;
    try {
      await closing;
      if (stopped) return;
      const p = await listen(listenOpts()).catch((err) => { log(`[main] one window: no launch pipe on resume (${err && err.message})`); return null; });
      if (stopped) { if (p) await p.close().catch(() => {}); return; }       // stopped again while listening: quitting for real
      pipe = p;
      const r = await claim({ stateRoot, self, startTimes });
      if (stopped) return;
      if (r.published === true && pipe) hookExit();
      else if (r.published === true) releaseFile();
      else if (pipe) { const q = pipe; pipe = null; await q.close().catch(() => {}); }
    } catch (err) {
      log(`[main] one window: resume failed: ${err && err.message}`);
    }
  }

  return { run, markReady, stop, resume, accepting };
}

module.exports = { createWindowClaim, DEFAULT_READY_BOUND_MS };
