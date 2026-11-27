'use strict';
/**
 * "One window per project", the launch-time orchestration and the owner's life cycle (DESIGN_TABS_SESSIONS.md 3.3). Out of app/main.js
 * with every effect handed in (PR #247 Miguel I2), so each path is a test and not a regex over main.js.
 * SINGLE-INSTANCE PR 3: every window of a process holds one (its listen is host/window-router.js register), and the APP lock is this same
 * claim with another owner file, pipe and message (host/app-claim.js), through the optional deps below; not a second copy.
 *
 *   createWindowClaim(deps) -> { run(), markReady(), stop(), resume(), accepting() }
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
 * Optional (single-instance PR 3): root (this window's project root: sent as msg.root, and handed to listen with hasPort(port), so
 *       listen may be host/window-router.js register), message() (the message to send, replacing the root/lane/port one: the app claim's
 *       open), tag (the log lines' name, default 'one window'), ackMs (ask the owner for the ack), prove(owner) (re-proof after a missed
 *       ack). A missed ack is not a refusal by itself (PR #258 Dexter 1): an owner still proven live, or not proven gone, gets one more send
 *       with the full wait; only its silence then (a true hang) is a refusal.
 */

const DEFAULT_READY_BOUND_MS = 180_000;
const SEND_SLACK_MS = 10_000;       // a launch waits this much longer than the owner may take to be ready
const MAX_TAKEOVER_TRIES = 3;       // sends a launch makes (each may wait readyBound + slack) before it just opens its window

function createWindowClaim(deps) {
  const {
    enabled, stateRoot, pid, ownStart, startTimes, project, launchCwd, explicitPort,
    listen, claim, send, takeOver, release, forwardedCwd, act, onExit,
    root, hasPort, message, ackMs,
  } = deps;
  const tag = typeof deps.tag === 'string' && deps.tag ? deps.tag : 'one window';
  // proof of the owner after a missed ack: 'live' | 'dead' | 'unknown' (default: the owner-file proof by pid + start)
  const prove = typeof deps.prove === 'function' ? deps.prove : (owner) => require('./owner-file').proveOwner(owner, { startTimes });
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const readyBoundMs = Number.isFinite(deps.readyBoundMs) ? deps.readyBoundMs : DEFAULT_READY_BOUND_MS;

  const t0 = now();
  // The hold is measured on a monotonic clock, like the launch's own send timer: a wall-clock step back must not stretch the hold past
  // the launch's wait (PR #248 Dexter 2).
  const mono = deps.mono || (() => performance.now());
  const monoT0 = mono();
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
      const left = Math.min(readyBoundMs, Math.max(0, readyBoundMs - (mono() - monoT0)));
      const timer = setTimeout(() => resolve(false), left);
      if (timer.unref) timer.unref();
      readyPromise.then(() => { clearTimeout(timer); resolve(ready && !stopped); });
    });
  }

  // A launch came in and was answered 'accepted' (so this window is ready): act on it (never for one that is quitting). The wait stays for
  // a caller that hands a message in directly before ready; through the pipe it is already resolved.
  async function onLaunch(msg) {
    await readyPromise;
    if (stopped) return;
    await act(msg);
  }

  const listenOpts = () => ({ pid, root, hasPort, onFocus: onLaunch, accepting, whenReady, log });

  function launchMessage() {
    if (typeof message === 'function') return message();
    const msg = {};
    if (typeof root === 'string' && root) msg.root = root;
    const cwd = forwardedCwd(launchCwd, project);
    if (cwd) msg.cwd = cwd;
    if (Number.isInteger(explicitPort)) msg.port = explicitPort;
    return msg;
  }
  let exitHooked = false;
  const hookExit = () => { if (exitHooked) return; exitHooked = true; onExit(releaseFile); };   // gone with the process, however it ends (app.exit skips will-quit)

  async function run() {
    if (!enabled) return 'proceed';
    try {
      pipe = await listen(listenOpts()).catch((err) => {
        log(`[main] ${tag}: no launch pipe (${err && err.message})`);
        return null;
      });
      self = { pid, start: await ownStart() };
      let r = await claim({ stateRoot, self, startTimes });
      let published = r.published === true;
      // A refused launch takes the file over only with the bytes it judged; when another launch took over first, the takeover fails and
      // the claim is made again, which finds that window and hands this launch to it (PR #247 Dexter M3). Bounded: never a loop.
      for (let attempt = 0; r.action === 'focus'; attempt++) {
        const msg = launchMessage();
        // Waits as long as the owner may take to be ready, then the owner has said ok (and will act) or no. With ackMs, an owner that does
        // not even acknowledge (hung) is a refusal within ackMs.
        let told = await send({ pid: r.owner.pid, msg, timeoutMs: readyBoundMs + SEND_SLACK_MS, ackMs });
        // PR #258 Dexter 1 / Miguel S2: no ack is NOT proof of a hang. A starting Electron at full CPU (or an owner of older code, which never
        // acks) can miss the bound. The owner is proven again; unless it is now proven gone, it gets one more send with no ack bound and the
        // full wait, and only a second silence (a true hang) lets this launch go on and take the file over.
        if (Number.isFinite(ackMs) && told && told.error === 'no ack') {
          let proof = 'unknown';
          try { proof = await prove(r.owner); } catch { proof = 'unknown'; }
          if (proof !== 'dead') {
            log(`[main] ${tag}: owner pid ${r.owner.pid} did not acknowledge within ${ackMs} ms but is ${proof === 'live' ? 'still alive' : 'not proven gone'}; waiting for its answer`);
            told = await send({ pid: r.owner.pid, msg, timeoutMs: readyBoundMs + SEND_SLACK_MS });
          }
        }
        if (told && told.ok === true) {
          // verify/probe-one-window.js check 2 reads the window claim's wording
          log(`[main] ${tag}: ${tag === 'one window' ? "this project's window" : 'the owner'} (pid ${r.owner.pid}) has it; this launch ends`);
          const p = pipe;
          pipe = null;
          if (p) await Promise.resolve().then(() => p.close()).catch(() => {});
          return 'exit';
        }
        // A proven owner that won't take it (closing, or a build from before the pipe): a window of its own, which then owns the file.
        const why = told && typeof told.error === 'string' ? told.error : 'no usable answer';
        log(`[main] ${tag}: owner pid ${r.owner.pid} did not accept (${why}); going on here and taking the owner file over`);
        if (takeOver({ stateRoot, self, judgedText: r.text }) === true) { published = true; break; }
        published = false;
        if (attempt + 1 >= MAX_TAKEOVER_TRIES) break;
        r = await claim({ stateRoot, self, startTimes });
        published = r.published === true;
      }
      // PR #258 Dexter 4: going on WITHOUT the owner file (an owner that could not be proven, no start time of our own, a contended or
      // foreign file) is said, with the reason: under load it is a second process (or window), and the log is the only trace of why.
      if (!published && r && r.action === 'proceed' && r.reason !== 'self') log(`[main] ${tag}: going on here without the owner file (${r.reason})`);
      if (published && !pipe) releaseFile();     // a file naming a window nobody can reach
      else if (published) hookExit();
      return 'proceed';
    } catch (err) {
      log(`[main] ${tag}: the check failed, going on here: ${err && err.message}`);
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
      const p = await listen(listenOpts()).catch((err) => { log(`[main] ${tag}: no launch pipe on resume (${err && err.message})`); return null; });
      if (stopped) { if (p) await p.close().catch(() => {}); return; }       // stopped again while listening: quitting for real
      pipe = p;
      const r = await claim({ stateRoot, self, startTimes });
      if (stopped) {
        // A quit landed while the claim ran: stop() found no file to release yet, so release what the claim just published.
        if (r.published === true) { released = false; releaseFile(); }
        return;
      }
      if (r.published === true && pipe) hookExit();
      else if (r.published === true) releaseFile();
      else if (pipe) { const q = pipe; pipe = null; await q.close().catch(() => {}); }
    } catch (err) {
      log(`[main] ${tag}: resume failed: ${err && err.message}`);
    }
  }

  // PR #258 Dexter 2: an owner that was passed by (it looked hung, a launch took the file over) and then left by that launch (which quit,
  // releasing the file) owned nothing for the rest of its life. While it runs, it claims again: the file is taken only when it names nobody
  // alive (no file, a dead owner, or this process); a LIVE other owner is left alone. true when the file names this process again.
  async function reclaim() {
    if (!enabled || stopped || !pipe) return false;
    try {
      const r = await claim({ stateRoot, self, startTimes });
      if (stopped) { if (r.published === true) { released = false; releaseFile(); } return false; }
      if (r.published !== true) return false;
      released = false;
      hookExit();
      log(`[main] ${tag}: the owner file named nobody alive; this process owns it again`);
      return true;
    } catch (err) {
      log(`[main] ${tag}: reclaim failed: ${err && err.message}`);
      return false;
    }
  }

  return { run, markReady, stop, resume, accepting, reclaim };
}

module.exports = { createWindowClaim, DEFAULT_READY_BOUND_MS };
