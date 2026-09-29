'use strict';
/**
 * Drag a file onto an agent's face -> the harness COPIES it into
 * .harness/portraits/<agent>/<state>.<ext>, for that agent's CURRENT state.
 *
 * Split in the same shape as host/drop.js on purpose: PLAN is pure (decide
 * whether this upload is allowed and where it would land, no filesystem
 * writes), APPLY does the one side effect, temp-then-rename. `safeSegment`
 * comes from host/portraits.js rather than being redefined here -- agent and
 * state are path segments in both modules, and a traversal guard that drifts
 * between the reader and the writer is worse than one that is merely strict.
 */

const fs = require('fs');
const path = require('path');
const { safeSegment, MEDIA_EXTENSIONS } = require('./portraits');
const { renameWithRetry } = require('./atomic-write');

// The upload tier accepts the same media as the resolver serves. Named
// separately from MEDIA_EXTENSIONS at the call site below so a future format
// difference between "what we can display" and "what we accept from a drag"
// does not require touching two unrelated lists to express.
const UPLOAD_EXTENSIONS = MEDIA_EXTENSIONS;

// 25 MB. Ricardo, 2026-09-22: refuse by extension and size, with a visible
// reason -- a stuck drag of a multi-gigabyte video should fail fast and say
// why, not fill the disk silently.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function extensionOf(sourcePath) {
  const m = /\.([^.\\/]+)$/.exec(String(sourcePath || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * Decide whether a drag-and-drop upload may proceed, and where it would land.
 * PURE: takes the file's size as an argument rather than statting it, so this
 * function needs no filesystem access to be tested and the caller controls
 * exactly when the one real stat happens.
 *
 * Returns `{ ok: true, dest }` or `{ ok: false, reason }` -- `reason` is
 * always a sentence a person can read, never an error code, because a
 * refused upload is exactly the moment this project's rule is "say so
 * out loud" (host/drop.js, planDrop).
 */
function planPortraitUpload({ source, agent, state, uploadsDir, size } = {}) {
  if (!uploadsDir) {
    return { ok: false, reason: 'no uploads directory is configured' };
  }
  const safeAgent = safeSegment(agent);
  if (!safeAgent) {
    return { ok: false, reason: 'the agent name is not a valid path segment' };
  }
  const safeState = safeSegment(state);
  if (!safeState) {
    return { ok: false, reason: 'the state name is not a valid path segment' };
  }
  if (!source || typeof source !== 'string') {
    return { ok: false, reason: 'no source file was supplied' };
  }

  const ext = extensionOf(source);
  if (!UPLOAD_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      reason: `".${ext || '?'}" is not a supported portrait type -- expected one of ${UPLOAD_EXTENSIONS.join(', ')}`,
    };
  }

  // Number(null) is 0 -- the absence-reported-as-zero bug this project keeps
  // catching. A size we could not determine must refuse, not plan as though
  // the file were empty and therefore "under the limit".
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: 'could not determine the file size' };
  }
  if (size > MAX_UPLOAD_BYTES) {
    const mb = (size / (1024 * 1024)).toFixed(1);
    return { ok: false, reason: `the file is ${mb} MB, larger than the 25 MB limit` };
  }

  const dest = path.join(uploadsDir, safeAgent, `${safeState}.${ext}`);
  return { ok: true, dest };
}

/**
 * The one side effect: copy `source` to `dest`, temp-then-rename.
 *
 * CLAUDE.md: "Never open a file with 'w' before you are sure the write
 * succeeds. A failed encode truncated app/renderer.js to zero bytes." A copy
 * that failed partway through, written directly to `dest`, would leave a
 * half-written portrait sitting where the last good one used to be -- worse
 * than the crash it replaces, because it looks like a valid, just-corrupt
 * file rather than an obvious failure. So the copy lands in a temp file next
 * to the destination and only `renameWithRetry` (host/atomic-write.js, the
 * Windows antivirus-handle retry) makes it visible at the real name.
 *
 * Throws on failure -- never swallows it, per atomic-write.js's own rule that
 * a save which cannot happen must be reported, never reported as done. The
 * caller (host/host.js) turns that into a `{ type: 'portrait', ok: false }`
 * broadcast with the message as the reason.
 */
function applyPortraitUpload({ source, dest }, {
  copyFile = fs.copyFileSync,
  mkdirSync = fs.mkdirSync,
  rename = renameWithRetry,
  unlinkSync = fs.unlinkSync,
} = {}) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    // Inside the try (Dexter F4, PR #35): a copy that dies partway -- ENOSPC
    // on a large video -- has already created the temp file.
    copyFile(source, tmp);
    rename(tmp, dest);
  } catch (err) {
    // Best-effort cleanup; the copy's or rename's own error is the one that matters.
    try { unlinkSync(tmp); } catch { /* already gone, or never landed */ }
    throw err;
  }
  removeOtherFormats(dest, unlinkSync);
}

// The resolver picks between formats by a fixed extension order, so a stale
// working.png would keep beating a freshly uploaded working.webm (Dexter F1 /
// Miguel B1, PR #35). Once the new file is in place, every other format for
// the same <state> goes. A leftover that cannot be removed would still win,
// so that is a failed upload, never a quiet success.
function removeOtherFormats(dest, unlinkSync) {
  const ext = extensionOf(dest);
  const base = dest.slice(0, -(ext.length + 1));
  for (const other of UPLOAD_EXTENSIONS) {
    if (other === ext) continue;
    const stale = `${base}.${other}`;
    try {
      unlinkSync(stale);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw new Error(`the new portrait was saved, but the old ${path.basename(stale)} could not be removed and would still be shown (${err && err.message})`);
    }
  }
}

module.exports = {
  planPortraitUpload, applyPortraitUpload, MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS,
};
