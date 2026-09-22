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

function writeIdentity({ dir, port, cwd, pid = process.pid } = {}) {
  const file = fileFor(dir, port);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ port, cwd, pid, startedAt: Date.now() }), 'utf8');
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
  if (!Number.isInteger(parsed.pid)) return null;
  // The filename says one port and the contents another: something moved this
  // file, so nothing in it is worth trusting.
  if (Number(parsed.port) !== Number(port)) return null;
  if (!isAlive(parsed.pid)) return null;
  return { port: Number(port), cwd: parsed.cwd, pid: parsed.pid, startedAt: parsed.startedAt };
}

module.exports = { writeIdentity, readIdentity, defaultIsAlive, fileFor };
