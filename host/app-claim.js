'use strict';
/**
 * The app lock's claim (single-instance PR 3): one Jiandu process per install. A launch runs it first, before any service or window, and
 * either hands its folder to the running process ('exit') or becomes that process ('proceed').
 *
 * It is host/window-claim.js reused, not written a second time, with:
 *   the owner   host/app-owner.js (`<dir>\app.json`, the owner-file proof)
 *   the pipe    `\\.\pipe\claude-custom-app-<pid>` (host/window-focus.js appPipeNameFor), a second name beside the window pipe, so the window
 *               pipe keeps "opens nothing" and its one-line protocol for old senders. Only a launcher that read this install's app.json
 *               knows it.
 *   the message { cwd, install, probe, env }, type 'open'. No port (a port-named launch is its own process). `env` carries only
 *               CLAUDE_CUSTOM_BIN / CONPTY / SHELL, so the owner can log which differ (design 3.1: the open runs on the owner's env).
 *   the ack     10 s: an owner that does not acknowledge is proven again; unless it is now gone, it gets one more send with the full wait
 *               (readyBound + 10 s), and only its silence then (a true hang) lets the launch go on and take app.json over with the judged
 *               bytes (PR #258 Dexter 1: a live owner that is only slow is never passed by on the 10 s alone).
 * Everything else is window-claim's: a starting owner holds the launch until markReady() (or says no when it stops or its bound passes),
 * ok only from a ready owner, the takeover with the judged bytes, the guarded release, stop() / resume().
 *
 * What an owner accepts (cleanOpenFor): an absolute cwd of at most 1024 characters, THIS install (one folder in two spellings is one), and a
 * probe flag equal to its own. Anything else is refused whole.
 */

const path = require('path');
const focus = require('./window-focus');
const appOwner = require('./app-owner');
const { createWindowClaim } = require('./window-claim');

const APP_ACK_MS = 10_000;
const ENV_NAMES = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CONPTY', 'CLAUDE_CUSTOM_SHELL'];
const MAX_ENV_VALUE = 4096;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The launch-carried env: the three names, text only. */
function envOf(env) {
  const out = {};
  if (!isObj(env)) return out;
  for (const name of ENV_NAMES) {
    const v = env[name];
    if (typeof v === 'string' && v.length <= MAX_ENV_VALUE) out[name] = v;
  }
  return out;
}

function cleanOpenFor({ install, probe, samePath }) {
  return (raw) => {
    if (!isObj(raw) || raw.type !== 'open') return null;
    const { cwd } = raw;
    if (typeof cwd !== 'string' || !cwd || cwd.length > focus.MAX_CWD || !path.isAbsolute(cwd)) return null;
    if (typeof raw.install !== 'string' || !samePath(raw.install, install)) return null;
    if (raw.probe !== probe) return null;
    return { cwd, env: envOf(raw.env) };
  };
}

/**
 * deps: dir (the lock's folder, host/app-lock-config.js), pid, ownStart, startTimes, launchCwd, installDir, probe, env (this launch's),
 * samePath, act(msg) (the owner opens msg.cwd: main's openProject), onExit(fn), log; optional enabled (default true), readyBoundMs, ackMs,
 * listen, send, now, mono.
 */
function createAppClaim(deps) {
  const { dir, pid, ownStart, startTimes, launchCwd, installDir, probe, env, samePath, act, onExit, log } = deps;
  const listen = deps.listen || focus.listen;
  const send = deps.send || focus.send;
  const clean = cleanOpenFor({ install: installDir, probe, samePath });
  return createWindowClaim({
    // off (host/app-lock-config.js): run() proceeds and touches nothing
    enabled: deps.enabled !== false, stateRoot: dir, pid, ownStart, startTimes, project: null, launchCwd, explicitPort: null,
    listen: (entry) => listen({ ...entry, name: focus.appPipeNameFor(pid), clean }),
    claim: appOwner.claim,
    send: (o) => send({ ...o, name: focus.appPipeNameFor(o.pid), type: 'open' }),
    takeOver: appOwner.takeOver, release: appOwner.release, forwardedCwd: () => undefined,
    message: () => ({ cwd: launchCwd, install: installDir, probe, env: envOf(env) }),
    tag: 'single instance',
    ackMs: Number.isFinite(deps.ackMs) ? deps.ackMs : APP_ACK_MS,
    act, onExit, log, refuse: deps.refuse,
    readyBoundMs: deps.readyBoundMs, now: deps.now, mono: deps.mono,
  });
}

module.exports = { createAppClaim, cleanOpenFor, envOf, APP_ACK_MS, ENV_NAMES };
