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
function launchEnv(env, target, { fresh = false } = {}) {
  const out = {};
  // WILDCARD, not a denylist. Dexter, Finding 4: the denylist named the two
  // variables whose harm I had already been bitten by, and at least four more
  // mattered -- CLAUDE_CUSTOM_TOKEN above all, which made every project opened
  // through the picker share ONE session token, wiring together the control
  // channels of the projects this feature exists to keep apart.
  //
  // host.js argues the opposite case for CLAUDE_CODE_*, choosing an explicit
  // list over a wildcard, and is right to: that namespace carries the USER'S
  // configuration, so stripping it wholesale would break things they set on
  // purpose. CLAUDE_CUSTOM_* carries none of that. It is entirely this harness
  // talking to itself, which makes it the one namespace where the wildcard is
  // the correct shape -- and the only shape that also strips whatever is added
  // to it next year by someone who never reads this function.
  for (const [k, v] of Object.entries(env || {})) {
    if (!k.startsWith('CLAUDE_CUSTOM_')) out[k] = v;
  }
  delete out.ELECTRON_RUN_AS_NODE;
  out.CLAUDE_CUSTOM_CWD = target;
  // `--new`: the one CLAUDE_CUSTOM_* value set on purpose, AFTER the wildcard,
  // so an inherited one never survives a plain launch.
  if (fresh) out.CLAUDE_CUSTOM_NEW = FRESH_VALUE;
  return out;
}

// The launcher and main.js are separate processes, so `--new` crosses as an
// environment variable. One exact value, written and read only here (Dexter
// #41 F2: deleting either side by hand left the suite green).
const FRESH_VALUE = '1';
const isFreshLaunch = (env) => !!env && env.CLAUDE_CUSTOM_NEW === FRESH_VALUE;

/**
 * claude-custom [folder] [--new] [-h|--help]. `--new` may sit before or after
 * the folder. There is deliberately no `-n` alias (Dexter #41 F5): it was
 * undocumented, and it swallowed a folder actually named `-n`.
 */
function parseLaunchArgs(argv) {
  const args = argv || [];
  const rest = args.filter(a => a !== '--new');
  return {
    help: args.includes('-h') || args.includes('--help'),
    fresh: args.includes('--new'),
    folder: rest[0],
  };
}

/**
 * The detached host's environment. `--new` is dropped: it is main's question
 * alone, and inherited it reached the host's `claude` child -- so `npm start`
 * run inside a --new session's terminal asked for a fresh session too (Miguel
 * #41 #4, Dexter F4).
 */
function hostEnv(env, { port, cwd, token }) {
  const out = { ...env };
  delete out.CLAUDE_CUSTOM_NEW;
  out.ELECTRON_RUN_AS_NODE = '1';
  out.CLAUDE_CUSTOM_PORT = String(port);
  out.CLAUDE_CUSTOM_CWD = cwd;
  out.CLAUDE_CUSTOM_TOKEN = token;
  return out;
}

module.exports = { resolveLaunchTarget, launchEnv, parseLaunchArgs, isFreshLaunch, hostEnv };
