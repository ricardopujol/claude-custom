'use strict';
/**
 * Which port does this project's host live on?
 *
 * Derived from the path rather than allocated, so that closing a window and
 * reopening it finds the host it left running -- with no registry to keep in
 * step, and no ordering dependency between two projects opened at once.
 *
 * Derivation is not a guarantee of uniqueness and is not treated as one: two
 * projects can hash to the same port, so the caller probes and steps. What the
 * hash buys is STABILITY, not exclusivity -- the same project lands on the same
 * port every time, and the handshake decides whether the occupant is ours.
 */

const { normalizeProjectPath } = require('./project-path');
const { decideAttach } = require('./handshake');

// Deliberately NOT 7681, the port this app used when it could only serve one
// project. 7681 is also ttyd's default, so leaving the old single-project
// default where it was keeps the collision confined to one well-known port
// rather than spreading it across the derived range.
const PORT_BASE = 7700;
const PORT_SPAN = 100;

function portForCwd(cwd) {
  const key = normalizeProjectPath(cwd);
  if (key === null) {
    throw new Error(`portForCwd: need a project path, got ${JSON.stringify(cwd)}`);
  }
  // FNV-ish rolling hash. Nothing here is security-sensitive -- it picks a
  // starting point for a probe -- so cheap and stable beats strong.
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PORT_BASE + (h % PORT_SPAN);
}

/**
 * The port this project should actually use, and what to do when we get there.
 *
 * Walks the whole range from the derived port: a port already serving THIS
 * project wins; otherwise the first free port is used (see F1 below). A refusal of any kind -- another
 * project, or an occupant that would not identify itself -- steps to the next
 * one, because both mean "not ours" and neither is the user's problem to solve.
 *
 * Bounded by construction: exactly PORT_SPAN probes, then an error. An
 * unbounded probe here is a silent hang in the first command a new user runs.
 */
// A wall-clock ceiling on the whole walk, not just a count of attempts.
// Dexter F12: app/main.js probes with a 400ms socket timeout, so behind a
// DROP-style firewall rule PORT_SPAN attempts is 40 SECONDS before the window
// opens -- and the header promises a bound precisely so there is no hang. An
// iteration count bounds the wrong axis. 6s is comfortably more than a healthy
// resolve (microseconds) and far less than a user's patience with a blank
// screen.
const DEADLINE_MS = 6000;

async function resolvePort({ cwd, occupantAt, deadlineMs = DEADLINE_MS, side = false } = {}) {
  const first = portForCwd(cwd);
  const giveUpAt = Date.now() + deadlineMs;
  // Dexter, PR #75 F1: a live host of ours ANYWHERE in the range wins over the
  // first free port. Two projects can hash to one port, and the loser's host
  // is stepped up; if the winner's tab is later closed, the loser's walk meets
  // a FREE port first and would spawn a duplicate while its real session runs
  // further along. So the walk remembers the first free port but keeps going.
  // A free port answers ECONNREFUSED in about a millisecond, so the full walk
  // is ~100 ms in practice.
  //
  // Known limit: if the wall-clock deadline hits after a free port was seen we
  // return that port rather than throw, which can still miss an "ours" further
  // along. That only happens when probes are being dropped, and a blank screen
  // is the worse failure.
  let firstFree = null;
  let tried = 0;
  for (let i = 0; i < PORT_SPAN; i++) {
    if (Date.now() > giveUpAt) {
      if (firstFree !== null) return { port: firstFree, action: 'spawn' };
      throw new Error(
        `resolvePort: probing for a free port took too long (>${deadlineMs}ms, ` +
        `${tried} of ${PORT_SPAN} ports tried) -- something is dropping connections on ` +
        `${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1}`);
    }
    const port = PORT_BASE + ((first - PORT_BASE + i) % PORT_SPAN);
    tried++;
    // Awaited because the real probe opens a socket. A synchronous answer --
    // which is what every test injects -- passes through await unchanged.
    const { action } = decideAttach({ requestedCwd: cwd, occupant: await occupantAt(port), requestedSide: side === true });
    if (action === 'attach') return { port, action };
    if (action === 'spawn' && firstFree === null) firstFree = port;
  }
  if (firstFree !== null) return { port: firstFree, action: 'spawn' };
  throw new Error(
    `resolvePort: no free port for ${cwd} in ${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1}`,
  );
}

module.exports = { portForCwd, resolvePort, PORT_BASE, PORT_SPAN, DEADLINE_MS };
