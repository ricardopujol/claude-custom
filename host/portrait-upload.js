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
const { safeSegment, MEDIA_EXTENSIONS, BUILTIN_STATES, EXTRA_STATES, GLOBAL_AGENT, isReservedAgent } = require('./portraits');
const { renameWithRetry } = require('./atomic-write');

// The upload tier accepts the same media as the resolver serves. Named
// separately from MEDIA_EXTENSIONS at the call site below so a future format
// difference between "what we can display" and "what we accept from a drag"
// does not require touching two unrelated lists to express.
const UPLOAD_EXTENSIONS = MEDIA_EXTENSIONS;

const STALE_REASON = 'the new picture was saved, but its version could not be updated, so the previous picture may still be shown until the app is restarted';
const RESERVED_REASON = `"${GLOBAL_AGENT}" is reserved for the global default picture and cannot be an agent's name`;

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
function planPortraitUpload({ source, agent, state, uploadsDir, size, allowReserved = false } = {}) {
  if (!uploadsDir) {
    return { ok: false, reason: 'no uploads directory is configured' };
  }
  if (!allowReserved && isReservedAgent(agent)) return { ok: false, reason: RESERVED_REASON };
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
  statSync = fs.statSync,
  utimesSync = fs.utimesSync,
  now = Date.now,
} = {}) {
  mkdirSync(path.dirname(dest), { recursive: true });
  // The version the display puts in the picture's URL (?v=) is this file's
  // mtime -- and copyFile PRESERVES THE SOURCE'S mtime, so two different
  // pictures from one zip (same DOS timestamp) would share a URL and the cached
  // one would be served (Dexter F2, PR #64). The destination is stamped after
  // the copy with a time this function controls, strictly later than whatever
  // it replaces.
  let previous = 0;
  try { previous = statSync(dest).mtimeMs; } catch { /* first upload */ }
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  let stamped = false;
  let versionMoved = true;
  try {
    // Inside the try (Dexter F4, PR #35): a copy that dies partway -- ENOSPC
    // on a large video -- has already created the temp file.
    copyFile(source, tmp);
    rename(tmp, dest);
    // Retried like the rename (an antivirus scan of the just-renamed file holds
    // it for a moment). The file has landed, so a stamp that never succeeds must
    // not read as a failed copy -- but it must not read as a clean success
    // either: if the version did not move, the old picture may stay cached.
    const stamp = Math.max(now(), previous + 1) / 1000;
    for (let attempt = 0; attempt < 3 && !stamped; attempt++) {
      try { utimesSync(dest, stamp, stamp); stamped = true; } catch { /* try again */ }
    }
    if (!stamped) {
      let after = previous;
      try { after = statSync(dest).mtimeMs; } catch { /* unknown counts as unmoved */ }
      versionMoved = after !== previous;
    }
  } catch (err) {
    // Best-effort cleanup; the copy's or rename's own error is the one that matters.
    try { unlinkSync(tmp); } catch { /* already gone, or never landed */ }
    throw err;
  }
  return { leftovers: removeOtherFormats(dest, unlinkSync), versionStale: !stamped && !versionMoved };
}

// The resolver picks between formats by a fixed extension order, so a stale
// working.png would keep beating a freshly uploaded working.webm (Dexter F1 /
// Miguel B1, PR #35). Once the new file is in place, every other format for
// the same <state> goes. One that cannot be removed is RETURNED, not thrown:
// the new file has already landed, so "copy failed" would be false, and
// whether the leftover still wins depends on the extension order -- the
// caller reads that back from the resolver (Miguel R2 #1, Dexter R2-2).
function removeOtherFormats(dest, unlinkSync) {
  const ext = extensionOf(dest);
  if (!ext) return []; // Dexter R2 L2: never slice a name that has no extension
  const base = dest.slice(0, -(ext.length + 1));
  const leftovers = [];
  for (const other of UPLOAD_EXTENSIONS) {
    if (other === ext) continue;
    const stale = `${base}.${other}`;
    try {
      unlinkSync(stale);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') leftovers.push(path.basename(stale));
    }
  }
  return leftovers;
}

/**
 * The host's whole decision for a {type:'portrait', action:'set', agent,
 * state, path} frame, with every side effect injected so it can be tested
 * (Miguel I5, PR #35). host/host.js only performs what this returns:
 *
 *   reply         -> broadcast as {type:'portrait', ...reply}
 *   mood          -> {agent, state} to re-describe and broadcast, or null
 *   repaintIndex  -> re-resolve this agent's portrait in the Inactive list
 *
 * The state the renderer sends is what the person SAW. The file lands under
 * it, but only if it is one of the four real states, and the mood re-broadcast
 * uses the state the machine is in NOW (Dexter F3). A drop on an Inactive-tab
 * row (state 'inactive', Miguel I1) replaces the picture that row shows, its
 * `sleeping` one (Ricardo, 2026-09-28, after Dexter R2-1 found that writing
 * default.<ext> lost to an existing sleeping upload). An agent that is not
 * live gets no mood broadcast -- that would invent a live roster row for it.
 * (That split relies on the mood machine never dropping an agent from its
 * roster; it only ever sets -- Dexter R2 L1.)
 *
 * `reply.state` is the state the file was saved under ('sleeping' for an
 * Inactive drop); a refusal echoes the state that was sent. Only the flourish
 * text reads it.
 *
 * Success is read back, not assumed: after the copy, `resolve(agent, state)`
 * says which file the face now shows. If a stale format that could not be
 * removed still wins, the reply says so -- and the mood/repaint still goes
 * out either way, because the saved file changed what some window resolves.
 */
function handlePortraitMessage(msg, { uploadsDir, stat, apply = applyPortraitUpload, resolve, liveState }) {
  const agent = msg && msg.agent;
  const seen = msg && msg.state;
  const source = msg && msg.path;
  const refuse = (reason) => ({
    reply: { ok: false, agent, state: seen, reason }, mood: null, repaintIndex: false,
  });

  if (!msg || msg.action !== 'set') return refuse(`unsupported portrait action: ${msg && msg.action}`);

  // `_global` is the folder of the global default picture (handleGlobalPortraitMessage);
  // an agent sharing the name would write into it.
  if (isReservedAgent(agent)) return refuse(RESERVED_REASON);
  if (typeof seen !== 'string' || !seen) return refuse('no state was given for the portrait');
  const target = seen === 'inactive' ? 'sleeping' : seen;
  if (!BUILTIN_STATES.includes(target) && !EXTRA_STATES.includes(target)) {
    return refuse(`"${seen}" is not a state a portrait can be set for`);
  }

  let info;
  try {
    info = stat(source);
  } catch (err) {
    return refuse(`could not read the dropped file: ${err && err.message}`);
  }
  if (info && typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()) {
    return refuse('the dropped item is a symbolic link; drop the real file instead');
  }
  if (!info || typeof info.isFile !== 'function' || !info.isFile()) {
    return refuse('the dropped item is not a file');
  }

  const plan = planPortraitUpload({ source, agent, state: target, uploadsDir, size: info.size });
  if (!plan.ok) return refuse(plan.reason);

  let leftovers;
  let versionStale = false;
  try {
    const applied = apply({ source, dest: plan.dest }) || {};
    leftovers = applied.leftovers || [];
    versionStale = applied.versionStale === true;
  } catch (err) {
    return refuse(`copy failed: ${err && err.message}`);
  }

  const shown = resolve(agent, target) === plan.dest;
  const reason = shown ? (versionStale ? STALE_REASON : null)
    : leftovers.length
      ? `the new portrait was saved, but the old ${leftovers.join(', ')} could not be removed and is still shown`
      : 'the new portrait was saved, but another file is still shown';
  const now = liveState(agent);
  return {
    reply: { ok: shown && !versionStale, agent, state: target, reason },
    mood: now ? { agent, state: now } : null,
    repaintIndex: !now,
  };
}

/**
 * The GLOBAL default picture (BACKLOG C #3): {type:'portrait', action:
 * 'set-global', path} copies a file to <uploads>/_global/default.<ext> through
 * the same plan/apply as a per-agent upload; {action:'reset-global'} removes
 * every _global default. Same shape as handlePortraitMessage: every side
 * effect is injected, success is read back from the resolver, and a refusal is
 * a sentence.
 *
 *   reply    -> broadcast as {type:'portrait', global: true, ...reply}
 *   changed  -> true when files on disk changed, i.e. every face must be
 *               re-resolved (the host does that; this module only decides)
 */
function handleGlobalPortraitMessage(msg, {
  uploadsDir, stat, apply = applyPortraitUpload, resolve, unlink = fs.unlinkSync,
} = {}) {
  const refuse = (reason) => ({ reply: { ok: false, global: true, reason }, changed: false });
  const action = msg && msg.action;

  if (action === 'reset-global') {
    const dir = uploadsDir ? path.join(uploadsDir, GLOBAL_AGENT) : null;
    if (!dir) return refuse('no uploads directory is configured');
    let removed = 0;
    const stuck = [];
    for (const ext of UPLOAD_EXTENSIONS) {
      const file = path.join(dir, `default.${ext}`);
      try {
        unlink(file);
        removed += 1;
      } catch (err) {
        if (!err || err.code !== 'ENOENT') stuck.push(path.basename(file));
      }
    }
    if (stuck.length) {
      return { reply: { ok: false, global: true, reason: `could not remove ${stuck.join(', ')}` }, changed: removed > 0 };
    }
    return { reply: { ok: true, global: true, reason: null }, changed: removed > 0 };
  }

  if (action !== 'set-global') return refuse(`unsupported portrait action: ${action}`);

  const source = msg.path;
  let info;
  try {
    info = stat(source);
  } catch (err) {
    return refuse(`could not read the chosen file: ${err && err.message}`);
  }
  if (info && typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()) {
    return refuse('the chosen item is a symbolic link; choose the real file instead');
  }
  if (!info || typeof info.isFile !== 'function' || !info.isFile()) return refuse('the chosen item is not a file');

  const plan = planPortraitUpload({ source, agent: GLOBAL_AGENT, state: 'default', uploadsDir, size: info.size, allowReserved: true });
  if (!plan.ok) return refuse(plan.reason);

  let leftovers;
  let versionStale = false;
  try {
    const applied = apply({ source, dest: plan.dest }) || {};
    leftovers = applied.leftovers || [];
    versionStale = applied.versionStale === true;
  } catch (err) {
    return refuse(`copy failed: ${err && err.message}`);
  }
  const shown = resolve() === plan.dest;
  const reason = shown ? (versionStale ? STALE_REASON : null)
    : leftovers.length
      ? `the new picture was saved, but the old ${leftovers.join(', ')} could not be removed and is still shown`
      : 'the new picture was saved, but another file is still shown';
  return { reply: { ok: shown && !versionStale, global: true, reason }, changed: true };
}

module.exports = {
  planPortraitUpload, applyPortraitUpload, handlePortraitMessage, handleGlobalPortraitMessage,
  MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS,
};
