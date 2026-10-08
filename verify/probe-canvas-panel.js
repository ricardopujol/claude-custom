'use strict';
/**
 * PROBE: Claude's panel (BACKLOG #71), in a REAL window with a REAL host. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-canvas-panel.js        (exit 0 = every check held)
 *   CANVAS_PROBE_SHOTS=<dir>                                             where the screenshots go
 *
 * The unit tests pin the decisions (test/canvas-display.test.js, canvas-views.test.js, canvas-fetch.test.js, canvas-control.test.js)
 * and verify/probe-canvas-sandbox.js runs the sealed view through ~50 escape paths. No unit test can see the page: every renderer
 * script shares ONE global scope (CLAUDE.md) and the panel is a native view laid over a DOM slot. This runs the whole thing:
 *
 *   1  Claude's panel starts HIDDEN (in no group of the layout); the module is registered and its script ran in the shared scope
 *   2  a page written to the session's folder docks the panel, selects it, and a native view appears over its slot at the slot's
 *      rectangle; the page runs (its title ticks, so it is live)
 *   3  hidden means stopped: hiding the module destroys the view; showing it rebuilds the page from the file (the ticks restart)
 *   4  a page over 1 MB is refused with "Claude's page is too big (1.5 MB, the limit is 1 MB)" and no view; a good page brings it back
 *   5  the page reaches for a host: the panel is covered by "This panel wants to reach <host>", the native view is hidden, NOTHING
 *      reached the server; Deny keeps it out (still nothing), a denied host is not asked about again, and the badge says "1 host
 *      denied"; removing it from the list and reloading asks again; Allow reaches the server (the fetch answers 200), the badge
 *      says "1 host allowed", the answer is on disk in hosts.json
 *   6  a new CLI session is an empty panel (the empty state, no view); the first session's page comes back on resume without
 *      re-docking the panel
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills and no prompt is ever sent; ELECTRON_RUN_AS_NODE and
 * every CLAUDE_CUSTOM_* variable of an enclosing tab are stripped; the project is a temp git repo, registry, portraits, uploads
 * and user data are temp folders. Files of THIS checkout touched, because host.js hardcodes its state dir: layout-global.json and
 * layout-tree.json (snapshotted and put back on every exit path) and .harness/state/canvas/probe-canvas-* (removed). Only PIDs this
 * probe started are killed.
 */
const { spawn, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.harness', 'state');
const LAYOUT_FILE = path.join(STATE_DIR, 'layout-global.json');
const TREE_FILE = path.join(STATE_DIR, 'layout-tree.json');
const CANVAS_DIR = path.join(STATE_DIR, 'canvas');
const SID1 = 'probe-canvas-one';
const SID2 = 'probe-canvas-two';
const BROKER_NAME = 'probe-broker.invalid';
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');
const { isLiveHost } = require('./lib/live-host');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function fireHook(pid, event, payload) {
  return new Promise((resolve) => {
    const sock = net.connect(`\\\\.\\pipe\\claude-custom-${pid}`);
    sock.on('connect', () => sock.end(JSON.stringify({ event, payload }) + '\n', () => resolve(true)));
    sock.on('error', () => resolve(false));
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-canvas-panel-'));
const dev = path.join(tmp, 'proj', 'dev');
const userData = path.join(tmp, 'user-data');
const shots = process.env.CANVAS_PROBE_SHOTS || path.join(ROOT, '.harness', 'probe-canvas-panel');
fs.mkdirSync(shots, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
async function waitFor(fn, ms = 20000, step = 200) {
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

const layoutSnap = snapshotFile(LAYOUT_FILE);
const treeSnap = snapshotFile(TREE_FILE);
const removeCanvasDirs = () => { for (const sid of [SID1, SID2]) { try { fs.rmSync(path.join(CANVAS_DIR, sid), { recursive: true, force: true }); } catch { /* none */ } } };
hygiene.addCleanup(() => { layoutSnap.restore(); treeSnap.restore(); removeCanvasDirs(); });
hygiene.install();

async function launchApp(cwd) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CUSTOM_')));
  const env = {
    ...inherited,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    // The broker refuses every loopback address, so the stub is reached by a NAME the app's probe seam maps to loopback (PR #122 F6/F10).
    // That is also what makes this check able to see the resolver rule break the broker: Chromium's own stack (net.fetch) would refuse
    // this name (ERR_NAME_NOT_RESOLVED under host-resolver-rules), where it would still reach a bare 127.0.0.1.
    CLAUDE_CUSTOM_CANVAS_PROBE_HOSTS: JSON.stringify({ [BROKER_NAME]: '127.0.0.1' }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env });
  hygiene.registerChild(child);
  const app = { port, token, child, out: '', exited: false };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; });
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
const view = (app, action, args = {}) => command(app, { cmd: 'view', action, args });

const seenPids = new Set();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(ROOT, '.harness', 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: path.join(ROOT, '.harness'), port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) out.push(id);
  }
  return out;
}
function killEverything() {
  for (const id of hostsOfThisRun()) seenPids.add(id.pid);
  for (const pid of seenPids) { try { require(path.join(ROOT, 'host', 'kill-tree')).killPidTree(pid); } catch { /* gone */ } }   // kill-ok: a host pid from an identity file or the app state, no handle held (the seenPids class, PR #130 follow-up)
}
hygiene.addCleanup(killEverything);

async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.add(h.pid);
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? v : null;
  }, 45000);
}

async function liveForeignHost() {
  let files = [];
  try { files = fs.readdirSync(path.join(ROOT, '.harness', 'hosts')).filter(f => f.endsWith('.json')); } catch { return null; }
  for (const f of files) {
    const id = readIdentity({ dir: path.join(ROOT, '.harness'), port: Number(f.replace(/\.json$/, '')) });
    if (!id || !Number.isInteger(id.pid)) continue;
    if (await isLiveHost(id) && !path.resolve(String(id.cwd || '')).toLowerCase().startsWith(path.resolve(tmp).toLowerCase() + path.sep)) return id;
  }
  return null;
}

const writePage = (sid, html) => {
  const dir = path.join(CANVAS_DIR, sid);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `index.html.${process.pid}.tmp`);
  fs.writeFileSync(temp, html);
  fs.renameSync(temp, path.join(dir, 'index.html'));      // by rename, as the MCP tool writes it
};

const CLOCK = '<h1 id="c">clock</h1><script>let n = 0; setInterval(() => { document.title = "tick " + (++n); }, 100);</script>';
const tickOf = (title) => { const m = /^tick (\d+)$/.exec(String(title)); return m ? Number(m[1]) : null; };

async function main() {
  const foreign = await liveForeignHost();
  if (foreign) {
    console.log(`REFUSED: a live host (pid ${foreign.pid}, ${foreign.cwd}) is open on this checkout. The probe rewrites the layout files on purpose; close that window, or run the probe from another checkout.`);
    failures++;
    return;
  }
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const f of [LAYOUT_FILE, TREE_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  removeCanvasDirs();

  // the host the panel's page may reach (counts what arrives)
  const hits = { n: 0 };
  const server = http.createServer((q, res) => { hits.n += 1; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('pong'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  hygiene.addCleanup(() => { try { server.close(); } catch { /* closed */ } });
  const loopbackOrigin = `http://127.0.0.1:${server.address().port}`;
  const origin = `http://${BROKER_NAME}:${server.address().port}`;

  const app = await launchApp(dev);
  const ready = await viewReady(app);
  check('the window came up with a session', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  const hostPid = (await command(app, { cmd: 'state' })).hosts[0].pid;
  const st = () => view(app, 'canvasState');
  const inspect = () => command(app, { cmd: 'canvas', action: 'inspect' });
  const hook = (event, payload = {}) => fireHook(hostPid, event, payload);

  // 1 -----------------------------------------------------------------------------
  const s0 = await st();
  check('1: canvas-display.js loaded in the shared plain-script scope', s0.ok && s0.scope, JSON.stringify(s0).slice(0, 200));
  check('1: Claude\'s panel starts hidden: in no group of the layout, not shown', s0.hiddenInLayout === true && s0.shown === false && s0.inShownModules === false, JSON.stringify(s0).slice(0, 300));
  check('1: no native view yet', (await inspect()).exists === false);
  check('a SessionStart hook reached the host', await hook('SessionStart', { source: 'startup', session_id: SID1 }));
  await sleep(600);
  check('1: a session with no page docks nothing', (await st()).hiddenInLayout === true);

  // 2 -----------------------------------------------------------------------------
  writePage(SID1, CLOCK);
  const docked = await waitFor(async () => { const s = await st(); return s.shown && s.slot && s.slot.width > 50 ? s : null; }, 20000, 200);
  check('2: a page written to the session folder docks Claude\'s panel and shows it', !!docked, JSON.stringify(await st()).slice(0, 400));
  const v1 = await waitFor(async () => { const i = await inspect(); return i.exists && i.visible && tickOf(i.title) !== null ? i : null; }, 15000, 200);
  check('2: a native view exists, is visible, and its page is RUNNING (the title ticks)', !!v1, JSON.stringify(await inspect()));
  if (!v1) { console.log(app.out.slice(-800)); return; }
  const tabView = await command(app, { cmd: 'state' });
  const slot = (await st()).slot;
  const near = (a, b) => Math.abs(a - b) <= 2;
  check('2: the native view sits over the slot at its rectangle (same size, inside the window)',
    near(v1.bounds.width, slot.width) && near(v1.bounds.height, slot.height) && v1.bounds.x >= 0 && v1.bounds.y >= slot.y,
    JSON.stringify({ view: v1.bounds, slot }));
  await sleep(500);
  const v1b = await inspect();
  check('2: the page keeps running: the ticks go up', tickOf(v1b.title) > tickOf(v1.title), `${v1.title} -> ${v1b.title}`);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '2-docked.png') });
  void tabView;

  // 3 -----------------------------------------------------------------------------
  await view(app, 'hide', { id: 'canvas' });
  const gone = await waitFor(async () => { const i = await inspect(); return i.exists === false ? true : null; }, 8000, 150);
  check('3: hiding the module destroys the native view (hidden means stopped)', !!gone, JSON.stringify(await inspect()));
  await view(app, 'show', { id: 'canvas' });
  const back = await waitFor(async () => { const i = await inspect(); return i.exists && i.visible && tickOf(i.title) !== null ? i : null; }, 15000, 200);
  check('3: showing it rebuilds the page from the file (the ticks start again from the beginning)', !!back && tickOf(back.title) < tickOf(v1b.title), `${v1b.title} -> ${back && back.title}`);

  // 4 -----------------------------------------------------------------------------
  writePage(SID1, 'x'.repeat(Math.round(1.5 * 1024 * 1024)));
  const big = await waitFor(async () => { const s = await st(); return /too big/.test(s.text) ? s : null; }, 15000, 200);
  check('4: a page over 1 MB says how big it is and what the limit is', !!big && big.text.includes("Claude's page is too big (1.5 MB, the limit is 1 MB)"), big ? big.text.slice(0, 200) : JSON.stringify(await st()).slice(0, 300));
  check('4: ...and there is no native view', (await inspect()).exists === false, JSON.stringify(await inspect()));
  writePage(SID1, CLOCK);
  const again = await waitFor(async () => { const i = await inspect(); return i.exists && tickOf(i.title) !== null ? i : null; }, 15000, 200);
  check('4: a good page brings it back', !!again);

  // 5 -----------------------------------------------------------------------------
  const reach = (n) => `<h1>reach ${n}</h1><script>fetch(${JSON.stringify(origin + '/ping')}).then(r => { document.title = "fetch " + r.status; }, () => { document.title = "fetch blocked"; });</script>`;
  const hostsFile = path.join(CANVAS_DIR, SID1, 'hosts.json');
  const hostsOnDisk = () => { try { return JSON.parse(fs.readFileSync(hostsFile, 'utf8')); } catch { return null; } };
  hits.n = 0;
  writePage(SID1, reach(1));
  const asked = await waitFor(async () => { const s = await st(); return s.asking ? s : null; }, 15000, 200);
  check('5: the page reaching for a host is a question over the panel: "This panel wants to reach <host>."', !!asked && asked.asking.includes(`This panel wants to reach ${origin}`), JSON.stringify(asked && asked.asking));
  const cov = await inspect();
  check('5: the native view is hidden while the question is up (it would paint above it)', cov.exists && cov.visible === false, JSON.stringify(cov));
  check('5: NOTHING reached the server before the answer', hits.n === 0, `hits ${hits.n}`);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '5-question.png') });
  await view(app, 'canvasClick', { act: 'deny' });
  const denied = await waitFor(async () => { const i = await inspect(); return i.title === 'fetch blocked' ? i : null; }, 10000, 150);
  check('5: Deny: the page\'s fetch fails and the server saw nothing', !!denied && hits.n === 0, JSON.stringify({ title: (await inspect()).title, hits: hits.n }));
  // the host's frame with the new list follows the answer: wait for it, a probe that reads the instant after the click races it
  const afterDeny = await waitFor(async () => { const s = await st(); return s.badge === '1 host denied' ? s : null; }, 8000, 150) || await st();
  check('5: the badge says "1 host denied", and the view is back', afterDeny.badge === '1 host denied' && (await inspect()).visible === true, JSON.stringify({ badge: afterDeny.badge, v: await inspect() }));
  check('5: the denial is on disk for this panel', !!hostsOnDisk() && hostsOnDisk().denied.includes(origin) && hostsOnDisk().approved.length === 0, JSON.stringify(hostsOnDisk()));
  writePage(SID1, reach(2));
  await sleep(2500);
  const quiet = await st();
  check('5: a denied host is not asked about again, and still nothing reached it', !quiet.asking && hits.n === 0 && (await inspect()).title === 'fetch blocked', JSON.stringify({ asking: quiet.asking, hits: hits.n, title: (await inspect()).title }));
  await view(app, 'canvasClick', { act: 'hosts' });
  const listed = await waitFor(async () => { const s = await st(); return s.hostsListed.length ? s : null; }, 5000, 150);
  check('5: the badge opens the list: the host, "Denied", with a Remove', !!listed && listed.hostsListed[0].includes(origin) && /Denied/.test(listed.hostsListed[0]), JSON.stringify(listed && listed.hostsListed));
  check('5: ...and the list covers the view', (await inspect()).visible === false);
  await view(app, 'canvasClick', { act: 'remove', origin });
  await waitFor(async () => { const s = await st(); return /No hosts yet/.test(s.text) ? s : null; }, 8000, 150);
  await waitFor(async () => (hostsOnDisk() && hostsOnDisk().denied.length === 0 ? true : null), 8000, 150);     // the host writes it a moment after the list redraws
  check('5: Remove takes the host off the list (and the disk)', !!hostsOnDisk() && hostsOnDisk().denied.length === 0, JSON.stringify(hostsOnDisk()));
  await view(app, 'canvasClick', { act: 'close-hosts' });
  writePage(SID1, reach(3));
  const asked2 = await waitFor(async () => { const s = await st(); return s.asking ? s : null; }, 15000, 200);
  check('5: after the removal the page is asked about again', !!asked2);
  await view(app, 'canvasClick', { act: 'allow' });
  const ok200 = await waitFor(async () => { const i = await inspect(); return i.title === 'fetch 200' ? i : null; }, 10000, 150);
  check('5: Allow: the fetch reaches the server and answers 200', !!ok200 && hits.n >= 1, JSON.stringify({ title: (await inspect()).title, hits: hits.n }));
  const afterAllow = await st();
  check('5: the badge says "1 host allowed" and the answer is on disk', afterAllow.badge === '1 host allowed' && !!hostsOnDisk() && hostsOnDisk().approved.includes(origin), JSON.stringify({ badge: afterAllow.badge, disk: hostsOnDisk() }));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '5-allowed.png') });

  // 5b: something else drawn over the slot (PR #122 Dexter F5) -----------------------------------------------------
  check('5b: before the overlay the native view is visible', (await inspect()).visible === true, JSON.stringify(await inspect()));
  await view(app, 'canvasOverlay', { on: true });
  const hiddenByOverlay = await waitFor(async () => ((await inspect()).visible === false ? true : null), 5000, 100);
  check('5b: a box drawn over part of the slot (a float, menu or popover) hides the native view, which would paint above it', !!hiddenByOverlay, JSON.stringify(await inspect()));
  await view(app, 'canvasOverlay', { on: false });
  const shownAgain = await waitFor(async () => ((await inspect()).visible === true ? true : null), 5000, 100);
  check('5b: and the view is back once the box is gone', !!shownAgain, JSON.stringify(await inspect()));

  // 5c: the broker never reaches this machine, whatever the person approved (PR #122 Dexter F6) ------------------------------------
  const hitsBefore = hits.n;
  writePage(SID1, `<h1>literal</h1><script>fetch(${JSON.stringify(loopbackOrigin + '/ping')}).then(r => { document.title = "literal " + r.status; }, (e) => { document.title = "literal blocked"; });</script>`);
  const lit = await waitFor(async () => { const i = await inspect(); return i.title === 'literal blocked' || /^literal \d/.test(i.title) ? i : null; }, 15000, 150);
  check('5c: a loopback ADDRESS is refused by the real broker, with no question and nothing reaching the server', !!lit && lit.title === 'literal blocked' && hits.n === hitsBefore && !(await st()).asking, JSON.stringify({ title: lit && lit.title, hits: hits.n - hitsBefore, asking: (await st()).asking }));

  // 6 -----------------------------------------------------------------------------
  await hook('SessionStart', { source: 'clear', session_id: SID2 });
  const empty = await waitFor(async () => { const s = await st(); return s.empty ? s : null; }, 10000, 150);
  check('6: a new CLI session is an empty panel: the invitation and its examples', !!empty && /Nothing here yet\. Ask Claude to build something in this panel, for example:/.test(empty.text) && /a clock with Santiago and UTC/.test(empty.text), JSON.stringify(empty && empty.text).slice(0, 200));
  check('6: ...with no native view', (await inspect()).exists === false);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '6-empty.png') });
  await hook('SessionStart', { source: 'resume', session_id: SID1 });
  const resumed = await waitFor(async () => { const i = await inspect(); return i.exists && i.visible ? i : null; }, 15000, 200);
  check('6: resuming the first session brings its page back', !!resumed, JSON.stringify(await inspect()));
  check('6: ...and its allowed host is still allowed', (await st()).badge === '1 host allowed', JSON.stringify((await st()).badge));

  const fin = await st();
  check('the page raised no panel error line at rest', fin.note === null, JSON.stringify(fin.note));
  console.log(`screenshots: ${shots}`);
  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 10000);
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    console.log(failures ? `\nFAILED: ${failures}` : '\nOK: every check held');
    process.exit(failures ? 1 : 0);
  });
