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
 * The launcher's arguments: `[folder]`, `[folder] --stop` (Windowless sessions
 * PR 3), `-h` / `--help`, `-v` / `--version`. -> { cmd: 'help' } | { cmd: 'version' } | { cmd: 'open', arg }
 * | { cmd: 'stop', folder }. A `--stop` folder is only resolved, never checked:
 * the folder being cleaned up may already be gone. An unknown option or a
 * second folder throws, rather than opening a folder named "--stpo" or quietly
 * ignoring one of the two.
 */
function parseCli(argv, { cwd = process.cwd() } = {}) {
  if (argv.includes('-h') || argv.includes('--help')) return { cmd: 'help' };
  if (argv.includes('-v') || argv.includes('--version')) return { cmd: 'version' };
  let stop = false;
  const folders = [];
  for (const a of argv) {
    if (a === '--stop') stop = true;
    else if (!a.trim()) throw new Error('an empty folder name (name a folder, or leave it out for this one)');
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else folders.push(a);
  }
  if (folders.length > 1) throw new Error(`one folder at a time (got ${folders.length})`);
  if (stop) return { cmd: 'stop', folder: path.resolve(cwd, folders[0] || '.') };
  return { cmd: 'open', arg: folders[0] };
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
  return out;
}

/**
 * *Open* from the strip's ▾ menu (Windowless sessions PR 2): a fresh window
 * on one running host. launchEnv's clean slate, plus that host's exact port --
 * an explicit port is honoured and never stepped (app/main.js), so the window
 * attaches to that host or refuses; it never starts a second session beside it.
 */
const ATTACH_ONLY = 'CLAUDE_CUSTOM_ATTACH_ONLY';

function attachEnv(env, { cwd, port } = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('attachEnv: cwd must be a non-empty string');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`attachEnv: port must be an integer in 1-65535, got ${String(port)}`);
  }
  return { ...launchEnv(env, cwd), CLAUDE_CUSTOM_PORT: String(port), [ATTACH_ONLY]: '1' };
}

/**
 * Open's other half (Dexter, PR 2 F2): an explicit port with nothing on it
 * SPAWNS, so a host that ended between the list and the click would hand the
 * person a fresh claude they never asked for. An attach-only window takes
 * app/main.js's decideAttach verdict and turns anything but `attach` into a
 * refusal it can explain. Every other window is unchanged.
 */
function attachOnlyDecision(decision, env) {
  if (!env || env[ATTACH_ONLY] !== '1' || decision.action === 'attach') return decision;
  if (decision.action === 'spawn') return { action: 'refuse', reason: 'ended', attachOnly: true };
  return { ...decision, attachOnly: true };
}

module.exports = { resolveLaunchTarget, parseCli, launchEnv, attachEnv, attachOnlyDecision };
