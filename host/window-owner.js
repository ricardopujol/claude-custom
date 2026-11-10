'use strict';
/**
 * One window per project (DESIGN_TABS_SESSIONS.md 3.3, Ricardo's pick P2): who owns this project's window?
 *
 * The window that opens first writes `<project>\.claude-custom\window.json` = { pid, start, at }: its own Electron
 * main pid and OS start time (host/proc-start.js FILETIME), the same pid + start proof host/host-identity.js and
 * host/kill-proven use. A later launch of the same project reads it BEFORE it makes a window and decides:
 *
 *   live owner (pid running AND start time equal)   focus it, forward the lane, exit with no window
 *   no file / dead owner / reused pid               proceed (and take the file over)
 *   a proof that could not be made                  proceed: a second window is the old behaviour, never a crash
 *
 * A pid alone is never enough (Windows reuses them): the start time is what makes "live" mean "that window".
 *
 * TWO LAUNCHES RACING. The file is published with a hard link (`link(temp, file)`), which fails with EEXIST when the file is
 * already there, so exactly one racer publishes; the loser re-reads, finds the winner, and focuses it. Taking over a dead
 * owner's file removes it only if it still holds the bytes that were judged dead (a third launch may have taken over first).
 * Where a filesystem refuses hard links the publish falls back to atomic rename (last writer wins): the old two-window
 * behaviour in the rare tie, never a crash. KNOWN RESIDUAL: the compare-then-unlink of a takeover is two calls, so two launches
 * that both judge the SAME dead owner in the same millisecond can both proceed. The result is the old behaviour (two windows).
 */

const fs = require('fs');
const path = require('path');
const { lookDir, lookDirState, ensureLookDir } = require('./style');
const { renameWithRetry } = require('./atomic-write');
const { samePath, isInside } = require('./project-layout');

const OWNER_FILE = 'window.json';
const ATTEMPTS = 3;

const isPid = (n) => Number.isInteger(n) && n > 0;

/** The file's text as an owner record { pid, start, at }, or null for anything that is not a proof (half-written, wrong shape). */
function parseOwner(text) {
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (!isPid(o.pid)) return null;
  if (typeof o.start !== 'string' || !o.start) return null;
  return { pid: o.pid, start: o.start, at: Number.isFinite(o.at) ? o.at : null };
}

/**
 * The whole decision, pure. `proof` is 'live' | 'dead' | 'unknown' (proveOwner), or null when there was nothing to prove.
 * Anything but the exact word 'live' proceeds: only a proven owner may stop a window from opening.
 */
function decide({ owner, proof, selfPid } = {}) {
  if (!owner) return { action: 'proceed', reason: 'no-owner' };
  if (owner.pid === selfPid) return { action: 'proceed', reason: 'self' };
  if (proof === 'live') return { action: 'focus', reason: 'live-owner' };
  if (proof === 'dead') return { action: 'proceed', reason: 'dead-owner' };
  return { action: 'proceed', reason: 'unproven-owner' };
}

/**
 * Is `owner` still the process that wrote its file? 'live' only when the pid runs with the SAME start time. 'unknown' when the
 * query failed or the start could not be read: never 'dead' (host/proc-start.js: "couldn't ask" is not "not running").
 */
async function proveOwner(owner, { startTimes } = {}) {
  let map;
  try { map = await startTimes([owner.pid]); } catch { return 'unknown'; }
  if (!map) return 'unknown';
  if (!map.has(owner.pid)) return 'dead';
  const start = map.get(owner.pid);
  if (typeof start !== 'string') return 'unknown';
  return start === owner.start ? 'live' : 'dead';
}

function readRaw(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * Put `doc` at `file` unless somebody holds it: 'ok' | 'exists'. `staleText` is the bytes of a file we judged dead; it is removed
 * first, but only while it still holds exactly those bytes.
 */
function publish(stateRoot, file, doc, { staleText = null, link = fs.linkSync, now = Date.now } = {}) {
  ensureLookDir(stateRoot, fs);
  const temp = `${file}.${process.pid}.${now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
  try {
    if (staleText !== null && readRaw(file) === staleText) fs.rmSync(file, { force: true });
    try {
      link(temp, file);
      return 'ok';
    } catch (err) {
      if (err && err.code === 'EEXIST') return 'exists';
      // A filesystem without hard links: the atomic rename the other state files use. Last writer wins.
      renameWithRetry(temp, file);
      return 'ok';
    }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing left to remove */ }
  }
}

/**
 * Called once, before this process makes a window. Resolves { action: 'focus', owner, file } (forward and exit) or
 * { action: 'proceed', reason, file, published } (make the window; `published` says the file now names this process).
 *   self       { pid, start }   this process (start from host/proc-start.js createSelfStartTime)
 *   startTimes async (pids) -> Map|null   host/proc-start.js startTimes
 *   hooks      { beforePublish() }   a test seam for the race between the read and the publish
 */
async function claim({ stateRoot, self, startTimes, now = Date.now, link, hooks = {} } = {}) {
  if (lookDirState(stateRoot, fs) === 'foreign') return { action: 'proceed', reason: 'foreign-dir', file: null, published: false };
  const file = path.join(lookDir(stateRoot), OWNER_FILE);
  for (let i = 0; i < ATTEMPTS; i++) {
    const text = readRaw(file);
    const owner = text === null ? null : parseOwner(text);
    const proof = owner && owner.pid !== self.pid ? await proveOwner(owner, { startTimes }) : null;
    const d = decide({ owner, proof, selfPid: self.pid });
    if (d.action === 'focus') return { ...d, owner, file };
    if (typeof self.start !== 'string' || !self.start) return { ...d, reason: 'no-self-start', file, published: false };
    // A proof that could not be made (a slow PowerShell) opens a window but never takes a LIVE owner's file: it would cut that window off
    // from the rule for good (PR #247 Miguel I4). A file that names nobody (garbage) is still replaced.
    if (d.reason === 'unproven-owner') return { ...d, file, published: false };
    if (typeof hooks.beforePublish === 'function') hooks.beforePublish();
    let r;
    try {
      r = publish(stateRoot, file, { pid: self.pid, start: self.start, at: now() }, { staleText: text, link, now });
    } catch {
      return { ...d, file, published: false };           // cannot write the file: still no reason to refuse a window
    }
    if (r === 'ok') return { ...d, file, published: true };
  }
  return { action: 'proceed', reason: 'contended', file, published: false };
}

/**
 * The owner on file was proven live but could not be reached (it is mid-shutdown, or a build from before the pipe): this launch
 * opens its window anyway, and the file must then name THAT window, or a later launch would be handed to a window on its way out.
 * true when the file now names this process.
 */
function takeOver({ stateRoot, self, now = Date.now, link } = {}) {
  if (lookDirState(stateRoot, fs) === 'foreign') return false;
  if (typeof self.start !== 'string' || !self.start) return false;
  const file = path.join(lookDir(stateRoot), OWNER_FILE);
  try { return publish(stateRoot, file, { pid: self.pid, start: self.start, at: now() }, { staleText: readRaw(file), link, now }) === 'ok'; } catch { return false; }
}

/**
 * Remove the file when it still names this process, by pid AND start time (a clean exit, a quit). true when it removed one.
 * The removal is guarded by the bytes read: the file is renamed aside, and if what was moved is not what was read (a launch took
 * over between the read and the remove) it is put back, so a dying window never deletes the file of the window that replaced it
 * (PR #247 Dexter 3).
 */
function release({ stateRoot, selfPid, selfStart, hooks = {} } = {}) {
  if (typeof selfStart !== 'string' || !selfStart) return false;
  const file = path.join(lookDir(stateRoot), OWNER_FILE);
  const text = readRaw(file);
  const owner = text === null ? null : parseOwner(text);
  if (!owner || owner.pid !== selfPid || owner.start !== selfStart) return false;
  if (typeof hooks.afterRead === 'function') hooks.afterRead();
  const aside = `${file}.${process.pid}.${Date.now()}.gone`;
  try { fs.renameSync(file, aside); } catch { return false; }          // already gone, or held: nothing of ours to remove
  const same = readRaw(aside) === text;
  if (!same) { try { fs.linkSync(aside, file); } catch { /* a newer file is already there: keep that one */ } }
  try { fs.rmSync(aside, { force: true }); } catch { /* nothing left to remove */ }
  return same;
}

/**
 * The lane a launch asked for: the tab on that port, else the tab whose folder IS the launch folder, else the deepest tab whose folder
 * CONTAINS it (a terminal opened in `<lane>\app`: project resolution climbs, so lane resolution does too). null = just focus.
 * `tabs` is tabShell.snapshot().tabs ({ key, cwd, port? }).
 */
function pickLane(tabs, { cwd, port } = {}) {
  if (!Array.isArray(tabs)) return null;
  if (Number.isInteger(port)) {
    const byPort = tabs.find(t => t && t.port === port);
    if (byPort) return byPort.key;
  }
  if (typeof cwd !== 'string' || !cwd) return null;
  const withCwd = tabs.filter(t => t && typeof t.cwd === 'string');
  const exact = withCwd.find(t => samePath(t.cwd, cwd));
  if (exact) return exact.key;
  let best = null;
  for (const t of withCwd) {
    if (isInside(cwd, t.cwd) && (best === null || isInside(t.cwd, best.cwd))) best = t;   // the deeper container wins
  }
  return best ? best.key : null;
}

/**
 * What a launch forwards as its lane: its folder when that is a lane's own folder (a worktree), nothing when it is the project's
 * `dev` or its container root (a plain focus: launching from `dev\` is not asking to leave the lane the person is on).
 */
function forwardedCwd(cwd, project) {
  if (typeof cwd !== 'string' || !cwd || !project) return undefined;
  if (samePath(cwd, project.dev) || samePath(cwd, project.root)) return undefined;
  return cwd;
}

module.exports = { OWNER_FILE, parseOwner, decide, proveOwner, claim, takeOver, release, pickLane, forwardedCwd };
