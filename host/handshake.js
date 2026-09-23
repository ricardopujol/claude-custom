'use strict';
/**
 * Whether a window may attach to whatever is listening on its port.
 *
 * Before this existed, `app/main.js` asked only "is something listening?" and
 * reattached if so. The host is spawned `detached: true` on purpose, so it
 * outlives its window -- which meant opening project B while project A's host
 * was still alive silently gave you A's session inside B's window, with the
 * right title, the wrong files, and no error on any surface.
 *
 * Kept pure and separate from the socket so the property that matters can be
 * tested without one: an occupant we cannot identify is REFUSED, never assumed
 * to be ours.
 *
 * Returns `{ action: 'spawn' | 'attach' | 'refuse', reason?, occupiedBy? }`.
 * The three refusal reasons are distinct because callers act on them
 * differently -- the launcher may step to the next port for 'other-project',
 * and must not for the other two, which mean we are flying blind.
 */

const { samePath, normalizeProjectPath } = require('./project-path');

function decideAttach({ requestedCwd, occupant } = {}) {
  // Asked first: if we do not know which project we WANT, no answer about the
  // occupant can be right. main.js reads this from an environment variable,
  // so "unset" is an ordinary input, not a programming error.
  if (normalizeProjectPath(requestedCwd) === null) {
    return { action: 'refuse', reason: 'no-request' };
  }
  if (!occupant) return { action: 'spawn' };

  // Listening, but it could not tell us whose it is. A stale host from a
  // crashed run, a half-started one, or an unrelated program on the same port.
  // Saying 'other-project' here would claim knowledge we do not have.
  if (normalizeProjectPath(occupant.cwd) === null) {
    return { action: 'refuse', reason: 'unidentified' };
  }

  if (samePath(occupant.cwd, requestedCwd)) return { action: 'attach' };
  return { action: 'refuse', reason: 'other-project', occupiedBy: occupant.cwd };
}

module.exports = { decideAttach };
