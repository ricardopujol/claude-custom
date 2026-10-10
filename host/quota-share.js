'use strict';
/**
 * One quota poller per machine, and one shared file everybody reads (BACKLOG #83).
 *
 * THE PROBLEM. Every host polled the usage endpoint every 60 s, so seven hosts
 * meant ~7 requests a minute from one account, and the endpoint answered 429.
 * And a session or agent had no way to read the numbers at all.
 *
 * THE SHAPE. A lease file elects one poller; it writes its last good result to
 * `quota.json`; every other host (and `host/quota-cli.js`) only reads that file.
 *
 * WHERE. `~\.claude-custom\`, beside worktree-ports.json -- NOT `.harness\state`,
 * which is a folder per checkout (each worktree has its own), so hosts of
 * different worktrees would never meet there. The quota is per account, so the
 * file is per user.
 *
 * THE TWO BOUNDS, both measured against the 60 s poll interval:
 *
 *   DATA_STALE_MS  180 s (3 polls). A figure older than this is UNKNOWN. The
 *                  quota windows are 5 h and 7 d, so a few minutes of age is
 *                  honest, but a poller that has been failing for longer must
 *                  not keep showing a figure that no longer describes the
 *                  account. Three intervals tolerates two missed or 429'd polls.
 *   LEASE_STALE_MS 150 s. The poller renews every 60 s, so a live one never
 *                  nears it (it survives two missed renewals); a dead pid is
 *                  taken over at once regardless. It is below DATA_STALE_MS so a
 *                  successor has polled before the last figure goes unknown.
 *
 * ABSENT STAYS ABSENT. No file, a bad file, a wrong-shaped one and a stale one
 * all read as `state: 'absent'` with empty windows -- never a set of windows at
 * 0% (CLAUDE.md, `Number(null)`). A failed poll never replaces the last good
 * result; the error is recorded beside it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withFileLock } = require('./file-lock');
const { renameWithRetry } = require('./atomic-write');

const QUOTA_FILE = 'quota.json';
const LEASE_FILE = 'quota.lease';
const DATA_STALE_MS = 180_000;
const LEASE_STALE_MS = 150_000;
// A readAt this far in the future is a clock fault or a bad file, not data.
const FUTURE_SKEW_MS = 60_000;

function defaultDir() { return path.join(os.homedir(), '.claude-custom'); }

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function writeJsonAtomic(file, value) {
  // Serialised BEFORE anything touches disk: an encode failure must leave the
  // existing file exactly as it was (CLAUDE.md, never open with 'w' first).
  const text = JSON.stringify(value, null, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp${process.pid}`;
  try {
    fs.writeFileSync(temp, text);
    renameWithRetry(temp, file);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch { /* never written */ }
    throw err;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Is this host the poller? Takes the lease when it is free, stale or held by a
 * dead pid; renews it when it is already ours. The check-and-write runs under
 * a file lock so two hosts starting together can't both win. Any failure to
 * decide answers false: not polling is visible (the figure goes unknown), a
 * second poller is the 429.
 */
function claimPoller({ dir = defaultDir(), owner, pid = process.pid, now = Date.now, isAlive = defaultIsAlive } = {}) {
  const leasePath = path.join(dir, LEASE_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return withFileLock(`${leasePath}.lock`, () => {
      const t = now();
      const lease = readJson(leasePath);
      const shaped = lease && typeof lease === 'object' && isNum(lease.at) && typeof lease.owner === 'string';
      const heldByOther = shaped && lease.owner !== owner
        && t - lease.at <= LEASE_STALE_MS && isAlive(lease.pid);
      if (heldByOther) return false;
      writeJsonAtomic(leasePath, { owner, pid, at: t });
      return true;
    });
  } catch {
    return false;
  }
}

/** Give the lease up (host exit) so a successor needn't wait out the bound. Owner only. */
function releasePoller({ dir = defaultDir(), owner } = {}) {
  const leasePath = path.join(dir, LEASE_FILE);
  try {
    withFileLock(`${leasePath}.lock`, () => {
      const lease = readJson(leasePath);
      if (lease && lease.owner === owner) fs.unlinkSync(leasePath);
    });
  } catch { /* best effort: the bound covers it */ }
}

/**
 * Record a poll. A good one replaces the file; a failed one keeps the last good
 * windows and readAt and only adds `lastError`.
 */
function recordPoll({ dir = defaultDir(), result, now = Date.now } = {}) {
  const file = path.join(dir, QUOTA_FILE);
  const t = now();
  if (result && result.ok === true) {
    writeJsonAtomic(file, { version: 1, readAt: t, windows: result.windows, lastError: null });
    return;
  }
  const prior = readJson(file);
  const good = prior && isNum(prior.readAt) && Array.isArray(prior.windows);
  writeJsonAtomic(file, {
    version: 1,
    readAt: good ? prior.readAt : null,
    windows: good ? prior.windows : [],
    lastError: { message: String((result && result.error) || 'unknown error'), at: t },
  });
}

function cleanWindow(w) {
  return {
    key: typeof w.key === 'string' ? w.key : null,
    label: typeof w.label === 'string' ? w.label : 'limit',
    percent: isNum(w.percent) ? w.percent : null,
    resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
    severity: typeof w.severity === 'string' ? w.severity : 'normal',
    isActive: w.isActive === true,
    usedDollars: null,
    remainingDollars: null,
    lockedReason: typeof w.lockedReason === 'string' ? w.lockedReason : null,
  };
}

const absent = (error, extra = {}) => ({ ok: false, state: 'absent', windows: [], error, ...extra });

/** What the shared file says right now: `{ ok, state: 'fresh'|'absent', windows, readAt, ageMs, error, lastError }`. */
function readShared({ dir = defaultDir(), now = Date.now, maxAgeMs = DATA_STALE_MS } = {}) {
  const file = path.join(dir, QUOTA_FILE);
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
  const windows = body.windows.filter(w => w && typeof w === 'object').map(cleanWindow);
  return { ok: true, state: 'fresh', windows, readAt: body.readAt, ageMs, error: null, lastError };
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
 * A write failure is swallowed to a log: the shared file is an optimisation, and
 * the host must keep working without it.
 */
function createSharedQuota({
  dir = defaultDir(), owner, readQuota, now = Date.now, isAlive = defaultIsAlive, log = () => {},
} = {}) {
  async function refresh() {
    if (claimPoller({ dir, owner, now, isAlive })) {
      try {
        recordPoll({ dir, result: await readQuota({}), now });
      } catch (err) {
        log(`quota poll/record failed: ${err && err.message}`);
      }
    }
    return readShared({ dir, now });
  }
  return { refresh, release: () => releasePoller({ dir, owner }) };
}

module.exports = {
  createSharedQuota, claimPoller, releasePoller, recordPoll, readShared, formatLine, formatAge, defaultDir,
  QUOTA_FILE, LEASE_FILE, DATA_STALE_MS, LEASE_STALE_MS,
};
