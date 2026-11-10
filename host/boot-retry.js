'use strict';
/**
 * BACKLOG #217: Claude Code's auto-update rewrites claude.exe in place, and a spawn that lands in that window fails (node-pty: "Cannot
 * create process, error code: 216", a truncated exe) and left the tab empty for good. This is the decision, kept pure: is the failure the
 * "binary not usable right now" kind, and is it still worth another try. The host owns the clock and the tab line (host/host.js).
 */

const RETRY_EVERY_MS = 5000;
const GIVE_UP_AFTER_MS = 120000;
const RETRY_LINE = 'Claude Code is updating, retrying…';

// Windows 216 ERROR_EXE_MACHINE_TYPE_MISMATCH, 193 ERROR_BAD_EXE_FORMAT, 32 ERROR_SHARING_VIOLATION, as node-pty words them; and its
// "File not found" for a binary that is momentarily absent.
const PTY_CODE = /error code: (?:216|193|32)\b/;
const PTY_NOT_FOUND = /^File not found\b/;
const RETRYABLE_CODES = new Set(['EBUSY', 'EACCES', 'ENOENT', 'EPERM']);

function messageOf(err) {
  if (typeof err === 'string') return err;
  return err && typeof err.message === 'string' ? err.message : '';
}

/** Does this spawn error mean the binary is not usable right now? Anything else is a real failure and stays one. */
function isRetryableSpawnError(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string' && RETRYABLE_CODES.has(err.code)) return true;
  const m = messageOf(err);
  return PTY_CODE.test(m) || PTY_NOT_FOUND.test(m);
}

/**
 * What to do after a spawn failed. `firstFailedAt` is null on the first failure. -> { action: 'fail' } (not ours: propagate),
 * { action: 'retry', delayMs, firstFailedAt, first }, or { action: 'give-up' } (the next try would land past the bound).
 */
function nextStep({ err, firstFailedAt, now }) {
  if (!isRetryableSpawnError(err)) return { action: 'fail' };
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

module.exports = { isRetryableSpawnError, nextStep, giveUpLine, RETRY_EVERY_MS, GIVE_UP_AFTER_MS, RETRY_LINE };
