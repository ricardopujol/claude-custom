'use strict';
const path = require('path');
/**
 * BACKLOG #217: Claude Code's auto-update rewrites claude.exe in place, and a spawn that lands in that window fails (node-pty: "Cannot
 * create process, error code: 216", a truncated exe) and left the tab empty for good. This is the decision (is the failure the "binary
 * not usable right now" kind, is it still worth another try) and the chain that acts on it, with every collaborator injected: the host
 * owns the real clock, timers and tab (host/host.js), the tests a fake clock.
 */

const RETRY_EVERY_MS = 5000;
const GIVE_UP_AFTER_MS = 120000;
// On-screen wording: Ricardo's pick is pending (PR #252 Miguel G1), so each line is one constant. The give-up's "[claude did not start]" is
// app/top-bar-display.js shellExitText.
const RETRY_LINE = "Claude Code isn't ready (it may be updating), retrying for up to 2 minutes…";
const VERSION_RETRIES = 2;
const VERSION_RETRY_GAP_MS = 1500;

// Windows 216 ERROR_EXE_MACHINE_TYPE_MISMATCH, 193 ERROR_BAD_EXE_FORMAT, 32 ERROR_SHARING_VIOLATION, as node-pty words them: the file is
// there, just not whole or not free. And "File not found" / ENOENT / EACCES / EPERM, which a binary that was never there gives too.
const PTY_CODE = /error code: (?:216|193|32)\b/;
const PTY_NOT_FOUND = /^File not found\b/;
const ALWAYS_CODES = new Set(['EBUSY']);
const IF_IT_EXISTED_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);

/**
 * Is a claude installed here, even if its exe is not on disk this second? An update deletes claude.exe and writes it again, so a tab
 * opened in that window boots with no exe (measured 2026-11-11: "claude binary : claude.exe", the bare PATH fallback, then "File not
 * found" and a blank tab for good). The exe being there is the strongest proof; failing that, the CLI's own data folder is (the native
 * installer keeps it through an update). The npm package folder is not a marker: npm moves it aside in the same update that removes the
 * exe, so it would vanish together with it (PR #253 Dexter 2). A CLAUDE_CUSTOM_BIN that isn't there is a typo and stays one. All the
 * filesystem reads are the injected `exists`.
 */
function claudeLooksInstalled({ bin, explicit, exists, home }) {
  if (exists(bin)) return true;
  if (explicit) return false;
  return exists(path.join(home, '.local/share/claude'));
}

/**
 * The one answer to "which claude do I run": the boot's path while it is there, else resolved again (a boot in an update's gap holds the
 * bare PATH name, which may not even resolve from the host's environment). The pty spawn, the version read and Ask all call it, so none
 * of them keeps the boot value (PR #253 Dexter 1, Miguel Y1/Y2). A path that changes is said once.
 */
function createLiveBin({ initial, exists, resolve, log }) {
  let current = initial;
  return function liveBin() {
    if (!exists(current)) {
      const found = resolve();
      if (found !== current) {
        log(`claude binary : ${found} (was ${current}, which is not there)`);
        current = found;
      }
    }
    return current;
  };
}

function messageOf(err) {
  if (typeof err === 'string') return err;
  return err && typeof err.message === 'string' ? err.message : '';
}

/**
 * Does this spawn error mean the binary is not usable right now? Anything else is a real failure and stays one. `binExisted`: the exe was
 * there when the host booted. A path that never existed (no claude installed, a typo'd CLAUDE_CUSTOM_BIN) fails at once with its real
 * error instead of two minutes of "updating" (PR #252 Dexter 2 / Miguel Y2).
 */
function isRetryableSpawnError(err, { binExisted = true } = {}) {
  const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : null;
  if (code !== null && ALWAYS_CODES.has(code)) return true;
  if (PTY_CODE.test(messageOf(err))) return true;
  if (binExisted !== true) return false;
  return (code !== null && IF_IT_EXISTED_CODES.has(code)) || PTY_NOT_FOUND.test(messageOf(err));
}

/**
 * What to do after a spawn failed. `firstFailedAt` is null on the first failure. -> { action: 'fail' } (not ours: propagate),
 * { action: 'retry', delayMs, firstFailedAt, first }, or { action: 'give-up' } (the next try would land past the bound).
 */
function nextStep({ err, firstFailedAt, now, binExisted = true }) {
  if (!isRetryableSpawnError(err, { binExisted })) return { action: 'fail' };
  const first = typeof firstFailedAt === 'number';
  const since = first ? firstFailedAt : now;
  if (now + RETRY_EVERY_MS > since + GIVE_UP_AFTER_MS) return { action: 'give-up' };
  return { action: 'retry', delayMs: RETRY_EVERY_MS, firstFailedAt: since, first: !first };
}

/** The line a tab shows when the bound ran out; the reason is the spawn's own words, on one line. */
function giveUpLine(err) {
  const why = messageOf(err).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 200);
  return why === '' ? 'Claude Code could not be started.' : `Claude Code could not be started: ${why}`;
}

/**
 * The retry chain. `failed(err)` is called with a spawn's error: false when it is not ours (the caller rethrows), true when a retry is
 * pending or the host was ended. `started()` after a spawn that worked. One chain at most (a second failure while a retry is pending adds
 * no timer), and the clock is freed whenever a chain ends (a spawn, a give-up, a start that returned without spawning because the kill
 * switch or a stop got there first), so a later outage gets its own 2 minutes. `now` should be monotonic.
 *
 * deps: now(), setTimer(fn, ms), say(text), end(reason), log(line), prepare() (re-reads the CLI version), unreadable() (was the version
 * unreadable, so a re-read could change the answer), binExisted(), startSession().
 */
function createBootRetry(deps) {
  let firstFailedAt = null;
  let failures = 0;
  let pending = false;
  let lastErr = null;

  const secs = () => Math.round((deps.now() - firstFailedAt) / 1000);
  const reset = () => { firstFailedAt = null; failures = 0; lastErr = null; };
  const msgOf = (e) => (messageOf(e) || String(e)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 200);

  function giveUp(err) {
    deps.log(`claude would not start: gave up after ${failures} tries, ${secs()} s in: ${msgOf(err)}`);
    const line = giveUpLine(err);
    deps.say(line);
    // The existing ended state with its click-to-restart, the way a shell that can't start ends.
    deps.end(line);
    reset();
  }

  async function onTimer() {
    try {
      // The version read that decides whether the mod loads failed while the exe was half-written: read it again now.
      if (deps.unreadable()) await deps.prepare();
      // That read took time of its own: a try that would now land past the bound is not made.
      if (deps.now() - firstFailedAt > GIVE_UP_AFTER_MS) { pending = false; giveUp(lastErr); return; }
      pending = false;
      deps.startSession();
    } catch (e) {
      // startSession throws only for an error that is not ours: say it and end like a failed start rather than hang on a blank tab.
      pending = false;
      deps.log(`could not start the session: ${msgOf(e)}`);
      giveUp(e);
    } finally {
      // Nothing re-armed and nothing ended it: the start returned without a spawn (kill switch, stop) or it worked. The clock is free.
      if (!pending) reset();
    }
  }

  return {
    failed(err) {
      if (!isRetryableSpawnError(err, { binExisted: deps.binExisted() })) return false;
      if (pending) {
        deps.log(`claude would not start again while a retry is pending: ${msgOf(err)}`);
        return true;
      }
      const step = nextStep({ err, firstFailedAt, now: deps.now(), binExisted: deps.binExisted() });
      failures++;
      lastErr = err;
      if (step.action === 'give-up') { giveUp(err); return true; }
      firstFailedAt = step.firstFailedAt;
      deps.log(`claude would not start (attempt ${failures}, ${secs()} s in): ${msgOf(err)}; retrying in ${step.delayMs / 1000} s`);
      if (step.first) deps.say(RETRY_LINE);
      pending = true;
      deps.setTimer(onTimer, step.delayMs);
      return true;
    },
    started() {
      if (failures > 0) deps.log(`claude started after ${failures} retries`);
      reset();
    },
  };
}

/**
 * After the boot's own read of the CLI version: while it was unreadable (the exe was mid-update), read it again a couple of times, briefly,
 * BEFORE the session starts, so a spawn that then works still loads the claude-custom mod (the plugin dir is a spawn argument, so it
 * can't be added afterwards). Bounded; a readable version costs nothing.
 */
async function settleVersion({ prepare, unreadable, sleep, retries = VERSION_RETRIES, gapMs = VERSION_RETRY_GAP_MS }) {
  for (let i = 0; i < retries && unreadable(); i++) {
    await sleep(gapMs);
    await prepare();
  }
}

module.exports = {
  isRetryableSpawnError, nextStep, giveUpLine, createBootRetry, settleVersion, claudeLooksInstalled, createLiveBin,
  RETRY_EVERY_MS, GIVE_UP_AFTER_MS, RETRY_LINE,
};
