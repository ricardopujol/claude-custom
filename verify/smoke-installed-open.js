'use strict';
/**
 * The installed build's strip ▾ Open, run for real. (re-runnable; needs the installer's output installed to a TEMP folder)
 *
 *   node verify/smoke-installed-open.js <install-folder>        e.g. a temp folder from `claude-custom-setup-x.exe /S /D=<folder>`
 *
 * PR #203 Dexter r2 N1: the spawner used to give the installed exe the app folder as its one argument, which read as the folder to open,
 * so every row said "That port now serves another folder". This starts the installed exe the way the launcher does on a temp project
 * (window A, whose host serves that folder), then starts it the way ▾ Open does (host/exe-entry.js appLaunchArgs: no arguments, attachEnv's
 * environment naming the row's folder and port) and asserts window B's folder is the PROJECT, not resources\app, and that it did not refuse.
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN): nothing bills. The project is a temp git repo. Electron is started only through
 * verify/lib/launch-electron.js (heavy lock, stopped by PID); the hosts it leaves are found by identity file and stopped by PID with
 * verify/lib/seen-pids.js. Nothing is stopped by name. WINDOWS ONLY.
 */
const { launchElectron } = require('./lib/launch-electron');
const { attachEnv } = require('../host/launch-target');
const { appLaunchArgs } = require('../host/exe-entry');
const { readIdentity } = require('../host/host-identity');
const seenPids = require('./lib/seen-pids').createSeenPids();   // pid + start time: a reused pid is never killed
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const install = process.argv[2];
if (!install || !fs.existsSync(path.join(install, 'claude-custom.exe'))) { console.error('usage: node verify/smoke-installed-open.js <install-folder>'); process.exit(2); }
const exe = path.join(install, 'claude-custom.exe');
const appDir = path.join(install, 'resources', 'app');
const harness = path.join(appDir, '.harness');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-open-smoke-'));
const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj);
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'init', '-q', '-b', 'develop'], { cwd: proj, windowsHide: true });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: proj, windowsHide: true });

const norm = (p) => path.resolve(p).toLowerCase();
let failures = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`); if (!ok) failures++; };

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(300); }
}
const common = { CLAUDE_CUSTOM_BIN: 'C:/Windows/System32/cmd.exe', CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'), CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'), CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads') };
fs.mkdirSync(common.CLAUDE_CUSTOM_REGISTRY, { recursive: true });

function start(label, args, env) {
  let out = '';
  return launchElectron({ electronPath: exe, args: [...args, `--user-data-dir=${path.join(tmp, 'ud-' + label)}`], extraEnv: { ...common, ...env }, label, stdio: ['ignore', 'pipe', 'pipe'] })
    .then((h) => { h.child.stdout.on('data', d => { out += d; }); h.child.stderr.on('data', d => { out += d; }); h.out = () => out; return h; });
}

function hostsHere() {
  const found = [];
  try {
    for (const f of fs.readdirSync(path.join(harness, 'hosts')).filter(x => x.endsWith('.json'))) {
      const port = Number(f.replace(/\.json$/, ''));
      const id = readIdentity({ dir: harness, port });
      if (id && typeof id.cwd === 'string' && norm(id.cwd) === norm(proj)) found.push({ port, pid: id.pid, started: id.processStartedAt });
    }
  } catch { /* none yet */ }
  return found;
}

(async () => {
  const handles = [];
  try {
    // A: the launcher's way: no arguments, the folder in CLAUDE_CUSTOM_CWD.
    const a = await start('a', [], { CLAUDE_CUSTOM_CWD: proj });
    handles.push(a);
    const host = await waitFor(() => hostsHere()[0], 60000);
    check('window A: the installed exe opens the project and its host serves that folder', !!host && new RegExp(`launched on\\s*:\\s*${proj.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`, 'i').test(a.out()), a.out().slice(-300));
    if (!host) return;

    // B: the strip's ▾ Open: the exact argv the app's spawner builds when installed, attachEnv's environment.
    const argv = appLaunchArgs({ packaged: true, installDir: appDir });
    check('the spawner gives an installed exe NO folder argument', argv.length === 0, JSON.stringify(argv));
    const b = await start('b', argv, attachEnv({}, { cwd: proj, port: host.port }));
    handles.push(b);
    await sleep(15000);
    const text = b.out();
    check('window B (▾ Open) is on the PROJECT folder', new RegExp(`launched on\\s*:\\s*${proj.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`, 'i').test(text), text.slice(-400));
    check('window B is not on resources\\app', !/launched on\s*:.*resources[\\/]app/i.test(text));
    check('window B was not refused ("serves another folder")', !/serves another folder|nothing was opened/i.test(text), text.slice(-400));
  } finally {
    for (const h of handles.reverse()) { try { await h.stop(); } catch { /* gone */ } }
    for (const h of hostsHere()) seenPids.add(h.pid, h.started);   // hosts this run started, found by their identity file inside its temp project
    seenPids.endAll();
    await sleep(1500);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  }
})().catch((e) => { console.error('crashed: ' + (e && e.stack)); process.exit(1); });
