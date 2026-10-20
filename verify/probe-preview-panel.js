'use strict';
/**
 * PROBE: the Preview panel and the Dev servers chip (BACKLOG #119 A4), in a REAL window with a REAL host. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-preview-panel.js        (exit 0 = every check held)
 *   PREVIEW_PROBE_SHOTS=<dir>                                             where the screenshots go
 *
 * The unit tests pin the decisions (test/preview-guard.test.js, preview-views.test.js, preview-display.test.js, dev-servers*.test.js). No
 * unit test can see the page: every renderer script shares ONE global scope (CLAUDE.md) and the panel is a native view laid over a DOM slot.
 * This runs the whole thing, against a tiny HTTP server of the probe's own on a port INSIDE the temp worktree's block:
 *
 *   1  previewDisplay loaded in the shared plain-script scope; the chip appears once the worktree's block is known, counting 0
 *   2  a server on a port in the block is counted by the chip (1); a server on a port outside the block, not started by the session, is not
 *   3  the chip's list has one row "port · process name"; its Preview button shows the panel, the address field and a native view that is
 *      visible, over the slot, on the server's page (the page's title proves it ran)
 *   4  hidden means stopped (the view is destroyed) and showing it again comes back to the same address; nothing persists in the session
 *   5  the page has NO bridge to the app: no window.harness, no require, no process
 *   6  the guard: a page that sets its own location to another site stays where it was and the header says "blocked: example.com"; so does a
 *      redirect; window.open makes no window (returns null) and says so; a download is cancelled and says so; a typed address on the web is
 *      refused; a sub-resource on another loopback address (127.0.0.2, where a second server of the probe listens) is never requested, while the
 *      page's own assets are
 *   7  something drawn over the slot hides the native view, and it comes back
 *   8  the DevTools button toggles without taking the app down
 *   9  stopping the server brings the chip back to 0
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills and no prompt is ever sent; ELECTRON_RUN_AS_NODE and every
 * CLAUDE_CUSTOM_* variable of an enclosing tab are stripped; the project is a temp git repo, registry, portraits, uploads and user data are
 * temp folders. Files of THIS checkout touched, because host.js hardcodes its state dir: layout-global.json and layout-tree.json (snapshotted
 * and put back on every exit path). The worktree's port block is recorded in the user-wide worktree-ports.json by the host, as for any session; the
 * block is given back the next time anything allocates, once the temp folder is gone. "Open in browser" is NOT clicked (it would open the
 * person's real browser; test/preview-views.test.js pins it). Only PIDs this probe started are killed; the probe's HTTP servers are its own
 * process and are closed at the end.
 */
const { execFileSync } = require('child_process');
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
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');
const { isLiveHost } = require('./lib/live-host');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { lookup } = require(path.join(ROOT, 'host', 'port-blocks'));
const { worktreeRoot } = require(path.join(ROOT, 'host', 'worktree-env'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-preview-panel-'));
const dev = path.join(tmp, 'proj', 'dev');
const userData = path.join(tmp, 'user-data');
const shots = process.env.PREVIEW_PROBE_SHOTS || path.join(ROOT, '.harness', 'probe-preview-panel');
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
hygiene.addCleanup(() => { layoutSnap.restore(); treeSnap.restore(); });
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

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
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
// A killed host cannot remove its own identity file, and a stale one whose pid Windows has reused makes the NEXT run's REFUSED check
// answer "live" whenever it cannot read a start time. So this run's files go with its hosts.
function removeIdentityFiles() {
  const hostsDir = path.join(ROOT, '.harness', 'hosts');
  let files = [];
  try { files = fs.readdirSync(hostsDir).filter(f => f.endsWith('.json')); } catch { return; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const port = f.replace(/\.json$/, '');
    const id = readIdentity({ dir: path.join(ROOT, '.harness'), port: Number(port) });
    if (id && path.resolve(String(id.cwd || '')).toLowerCase().startsWith(inside)) {
      try { fs.rmSync(path.join(hostsDir, f), { force: true }); fs.rmSync(path.join(hostsDir, `${port}.token`), { force: true }); } catch { /* gone */ }
    }
  }
}
function killEverything() {
  const ours = hostsOfThisRun();
  for (const id of ours) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
  if (ours.length) removeIdentityFiles();
}
hygiene.addCleanup(killEverything);

async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? v : null;
  }, 120000);
}

async function liveForeignHost() {
  let files = [];
  try { files = fs.readdirSync(path.join(ROOT, '.harness', 'hosts')).filter(f => f.endsWith('.json')); } catch { return null; }
  for (const f of files) {
    const id = readIdentity({ dir: path.join(ROOT, '.harness'), port: Number(f.replace(/\.json$/, '')) });
    if (!id || !Number.isInteger(id.pid)) continue;
    if (path.basename(path.dirname(path.dirname(String(id.cwd || '')))).startsWith('cc-probe-preview-panel-')) continue;
    if (await isLiveHost(id) && !path.resolve(String(id.cwd || '')).toLowerCase().startsWith(path.resolve(tmp).toLowerCase() + path.sep)) return id;
  }
  return null;
}

// ---- the probe's own servers ----------------------------------------------------------------------------------------------------
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const hits = { ok: 0, leak: 0 };
let leakPort = 0;
function pageFor(url, port) {
  const html = (title, body) => `<!doctype html><title>${title}</title>${body}`;
  switch (url.split('?')[0]) {
    case '/': return html('index', '<h1 id="h">preview index</h1>');
    case '/surface': return html('x', '<script>document.title = [typeof window.harness, typeof require, typeof process, typeof Buffer].join(",");</script>');
    case '/nav-external': return html('nav', '<script>setTimeout(function () { location.href = "http://example.com/stolen"; }, 200);</script>');
    case '/redirect': return null;
    case '/open': return html('open', '<script>var w = window.open("https://example.com/popup"); var w2 = window.open("http://localhost:' + port + '/"); document.title = "open:" + (w === null ? "null" : "window") + "," + (w2 === null ? "null" : "window");</script>');
    case '/subres': return html('subres', '<img id="ok" src="/ok.png"><script>'
      + 'var done = 0; function fin() { if (++done === 2) document.title = "subres:done ok=" + (document.getElementById("ok").naturalWidth > 0 ? 1 : 0); }'
      + 'fetch("http://127.0.0.2:' + leakPort + '/leak", { mode: "no-cors" }).then(fin, fin);'
      + 'var i = new Image(); i.onload = fin; i.onerror = fin; i.src = "http://127.0.0.2:' + leakPort + '/leak.png";</script>');
    case '/download': return html('download', '<a id="a" href="/file.bin" download="x.bin">x</a><script>document.getElementById("a").click(); document.title = "download:tried";</script>');
    case '/storage': return html('storage', '<script>document.title = localStorage.getItem("k") ? "storage:kept" : (localStorage.setItem("k", "1"), "storage:fresh");</script>');
    default: return html('404', '');
  }
}
function startServer(host, port, handler) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.once('error', reject);
    srv.listen(port, host, () => { hygiene.addCleanup(() => { try { srv.close(); srv.closeAllConnections(); } catch { /* closed */ } }); resolve(srv); });
  });
}
const closeServer = (srv) => new Promise((resolve) => { try { srv.closeAllConnections(); srv.close(() => resolve()); } catch { resolve(); } });

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

  const app = await launchApp(dev);
  const ready = await viewReady(app);
  check('the window came up with a session', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  const st = () => view(app, 'previewState');
  const doit = (args) => view(app, 'previewDo', args);
  const inspect = () => command(app, { cmd: 'preview', action: 'inspect' });
  const near = (a, b) => Math.abs(a - b) <= 2;

  // 1 -----------------------------------------------------------------------------
  const s0 = await st();
  check('1: preview-display.js loaded in the shared plain-script scope', s0.ok && s0.scope, JSON.stringify(s0).slice(0, 200));
  const root = worktreeRoot(dev);
  const base = await waitFor(() => lookup(root), 60000, 300);
  check('1: the host gave the temp worktree a block of ports', Number.isInteger(base), `root=${root} base=${base}`);
  if (!Number.isInteger(base)) { console.log(app.out.slice(-800)); return; }
  const chip0 = await waitFor(async () => { const s = await st(); return s.chip && s.chip.hidden === false ? s : null; }, 60000, 300);
  check('1: the Dev servers chip appears once the block is known, with the server icon, counting 0 and idle',
    !!chip0 && chip0.chip.text === '0' && chip0.chip.icon === true && /dv-idle/.test(chip0.chip.cls) && chip0.chip.title.includes(`${base}-${base + 99}`), JSON.stringify(chip0 && chip0.chip));

  // 2 -----------------------------------------------------------------------------
  const portA = base + 7;
  const portB = await freePort();
  const servers = [];
  const serverA = await startServer('127.0.0.1', portA, (q, res) => {
    const u = q.url;
    if (u.startsWith('/ok.png')) { hits.ok += 1; res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
    if (u.startsWith('/file.bin')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x.bin"' }); res.end('payload'); return; }
    if (u.startsWith('/redirect')) { res.writeHead(302, { location: 'http://example.com/redirected' }); res.end(); return; }
    const body = pageFor(u, portA);
    res.writeHead(body === null ? 404 : 200, { 'content-type': 'text/html' });
    res.end(body === null ? '' : body);
  });
  servers.push(serverA);
  const serverB = await startServer('127.0.0.1', portB, (q, res) => { res.writeHead(200); res.end('b'); });
  servers.push(serverB);
  // A second server on ANOTHER loopback address, the same port the page is told to fetch from: if the session's request filter ever lets it
  // through, this counts the request.
  let leakServer = null;
  leakPort = await freePort();
  try {
    leakServer = await startServer('127.0.0.2', leakPort, (q, res) => { hits.leak += 1; res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); });
  } catch (err) {
    console.log(`NOTE  could not listen on 127.0.0.2 (${err.code || err.message}): the sub-resource check below cannot see a leak`);
  }
  const counted = await waitFor(async () => { const s = await st(); return s.chip && s.chip.text === '1' ? s : null; }, 60000, 500);
  check(`2: a server on port ${portA}, inside the block, is counted: the chip reads 1 (and is no longer idle)`, !!counted && !/dv-idle/.test(counted.chip.cls), JSON.stringify((await st()).chip));
  check('2: its title says "1 dev server listening in this worktree\'s ports"', !!counted && /1 dev server listening in this worktree's ports/.test(counted.chip.title), counted && counted.chip.title);
  await sleep(500);
  check(`2: a server on port ${portB}, outside the block and not started by the session, is not counted`, (await st()).chip.text === '1');

  // 3 -----------------------------------------------------------------------------
  await doit({ op: 'chip' });
  const opened = await waitFor(async () => { const s = await st(); return s.menu.open ? s : null; }, 5000, 150);
  check('3: clicking the chip opens its list', !!opened && opened.chip.expanded === 'true', JSON.stringify(opened && opened.menu));
  check(`3: the list has ONE row, "${portA} · node" (the probe\'s own process), and not the outside port`,
    !!opened && opened.menu.rows.length === 1 && opened.menu.rows[0].startsWith(`${portA} · node`) && !opened.menu.text.includes(String(portB)), JSON.stringify(opened && opened.menu));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '3-chip-menu.png') });
  await doit({ op: 'menu', act: 'preview', port: portA });
  const shown = await waitFor(async () => { const s = await st(); const i = await inspect(); return s.shown && s.slot && s.slot.width > 50 && i.exists && i.visible && i.title === 'index' ? { s, i } : null; }, 30000, 200);
  check('3: Preview shows the panel, closes the list, and a native view is visible on the server\'s page (its title is "index")', !!shown && (await st()).menu.open === false, JSON.stringify({ s: await st(), i: await inspect() }).slice(0, 600));
  if (!shown) { console.log(app.out.slice(-1200)); return; }
  const slot = (await st()).slot;
  const v1 = await inspect();
  check('3: the native view sits over the slot at its rectangle (same size, inside the window)', near(v1.bounds.width, slot.width) && near(v1.bounds.height, slot.height) && v1.bounds.y >= slot.y,
    JSON.stringify({ view: v1.bounds, slot }));
  check(`3: the address field reads localhost:${portA}, the picker is on ${portA}, and the view is on http://localhost:${portA}/`,
    (await st()).url === `localhost:${portA}` && (await st()).options.some(o => o.s && o.v === String(portA)) && v1.url === `http://localhost:${portA}/`, JSON.stringify({ url: (await st()).url, options: (await st()).options, view: v1.url }));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '3-panel-frame.png') });
  const shot = await command(app, { cmd: 'preview', action: 'shot', file: path.join(shots, '3-panel-page.png') });
  check('3: a picture of the page was taken', shot.ok === true && shot.bytes > 0, JSON.stringify(shot));

  // 4 -----------------------------------------------------------------------------
  const go = async (text) => { await doit({ op: 'type', text }); await doit({ op: 'go' }); };
  await go(`localhost:${portA}/storage`);
  const fresh = await waitFor(async () => ((await inspect()).title === 'storage:fresh' ? true : null), 10000, 150);
  await go(`localhost:${portA}/storage?again`);
  const kept = await waitFor(async () => ((await inspect()).title === 'storage:kept' ? true : null), 10000, 150);
  check('4: the page can keep things in its session while it is shown (storage:fresh, then storage:kept)', !!fresh && !!kept, (await inspect()).title);
  await view(app, 'hide', { id: 'preview' });
  const gone = await waitFor(async () => ((await inspect()).exists === false ? true : null), 8000, 150);
  check('4: hiding the module destroys the native view (hidden means stopped)', !!gone, JSON.stringify(await inspect()));
  await view(app, 'show', { id: 'preview' });
  const back = await waitFor(async () => { const i = await inspect(); return i.exists && i.visible && /^storage:/.test(i.title) ? i : null; }, 20000, 200);
  check('4: showing it again comes back to the same address (the last one of this worktree)', !!back && back.url === `http://localhost:${portA}/storage?again`, JSON.stringify(back));
  check('4: ...and nothing the page stored survived the view (storage:fresh again)', !!back && back.title === 'storage:fresh', back && back.title);

  // 5 -----------------------------------------------------------------------------
  await go(`localhost:${portA}/surface`);
  const surf = await waitFor(async () => { const i = await inspect(); return /^(undefined|object|function)/.test(i.title) ? i : null; }, 10000, 150);
  check('5: the page has no bridge to the app: no window.harness, no require, no process, no Buffer', !!surf && surf.title === 'undefined,undefined,undefined,undefined', surf && surf.title);

  // 6 -----------------------------------------------------------------------------
  const note = async () => (await st()).note;
  await go(`localhost:${portA}/`);
  await waitFor(async () => ((await inspect()).title === 'index' ? true : null), 10000, 150);
  check('6: a good page leaves no blocked line', (await note()) === null, JSON.stringify(await note()));
  await go(`localhost:${portA}/nav-external`);
  const navNote = await waitFor(async () => ((await note()) === 'blocked: example.com' ? true : null), 10000, 150);
  await sleep(1200);
  const afterNav = await inspect();
  check('6: a page that sets its own location to example.com stays where it was, and the header says "blocked: example.com"',
    !!navNote && afterNav.url === `http://localhost:${portA}/nav-external` && afterNav.title === 'nav', JSON.stringify({ note: await note(), view: afterNav }));
  await go(`localhost:${portA}/`);
  await waitFor(async () => ((await note()) === null && (await inspect()).title === 'index' ? true : null), 10000, 150);
  await go(`localhost:${portA}/redirect`);
  const redirNote = await waitFor(async () => ((await note()) === 'blocked: example.com' ? true : null), 10000, 150);
  await sleep(600);
  const afterRedir = await inspect();
  check('6: a redirect to example.com is refused too (the view is not on example.com)', !!redirNote && /^http:\/\/localhost:/.test(afterRedir.url), JSON.stringify({ note: await note(), view: afterRedir }));
  await go(`localhost:${portA}/`);
  await waitFor(async () => ((await note()) === null && (await inspect()).title === 'index' ? true : null), 10000, 150);
  await go(`localhost:${portA}/open`);
  const opened2 = await waitFor(async () => { const i = await inspect(); return /^open:/.test(i.title) ? i : null; }, 10000, 150);
  check('6: window.open makes no window (it returns null, for the web AND for loopback) and the header says so', !!opened2 && opened2.title === 'open:null,null' && (await note()) === 'blocked: a new window', JSON.stringify({ title: opened2 && opened2.title, note: await note() }));
  await go(`localhost:${portA}/`);
  await waitFor(async () => ((await note()) === null && (await inspect()).title === 'index' ? true : null), 10000, 150);
  await go(`localhost:${portA}/download`);
  const dl = await waitFor(async () => ((await note()) === 'blocked: a download' ? true : null), 10000, 150);
  check('6: a download is cancelled and the header says so', !!dl, JSON.stringify({ note: await note(), view: await inspect() }));
  await go(`localhost:${portA}/`);
  await waitFor(async () => ((await note()) === null && (await inspect()).title === 'index' ? true : null), 10000, 150);
  await go('https://example.com/');
  const typed = await waitFor(async () => ((await note()) === 'blocked: example.com' ? true : null), 8000, 150);
  check('6: a typed address on the web is refused, with the same line, and the view does not move', !!typed && (await inspect()).url === `http://localhost:${portA}/`, JSON.stringify({ note: await note(), view: await inspect() }));
  await go('javascript:alert(1)');
  const typedJs = await waitFor(async () => (/^blocked:/.test((await note()) || '') && (await note()) !== 'blocked: example.com' ? true : null), 8000, 150);
  check('6: a typed javascript: address is refused', !!typedJs && (await inspect()).url === `http://localhost:${portA}/`, JSON.stringify(await note()));
  await go(`localhost:${portA}/`);
  await waitFor(async () => ((await note()) === null && (await inspect()).title === 'index' ? true : null), 10000, 150);
  hits.ok = 0; hits.leak = 0;
  await go(`localhost:${portA}/subres`);
  const sub = await waitFor(async () => { const i = await inspect(); return /^subres:done/.test(i.title) ? i : null; }, 15000, 200);
  check('6: the page\'s own assets load (the image on its own server was requested and drawn)', !!sub && sub.title === 'subres:done ok=1' && hits.ok >= 1, JSON.stringify({ title: sub && sub.title, hits: hits.ok }));
  if (leakServer) check('6: a request to ANOTHER loopback address (127.0.0.2) never leaves the session: the server there saw nothing', hits.leak === 0, `leak hits ${hits.leak}`);

  // 7 -----------------------------------------------------------------------------
  await go(`localhost:${portA}/`);
  await waitFor(async () => ((await inspect()).title === 'index' ? true : null), 10000, 150);
  check('7: before the overlay the native view is visible', (await inspect()).visible === true);
  await doit({ op: 'overlay', on: true });
  const covered = await waitFor(async () => ((await inspect()).visible === false ? true : null), 5000, 100);
  check('7: a box drawn over part of the slot hides the native view, which would paint above it', !!covered, JSON.stringify(await inspect()));
  await doit({ op: 'overlay', on: false });
  const uncovered = await waitFor(async () => ((await inspect()).visible === true ? true : null), 5000, 100);
  check('7: and the view is back once the box is gone', !!uncovered, JSON.stringify(await inspect()));

  // 8 -----------------------------------------------------------------------------
  await doit({ op: 'act', act: 'devtools' });
  await sleep(1500);
  await doit({ op: 'act', act: 'devtools' });
  await sleep(800);
  const afterDt = await inspect();
  check('8: the DevTools button toggles twice and the app and the view are still there', afterDt.exists === true && afterDt.title === 'index' && !app.exited, JSON.stringify(afterDt));
  await doit({ op: 'act', act: 'reload' });
  const reloaded = await waitFor(async () => ((await inspect()).title === 'index' ? true : null), 8000, 150);
  check('8: reload reloads the page', !!reloaded);

  // 9 -----------------------------------------------------------------------------
  await closeServer(serverA);
  const zero = await waitFor(async () => { const s = await st(); return s.chip.text === '0' ? s : null; }, 60000, 500);
  check('9: stopping the server brings the chip back to 0 (idle)', !!zero && /dv-idle/.test(zero.chip.cls), JSON.stringify((await st()).chip));
  await closeServer(serverB);
  if (leakServer) await closeServer(leakServer);

  if (failures) console.log('--- app output (tail) ---\n' + app.out.slice(-2500));
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
