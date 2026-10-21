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
 * PR 3), `-h` / `--help`. -> { cmd: 'help' } | { cmd: 'open', arg }
 * | { cmd: 'stop', folder }. A `--stop` folder is only resolved, never checked:
 * the folder being cleaned up may already be gone. An unknown option or a
 * second folder throws, rather than opening a folder named "--stpo" or quietly
 * ignoring one of the two.
 */
function parseCli(argv, { cwd = process.cwd() } = {}) {
  if (argv.includes('-h') || argv.includes('--help')) return { cmd: 'help' };
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

// --- BACKLOG #119 A5: the "shell" target ---------------------------------------------------------------------------------
// A shell tab's pty runs the person's shell, not `claude`. Which binary is decided here, pure: every collaborator is injected.

const SHELL_OVERRIDE = 'CLAUDE_CUSTOM_SHELL';

/** The first file called `name` in the PATH folders, or null. A name with a folder in it is not looked up. */
function findOnPath(name, { pathVar = process.env.PATH || process.env.Path || '', platform = process.platform, stat = fs.statSync } = {}) {
  if (typeof name !== 'string' || name === '' || /[\\/]/.test(name)) return null;
  const p = platform === 'win32' ? path.win32 : path.posix;
  for (const dir of String(pathVar).split(p.delimiter)) {
    const folder = dir.trim().replace(/^"(.*)"$/, '$1');
    if (folder === '') continue;
    const candidate = p.join(folder, name);
    try { if (stat(candidate).isFile()) return candidate; } catch { /* not in this folder */ }
  }
  return null;
}

/**
 * Which program a shell tab runs. -> { bin, args: [], source: 'override' | 'pwsh' | 'powershell' | 'env-shell' | 'sh' }.
 *   - CLAUDE_CUSTOM_SHELL (an absolute path, or a command on PATH) wins. It is returned as given when it is a path, and as the file
 *     PATH finds when it is a command; a command PATH can't find stays the name, so the pty fails loudly rather than the pick
 *     quietly choosing something the person did not ask for.
 *   - else PowerShell 7 (pwsh.exe on PATH), else Windows PowerShell at its fixed System32 path.
 * No arguments: the person gets their shell, not a script. Off Windows (this app is Windows-only; kept honest for the tests): $SHELL, else /bin/sh.
 */
function pickShell(env = {}, { platform = process.platform, onPath = findOnPath, exists = (f) => fs.existsSync(f), systemRoot = (env && env.SystemRoot) || process.env.SystemRoot || 'C:\\Windows' } = {}) {
  const win = platform === 'win32';
  const raw = typeof (env || {})[SHELL_OVERRIDE] === 'string' ? env[SHELL_OVERRIDE].trim().replace(/^"(.*)"$/, '$1').trim() : '';
  if (raw !== '') {
    const isPath = (win ? path.win32 : path.posix).isAbsolute(raw) || /[\\/]/.test(raw);
    if (isPath) return { bin: raw, args: [], source: 'override' };
    const found = onPath(raw) || (win && !/\.[A-Za-z0-9]+$/.test(raw) ? onPath(`${raw}.exe`) : null);
    return { bin: found || raw, args: [], source: 'override' };
  }
  if (!win) {
    const sh = env && typeof env.SHELL === 'string' && env.SHELL.trim() !== '' ? env.SHELL.trim() : null;
    return sh ? { bin: sh, args: [], source: 'env-shell' } : { bin: '/bin/sh', args: [], source: 'sh' };
  }
  const pwsh = onPath('pwsh.exe');
  if (pwsh) return { bin: pwsh, args: [], source: 'pwsh' };
  const ps5 = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return { bin: exists(ps5) ? ps5 : 'powershell.exe', args: [], source: 'powershell' };
}

/**
 * The environment of a program in a shell tab. An arbitrary program must not get the harness's own variables (the host's session
 * token above all), and must not inherit ELECTRON_RUN_AS_NODE: the host itself runs as Node through it (host/tab-env.js), and an
 * Electron app started from the shell would silently run as plain Node.
 */
function shellEnv(base) {
  const out = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (!k.startsWith('CLAUDE_CUSTOM_') && k !== 'ELECTRON_RUN_AS_NODE') out[k] = v;
  }
  return out;
}

module.exports = { resolveLaunchTarget, parseCli, launchEnv, attachEnv, attachOnlyDecision, pickShell, shellEnv, findOnPath, SHELL_OVERRIDE };
