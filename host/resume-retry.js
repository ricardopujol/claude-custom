'use strict';
/**
 * The safety net under `--resume <id>` (PR #250, Dexter's closing note; documentation/DESIGN_TABS_SESSIONS.md 3.1).
 *
 * MEASURED against the real CLI (2.1.322, verify/probe-continue.js meta): the interactive CLI asked to resume a session whose
 * transcript has only bookkeeping lines (no user or assistant entry) prints "No conversation found with session ID: <id>" and EXITS 1,
 * within a second. host/continue-flag.js hasTranscript already refuses to ask for such an id, but the CLI's own idea of "a
 * conversation" is its own: if the two ever disagree (or the transcript is moved between the check and the spawn) a tab asked to resume
 * would die at every launch, since nothing retried without the flag. So: a resumed main session that exits 1 within WITHIN_MS having
 * printed that refusal is started ONCE more, fresh, with no resume flag, and the host says why in host.log. Nothing else retries:
 * any other exit (a crash later, the person's /exit, a different code) ends the host as it always did.
 */

const WITHIN_MS = 15000;
const TAIL_CHARS = 4096;
const REFUSAL = /No conversation found/i;

/**
 * `createResumeWatch({ now })`: feed it the pty's output; ask it, at exit, whether to start fresh once.
 * One watch per spawn that asked to resume; it says yes at most once.
 */
function createResumeWatch({ now = Date.now, withinMs = WITHIN_MS } = {}) {
  const startedAt = now();
  let tail = '';
  let spent = false;
  return {
    feed(data) {
      if (typeof data !== 'string' || data === '') return;
      tail = (tail + data).slice(-TAIL_CHARS);
    },
    /** True once, only for exit code 1 within `withinMs` of the spawn after the CLI's refusal text. */
    shouldRetry({ exitCode } = {}) {
      if (spent) return false;
      if (exitCode !== 1) return false;
      if (now() - startedAt > withinMs) return false;
      if (!REFUSAL.test(tail)) return false;
      spent = true;
      return true;
    },
  };
}

module.exports = { createResumeWatch, WITHIN_MS, REFUSAL };
