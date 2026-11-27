'use strict';
/**
 * A second window prints no Chromium cache errors (BACKLOG #215).  (re-runnable)
 *
 *   node verify/probe-cache-errors.js        (exit 0 = the second window's output is clean)
 *
 * Every window shares one Electron user-data folder, so a window started while another is running used to print
 * `Unable to move the cache: Access is denied`, `Unable to create cache` and `Gpu Cache Creation failed: -2` (Chromium's
 * disk and GPU caches sit under the user-data folder and the first window holds them). This starts two real windows on two
 * throwaway projects with ONE shared --user-data-dir (a temp folder, never the real %APPDATA%\claude-custom) and prints
 * every cache line the second one wrote. PASS = none, and both windows answered the driver.
 * `--baseline` runs the same with the fix off (CLAUDE_CUSTOM_SHARED_CACHE=1) and PASSES only if the second window DOES print them,
 * which proves this probe can see the problem.
 *
 * The hosts' `claude` is cmd.exe (CLAUDE_CUSTOM_BIN): nothing bills. ELECTRON_RUN_AS_NODE is deleted. Hosts and windows are
 * ended by their own driver `quit` and by pid tree for any left (verify/lib/process-hygiene, verify/lib/seen-pids). Both windows
 * start through verify/lib/launch-electron.js; requiring it takes the machine's heavy lock once for this probe, held until it ends.
 */
const { spawnElectron } = require('./lib/launch-electron');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));

if (process.platform !== 'win32') { console.log('SKIP: this probe drives cmd.exe; Windows only'); process.exit(0); }

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-cache-'));
const userData = path.join(tmp, 'user-data');
// The three lines of the bug, the files Chromium logs them from, and a failure that names the Code, Dawn, shader or GPU cache
// (those folders stay shared in user-data: a PASS here says THIS machine's second window is quiet about them too).
const CACHE_LINE = /Unable to move the cache|Unable to create cache|Gpu Cache Creation failed|cache_util_win\.cc|disk_cache\.cc|gpu_disk_cache\.cc|(?:Code|Dawn|GrShader|Shader|GPU) ?Cache.*(?:fail|error|denied|unable)/i;
const BASELINE = process.argv.includes('--baseline');     // the fix is switched off (CLAUDE_CUSTOM_SHARED_CACHE=1): the probe must SEE the lines
const seenPids = require('./lib/seen-pids').createSeenPids();

let failures = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`); if (!ok) failures++; };

async function waitFor(fn, ms = 20000, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer(); srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

async function launchApp(no) {
  const project = path.join(tmp, `project-${no}`);
  fs.mkdirSync(project, { recursive: true });
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: project,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, `registry-${no}`),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    ...(BASELINE ? { CLAUDE_CUSTOM_SHARED_CACHE: '1' } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE; delete env.CLAUDE_CUSTOM_PORT; delete env.CLAUDE_CUSTOM_TOKEN;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`, '--enable-logging=stderr'], { cwd: ROOT, env },
    { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_SHARED_CACHE'] });
  hygiene.registerChild(child);
  const app = { no, port, token, child, out: '', exited: false };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; hygiene.unregisterSpawnedTree(child.pid); });
  return app;
}

function command(app, cmd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: app.port });
    let buf = '';
    const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done({ ok: false, error: `no reply to ${cmd.cmd}` }), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ ...cmd, token: app.token }) + '\n'));
    sock.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done({ ok: false, error: 'unparseable' }); } } });
    sock.on('error', (e) => done({ ok: false, error: e.message }));
  });
}

async function up(app) {
  return waitFor(async () => {
    if (app.exited) throw new Error('the app exited');
    const s = await command(app, { cmd: 'state' });
    if (s && s.ok) for (const h of s.hosts || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
    return s && s.ok ? s : null;
  }, 60000, 500);
}

async function main() {
  console.log('temp folder:', tmp);
  const first = await launchApp(1);
  const a = await up(first);
  check('the first window came up and its driver answers', !!a, a ? `pid ${first.child.pid}` : first.out.split('\n').slice(-15).join('\n'));
  if (!a) return;
  await sleep(2000);
  const second = await launchApp(2);
  const b = await up(second);
  check('the second window (same user-data folder, other project) came up and its driver answers', !!b, b ? `pid ${second.child.pid}` : second.out.split('\n').slice(-15).join('\n'));
  await sleep(3000);
  const lines = second.out.split(/\r?\n/).filter(l => CACHE_LINE.test(l));
  if (BASELINE) check('baseline (fix off): the second window DOES print the cache lines, so this probe can see the problem', lines.length > 0, lines.slice(0, 3).join(' | '));
  else check('the second window printed no Chromium cache lines', lines.length === 0, lines.length ? `\n    ${lines.slice(0, 8).join('\n    ')}` : '');
  const firstLines = first.out.split(/\r?\n/).filter(l => CACHE_LINE.test(l));
  console.log(`(the first window printed ${firstLines.length} cache lines)`);
  for (const app of [second, first]) { if (!app.exited) await command(app, { cmd: 'quit' }, 5000); await waitFor(() => app.exited, 15000, 200); }
}

(async () => {
  try { await main(); } catch (err) { console.log(`FAIL  the probe threw: ${err && err.stack || err}`); failures++; } finally {
    try {
      const dir = path.join(HARNESS_DIR, 'hosts');
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.json')) : []) {
        const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
        if (id && path.resolve(id.cwd).toLowerCase().startsWith(path.resolve(tmp).toLowerCase())) seenPids.add(id.pid, id.processStartedAt);
      }
    } catch { /* best effort */ }
    seenPids.endAll();
    hygiene._emergencyCleanup('done');
    await sleep(800);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { console.log(`(could not remove ${tmp}: ${e.message})`); }
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
