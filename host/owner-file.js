'use strict';
/**
 * The owner-file core (single-instance PR 3, step 0): "which live process owns this file?", over ANY file.
 *
 * host/window-owner.js (one window per project, `<project>\.claude-custom\window.json`) and host/app-owner.js (one process per install,
 * `<state dir>\app.json`) both use it, so the proof is written once:
 *
 *   the record   { pid, start, at }: an Electron main's pid and OS start time (host/proc-start.js FILETIME). A pid alone is never enough
 *                (Windows reuses them): the start time is what makes "live" mean "that process".
 *   the decision live owner -> focus it; no file / dead owner / reused pid -> proceed and take the file over; a proof that could not be
 *                made -> proceed WITHOUT taking a maybe-live owner's file.
 *   the publish  a hard link (`link(temp, file)`) fails with EEXIST when the file is there, so exactly one racer publishes; the loser
 *                re-reads and is handed to the winner. A dead owner's file is removed first, only while it holds the bytes judged dead.
 *                A filesystem without hard links falls back to an atomic rename (last writer wins: the old behaviour in the rare tie).
 *   the release  removes the file only while it names this process (pid AND start), guarded by the bytes read: a file a launch took
 *                over between the read and the remove is put back.
 * KNOWN RESIDUAL (as before): the compare-then-unlink of a takeover is two calls, so two launches that judge the SAME dead owner in the
 * same millisecond can both proceed (two owners: the old behaviour).
 *
 * Every function takes `{ file, usable, prepare }`: `usable()` false means the place must not be written (a `.claude-custom` that is a
 * link elsewhere), `prepare()` makes the folder (and whatever it needs) before the first write.
 */

const fs = require('fs');
const { renameWithRetry } = require('./atomic-write');

const ATTEMPTS = 3;

const isPid = (n) => Number.isInteger(n) && n > 0;
const always = () => true;
const nothing = () => {};

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
 * Anything but the exact word 'live' proceeds: only a proven owner may stop a process from going on.
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
 * Put `doc` at `file` unless somebody holds it: 'ok' | 'exists'. `staleText` is the bytes of a file judged dead; it is removed first,
 * but only while it still holds exactly those bytes.
 */
function publish({ file, prepare = nothing }, doc, { staleText = null, link = fs.linkSync, now = Date.now } = {}) {
  prepare();
  const temp = `${file}.${process.pid}.${now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
  try {
    if (staleText !== null && readRaw(file) === staleText) fs.rmSync(file, { force: true });
    try {
      link(temp, file);
      return 'ok';
    } catch (err) {
      if (err && err.code === 'EEXIST') return 'exists';
      renameWithRetry(temp, file);          // a filesystem without hard links: last writer wins
      return 'ok';
    }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing left to remove */ }
  }
}

/**
 * Called once, before this process takes the role the file stands for. Resolves { action: 'focus', owner, file, text } (hand over to the
 * owner) or { action: 'proceed', reason, file, published } (`published`: the file now names this process).
 *   self       { pid, start }   this process (start from host/proc-start.js createSelfStartTime)
 *   startTimes async (pids) -> Map|null   host/proc-start.js startTimes
 *   hooks      { beforePublish() }   a test seam for the race between the read and the publish
 */
async function claimFile({ file, usable = always, prepare = nothing, unusableReason = 'unusable', self, startTimes, now = Date.now, link, hooks = {} } = {}) {
  if (!usable()) return { action: 'proceed', reason: unusableReason, file: null, published: false };
  for (let i = 0; i < ATTEMPTS; i++) {
    const text = readRaw(file);
    const owner = text === null ? null : parseOwner(text);
    const proof = owner && owner.pid !== self.pid ? await proveOwner(owner, { startTimes }) : null;
    const d = decide({ owner, proof, selfPid: self.pid });
    if (d.action === 'focus') return { ...d, owner, file, text };
    if (typeof self.start !== 'string' || !self.start) return { ...d, reason: 'no-self-start', file, published: false };
    // A proof that could not be made (a slow PowerShell) proceeds but never takes a LIVE owner's file: it would cut that owner off for good
    // (PR #247 Miguel I4). A file that names nobody (garbage) is still replaced.
    if (d.reason === 'unproven-owner') return { ...d, file, published: false };
    if (typeof hooks.beforePublish === 'function') hooks.beforePublish();
    let r;
    try {
      r = publish({ file, prepare }, { pid: self.pid, start: self.start, at: now() }, { staleText: text, link, now });
    } catch {
      return { ...d, file, published: false };           // cannot write the file: still no reason to refuse
    }
    if (r === 'ok') return { ...d, file, published: true };
  }
  return { action: 'proceed', reason: 'contended', file, published: false };
}

/**
 * The owner on file was proven live but could not be reached (mid-shutdown, hung, a build from before the pipe): this process goes on
 * anyway, and the file must then name IT. Only the judged bytes are replaced; a file that names someone else now is left alone and this
 * says false (the caller claims again). true when the file now names this process.
 */
function takeOverFile({ file, usable = always, prepare = nothing, self, judgedText = null, now = Date.now, link } = {}) {
  if (!usable()) return false;
  if (typeof self.start !== 'string' || !self.start) return false;
  try {
    return publish({ file, prepare }, { pid: self.pid, start: self.start, at: now() },
      { staleText: typeof judgedText === 'string' ? judgedText : null, link, now }) === 'ok';
  } catch { return false; }
}

/** Remove the file when it still names this process, by pid AND start time, guarded by the bytes read. true when it removed one. */
function releaseFile({ file, selfPid, selfStart, hooks = {} } = {}) {
  if (typeof selfStart !== 'string' || !selfStart) return false;
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

module.exports = { parseOwner, decide, proveOwner, publish, claimFile, takeOverFile, releaseFile, readRaw };
