'use strict';
/**
 * What a tab's pty must NOT inherit from its host.
 *
 * ELECTRON_RUN_AS_NODE. host/tab-env.js starts every host with it set, because a host IS Electron's exe running as plain Node. It
 * must stop there: if the session's `claude` (and every command it runs) inherits it, an Electron exe started from inside the tab
 * (claude-custom.exe, a second Electron app, a probe) starts as Node too, with errors that name anything but the cause (CLAUDE.md,
 * "ELECTRON_RUN_AS_NODE is inherited"). Windows variable names are case-insensitive, so every spelling goes.
 *
 * The host's per-tab identity (PER_TAB_KEYS: CLAUDE_CUSTOM_PORT, _TOKEN, _CWD, ...). A `claude-custom.exe C:\other` typed in the tab
 * would otherwise carry the tab's port into a window for another folder (it would refuse: "that port serves another folder"), and a
 * bare `claude-custom.exe` would attach a second window to the tab's own host. The same reason host/launch-target.js launchEnv strips
 * the namespace for the launcher. The pty gets its own markers (CLAUDE_CUSTOM_SESSION, the mod port and token) added after this.
 */
const { PER_TAB_KEYS } = require('./tab-env');

const NODE_MODE = 'ELECTRON_RUN_AS_NODE';
const IDENTITY = new Set(PER_TAB_KEYS.map(k => k.toUpperCase()));

function without(env, drop) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!drop(k.toUpperCase())) out[k] = v;
  return out;
}

function withoutNodeMode(env) {
  return without(env, (up) => up === NODE_MODE);
}

/** The environment a tab's pty starts from: no node mode, and none of the host's per-tab identity. */
function forPty(env) {
  return without(env, (up) => up === NODE_MODE || IDENTITY.has(up));
}

module.exports = { withoutNodeMode, forPty };
