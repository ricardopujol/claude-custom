'use strict';
/**
 * How claude-custom.exe (the installed build, and `electron .` in a checkout) reads its own command line.
 *
 * The launcher script (bin/claude-custom.js) isn't in the installed build's path, so the exe has to decide for itself:
 *
 *   --help / -h       print the usage and leave (exit 0)
 *   --version / -v    print ONE line, `claude-custom <version>`, and leave. The exit code says whether the line was written.
 *   --stop            refused: stopping sessions is the launcher's job, and "open a window here" is the opposite of it
 *   a folder          open it. One that isn't there is refused, in one line, with no window and no session
 *   no folder         CLAUDE_CUSTOM_CWD (the launcher's hand-off), else the folder it was started in; and when that is its
 *                     own install folder (the Start menu and the desktop shortcut start it there) the home folder instead
 *
 * A folder on the command line beats an inherited CLAUDE_CUSTOM_CWD: that variable is a leftover from some other tab's shell
 * whenever a person types a path. Other options (Chromium's, --inspect) are ignored, as before. Outside an installed build only
 * the first two apply: a checkout's `electron .` is driven by CLAUDE_CUSTOM_CWD and the probes' own switches.
 *
 * Pure over what it's handed (`stat`, `write`, `exit`), so every branch is tested without a window.
 */
const fs = require('fs');
const path = require('path');

const USAGE = `claude-custom [folder]
claude-custom --version

  Opens the claude-custom harness on a project folder: the one you name, or the one you start it in.
  Started from the Start menu it opens your home folder; switch with the Projects panel.
  Stopping the sessions that use a folder (--stop) is the launcher's job: node bin/claude-custom.js <folder> --stop in a checkout.`;

/** `claude-custom 0.0.1`: the same line from the launcher and the exe, so a smoke test can match one shape. */
function versionText(pkg) {
  const v = pkg && typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : null;
  return v ? `claude-custom ${v}` : 'claude-custom (version unknown)';
}

const inside = (dir, root) => {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function decideEntry({ args = [], env = {}, cwd, installDir, home, packaged = false, pkg, stat = fs.statSync, appDirs = [] } = {}) {
  // The app's own folder on the command line is how `electron <appDir>` is started in a checkout, and what an older spawner passed: it is
  // never a project folder.
  const own = (Array.isArray(appDirs) ? appDirs : []).map(d => path.resolve(d).toLowerCase());
  const list = (Array.isArray(args) ? args.filter(a => typeof a === 'string') : [])
    .filter(a => a.startsWith('-') || !own.includes(path.resolve(cwd || '.', a).toLowerCase()));
  if (list.includes('-h') || list.includes('--help')) return { action: 'help', text: USAGE };
  if (list.includes('-v') || list.includes('--version')) return { action: 'version', text: versionText(pkg) };
  const fromEnv = typeof env.CLAUDE_CUSTOM_CWD === 'string' && env.CLAUDE_CUSTOM_CWD !== '' ? env.CLAUDE_CUSTOM_CWD : null;
  if (!packaged) return { action: 'open', cwd: fromEnv || cwd };

  if (list.includes('--stop')) {
    return { action: 'refuse', text: 'claude-custom.exe doesn\'t stop sessions (--stop). Close the session\'s window, or use the launcher: node bin/claude-custom.js <folder> --stop' };
  }
  const folders = list.filter(a => a.trim() !== '' && !a.startsWith('-'));
  if (folders.length > 1) return { action: 'refuse', text: `one folder at a time (got ${folders.length})` };
  if (folders.length === 1) {
    const target = path.resolve(cwd, folders[0]);
    let ok = false;
    try { ok = stat(target).isDirectory(); } catch { ok = false; }
    return ok ? { action: 'open', cwd: target } : { action: 'refuse', text: `no such folder: ${target}` };
  }
  if (fromEnv) return { action: 'open', cwd: fromEnv };
  return { action: 'open', cwd: typeof installDir === 'string' && inside(cwd, installDir) ? home : cwd };
}

/**
 * Do what a decision says when it isn't "open". Returns true when it handled the run (and called `exit`).
 * A line that couldn't be written is a failed run: a smoke test that checks the exit code must not pass on no output.
 */
function carryOut(decision, { write, exit }) {
  if (decision.action === 'version' || decision.action === 'help') {
    exit(write(1, decision.text + '\n') === true ? 0 : 1);
    return true;
  }
  if (decision.action === 'refuse') {
    write(2, decision.text + '\n');
    exit(1);
    return true;
  }
  return false;
}

/** Started as plain Node (ELECTRON_RUN_AS_NODE set, in any spelling: Windows names are case-insensitive) when it should be the app. */
function startedAsNode(env) {
  if (!env || typeof env !== 'object') return false;
  return Object.entries(env).some(([k, v]) => k.toUpperCase() === 'ELECTRON_RUN_AS_NODE' && typeof v === 'string' && v !== '');
}

const REEXEC = 'CLAUDE_CUSTOM_REEXEC';

/**
 * What to do about a Node-mode start. 'run': not node mode. 'rerun': run again as the app with `env` (no variable in any spelling, the
 * one-hop marker set). 'giveup': the marker says this already was the re-run and it is still node mode, so say so and stop: never a chain.
 */
function nodeModePlan(env) {
  if (!startedAsNode(env)) return { action: 'run' };
  if (env[REEXEC] === '1') return { action: 'giveup', text: 'claude-custom: still running as plain Node after one re-run (ELECTRON_RUN_AS_NODE could not be cleared)' };
  const out = {};
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== 'ELECTRON_RUN_AS_NODE') out[k] = v;
  out[REEXEC] = '1';
  return { action: 'rerun', env: out };
}

/** The arguments the app's own spawner (the strip's Open) gives the exe: none when installed (the exe finds its app), the app folder in a checkout. */
function appLaunchArgs({ packaged, installDir }) {
  return packaged ? [] : [installDir];
}

/** Which Electron the launcher starts: the checkout's own (a devDependency), else this very exe (the installed build ships none). */
function electronLaunch({ installDir, execPath, load = require, isElectron = !!process.versions.electron }) {
  let failure = null;
  try {
    const exe = load(path.join(installDir, 'node_modules', 'electron'));
    if (typeof exe === 'string' && exe !== '') return { exe, args: [installDir], installed: false };
  } catch (err) { failure = err; }
  // The installed build ships no electron module and runs under its own exe, which IS Electron. A plain Node (a checkout whose electron is
  // missing or failed to install) must not be started in its place: that is a bare REPL waiting on stdin.
  if (isElectron) return { exe: execPath, args: [], installed: true };
  throw new Error(`electron isn't available here (${failure ? failure.message : 'node_modules/electron is not a path'}): run npm ci in ${installDir}`);
}

module.exports = { USAGE, REEXEC, versionText, decideEntry, carryOut, startedAsNode, nodeModePlan, appLaunchArgs, electronLaunch };
