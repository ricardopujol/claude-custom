'use strict';
/**
 * Which folder did the user ask to open?
 *
 * Small, but it is the first thing anyone runs, so its failures are the first
 * ones they see. A typo must produce one clear line here rather than a window
 * opening on a folder that does not exist -- where `claude` fails inside the
 * pty and the message is buried in a TUI the user has not learned yet.
 */

const fs = require('fs');
const path = require('path');

function resolveLaunchTarget(arg, { cwd = process.cwd(), stat = fs.statSync } = {}) {
  const target = path.resolve(cwd, arg || '.');
  let info;
  try {
    info = stat(target);
  } catch {
    throw new Error(`no such folder: ${target}`);
  }
  if (!info.isDirectory()) throw new Error(`not a folder: ${target}`);
  return target;
}

/**
 * The environment a freshly launched window should get.
 *
 * Two variables must NOT be inherited, and both look harmless.
 *
 * ELECTRON_RUN_AS_NODE, because of the trap this project's CLAUDE.md already
 * records: an Electron process started with it set runs as plain Node. The
 * chain that reaches here looks correct at every step -- the host's execPath IS
 * electron, this launcher IS a node script, so the host must set it; and then
 * passing the environment straight through hands it to the GUI, which starts as
 * Node, tries to execute a directory and exits. Measured: "opening project"
 * logged, no window, and stdio:'ignore' meant nothing said why.
 *
 * CLAUDE_CUSTOM_PORT, because it is honoured exactly and never stepped. Carried
 * into a different project it would hand the new window the old project's port,
 * where main.js finds the old host, refuses it and exits -- so the picker would
 * appear to do nothing.
 */
function launchEnv(env, target) {
  const out = { ...env, CLAUDE_CUSTOM_CWD: target };
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.CLAUDE_CUSTOM_PORT;
  return out;
}

module.exports = { resolveLaunchTarget, launchEnv };
