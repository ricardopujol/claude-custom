'use strict';
/**
 * Which project is the host on this port serving?
 *
 * `app/main.js` needs this BEFORE it opens a window, so it cannot ask over the
 * websocket -- that channel is authenticated and belongs to the renderer. The
 * host publishes a small file instead, one per port, and the reader treats it
 * as a claim to be checked rather than as fact.
 *
 * Three ways the claim can be false, all of them ordinary rather than exotic:
 *
 *   the process is gone     a crash or a kill leaves the file behind
 *   the file is half-written  it is written at startup, so this is a real state
 *   the file was moved      a copied .harness, or a hand edit
 *
 * Each of those reads as ABSENT. Absence is honest: `decideAttach` turns it
 * into 'unidentified' and refuses, rather than into "no host" -- which would be
 * a different and wrong conclusion, since something IS listening.
 *
 * KNOWN RESIDUAL HOLE, documented rather than hidden: if the host dies and the
 * OS recycles its pid to an unrelated process while something else takes the
 * port, this reports the stale cwd as live. The window then attaches and fails
 * the token check at the websocket, so the failure is LOUD -- a visible connect
 * error, not a silently wrong session, which is the failure class this whole
 * module exists to remove. Closing it properly means asking the listener
 * itself, which needs an unauthenticated endpoint on the host; that is a worse
 * trade than this.
 */

const fs = require('fs');
const path = require('path');
const { renameWithRetry } = require('./atomic-write');

const fileFor = (dir, port) => path.join(dir, 'hosts', `${port}.json`);

// Default liveness check. Signal 0 tests for existence without delivering
// anything; EPERM means the process exists and belongs to someone else, which
// is still alive for our purposes.
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * WRITE-AND-RENAME, like host/store.js next door.
 *
 * Dexter, PR #31 Finding 7: this was a bare `fs.writeFileSync`, which
 * truncates and then writes. A reader landing between those two gets a parse
 * error, which this module reports as ABSENT -- and the caller's response to
 * absence is not to wait, it is to step past the live host and spawn a
 * DUPLICATE session for a project that already has one. Absence is honest
 * about what we know; it is not harmless when that is what it causes.
 *
 * store.js has done this since it was written, with a comment citing this
 * project's own zeroed-PNG incident, and CLAUDE.md names the trap outright:
 * "Never open a file with 'w' before you are sure the write succeeds." This
 * was the one file in the feature that skipped it.
 *
 * mode 0o600 matches the token files beside it. It is near-inert on Windows --
 * Node honours only the read-only bit -- so the real protection is the ACL
 * .harness/ inherits, and this documents intent rather than carrying weight.
 */
// `processStartedAt` is the host's OS start time (host/proc-start.js FILETIME),
// once it knows it: the exact proof host/background-hosts.js needs before
// anything stops this pid. `startedAt` is wall clock, and a clock that steps
// back makes it prove an unrelated process (Dexter, PR 2 F1).
// `claudePid` is the host's claude, once it has one (Dexter, PR #83 F1): a stop
// waits for it too, since the host can exit while claude is still closing in
// the folder -- and a host with no session lock has nowhere else to say it.
function writeIdentity({ dir, port, cwd, pid = process.pid, processStartedAt, claudePid, side = false, sessionId } = {}) {
  const file = fileFor(dir, port);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp${process.pid}`;
  const doc = { port, cwd, pid, startedAt: Date.now() };
  if (typeof processStartedAt === 'string' && processStartedAt) doc.processStartedAt = processStartedAt;
  if (Number.isInteger(claudePid) && claudePid > 0) doc.claudePid = claudePid;
  // #81: a tab's read-only side session shares the folder; this keeps the port walk from mistaking it for the folder's own host.
  if (side === true) doc.side = true;
  // A side host's session id, for the producers that read transcripts (host/occupancy-transcripts.js): only a safe id, and only a side host's.
  if (side === true && typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) doc.sessionId = sessionId;
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc),
      { encoding: 'utf8', mode: 0o600 });
    // Not a bare renameSync: on Windows a scanner or indexer can hold the fresh
    // temp for a moment and the rename throws EPERM, so the host never
    // published its identity (backlog #68). Bounded, ~300 ms worst case.
    renameWithRetry(tmp, file);
  } catch (err) {
    // Best effort, and it can fail for the same reason the write did.
    try { fs.unlinkSync(tmp); } catch { /* nothing more to do */ }
    throw err;
  }
  return file;
}

function readIdentity({ dir, port, isAlive = defaultIsAlive } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(fileFor(dir, port), 'utf8'));
  } catch {
    return null;                                   // missing, unreadable, or half-written
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.cwd !== 'string' || !parsed.cwd.trim()) return null;
  // `> 0`, not merely an integer. Dexter, Finding 9: Number.isInteger admits 0
  // and negatives, and on POSIX `process.kill(-1, 0)` targets every process the
  // caller may signal and SUCCEEDS -- so a file claiming pid -1 reads as alive
  // and gets trusted for an attach decision.
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
  // The filename says one port and the contents another: something moved this
  // file, so nothing in it is worth trusting.
  if (Number(parsed.port) !== Number(port)) return null;
  if (!isAlive(parsed.pid)) return null;
  const identity = { port: Number(port), cwd: parsed.cwd, pid: parsed.pid, startedAt: parsed.startedAt };
  // Only a side host's carries the flag: an ordinary host's identity is what it always was.
  if (parsed.side === true) identity.side = true;
  return identity;
}

/**
 * `<dir>/hosts/<port>.token`, trimmed: the secret of the host that won that
 * port's bind (PR #75 F2). Null when it can't be read, is empty, or the port
 * isn't one -- `${null}.token` is a real file name and must never be read.
 * Read it only for a host whose identity has been matched first (see
 * app/go-to-session.js): the token is a credential.
 */
function readTokenFile({ dir, port } = {}) {
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) return null;
  try {
    return fs.readFileSync(path.join(dir, 'hosts', `${port}.token`), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

module.exports = { writeIdentity, readIdentity, readTokenFile, defaultIsAlive, fileFor };
