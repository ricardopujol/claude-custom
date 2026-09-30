'use strict';
/**
 * What the window says about its worktree (Extension X1/X4, PR 1b):
 *
 *   lockOverlay(lock, now)   another session holds this worktree's lock: who,
 *                            since when, and *Open anyway*
 *   lockBadge(lock)          header glyph for an overridden lock (a second
 *                            session, on purpose) or a lock that couldn't be taken
 *   terminalBanner(result)   other live `claude` sessions in this worktree
 *   healthMarker(health)     behind develop (a tab) / develop ahead of main (dev)
 *
 * Pure models -- the renderer paints them. The lock shapes are
 * host/session-gate.js's, the rest host/session-registry.js's and
 * host/branch-health.js's. Unknown is said in words or not drawn; it is never
 * drawn as a number (the absence-as-zero bug), and a marker appears only when
 * there is something to act on.
 *
 * WRAPPED IN AN IIFE, as every display module is: the renderer loads them all
 * as plain <script> tags sharing ONE global scope, and no unit test can see a
 * clash there. One name leaves it: `worktreeStatus`.
 */
(function (root) {

const isCount = n => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isPid = n => typeof n === 'number' && Number.isInteger(n) && n > 0;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function sinceText(startedAt, now) {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  const s = (now - startedAt) / 1000;
  if (!(s >= 0)) return null;                        // in the future: a clock we can't trust
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function lockOverlay(lock, now) {
  if (!lock || lock.state !== 'blocked') return null;
  const h = lock.holder || {};
  // host.js re-checks the lock every 30 s and on *Open anyway* (Dexter, PR #71
  // F1), so the copy says both: this window takes over by itself when that
  // session ends, and the button only makes a SECOND claude if it hasn't.
  const after = 'This window starts by itself when that session ends. ' +
    'Open anyway checks again and, if it is still running, starts a second claude beside it.';
  let detail;
  if (!isPid(h.pid)) {
    detail = `Its holder could not be read -- it may be starting up right now. ${after}`;
  } else {
    const since = sinceText(h.startedAt, now);
    detail = `Held by host pid ${h.pid}` +
      (isPid(h.claudePid) ? ` (claude pid ${h.claudePid})` : '') +
      (isPid(h.port) ? ` on port ${h.port}` : '') +
      (since ? `, since ${since}` : '') +
      `. ${after}`;
  }
  return { title: 'Another session is running in this worktree', detail, canOverride: true };
}

function lockBadge(lock) {
  if (!lock) return null;
  if (lock.state === 'override') {
    return {
      text: String.fromCodePoint(0x1f513),           // open padlock
      title: 'Second session in this worktree: its session lock was overridden (not saved -- the next window is blocked again)',
    };
  }
  if (lock.state === 'unlocked' && lock.reason === 'error') {
    return {
      text: String.fromCodePoint(0x26a0),            // warning sign
      title: `No session lock (${lock.code || 'unknown error'}): a second window on this worktree would not be stopped`,
    };
  }
  return null;
}

function terminalBanner(result) {
  if (!result || result.format !== 'ok' || result.verified !== true) return null;
  const sessions = (Array.isArray(result.sessions) ? result.sessions : []).filter(s => s && isPid(s.pid));
  if (sessions.length === 0) return null;
  const sorted = [...sessions].sort((a, b) => a.pid - b.pid);
  const list = sorted.map(s => `pid ${s.pid}${typeof s.status === 'string' ? ` (${s.status})` : ''}`).join(', ');
  const n = sorted.length;
  return {
    key: sorted.map(s => s.pid).join(','),
    text: `${plural(n, 'other claude session')} ${n === 1 ? 'is' : 'are'} live in this worktree: ${list}. ` +
      'This window still works; two sessions editing one worktree can collide.',
  };
}

function healthMarker(health) {
  if (!health) return null;
  if (health.kind === 'tab' && isCount(health.behindDevelop) && health.behindDevelop > 0) {
    const n = health.behindDevelop;
    return { text: `↓${n}`, title: `${plural(n, 'commit')} behind origin/develop`, cls: 'wt-behind' };
  }
  if (health.kind === 'dev' && isCount(health.developAheadOfMain) && health.developAheadOfMain > 0) {
    const n = health.developAheadOfMain;
    return { text: `+${n}`, title: `develop is ${plural(n, 'commit')} ahead of origin/main`, cls: 'wt-ahead' };
  }
  return null;
}

const api = { sinceText, lockOverlay, lockBadge, terminalBanner, healthMarker };

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.worktreeStatus = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
