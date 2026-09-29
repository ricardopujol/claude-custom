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
 * Walks from the derived port through the whole range. The first port already
 * serving THIS project wins, wherever it is -- which is what makes closing a
 * window and reopening it return to the session you left, including one that
 * `--new` put further along. Only when no session of this project is running
 * does it spawn, on the first free port from the derived one.
 *
 * With `fresh: true` it takes the first FREE port, walking past this project's
 * own running sessions. That is the difference between "reopen my session"
 * and "give me another window on this folder", and both are things a user
 * wants.
 *
 * A refusal of any kind -- another project, or an occupant that would not
 * identify itself -- steps to the next port, because both mean "not ours" and
 * neither is the user's problem to solve.
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

async function resolvePort({ cwd, occupantAt, deadlineMs = DEADLINE_MS, fresh = false } = {}) {
  const first = portForCwd(cwd);
  const giveUpAt = Date.now() + deadlineMs;
  // The default walk covers the WHOLE range before it settles for a free port
  // (Dexter #41 F1, Ricardo's option A, 2026-09-28): stopping at the first free
  // port spawned a duplicate beside a live session further along, and made a
  // closed `--new` window's session unreachable. A refused localhost connect is
  // ~1ms here, so the full walk is cheap; if the deadline hits first, the free
  // port already found is used rather than failing the launch.
  let firstFree = null;
  for (let i = 0; i < PORT_SPAN; i++) {
    if (Date.now() > giveUpAt) {
      if (firstFree !== null) return { port: firstFree, action: 'spawn' };
      throw new Error(
        `resolvePort: probing for a free port took too long (>${deadlineMs}ms, ` +
        `${i} of ${PORT_SPAN} ports tried) -- something is dropping connections on ` +
        `${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1}`);
    }
    const port = PORT_BASE + ((first - PORT_BASE + i) % PORT_SPAN);
    // Awaited because the real probe opens a socket. A synchronous answer --
    // which is what every test injects -- passes through await unchanged.
    const { action } = decideAttach({ requestedCwd: cwd, occupant: await occupantAt(port) });

    // `fresh` means "a SECOND session in this folder", so an occupied port is
    // never acceptable -- not even one serving this same project, which is
    // exactly the case the default is built to accept. One rule, one word.
    //
    // It does NOT widen anything: a port held by another project still refuses
    // and still steps, because wanting a new session is not permission to
    // evict somebody else's.
    if (fresh && action === 'spawn') return { port, action };
    if (!fresh && action === 'attach') return { port, action };
    if (action === 'spawn' && firstFree === null) firstFree = port;
  }
  if (firstFree !== null) return { port: firstFree, action: 'spawn' };
  throw new Error(
    `resolvePort: no free port for ${cwd} in ${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1}`,
  );
}

/**
 * CLAUDE_CUSTOM_PORT names an exact port, honoured and never stepped. With
 * `--new` on top, a port already serving this project must REFUSE rather than
 * reattach (Dexter #41 F4): the person asked for a new session and would
 * silently get the old one.
 */
function decideExplicitPort({ requestedCwd, occupant, fresh = false }) {
  const decision = decideAttach({ requestedCwd, occupant });
  if (fresh && decision.action === 'attach') {
    return {
      action: 'refuse',
      reason: '--new asks for a new session, but this port already serves this project',
    };
  }
  return decision;
}

module.exports = { portForCwd, resolvePort, decideExplicitPort, PORT_BASE, PORT_SPAN, DEADLINE_MS };
