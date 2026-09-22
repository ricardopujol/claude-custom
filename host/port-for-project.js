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
 * Walks from the derived port through the range, taking the first port that is
 * either free or already serving THIS project. A refusal of any kind -- another
 * project, or an occupant that would not identify itself -- steps to the next
 * one, because both mean "not ours" and neither is the user's problem to solve.
 *
 * Bounded by construction: exactly PORT_SPAN probes, then an error. An
 * unbounded probe here is a silent hang in the first command a new user runs.
 */
async function resolvePort({ cwd, occupantAt } = {}) {
  const first = portForCwd(cwd);
  for (let i = 0; i < PORT_SPAN; i++) {
    const port = PORT_BASE + ((first - PORT_BASE + i) % PORT_SPAN);
    // Awaited because the real probe opens a socket. A synchronous answer --
    // which is what every test injects -- passes through await unchanged.
    const { action } = decideAttach({ requestedCwd: cwd, occupant: await occupantAt(port) });
    if (action === 'spawn' || action === 'attach') return { port, action };
  }
  throw new Error(
    `resolvePort: no free port for ${cwd} in ${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1}`,
  );
}

module.exports = { portForCwd, resolvePort, PORT_BASE, PORT_SPAN };
