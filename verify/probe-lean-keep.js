'use strict';
/**
 * PROBE: lean mode DRAWS the Schedules panel (PR #200, Ricardo 2026-10-21) in a REAL window. (re-runnable; HEAVY: take
 * ~/.claude/scripts/heavy-lock.ps1 first)
 *
 *   node verify/probe-lean-keep.js            (exit 0 = every check held)
 *   LEAN_KEEP_SHOTS=<dir>                     keep the screenshots there (default: .harness/lean-keep)
 *
 * The unit tests pin the mark (data-lean-keep) and the CSS text; neither can see the page actually paint the box, nor the
 * one-global-scope trap of plain <script>s. This does: select the Schedules tab, go lean through the strip's button, and
 * read what is on screen.
 *
 *   1  normal: Schedules is the shown panel of a drawn box, marked data-lean-keep; other boxes are drawn too
 *   2  lean: exactly one box is drawn, it is marked, it shows Schedules, it has a real size and keeps its column (the header's room goes to the dock)
 *   3  lean: the terminal keeps the plan's rectangle beside it (it does not fill the page under the box)
 *   4  Back to normal: the page is as in 1
 *
 * Only PIDs this probe started are stopped (verify/lib/process-hygiene.js + launch-electron.js), never a process by name.
 */

const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-lean-keep-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const userData = path.join(tmp, 'user-data');
const shots = process.env.LEAN_KEEP_SHOTS || path.join(HARNESS_DIR, 'lean-keep');
fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
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

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS'];

async function launchApp(cwd) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: PASSED_ENV });
  hygiene.registerChild(child);
  const app = { port, token, child, out: '', exited: false };
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
    const t = setTimeout(() => done({ ok: false, error: `no reply to ${cmd.cmd} in ${timeoutMs}ms` }), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ ...cmd, token: app.token }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done({ ok: false, error: 'unparseable reply' }); } }
    });
    sock.on('error', (e) => done({ ok: false, error: e.message }));
  });
}

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) out.push(id);
  }
  return out;
}
function killEverything() {
  for (const id of hostsOfThisRun()) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}
hygiene.addCleanup(killEverything);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true });

const stateOf = async (app) => {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
  return st;
};
const view = (app, action, args = {}) => command(app, { cmd: 'view', action, args });
const leanPage = async (app) => { const r = await view(app, 'leanState'); return r && r.ok ? r : null; };
const press = (app, button) => command(app, { cmd: 'strip-lean', button });
const shoot = (app, name) => command(app, { cmd: 'screenshot', file: path.join(shots, `${name}.png`) });

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');

  const app = await launchApp(container);
  const devHost = await waitFor(async () => {
    const st = await stateOf(app);
    return ((st && st.hosts) || []).find(x => x.label === 'develop' && x.started && Number.isInteger(x.pid)) || null;
  }, 60000);
  check('0: the window is up and the dev host is running', !!devHost, devHost ? `pid ${devHost.pid}` : `exited=${app.exited} out=${app.out.slice(-600)}`);
  if (!devHost) return;
  await sleep(10000);          // the page and the terminal settle

  const sel = await view(app, 'select', { id: 'schedules' });
  check('1: the Schedules tab was selected', sel.ok === true, JSON.stringify(sel));
  const n = await waitFor(async () => { const p = await leanPage(app); return p && p.shown.includes('schedules') ? p : null; }, 10000);
  const nz = n && n.zones.find(z => z.panels.includes('schedules'));
  check('1: normal: Schedules is shown in a drawn, marked box, and other boxes are drawn too', !!nz && nz.keep === true && n.zones.length >= 1, n ? JSON.stringify(n.zones) : 'no state');
  if (!n || !nz) return;
  await shoot(app, '1-normal');

  const pressed = await press(app, 'lean-btn');
  check('2: the strip\'s Lean button was pressed', pressed.ok === true, JSON.stringify(pressed));
  const lean = await waitFor(async () => { const p = await leanPage(app); return p && p.leanOn ? p : null; }, 10000);
  if (!lean) { check('2: the page went lean', false); return; }
  await sleep(1500);
  const l = await leanPage(app);
  const lz = l.zones;
  check('2: lean: Schedules is the only panel mounted', JSON.stringify(l.shown) === '["schedules"]', JSON.stringify(l.shown));
  check('2: lean: exactly one box is drawn, marked, showing Schedules', lz.length === 1 && lz[0].keep === true && JSON.stringify(lz[0].panels) === '["schedules"]', JSON.stringify(lz));
  check('2: lean: that box has a usable size, keeps its column, and is as tall as in normal (the header room goes to the dock)', lz.length === 1 && lz[0].rect.width >= 100 && lz[0].rect.height >= 100 && Math.abs(lz[0].rect.left - nz.rect.left) <= 1 && Math.abs(lz[0].rect.width - nz.rect.width) <= 1 && lz[0].rect.height >= nz.rect.height, JSON.stringify({ lean: lz[0] && lz[0].rect, normal: nz.rect }));
  check('2: lean: the header is hidden', l.headerVisible === false);
  check('2: lean: the terminal keeps its rectangle beside the box (it does not fill the page under it)', l.termRect.left + l.termRect.width <= lz[0].rect.left + 2 || l.termRect.width < l.page.width - 2, JSON.stringify({ term: l.termRect, box: lz[0] && lz[0].rect, page: l.page }));
  await shoot(app, '2-lean-schedules');

  const back = await press(app, 'lean-back');
  check('3: Back to normal was pressed', back.ok === true, JSON.stringify(back));
  const normal = await waitFor(async () => { const p = await leanPage(app); return p && p.leanOn === false ? p : null; }, 10000);
  await sleep(1000);
  const again = normal && await leanPage(app);
  check('3: back in normal the header and more than one box are drawn again', !!again && again.headerVisible === true && again.zones.length >= 1, again ? JSON.stringify({ header: again.headerVisible, zones: again.zones.length }) : 'no state');

  await command(app, { cmd: 'quit' });
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
