'use strict';
/**
 * The strip's ▾ menu of running sessions, in a REAL window with REAL hosts.
 * (Windowless sessions PR 2; re-runnable)
 *
 *   node verify/probe-background-sessions.js     (exit 0 = every check held)
 *
 * The unit tests pin host/background-hosts.js, app/background-menu.js and
 * stopHost with fakes; this runs them through app/main.js against real hosts.
 * Two hosts serve NON-REPO folders, so neither holds a session lock -- the case
 * PR 1's *Stop that session* can't reach:
 *   H1  no window          -> listed "no window", Open + Stop
 *   H2  a window attached  -> listed "1 window", Open, no Stop
 * and a window W on a third folder, whose own host is a tab here:
 *   (render)  the strip painted the ▾ button
 *   list      H1, H2 and W's host appear, this build's, with the right offers;
 *             W's host is "open here" and Open selects its tab
 *   stop      Stop on H2 (window) answers has-window and H2 keeps running;
 *             Stop on H1 answers stopped, through its own stop-if-idle, and
 *             H1's claude ends with it; the next list no longer shows H1
 *   open      H2's window closes; Open launches a window that ATTACHES to H2
 *             (H2 counts 1 window again, and no second host is started)
 *
 * SAFE: every `claude` is cmd.exe (CLAUDE_CUSTOM_BIN); nothing bills. The list
 * reads every build's real hosts too, but only the probe's own ports are ever
 * stopped. ELECTRON_RUN_AS_NODE is deleted for every Electron launch. WINDOWS ONLY.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const BUILD = path.basename(ROOT);
const { createHygieneRegistry } = require('./lib/process-hygiene');

if (process.platform !== 'win32') {
  console.log('SKIP: this probe drives cmd.exe and taskkill; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-bg-'));
const loose1 = path.join(tmp, 'loose-one');
const loose2 = path.join(tmp, 'loose-two');
const flat = path.join(tmp, 'window-folder');
for (const d of [loose1, loose2, flat]) fs.mkdirSync(d, { recursive: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
};
async function waitFor(fn, ms = 20000, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const killed = new Set();
function killTree(pid) {
  if (!alive(pid) || killed.has(pid)) return;
  killed.add(pid);
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}

// --- a host, as app/main.js would spawn one, on a non-repo folder ---------------------
const hosts = [];
function startHost(name, cwd, port) {
  const token = `probe-bg-${name}-${Date.now()}`;
  const env = { ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd, CLAUDE_CUSTOM_PORT: String(port), CLAUDE_CUSTOM_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { cwd: ROOT, env });
  hygiene.registerSpawnedTree(child.pid);
  const h = { name, port, token, child, out: '' };
  child.stdout.on('data', d => { h.out += d; });
  child.stderr.on('data', d => { h.out += d; });
  hosts.push(h);
  return h;
}
const hostUp = h => waitFor(() => /pty pid {7}: (\d+)/.exec(h.out), 30000, 100);
const exited = h => h.child.exitCode !== null || h.child.signalCode !== null;

function attach(h) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}?token=${encodeURIComponent(h.token)}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
const closeWs = ws => new Promise((resolve) => { ws.once('close', resolve); ws.close(); });

// --- the window ------------------------------------------------------------------------
const apps = [];
async function launchApp(cwd, extraEnv = {}) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = { ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDE_CUSTOM_PORT;
  delete env.CLAUDE_CUSTOM_TOKEN;
  Object.assign(env, extraEnv);
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawn(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${path.join(tmp, 'user-data')}`], { cwd: ROOT, env });
  hygiene.registerSpawnedTree(child.pid);
  const app = { port, token, child, out: '', exited: false };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; hygiene.unregisterSpawnedTree(child.pid); });
  apps.push(app);
  return app;
}
function command(app, cmd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: app.port });
    let buf = '';
    const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done({ ok: false, error: `no reply to ${cmd.cmd} in ${timeoutMs}ms` }), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ ...cmd, token: app.token }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done({ ok: false, error: 'unparseable reply' }); } }
    });
    sock.on('error', e => done({ ok: false, error: e.message }));
  });
}
const itemOn = (list, port) => (list && list.items ? list.items.find(i => i.port === port) : null);

// Every host serving a folder under tmp (W's own included), from this build's identity files.
function probeHostPids() {
  const dir = path.join(ROOT, '.harness', 'hosts');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const id = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (id && typeof id.cwd === 'string' && path.resolve(id.cwd).toLowerCase().startsWith(path.resolve(tmp).toLowerCase())) {
        out.push({ pid: id.pid, port: id.port, cwd: id.cwd });
      }
    } catch { /* half-written */ }
  }
  return out;
}

function cleanup() {
  for (const a of apps) killTree(a.child.pid);
  for (const x of extraPids) killTree(x);
  for (const h of hosts) if (!exited(h)) killTree(h.child.pid);
  for (const id of probeHostPids()) killTree(id.pid);
}
const extraPids = [];
hygiene.addCleanup(cleanup);

async function main() {
  console.log('temp:', tmp);
  const h1 = startHost('H1', loose1, await freePort());
  const h2 = startHost('H2', loose2, await freePort());
  const m1 = await hostUp(h1);
  const m2 = await hostUp(h2);
  check('H1 and H2 started their sessions', Boolean(m1 && m2));
  if (!m1 || !m2) return;
  const h1Claude = Number(m1[1]);
  check('neither holds a lock (non-repo folders)', /session lock {2}: \(not a repo\)/.test(h1.out) && /session lock {2}: \(not a repo\)/.test(h2.out));
  let h2Win = await attach(h2);
  await sleep(1500);

  const w = await launchApp(flat);
  const up = await waitFor(async () => { const s = await command(w, { cmd: 'state' }, 5000); return s && s.ok && s.hosts && s.hosts.length ? s : null; }, 60000, 500);
  check('the window came up with its own host', Boolean(up));
  if (!up) return;
  const wHost = await waitFor(() => probeHostPids().find(x => path.resolve(x.cwd) === path.resolve(flat)), 20000);
  check("W's host published its identity", Boolean(wHost));

  // list
  const list = await waitFor(async () => {
    const r = await command(w, { cmd: 'background' });
    return r && r.ok && itemOn(r, h1.port) && itemOn(r, h2.port) && (!wHost || itemOn(r, wHost.port)) ? r : null;
  }, 30000, 1000);
  check('the ▾ list answered', Boolean(list));
  if (!list) return;
  check('(render) the strip painted the ▾ button', Boolean(list.button && list.button.text === '▾'), JSON.stringify(list.button));
  const i1 = itemOn(list, h1.port);
  const i2 = itemOn(list, h2.port);
  check('H1: this build, no window, Open in a window + Stop',
    i1.label.includes(BUILD) && /no window$/.test(i1.label) && i1.open && i1.open.kind === 'window' && i1.stop === true, i1.label);
  check('H2: 1 window, Open, and NO Stop',
    /1 window$/.test(i2.label) && i2.open && i2.open.kind === 'window' && i2.stop === false, i2.label);
  if (wHost) {
    const iw = itemOn(list, wHost.port);
    check("W's own host is 'open here', Open selects its tab, no Stop",
      /open here$/.test(iw.label) && iw.open && iw.open.kind === 'select-tab' && iw.stop === false, iw.label);
  }
  check("a real host is proven EXACTLY: its identity file carries its OS start time (Dexter F1)",
    i1.exact === true && i2.exact === true, `${i1.exact}/${i2.exact}`);
  check('the label names the folder, not just a port', i1.label.startsWith(`${path.basename(tmp)}\\loose-one`), i1.label);

  // stop
  const s2 = await command(w, { cmd: 'background-stop', port: h2.port });
  check('Stop on H2 (a window) answers has-window', s2.ok && s2.outcome === 'has-window', JSON.stringify(s2));
  check('H2 is still running', !exited(h2) && alive(h2.child.pid));

  const s1 = await command(w, { cmd: 'background-stop', port: h1.port });
  check('Stop on H1 (no window, no lock) answers stopped, through its own stop-if-idle',
    s1.ok && s1.outcome === 'stopped' && s1.how === 'stop-if-idle', JSON.stringify(s1));
  check('host H1 exited', Boolean(await waitFor(() => exited(h1), 15000, 100)));
  check(`H1's claude (pid ${h1Claude}) ended with it`, Boolean(await waitFor(() => !alive(h1Claude), 15000, 200)));
  check('main logged pid, port, build and how', new RegExp(`Stop \\(background\\): stopped \\(pid ${h1.child.pid}, port ${h1.port}, build ${BUILD}, how stop-if-idle`).test(w.out));
  const after = await command(w, { cmd: 'background' });
  check('the next list no longer shows H1', after.ok && !itemOn(after, h1.port) && Boolean(itemOn(after, h2.port)));

  // Open on a host that ended after the list was read (Dexter, PR 2 F2): the
  // attach-only window refuses and ends; it never starts a fresh claude.
  const ghost = await launchApp(loose1, { CLAUDE_CUSTOM_PORT: String(h1.port), CLAUDE_CUSTOM_ATTACH_ONLY: '1' });
  const ghostGone = await waitFor(() => ghost.exited, 60000, 250);
  check('Open on an ended session: the window refuses and exits', Boolean(ghostGone) && /Open refused: ended/.test(ghost.out), ghost.out.split('\n').filter(l => /refused/.test(l)).join(' | '));
  check('and no host was started for it', !probeHostPids().some(x => path.resolve(x.cwd) === path.resolve(loose1)));

  // open
  await closeWs(h2Win);
  h2Win = null;
  await sleep(1500);
  const before = await command(w, { cmd: 'background' });
  check('H2 now has no window', /no window$/.test((itemOn(before, h2.port) || {}).label || ''), (itemOn(before, h2.port) || {}).label);
  const hostsBefore = probeHostPids().length;
  const o = await command(w, { cmd: 'background-open', port: h2.port });
  check('Open launched a window', o.ok && Number.isInteger(o.pid), JSON.stringify(o));
  if (o.ok && Number.isInteger(o.pid)) extraPids.push(o.pid);
  const attached = await waitFor(async () => {
    const r = await command(w, { cmd: 'background' });
    const it = itemOn(r, h2.port);
    return it && /1 window$/.test(it.label) ? it : null;
  }, 60000, 1500);
  check('that window ATTACHED to H2 (1 window again)', Boolean(attached), attached ? attached.label : '');
  check('and started no second host', probeHostPids().length === hostsBefore && !exited(h2), `${hostsBefore} -> ${probeHostPids().length}`);
}

main()
  .catch((err) => { console.log('ERROR', err && err.stack); failures++; })
  .finally(async () => {
    if (failures) {
      for (const h of hosts) console.log(`---- ${h.name} ----\n${h.out.slice(-3000)}`);
      for (const a of apps) console.log(`---- window ----\n${a.out.slice(-3000)}`);
    }
    cleanup();
    await sleep(800);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { console.log(`(could not remove ${tmp}: ${e.message})`); }
    console.log(failures ? `\nprobe-background-sessions: ${failures} FAILED` : '\nprobe-background-sessions: every check held');
    process.exit(failures ? 1 : 0);
  });
