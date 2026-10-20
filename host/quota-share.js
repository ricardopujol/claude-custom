'use strict';
/**
 * One quota poller per machine, and one shared file everybody reads (BACKLOG #83).
 *
 * THE PROBLEM. Every host polled the usage endpoint every 60 s, so seven hosts
 * meant ~7 requests a minute from one account, and the endpoint answered 429.
 * And a session or agent had no way to read the numbers at all.
 *
 * THE SHAPE. A lease file elects one poller; it writes its last good result to
 * `quota-<key>.json`; every other host (and `host/quota-cli.js`) only reads that file.
 *
 * WHERE. `~\.claude-custom\`, beside worktree-ports.json -- NOT `.harness\state`,
 * which is a folder per checkout (each worktree has its own), so hosts of
 * different worktrees would never meet there.
 *
 * KEYED BY ACCOUNT, NOT BY USER. The figure belongs to whichever credentials the
 * poll used, and those live in the host's `CLAUDE_CONFIG_DIR` (host/quota.js reads
 * `claudeConfigDir()`). So the lease and the file carry a short hash of that
 * resolved dir in their names: hosts with the same config dir share a poller and
 * a figure, hosts with different ones never read each other's numbers.
 *
 * THE BOUNDS, measured against the 60 s tick (POLL_INTERVAL_MS):
 *
 *   LEASE_STALE_MS 150 s. The lease is stamped when it is TAKEN and again after
 *                  every GOOD poll (never before the poll, never after a failed
 *                  one), so a holder that hangs or keeps failing stops renewing and
 *                  a peer takes over once the stamp is older than this. A dead pid
 *                  is taken over at once regardless.
 *   POLL_TIMEOUT_MS 15 s. A poll is bounded, so "the stamp stopped moving" really
 *                  means "the holder is gone", not "the holder is slow".
 *   DATA_STALE_MS  240 s. A figure older than this is UNKNOWN. It is above
 *                  LEASE_STALE_MS + POLL_INTERVAL_MS + POLL_TIMEOUT_MS (225 s):
 *                  the holder's last good read is at most a stamp old, a peer may
 *                  take over once the stamp is 150 s old, ticks within 60 s of that,
 *                  and polls for at most 15 s. So a successor has polled before the
 *                  last figure goes unknown. (A test pins the inequality.)
 *
 * A HOLDER THAT KEEPS FAILING YIELDS. After MAX_FAILURES failed polls in a row it
 * gives the lease up and sits out one lease period, so another host (whose
 * credentials may work) gets to try, and a 429 is not hammered once a minute.
 *
 * ABSENT STAYS ABSENT. No file, a bad file, a wrong-shaped one and a stale one
 * all read as `state: 'absent'` with empty windows -- never a set of windows at
 * 0% (CLAUDE.md, `Number(null)`). A failed poll never replaces the last good
 * result; the error is recorded beside it.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withFileLock } = require('./file-lock');
const { writeFileAtomic } = require('./atomic-write');
const { isAlive: pidAlive } = require('./proc-start');
const { claudeConfigDir } = require('./claude-config-dir');

const POLL_INTERVAL_MS = 60_000;
const POLL_TIMEOUT_MS = 15_000;
const LEASE_STALE_MS = 150_000;
const DATA_STALE_MS = 240_000;
const MAX_FAILURES = 2;
// A readAt or lease stamp this far in the future is a clock fault or a bad file, not data.
const FUTURE_SKEW_MS = 60_000;
// BACKLOG #119 A2: the claude-custom mod (mods/claude-custom) reports the CLI's own rate limits. While its figure is this fresh
// and covers every window the last poll found, the poller yields (no network call). Under DATA_STALE_MS so a mod gone quiet
// hands back to the poller long before the figure would read as unknown.
const MOD_FRESH_MS = 120_000;

function defaultDir() { return path.join(os.homedir(), '.claude-custom'); }

/** A short stable key for one account: its resolved config dir (case-folded where the OS is). */
function accountKey(configDir) {
  const resolved = path.resolve(String(configDir));
  const norm = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 10);
}

// Resolved per call, not at creation: a host registers its tab's config anchor after it loads this module.
const cfgOf = (configDir) => (configDir === undefined ? claudeConfigDir() : configDir);
const quotaPath = (dir = defaultDir(), configDir) => path.join(dir, `quota-${accountKey(cfgOf(configDir))}.json`);
const leasePath = (dir = defaultDir(), configDir) => path.join(dir, `quota-${accountKey(cfgOf(configDir))}.lease`);

// "Can't tell" counts as alive: a second poller is the 429 this module exists to stop.
const defaultIsAlive = (pid) => pidAlive(pid) !== false;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** `{ kind: 'none' }` (missing or not JSON), `{ kind: 'unknown' }` (unreadable right now), or `{ kind: 'value', value }`. */
function readJsonFile(file, readFile = fs.readFileSync) {
  let text;
  try { text = readFile(file, 'utf8'); } catch (err) {
    return { kind: err && err.code === 'ENOENT' ? 'none' : 'unknown' };
  }
  try { return { kind: 'value', value: JSON.parse(text) }; } catch { return { kind: 'none' }; }
}

/** Run `fn(lease)` under the lease lock; `fn` sees `null` when the lease is missing, bad or unreadable. */
function underLease(dir, configDir, fn) {
  const file = leasePath(dir, configDir);
  fs.mkdirSync(dir, { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    const r = readJsonFile(file);
    return fn(r.kind === 'value' ? r.value : null, file);
  });
}

/**
 * Is this host the poller? Takes the lease when it is free, stale or held by a
 * dead pid; keeps it when it is already ours (the stamp is renewed by
 * `renewPoller`, after a good poll). The check-and-write runs under a file lock
 * so two hosts starting together can't both win. A lease that can't be READ right
 * now (antivirus, EBUSY) is not free: answers false. A failure to decide at all
 * (unwritable dir, lock timeout) THROWS, so the caller can say so and poll for itself.
 */
function claimPoller({
  dir = defaultDir(), configDir, owner, pid = process.pid, now = Date.now, isAlive = defaultIsAlive,
  readFile = fs.readFileSync,
} = {}) {
  const file = leasePath(dir, configDir);
  fs.mkdirSync(dir, { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    const t = now();
    const r = readJsonFile(file, readFile);
    if (r.kind === 'unknown') return false;
    const lease = r.kind === 'value' ? r.value : null;
    const shaped = lease && typeof lease === 'object' && isNum(lease.at) && typeof lease.owner === 'string';
    if (shaped && lease.owner === owner) return true;
    const age = shaped ? t - lease.at : 0;
    const heldByOther = shaped && age <= LEASE_STALE_MS && age >= -FUTURE_SKEW_MS && isAlive(lease.pid);
    if (heldByOther) return false;
    writeFileAtomic(file, JSON.stringify({ owner, pid, at: t }, null, 2));
    return true;
  });
}

/** Stamp the lease, if it is still ours: called after a GOOD poll. */
function renewPoller({ dir = defaultDir(), configDir, owner, pid = process.pid, now = Date.now } = {}) {
  return underLease(dir, configDir, (lease, file) => {
    if (!lease || lease.owner !== owner) return false;
    writeFileAtomic(file, JSON.stringify({ owner, pid, at: now() }, null, 2));
    return true;
  });
}

/** Give the lease up (host exit, or after repeated failures) so a successor needn't wait out the bound. Owner only. */
function releasePoller({ dir = defaultDir(), configDir, owner } = {}) {
  try {
    underLease(dir, configDir, (lease, file) => {
      if (lease && lease.owner === owner) fs.unlinkSync(file);
    });
  } catch { /* best effort: the bound covers it */ }
}

/**
 * Record a poll. A good one (ok, with a windows array) replaces the file; anything
 * else keeps the last good windows and readAt and only adds `lastError`.
 */
function recordPoll({ dir = defaultDir(), configDir, result, now = Date.now } = {}) {
  const file = quotaPath(dir, configDir);
  const t = now();
  fs.mkdirSync(dir, { recursive: true });
  // Serialised BEFORE anything touches disk: an encode failure must leave the
  // existing file exactly as it was (CLAUDE.md, never open with 'w' first).
  if (result && result.ok === true && Array.isArray(result.windows)) {
    writeFileAtomic(file, JSON.stringify({ version: 1, readAt: t, windows: result.windows, lastError: null }, null, 2));
    return;
  }
  const prior = readJsonFile(file);
  // Can't read the last good result right now: writing would regress it to nothing.
  if (prior.kind === 'unknown') return;
  const p = prior.kind === 'value' ? prior.value : null;
  const good = p && isNum(p.readAt) && Array.isArray(p.windows);
  const message = result && result.ok === true ? 'poll returned no windows' : (result && result.error) || 'unknown error';
  writeFileAtomic(file, JSON.stringify({
    version: 1,
    readAt: good ? p.readAt : null,
    windows: good ? p.windows : [],
    lastError: { message: String(message), at: t },
  }, null, 2));
}

/** A failed poll's record, written only while this owner still holds the lease (a late failure must not clobber a newer write). */
function recordFailureAsPoller({ dir = defaultDir(), configDir, owner, result, now = Date.now } = {}) {
  return underLease(dir, configDir, (lease) => {
    if (!lease || lease.owner !== owner) return false;
    recordPoll({ dir, configDir, result, now });
    return true;
  });
}

const keyOf = (w) => (w && typeof w === 'object' && typeof w.key === 'string' ? w.key : null);

// Two reset stamps name the same window instance when they are under a minute apart (the API says `+00:00` with microseconds, the CLI `Z`
// with milliseconds). Anything that does not parse is not the same instance.
const SAME_RESET_MS = 60_000;
function sameReset(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < SAME_RESET_MS;
}

/**
 * Write the mod's windows through the SAME file the poller writes, so every host and `quota-cli` benefit. The mod only knows the
 * windows the CLI reports (five_hour, seven_day: no model-scoped one), so a window the last poll found and the mod does not report
 * is CARRIED over in its place, with the age of the poll it came from (`carriedReadAt`); one older than DATA_STALE_MS is dropped,
 * never shown as fresh. `complete` says whether the mod covers every window the last poll found, which is what lets the poller
 * yield (`modCovers`); with no poll ever seen it is false, so the poller keeps learning what windows exist.
 * An empty list writes nothing: absence is not a figure. Returns whether it wrote.
 */
function recordModWindows({ dir = defaultDir(), configDir, windows, now = Date.now } = {}) {
  if (!Array.isArray(windows) || windows.length === 0) return false;
  const given = windows.filter(w => keyOf(w) !== null).map(cleanWindow);
  if (given.length === 0) return false;
  const file = quotaPath(dir, configDir);
  const t = now();
  fs.mkdirSync(dir, { recursive: true });
  const prior = readJsonFile(file);
  // Can't read the last file right now: writing would drop what it carried.
  if (prior.kind === 'unknown') return false;
  const p = prior.kind === 'value' && prior.value && typeof prior.value === 'object' && !Array.isArray(prior.value) ? prior.value : null;
  const priorWindows = p && Array.isArray(p.windows) ? p.windows.filter(w => keyOf(w) !== null) : [];
  // The mod's figure is the CLI's LAST RESPONSE; the poll's is the account now, which other sessions move. Inside one reset a window's
  // percent only goes up, so a lower mod figure for the same window and reset is older news and the file's stays; and an unknown mod
  // figure never erases a known one. Without a reset time on both sides nothing proves it is the same window, so the mod's is taken.
  const mine = given.map((m) => {
    const old = priorWindows.find(w => keyOf(w) === keyOf(m));
    if (!old || !sameReset(old.resetsAt, m.resetsAt) || !isNum(old.percent)) return m;
    return m.percent === null || old.percent > m.percent ? { ...m, percent: old.percent } : m;
  });
  const fromMod = !!p && p.source === 'mod';
  const pollKeys = fromMod && Array.isArray(p.pollKeys) ? p.pollKeys.filter(k => typeof k === 'string')
    : (p && isNum(p.readAt) ? priorWindows.map(keyOf) : null);
  const carriedReadAt = fromMod ? (isNum(p.carriedReadAt) ? p.carriedReadAt : null) : (p && isNum(p.readAt) ? p.readAt : null);
  const modKeys = new Set(mine.map(keyOf));
  const carryOk = carriedReadAt !== null && t - carriedReadAt <= DATA_STALE_MS;
  // The API's order is kept: a window the mod reports takes its old place, a new one goes last.
  const out = [];
  const placed = new Set();
  for (const w of priorWindows) {
    const k = keyOf(w);
    if (modKeys.has(k)) { if (!placed.has(k)) { out.push(mine.find(m => keyOf(m) === k)); placed.add(k); } }
    else if (carryOk) out.push(cleanWindow(w));
  }
  for (const w of mine) if (!placed.has(keyOf(w))) out.push(w);
  const complete = pollKeys !== null && pollKeys.every(k => modKeys.has(k));
  writeFileAtomic(file, JSON.stringify({
    version: 1, readAt: t, windows: out, lastError: null, source: 'mod', complete, pollKeys: pollKeys || [], carriedReadAt,
  }, null, 2));
  return true;
}

/** True when the mod's figure is fresh (under MOD_FRESH_MS) and covers every window the last poll found: the poller may yield. */
function modCovers({ dir = defaultDir(), configDir, now = Date.now } = {}) {
  const r = readJsonFile(quotaPath(dir, configDir));
  if (r.kind !== 'value') return false;
  const b = r.value;
  if (!b || typeof b !== 'object' || Array.isArray(b) || b.source !== 'mod' || b.complete !== true || !isNum(b.readAt)) return false;
  const age = now() - b.readAt;
  return age >= 0 && age < MOD_FRESH_MS;
}

// The windows file is written by this module from quota.js's own normalised shape, so everything but
// the number passes through (a field added there reaches every host); only `percent` is re-checked.
function cleanWindow(w) {
  return { ...w, percent: isNum(w.percent) ? w.percent : null };
}

const absent = (error, extra = {}) => ({ ok: false, state: 'absent', windows: [], error, ...extra });

const freshFrom = (windows, readAt, ageMs, lastError = null) => ({
  ok: true, state: 'fresh', windows: windows.filter(w => w && typeof w === 'object').map(cleanWindow),
  readAt, ageMs, error: null, lastError,
});

/** What the shared file says right now: `{ ok, state: 'fresh'|'absent', windows, readAt, ageMs, error, lastError }`. */
function readShared({ dir = defaultDir(), configDir, now = Date.now, maxAgeMs = DATA_STALE_MS } = {}) {
  const file = quotaPath(dir, configDir);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    return absent(err.code === 'ENOENT' ? 'no quota file (no host has polled yet)' : 'quota file unreadable');
  }
  let body;
  try { body = JSON.parse(text); } catch { return absent('quota file is not valid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.windows)) {
    return absent('quota file has an unexpected shape');
  }
  const lastError = body.lastError && typeof body.lastError.message === 'string' ? body.lastError : null;
  if (!isNum(body.readAt)) {
    return absent(`no good read yet${lastError ? `; last poll: ${lastError.message}` : ''}`, { lastError });
  }
  const t = now();
  const age = t - body.readAt;
  if (age < -FUTURE_SKEW_MS) return absent('quota file is dated in the future', { lastError });
  const ageMs = Math.max(0, age);
  if (ageMs > maxAgeMs) {
    return absent(`stale: last good read ${formatAge(ageMs)} ago${lastError ? `; last poll: ${lastError.message}` : ''}`,
      { readAt: body.readAt, ageMs, lastError });
  }
  return freshFrom(body.windows, body.readAt, ageMs, lastError);
}

function formatAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m} min`;
  return `${Math.floor(m / 60)} h`;
}

/** `5h 42% · week 61% · read 30 s ago`, or `unknown (why)`. Null percent prints `?`, never 0. */
function formatLine(shared) {
  if (!shared || shared.state !== 'fresh') {
    return `unknown (${(shared && shared.error) || 'no quota'})`;
  }
  const parts = shared.windows.map(w => `${w.label} ${isNum(w.percent) ? `${Math.round(w.percent)}%` : '?'}`);
  parts.push(`read ${formatAge(shared.ageMs)} ago`);
  return parts.join(' · ');
}

/**
 * What a host runs each tick: poll only if it holds the lease, then report what
 * the SHARED file says (so every host, poller or not, shows the same figure).
 *
 * The shared file is an optimisation, never a dependency: a host that can't claim
 * the lease (unwritable dir, lock timeout) says so once and polls for itself, as
 * every host did before; a poller whose own write fails still shows the fresh
 * result it holds in memory.
 */
function createSharedQuota({
  dir = defaultDir(), configDir, owner, readQuota, now = Date.now, isAlive = defaultIsAlive, log = () => {},
  pollTimeoutMs = POLL_TIMEOUT_MS,
} = {}) {
  let failures = 0;
  let sitOutUntil = 0;
  let lastClaimError = null;

  const goodResult = (r) => r && r.ok === true && Array.isArray(r.windows);

  async function pollOnce() {
    let timer;
    const timeout = new Promise((resolve) => {
      if (!Number.isFinite(pollTimeoutMs)) return;
      timer = setTimeout(() => resolve({ ok: false, state: 'absent', windows: [], error: 'poll timed out' }), pollTimeoutMs);
      if (timer.unref) timer.unref();
    });
    try {
      return await Promise.race([Promise.resolve().then(() => readQuota({})), timeout]);
    } catch (err) {
      return { ok: false, state: 'absent', windows: [], error: `poll threw: ${err && err.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh() {
    if (now() < sitOutUntil) return readShared({ dir, configDir, now });
    // The mod's figure is fresh and complete: nothing to ask the network for (#119 A2).
    if (modCovers({ dir, configDir, now })) return readShared({ dir, configDir, now });

    let claimed;
    try {
      claimed = claimPoller({ dir, configDir, owner, now, isAlive });
      lastClaimError = null;
    } catch (err) {
      const message = err && err.message;
      if (message !== lastClaimError) log(`quota lease unavailable, polling directly: ${message}`);
      lastClaimError = message;
      const direct = await pollOnce();
      if (goodResult(direct)) return freshFrom(direct.windows, now(), 0);
      log(`quota poll failed: ${direct && direct.error}`);
      return absent((direct && direct.error) || 'unknown error');
    }
    if (!claimed) return readShared({ dir, configDir, now });

    const result = await pollOnce();
    if (goodResult(result)) {
      failures = 0;
      try {
        recordPoll({ dir, configDir, result, now });
        renewPoller({ dir, configDir, owner, now });
      } catch (err) {
        log(`quota record failed: ${err && err.message}`);
        return freshFrom(result.windows, now(), 0);
      }
      return readShared({ dir, configDir, now });
    }

    log(`quota poll failed: ${result && result.error}`);
    failures++;
    try {
      recordFailureAsPoller({ dir, configDir, owner, result, now });
    } catch (err) {
      log(`quota record failed: ${err && err.message}`);
    }
    if (failures >= MAX_FAILURES) {
      releasePoller({ dir, configDir, owner });
      failures = 0;
      sitOutUntil = now() + LEASE_STALE_MS;
    }
    return readShared({ dir, configDir, now });
  }
  return { refresh, release: () => releasePoller({ dir, configDir, owner }) };
}

/**
 * The host's whole quota wiring in one place, so a test can hold it: refreshes go
 * through the shared module (never `readQuota` directly), overlapping refreshes
 * coalesce, a throw becomes absence (never a stale confident figure), and
 * `release()` gives the lease up on exit.
 */
function createHostQuota({ readQuota, onQuota = () => {}, log = () => {}, owner = `${process.pid}-${Date.now()}`, ...rest } = {}) {
  const shared = createSharedQuota({ owner, readQuota, log, ...rest });
  let pending = null;
  function refresh() {
    if (pending) return pending;
    pending = shared.refresh()
      .then((q) => { onQuota(q); return q; })
      .catch((err) => {
        // createSharedQuota turns every failure into a result, so reaching here is a bug.
        log(`quota read threw: ${err && err.message}`);
        const q = absent('read failed');
        onQuota(q);
        return q;
      })
      .finally(() => { pending = null; });
    return pending;
  }
  // What the shared file says right now, with no poll and no lease: for the mod's records (#119 A2), which arrive every couple
  // of seconds and must never cost a network call. Goes to `onQuota` like a refresh does.
  function readNow() {
    const q = readShared({ dir: rest.dir, configDir: rest.configDir, now: rest.now });
    onQuota(q);
    return q;
  }
  return { refresh, readNow, release: shared.release };
}

module.exports = {
  createHostQuota, createSharedQuota, claimPoller, renewPoller, releasePoller, recordPoll, recordFailureAsPoller,
  recordModWindows, modCovers, MOD_FRESH_MS, readShared, formatLine, formatAge, defaultDir, accountKey, quotaPath, leasePath,
  DATA_STALE_MS, LEASE_STALE_MS, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, MAX_FAILURES,
};
