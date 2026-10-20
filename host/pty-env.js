'use strict';
/**
 * What a tab's pty must NOT inherit from its host.
 *
 * host/tab-env.js starts every host with ELECTRON_RUN_AS_NODE=1, because a host IS Electron's exe running as plain Node. That
 * variable must stop there: if the session's `claude` (and every command it runs) inherits it, an Electron exe started from
 * inside the tab (claude-custom.exe, a second Electron app, a probe) starts as Node too, with errors that name anything but the
 * cause (CLAUDE.md, "ELECTRON_RUN_AS_NODE is inherited"). The installed exe's smoke test (`claude-custom.exe --version`) answers
 * Node's own version from such a shell.
 */
function withoutNodeMode(env) {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}

module.exports = { withoutNodeMode };
