'use strict';
/**
 * The mark a verify/ probe puts on every process tree it starts (BACKLOG #169).
 *
 * A probe that dies, or a window it left open, leaves hosts behind: detached on purpose (a host outlives its window), and
 * started by app/main.js rather than by the probe, so the probe's own ledger (host/pid-ledger.js) never heard of them. What
 * was missing was a way to prove a host belongs to a PROBE and not to a person's live window.
 *
 * The mark is an environment variable, set once in the probe's own process.env (verify/lib/launch-electron.js) so everything
 * built from it carries it: the Electron the probe starts, the host app/main.js starts from that, and a host the probe spawns
 * by hand. It is named CC_PROBE_MARK and NOT CLAUDE_CUSTOM_*, because the probes (and host/tab-env.js, and spawnElectron) strip
 * the CLAUDE_CUSTOM_* a tab's session carries; a mark under that prefix would be stripped from exactly the processes that need it.
 * A person's own session never sets it. The host writes it into its identity file (host/host-identity.js, `probeMark`), which is
 * where verify/sweep-orphans.js reads it back.
 *
 * Format: pm1-<launcher pid>-<12 hex>. The pid says WHO launched it, so the sweep can tell an orphan (launcher gone) from a host
 * its probe is still using; the hex makes two probes' marks differ even when a pid is reused.
 */
const crypto = require('crypto');

const MARK_VAR = 'CC_PROBE_MARK';
const MARK_RE = /^pm1-([1-9]\d{0,9})-([0-9a-f]{12})$/;

/** A fresh mark for a launcher. */
function makeMark(pid = process.pid, rand = crypto.randomBytes(6).toString('hex')) {
  const m = `pm1-${pid}-${rand}`;
  if (!parseMark(m)) throw new Error(`makeMark: ${String(pid)}/${String(rand)} do not make a valid mark`);
  return m;
}

/** { pid, rand } for a well-formed mark, else null. Strict: this string is read from a file and decides what may be stopped. */
function parseMark(value) {
  if (typeof value !== 'string') return null;
  const m = MARK_RE.exec(value);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, rand: m[2] } : null;
}

/** The mark in an environment, if it is a valid one; otherwise null (a malformed value marks nothing). */
function markFromEnv(env = process.env) {
  const v = env && env[MARK_VAR];
  return parseMark(v) ? v : null;
}

/** Give this environment a fresh mark and return it. Always fresh: a probe run by another probe owns its own children. */
function markEnv(env = process.env, pid = process.pid) {
  const mark = makeMark(pid);
  env[MARK_VAR] = mark;
  return mark;
}

module.exports = { MARK_VAR, makeMark, parseMark, markFromEnv, markEnv };
