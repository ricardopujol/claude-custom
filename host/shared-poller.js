'use strict';
/**
 * ONE resource sampler across app instances (BACKLOG #100 c). Every claude-custom window is its own Electron main, and each
 * used to start its own PowerShell/CIM sample every 10 s: three windows, three full samples per 10 s (MEASURED 2026-10-15:
 * about 3.1 s of powershell CPU each). Now the first instance to start OWNS the sampling; the others read what it publishes.
 *
 * THE SHARED FOLDER (defaultDir; the name carries a version, so a build whose sample script differs is a separate pool and
 * never reads a document it cannot parse):
 *   owner.json      { pid, start, since, beat }   who samples. `start` is the owner's FILETIME start time, so a REUSED pid is
 *                                                 told from the owner itself (host/pid-ledger.js's rule). `beat` is renewed
 *                                                 every BEAT_MS while it lives.
 *   owner.lock      host/file-lock.js, held only while a claim is decided, so two instances cannot both take it
 *   sample.json     the latest sample: one JSON header line { v, seq, at, mode, ownerPid, ok, error }, then the sample text
 *                   exactly as the script printed it. Written through a temp file and a rename (host/atomic-write.js).
 *   want-<pid>.json { pid, level, at }             what each instance wants (poller-policy: hidden | chip | panel), renewed every
 *                                                 WANT_REFRESH_MS; one nobody renews goes stale. The owner samples at the STRONGEST
 *                                                 level of everyone, and not at all while everyone is hidden.
 *
 * HANDOVER. Every instance checks the owner every CONTROL_MS (a stat-sized read, a kill(pid, 0)). A dead owner is claimed at
 * once and sampling resumes one interval after its last sample ended (never later). A live pid whose beat has gone stale is
 * asked for its start time (poller-policy ownerVerdict): another start means the pid was reused (claim), the same start is a
 * hung but live owner (kept: doubt keeps). An owner checks the folder still names it BEFORE it samples and BEFORE it publishes,
 * so a deposed owner's late sample is dropped, never written over its successor's.
 *
 * ONE CALL AT A TIME, the sampler's own rule: the gap between samples is measured from when one ENDED. `seq` continues across
 * owners, so a reader never sees it go backwards. A failed sample is published as a failure so every reader counts it.
 *
 * With no usable folder the instance is SOLO: it owns, publishes in memory only, and nothing throws.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');
const { withFileLock } = require('./file-lock');
const policy = require('./poller-policy');

const VERSION = 1;
const DIR_NAME = 'resource-poller-v1';
const CONTROL_MS = 2000;
const POLL_MS = 1000;
const BEAT_MS = 5000;
const WANT_REFRESH_MS = 30000;
const WANT_STALE_MS = 3 * WANT_REFRESH_MS;
const CLAIM_DEADLINE_MS = 1000;
const LEVELS = policy.LEVELS;

const isLevel = (l) => typeof l === 'string' && LEVELS.includes(l);
const validPid = (pid) => Number.isInteger(pid) && pid > 0;
const unrefTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); return t; };

/** The shared folder: a probe's UI-state folder (so it never touches the real one), else the user's local app data. */
function defaultDir({ uiStateDir = null, env = process.env } = {}) {
  const base = uiStateDir || path.join(env.LOCALAPPDATA || os.tmpdir(), 'claude-custom');
  return path.join(base, DIR_NAME);
}

function readJson(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

/** The recorded owner, validated; null when absent or not an owner record. */
function parseOwner(o) {
  if (!o || !validPid(o.pid)) return null;
  const since = Number.isFinite(o.since) ? o.since : 0;
  return { pid: o.pid, start: typeof o.start === 'string' ? o.start : null, since, beat: Number.isFinite(o.beat) ? o.beat : since };
}

function encodeRecord(h, text) {
  return `${JSON.stringify({ v: VERSION, seq: h.seq, at: h.at, mode: h.mode, ownerPid: h.ownerPid, ok: h.ok, error: h.ok ? undefined : h.error })}\n${h.ok ? text : ''}`;
}

/** A sample file's content as a record, or null when it is not one of ours. */
function decodeRecord(raw) {
  if (typeof raw !== 'string') return null;
  const i = raw.indexOf('\n');
  if (i < 0) return null;
  let h;
  try { h = JSON.parse(raw.slice(0, i)); } catch { return null; }
  if (!h || h.v !== VERSION || !Number.isInteger(h.seq) || !Number.isFinite(h.at) || typeof h.mode !== 'string' || typeof h.ok !== 'boolean') return null;
  const text = raw.slice(i + 1);
  if (h.ok && text === '') return null;
  return { key: `${h.ownerPid}:${h.seq}:${h.at}`, seq: h.seq, at: h.at, mode: h.mode, ownerPid: h.ownerPid, ok: h.ok, error: h.ok ? null : String(h.error || 'the shared sample failed'), text: h.ok ? text : null };
}

function createSharedPoller({
  dir, self = { pid: process.pid }, now = Date.now, setTimer = unrefTimer, clearTimer = clearTimeout, log = () => {},
  selfStart = async () => null,
  pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM' ? true : (e && e.code === 'ESRCH' ? false : null); } },
  proveOwner = async () => null,       // (owner) -> true (same start) | false (another process has the pid) | null (could not tell)
  script = () => '',                   // (mode) -> the script text
  makeExec = null,                     // () -> exec(script) -> Promise<string>, with .close(): the owner's persistent shell
  readText = null,                     // (file) -> text | null: a test seam for the sample read
  oneShot = null,                      // () -> exec(script) -> Promise<string>: a follower's own off-cadence call
  controlMs = CONTROL_MS, pollMs = POLL_MS, beatMs = BEAT_MS,
} = {}) {
  let started = false;
  let solo = false;
  let role = 'idle';                   // 'idle' | 'follower' | 'owner'
  let ownLevel = 'hidden';
  let effective = 'hidden';
  let lastEffective = null;
  let selfStartVal;                    // undefined: not asked yet; null: the last ask failed; a string: this process's start
  let controlTimer = null;
  let sampleTimer = null;
  let sampleDue = null;
  let pollTimer = null;
  let running = false;
  let exec = null;
  let epoch = 0;                       // bumped whenever ownership starts or ends: a sample from an older one is dropped
  let seq = 0;
  let seqSynced = true;                // false: the old sample could not be read when ownership began, so the first publish reads it again
  let lastEndAt = null;
  let lastBeatAt = -Infinity;
  let lastWantAt = -Infinity;
  let latest = null;
  let lastSig = null;
  let tickP = null;
  const waiters = [];

  const files = {
    owner: () => path.join(dir, 'owner.json'),
    lock: () => path.join(dir, 'owner.lock'),
    sample: () => path.join(dir, 'sample.json'),
    want: (pid) => path.join(dir, `want-${pid}.json`),
  };
  const me = () => ({ pid: self.pid, start: typeof selfStartVal === 'string' ? selfStartVal : null });
  const warn = (what, err) => log(`[resources] shared poller: ${what}:`, (err && err.message) || err);

  // ---- the shared files -------------------------------------------------------------------------------------------
  /**
   * owner.json as three states, because "absent" and "could not read it" are not the same fact. { kind: 'record', owner } (owner is
   * null for JSON that is not an owner record: claimable, as before) | { kind: 'absent' } | { kind: 'unreadable' }: a read error
   * other than "no such file", or text that does not parse. An unreadable record is doubt: it is kept, not claimed, until it has
   * sat unreadable past the stale age (by the file's mtime), when nobody is renewing it.
   */
  function readOwnerFile() {
    if (solo) return { kind: 'absent', owner: null };
    let raw;
    try { raw = fs.readFileSync(files.owner(), 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? { kind: 'absent', owner: null } : { kind: 'unreadable', owner: null }; }
    let o;
    try { o = JSON.parse(raw); } catch { return { kind: 'unreadable', owner: null }; }
    return { kind: 'record', owner: parseOwner(o && typeof o === 'object' && !Array.isArray(o) ? o : null) };
  }
  const readOwner = () => readOwnerFile().owner;
  function unreadableIsStale() {
    try { return now() - fs.statSync(files.owner()).mtimeMs > policy.STALE_BEAT_MS; } catch { return false; }
  }
  /** True when the folder's record cannot be read and has not yet sat unreadable long enough to be taken. */
  const ownerInDoubt = (r) => r.kind === 'unreadable' && !unreadableIsStale();
  function writeOwner(o) { writeFileAtomic(files.owner(), JSON.stringify(o)); }
  function writeWant() {
    if (solo) { lastWantAt = now(); return; }
    const at = now();
    // Stamped only once it is written: a failed write is tried again on the next tick, not after WANT_REFRESH_MS.
    try { writeFileAtomic(files.want(self.pid), JSON.stringify({ pid: self.pid, level: ownLevel, at })); lastWantAt = at; } catch (err) { warn('could not record what this window wants', err); }
  }

  // The strongest level anyone wants. Another instance's want counts only while its pid is alive and it is being renewed.
  function refreshWants() {
    const levels = [ownLevel];
    if (!solo) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { /* the folder went: this window's own want stands alone */ }
      for (const name of names) {
        const m = /^want-(\d+)\.json$/.exec(name);
        if (!m) continue;
        const pid = Number(m[1]);
        if (!validPid(pid) || !Number.isSafeInteger(pid) || pid === self.pid) continue;
        if (pidAlive(pid) === false) { try { fs.unlinkSync(path.join(dir, name)); } catch { /* already gone */ } continue; }
        const w = readJson(path.join(dir, name));
        if (w && isLevel(w.level) && Number.isFinite(w.at) && now() - w.at <= WANT_STALE_MS) levels.push(w.level);
      }
    }
    effective = policy.strongest(levels);
    // Coming back from nobody looking: the first sample is immediate, not a wait of one interval.
    if ((lastEffective === null || lastEffective === 'hidden') && effective !== 'hidden') lastEndAt = null;
    lastEffective = effective;
  }

  // ---- ownership --------------------------------------------------------------------------------------------------
  function demote(why) {
    if (role === 'owner') log(`[resources] shared poller: pid ${self.pid} no longer owns the sampling (${why})`);
    role = started ? 'follower' : 'idle';
    epoch++;
    if (sampleTimer) { clearTimer(sampleTimer); sampleTimer = null; sampleDue = null; }
    if (exec && typeof exec.close === 'function') { try { exec.close(); } catch { /* already gone */ } }
    exec = null;
    running = false;
  }

  function becomeOwner() {
    if (role === 'owner') return;
    role = 'owner';
    epoch++;
    lastBeatAt = now();
    const rec = solo ? null : decodeRecord(read(files.sample()));
    seqSynced = solo || rec !== null;
    if (rec) {
      seq = Math.max(seq, rec.seq);
      // Resume one interval after the last sample ended, never later (and never from the future).
      lastEndAt = Math.min(rec.at, now());
    }
  }

  const safeRead = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
  const read = (file) => (readText ? readText(file) : safeRead(file));

  function judge(owner, startsMatch) {
    return policy.ownerVerdict({
      owner, self: me(), pidAlive: owner ? pidAlive(owner.pid) : null, beatAgeMs: owner ? now() - owner.beat : 0, startsMatch,
    });
  }

  function claim(proved) {
    let won = false;
    let locked = false;
    let doubt = false;
    try {
      withFileLock(files.lock(), () => {
        locked = true;
        const r = readOwnerFile();
        if (ownerInDoubt(r)) { doubt = true; return; }
        const cur = r.owner;
        const sameProof = cur && proved && proved.pid === cur.pid && proved.start === cur.start;
        const v = judge(cur, sameProof ? proved.match : undefined);
        if (v === 'claim') { const t = now(); writeOwner({ pid: self.pid, start: me().start, since: t, beat: t }); won = true; }
        else if (v === 'mine') won = true;
      }, { deadlineMs: CLAIM_DEADLINE_MS });
    } catch (err) { warn('could not take the sampling', err); }
    if (won) becomeOwner();
    else if (doubt) { if (role !== 'owner') role = 'follower'; }      // could not read the record: nothing proves a change of owner
    else if (!locked) { if (role !== 'owner') role = 'follower'; }   // the lock failed: nobody else was seen to claim, so nothing is lost by waiting a tick
    else if (role === 'owner') demote('another instance claimed it');
    else role = 'follower';
  }

  /** The folder can vanish after start (someone wipes the app data): make it again, else this window samples for itself. */
  function ensureDir() {
    if (solo) return;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { solo = true; warn('the shared folder is gone and cannot be made again, sampling for this window only', err); }
  }

  async function judgeOwnership() {
    ensureDir();
    if (solo) { becomeOwner(); return; }
    // No claim without a start time of our own: a record that carries none cannot be told from a reused pid later.
    if (typeof me().start !== 'string') { if (role !== 'owner') role = 'follower'; return; }
    const r = readOwnerFile();
    if (ownerInDoubt(r)) { if (role !== 'owner') role = 'follower'; return; }
    const owner = r.owner;
    let v = judge(owner, undefined);
    let proved = null;
    if (v === 'verify') {
      const match = await proveOwner(owner).catch(() => null);
      proved = { pid: owner.pid, start: owner.start, match };
      v = judge(owner, match);
    }
    if (v === 'mine') { becomeOwner(); return; }
    if (v === 'keep') { if (role === 'owner') demote('another instance holds the folder'); else role = 'follower'; return; }
    claim(proved);
  }

  function release() {
    if (solo) return;
    try {
      withFileLock(files.lock(), () => {
        const cur = readOwner();
        if (cur && cur.pid === self.pid) fs.unlinkSync(files.owner());
      }, { deadlineMs: CLAIM_DEADLINE_MS });
    } catch (err) { warn('could not release the sampling', err); }
  }

  const stillOwner = () => {
    if (solo) return true;
    const r = readOwnerFile();
    if (r.kind === 'unreadable') return true;      // a read that failed is no proof the folder names another owner
    const cur = r.owner;
    const mine = me();
    return !!cur && cur.pid === mine.pid && cur.start === mine.start;
  };

  // ---- the owner's sampling ---------------------------------------------------------------------------------------
  function schedule() {
    if (!started || role !== 'owner' || running) return;
    const cad = policy.cadenceOf(effective);
    if (!cad) { if (sampleTimer) { clearTimer(sampleTimer); sampleTimer = null; sampleDue = null; } return; }
    const t = now();
    const due = lastEndAt === null ? t : lastEndAt + cad.intervalMs;
    if (sampleTimer && sampleDue === due) return;
    if (sampleTimer) clearTimer(sampleTimer);
    sampleDue = due;
    sampleTimer = setTimer(sampleOnce, Math.max(0, due - t));
  }

  async function sampleOnce() {
    sampleTimer = null;
    sampleDue = null;
    if (!started || role !== 'owner' || running) return;
    const cad = policy.cadenceOf(effective);
    if (!cad) return;
    if (!stillOwner()) { demote('the folder names another owner'); return; }
    running = true;
    const mine = epoch;
    let result;
    try {
      if (!exec) exec = makeExec();
      result = { ok: true, text: await exec(script(cad.mode)) };
    } catch (err) {
      result = { ok: false, error: (err && err.message) || String(err) };
    }
    if (mine !== epoch) return;          // ownership ended while this ran: its answer is nobody's
    running = false;
    if (!stillOwner()) { demote('the folder named another owner when the sample ended'); return; }
    publish(result, cad.mode);
    lastEndAt = now();
    schedule();
  }

  function publish(result, mode) {
    if (!seqSynced) {
      seqSynced = true;
      const old = decodeRecord(read(files.sample()));
      if (old) seq = Math.max(seq, old.seq);
    }
    seq++;
    const at = now();
    const header = { seq, at, mode, ownerPid: self.pid, ok: result.ok, error: result.error };
    if (!solo) {
      try { writeFileAtomic(files.sample(), encodeRecord(header, result.text)); } catch (err) { warn('could not publish a sample', err); }
    }
    latest = { key: `${self.pid}:${seq}:${at}`, seq, at, mode, ownerPid: self.pid, ok: result.ok, error: result.ok ? null : result.error, text: result.ok ? result.text : null };
    resolveWaiters(latest);
  }

  // ---- reading ----------------------------------------------------------------------------------------------------
  function refreshLatest() {
    if (solo || role === 'owner') return latest;
    let st;
    try { st = fs.statSync(files.sample()); } catch { return latest; }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (sig === lastSig) return latest;
    const rec = decodeRecord(safeRead(files.sample()));
    if (rec) { lastSig = sig; latest = rec; }
    return latest;
  }

  const fits = (w, rec) => rec.key !== w.after && now() - rec.at <= w.maxAgeMs;

  function resolveWaiters(rec) {
    for (const w of [...waiters]) {
      if (!fits(w, rec)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      clearTimer(w.timer);
      w.resolve(rec);
    }
  }

  function armPoll() {
    if (pollTimer || !started || role === 'owner' || solo || waiters.length === 0) return;
    pollTimer = setTimer(() => {
      pollTimer = null;
      const rec = refreshLatest();
      if (rec) resolveWaiters(rec);
      armPoll();
    }, pollMs);
  }

  /**
   * The next sample this reader has not had: `next({ after, maxAgeMs, timeoutMs })` -> Promise<record> with `.kill()`.
   * `after` is the key of the last record the reader took. A record older than `maxAgeMs` is never served as new.
   */
  function next({ after = null, maxAgeMs = Infinity, timeoutMs = 60000 } = {}) {
    let w;
    const p = new Promise((resolve, reject) => {
      w = { after, maxAgeMs, resolve, reject, timer: null };
      const rec = refreshLatest();
      if (rec && fits(w, rec)) { resolve(rec); return; }
      waiters.push(w);
      w.timer = setTimer(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error('no sample arrived in time'));
      }, timeoutMs);
      armPoll();
    });
    p.kill = () => {
      const i = waiters.indexOf(w);
      if (i < 0) return;
      waiters.splice(i, 1);
      clearTimer(w.timer);
      w.reject(new Error('the wait for a sample was cancelled'));
    };
    return p;
  }

  function cancelWaiters(why = 'the wait for a sample was cancelled') {
    for (const w of waiters.splice(0)) { clearTimer(w.timer); w.reject(new Error(why)); }
  }

  /** A fresh full sample now, off the cadence (Stop's re-read). The owner asks its own shell; a follower makes a one-off call. Nothing is published. */
  function sampleNow() {
    let raw;
    try {
      if (role === 'owner' && started && makeExec) { if (!exec) exec = makeExec(); raw = exec(script('full')); }
      else raw = oneShot()(script('full'));
    } catch (err) { raw = Promise.reject(err); }
    const p = raw.then((text) => ({ text, at: now(), mode: 'full' }));
    p.kill = () => { if (raw && typeof raw.kill === 'function') raw.kill(); };
    return p;
  }

  // ---- the control loop -------------------------------------------------------------------------------------------
  async function runTick() {
    try {
      // A failed query is asked again on the next tick (the callee does not cache a failure either), never kept as an answer.
      if (typeof selfStartVal !== 'string') selfStartVal = await selfStart().catch(() => null);
      if (!started) return;
      await judgeOwnership();
      if (!started) return;
      if (now() - lastWantAt >= WANT_REFRESH_MS) writeWant();
      refreshWants();
      if (role === 'owner') {
        if (!solo && now() - lastBeatAt >= beatMs) {
          const cur = readOwner();
          if (cur && cur.pid === self.pid) { try { writeOwner({ ...cur, beat: now() }); lastBeatAt = now(); } catch (err) { warn('could not renew the heartbeat', err); } }
        }
        schedule();
      } else armPoll();
    } catch (err) { warn('the control tick failed', err); }
    if (started) controlTimer = setTimer(() => { controlTimer = null; tick(); }, controlMs);
  }
  function tick() {
    if (!tickP) tickP = runTick().finally(() => { tickP = null; });
    return tickP;
  }

  return {
    /** Join the pool: make the folder (or go solo), record this window's want, find out who owns, start the control loop. */
    start() {
      if (started) return tick();
      started = true;
      role = 'follower';
      try { fs.mkdirSync(dir, { recursive: true }); solo = false; } catch (err) { solo = true; warn('no shared folder, sampling for this window only', err); }
      writeWant();
      return tick();
    },
    stop() {
      if (!started) return;
      started = false;
      if (controlTimer) { clearTimer(controlTimer); controlTimer = null; }
      if (sampleTimer) { clearTimer(sampleTimer); sampleTimer = null; sampleDue = null; }
      if (pollTimer) { clearTimer(pollTimer); pollTimer = null; }
      cancelWaiters('the poller stopped');
      const wasOwner = role === 'owner';
      epoch++;
      role = 'idle';
      running = false;
      // The persistent shell is ended by its own handle (exec.close), never by name.
      if (exec && typeof exec.close === 'function') { try { exec.close(); } catch { /* already gone */ } }
      exec = null;
      if (wasOwner) release();
      if (!solo) { try { fs.unlinkSync(files.want(self.pid)); } catch { /* already gone */ } }
    },
    setLevel(level) {
      const l = isLevel(level) ? level : 'hidden';
      if (l === ownLevel) return;
      ownLevel = l;
      if (!started) return;
      writeWant();
      refreshWants();
      if (role === 'owner') schedule();
    },
    level: () => ownLevel,
    role: () => role,
    next, cancelWaiters, sampleNow, tick,
    latest: () => latest,
  };
}

module.exports = {
  createSharedPoller, defaultDir, encodeRecord, decodeRecord, CONTROL_MS, BEAT_MS, WANT_STALE_MS,
};
