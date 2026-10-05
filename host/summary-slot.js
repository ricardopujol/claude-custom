'use strict';
/**
 * "One GPU job at a time", across every host (backlog #39 job 1, DESIGN_SLAVE_MODE_SUMMARY.md decision 3).
 *
 * Each tab is its own host process, so the in-process queue in host/summary-scheduler.js cannot see another tab's
 * summary job. This is the cross-process half: a file created with the 'wx' flag, which is an atomic create-or-fail
 * on Windows and POSIX. Whoever creates it owns the GPU; everyone else waits for its next tick (a refusal, never a
 * block). host/file-lock.js isn't reused: that one is a SYNCHRONOUS mutex for millisecond writes, and a summary job
 * holds its slot for seconds.
 *
 * ABANDONED SLOTS. A host that dies mid-job must not jam every tab's summaries, so a slot is taken over when it is
 * older than any job can run (STALE_MS, past the client's own timeouts) or when its holder's process is gone. The
 * pid is somebody else's data: only a positive integer is ever probed, and anything else is never read as dead
 * (the same rule host/file-lock.js learned on PR #31). A file nobody can read is judged by its age on disk.
 *
 * A host can only release the slot it took (its token is in the file), so a slow job whose slot was taken over
 * can't delete the new holder's.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STALE_MS = 90_000;
const CLAIM_STALE_MS = 10_000;

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isPid = (n) => Number.isInteger(n) && n > 0;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return !!err && err.code === 'EPERM'; }
}

function createSlot({ file, now = Date.now, pid = process.pid, isAlive = processAlive, staleMs = STALE_MS, fsImpl = fs } = {}) {
  const fs = fsImpl;
  const claimFile = file + '.takeover';
  let token = null;
  let error = '';

  function create() {
    const mine = crypto.randomBytes(8).toString('hex');
    const body = JSON.stringify({ pid, at: now(), token: mine });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(file, body, { flag: 'wx' });
        token = mine;
        return 'ok';
      } catch (err) {
        if (err && err.code === 'EEXIST') return 'exists';
        if (err && err.code === 'ENOENT' && attempt === 0) {
          try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e2) { error = String((e2 && e2.message) || e2); return 'error'; }
          continue;
        }
        error = String((err && err.message) || err);
        return 'error';
      }
    }
    return 'error';
  }

  function holder() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      let o = null;
      try { const parsed = JSON.parse(raw); o = isObject(parsed) ? parsed : null; } catch { o = null; }
      return { raw, o };
    } catch (err) {
      return err && err.code === 'ENOENT' ? { gone: true } : { raw: null, o: null };
    }
  }

  function diskAgeMs() {
    try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return 0; }
  }

  function isStale(h) {
    const o = h.o;
    if (o && Number.isFinite(o.at)) {
      if (now() - o.at > staleMs) return true;
    } else if (diskAgeMs() > staleMs) {
      return true;
    }
    return !!(o && isPid(o.pid) && !isAlive(o.pid));
  }

  // Breaking a stale slot is check-then-act, so it is serialised: whoever creates the claim file (create-exclusive) is the
  // only host that may break a slot, and it re-reads the slot under the claim. Without it a second host could delete the
  // FIRST host's fresh slot and both would hold the GPU (Dexter F3, PR #105). A claimant that died leaves its claim
  // behind, so a claim older than CLAIM_STALE_MS is cleared (on this tick; the takeover goes through on the next).
  function claim() {
    try {
      fs.writeFileSync(claimFile, JSON.stringify({ pid, at: now() }), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        let age = 0;
        try { age = Date.now() - fs.statSync(claimFile).mtimeMs; } catch { /* gone: next tick */ }
        if (age > CLAIM_STALE_MS) { try { fs.unlinkSync(claimFile); } catch { /* somebody else cleared it */ } }
      }
      return false;
    }
  }

  function tryAcquire() {
    if (token !== null) return false;
    const first = create();
    if (first === 'ok') return true;
    if (first === 'error') return false;
    const h = holder();
    if (h.gone) return create() === 'ok';
    if (!isStale(h)) return false;
    if (!claim()) return false;
    try {
      // Under the claim: only the very slot that was judged may be broken.
      const again = holder();
      if (!again.gone && again.raw !== h.raw) return false;
      if (!again.gone) { try { fs.unlinkSync(file); } catch { /* gone already: create() decides */ } }
      return create() === 'ok';
    } finally {
      try { fs.unlinkSync(claimFile); } catch { /* already cleared */ }
    }
  }

  function release() {
    if (token === null) return;
    const mine = token;
    token = null;
    const h = holder();
    if (h.o && h.o.token === mine) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
  }

  return { tryAcquire, release, lastError: () => error };
}

module.exports = { createSlot, STALE_MS, CLAIM_STALE_MS };
