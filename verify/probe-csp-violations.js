'use strict';
/**
 * PROBE: the tab page's Content-Security-Policy (BACKLOG #56), measured in a REAL window against a REAL host.
 *
 *   node verify/probe-csp-violations.js          (exit 0 = zero violations, and the detector is proven live)
 *   CSP_PROBE_SHOTS=<dir>                         also keep screenshots there
 *
 * test/renderer-csp.test.js pins the policy's text. It cannot tell whether the page still WORKS under it: a blocked
 * script, image, video or socket is a console message, never a test failure (CLAUDE.md: "No unit test can see this.
 * Render it in a real window."). This loads the real app/renderer.html with the real preload, and a real
 * host/host.js answering over the WebSocket, then exercises everything that loads a resource:
 *
 *   - every dock panel (agents, vault, bug vault, models, files, git, projects, wand, resources, style)
 *   - the Files tab and the code reader, which injects the CodeMirror bundle as a <script> on first open
 *   - a global portrait that is a VIDEO (file:///, <video>), then a PICTURE (file:///, <img>)
 *   - a project background that is a VIDEO, then a PICTURE (file:///, <video> and a CSS background-image)
 *   - the layout menu and the WebSocket to the host
 *
 * and collects every `Refused to ...` console message and every `securitypolicyviolation` event. It also runs a
 * NEGATIVE CONTROL: an inline script, an eval, a web image and a web socket are attempted on purpose, and the probe
 * only passes if the detector SAW all four -- otherwise "zero violations" would just mean "the listener is broken".
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills. ELECTRON_RUN_AS_NODE and every
 * CLAUDE_CUSTOM_* the probe does not set are deleted. Everything it writes is in a temp folder. Only PIDs this probe
 * started are killed (verify/lib/process-hygiene.js), never a process by name. Needs ffmpeg on PATH.
 */

const { spawn, spawnSync, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { createHygieneRegistry } = require('./lib/process-hygiene');

const hygiene = createHygieneRegistry();
hygiene.install();
process.on('exit', () => { try { hygiene._emergencyCleanup('exit'); } catch { /* best effort */ } });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-csp-probe-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const media = path.join(tmp, 'media');
const shots = process.env.CSP_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(dev, { recursive: true });
fs.mkdirSync(media, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, encoding: 'utf8' });
  return r.status === 0 ? null : (r.error ? r.error.message : r.stderr);
}
// Built with path.join, never a backslash literal: a JS string 'C:' + backslash + 'Windows' silently loses the slashes (Miguel F1).
const CMD_EXE = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'cmd.exe');
const VIDEO = path.join(media, 'loop.webm');
const PICTURE = path.join(media, 'rust.png');
// The admin share of this machine (//localhost/C$/...): a real UNC path to the same files, when the share is on. The URL
// has the shape the app builds for a UNC path: 'file:///' + the path with forward slashes, so file:////localhost/C$/...
const toUnc = (p) => {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? '//localhost/' + m[1] + '$/' + m[2].split('\\').join('/') : null;
};
const uncUrl = (p) => 'file:///' + encodeURI(p);
let UNC_PICTURE = null;
let UNC_VIDEO = null;
const GIT = ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid'];

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const mainSource = (port) => `
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path'); const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const { registerAvatarHandlers } = require(path.join(ROOT, 'app', 'avatar-bridge'));
const { createStore } = require(path.join(ROOT, 'host', 'store'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', ${JSON.stringify(path.join(tmp, 'userData'))});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let phase = 'exercise';                // flipped to 'control' just before the deliberate violations: control and exercise are told apart by TIME
const seen = [];                       // every CSP console line: { from, text, phase }
const errors = [];                     // every other console error, for the record
const panels = [];

app.whenReady().then(async () => {
  setTimeout(() => { console.log('@@' + JSON.stringify({ step: 'crash', error: 'the probe window ran past 240s' })); app.exit(2); }, 240000);
  // The SAME webPreferences app/main.js gives a tab's view.
  const win = new BrowserWindow({ width: 1200, height: 800, show: true, webPreferences: {
    contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'app', 'preload.js') } });
  registerAvatarHandlers({ ipcMain, store: createStore({ dir: ${JSON.stringify(path.join(tmp, 'state'))} }), win, dialog });
  win.webContents.on('console-message', (_e, level, message, line, src) => {
    const text = message + ' (' + String(src).split('/').pop() + ':' + line + ')';
    if (/Content[- ]Security[- ]Policy|Refused to/i.test(message)) seen.push({ from: 'console', text, phase });
    else if (level >= 2) errors.push(text);
  });
  win.loadFile(path.join(ROOT, 'app', 'renderer.html'), { query: {
    probe: '1', port: ${JSON.stringify(port)}, cwd: ${JSON.stringify(dev)}, project: 'probe', token: 'probe-token' } });
  const js = (code, ms = 15000) => Promise.race([win.webContents.executeJavaScript(code),
    new Promise((_, rej) => setTimeout(() => rej(new Error('page call timed out: ' + String(code).slice(0, 90))), ms))]);
  const until = async (code, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await js(code); if (v) return v; } catch (e) { /* page not ready */ } await sleep(150); }
    return null;
  };
  const probe = async (action, args) => JSON.parse(await js('window.__dockProbe(' + JSON.stringify({ action, args: args || {} }) + ')'));
  const wsSend = (m) => js('ws.send(' + JSON.stringify(JSON.stringify(m)) + ')');
  const out = (o) => console.log('@@' + JSON.stringify(o));
  const shot = async (name) => { try { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(${JSON.stringify(shots)}, name + '.png'), img.toPNG()); } catch (e) { /* best effort */ } };

  try {
    out({ step: 'ready', ok: !!(await until('typeof setRosterTab === "function" && typeof ws !== "undefined" && ws && ws.readyState === 1', 60000)) });
    // The listener for everything that happens after parse: the dynamic CodeMirror script, images, media, sockets.
    await js('window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, line: e.lineNumber, src: e.sourceFile })); true');
    out({ step: 'policy', csp: await js('document.querySelector("meta[http-equiv=Content-Security-Policy]") && document.querySelector("meta[http-equiv=Content-Security-Policy]").content') });

    // every panel, selected the way a click does
    for (const id of ['agents', 'vault', 'bugvault', 'models', 'fog', 'git', 'projects', 'wand', 'resources', 'style']) {
      const r = await probe('select', { id });
      await sleep(700);
      const on = await js('!!document.querySelector(\\'.panel[data-panel="' + id + '"].on\\')');
      panels.push({ id, shown: on, ok: r.ok !== false });
      if (id === 'style' || id === 'wand') await shot('panel-' + id);
    }
    out({ step: 'panels', panels });

    // the layout menu
    await probe('openMenu', { which: 'layout' });
    await sleep(400);
    await probe('closeMenu');

    // Files tab + code reader (CodeMirror is injected as a <script> on the first open)
    await probe('select', { id: 'fog' });
    const rp = async (what, extra) => JSON.parse(await js('window.__dockProbe(' + JSON.stringify({ action: 'repoProbe', args: { what, ...(extra || {}) } }) + ')'));
    const waitRp = async (what, pred, ms = 20000, extra) => {
      const end = Date.now() + ms; let s = null;
      while (Date.now() < end) { try { s = await rp(what, extra); if (pred(s)) return s; } catch (e) { s = { error: String(e) }; } await sleep(250); }
      return s;
    };
    await waitRp('state', (s) => s && s.rows && s.rows.some(r => r.path === 'src'));
    await rp('click', { path: 'src' });
    await waitRp('state', (s) => s && s.rows && s.rows.some(r => r.path === 'src/app.js'));
    await rp('click', { path: 'src/app.js' });
    const reader = await waitRp('reader.state', (s) => s && s.open && s.cmMounted);
    out({ step: 'reader', open: !!reader.open, cmMounted: !!reader.cmMounted, lines: reader.lines });
    await shot('reader');

    // portraits: a video, then a picture
    await probe('select', { id: 'agents' });
    await js('setRosterTab("inactive")');
    await until('document.querySelectorAll("#agents .agent[data-agent]").length > 2', 60000);
    await wsSend({ type: 'portrait', action: 'set-global', path: ${JSON.stringify(VIDEO)} });
    const vids = await until('document.querySelectorAll("#agents .face video").length > 2', 20000);
    await sleep(1500);
    const vstate = await js('[...document.querySelectorAll("#agents .face video")].slice(0, 3).map(v => ({ rs: v.readyState, err: v.error && v.error.code, playing: !v.paused && v.currentTime > 0 }))');
    out({ step: 'portrait-video', faces: !!vids, vstate });
    await shot('portrait-video');
    await wsSend({ type: 'portrait', action: 'set-global', path: ${JSON.stringify(PICTURE)} });
    const imgs = await until('document.querySelectorAll("#agents .face img.face-media").length > 2', 20000);
    await sleep(1000);
    const istate = await js('[...document.querySelectorAll("#agents .face img.face-media")].slice(0, 3).map(i => ({ complete: i.complete, w: i.naturalWidth }))');
    out({ step: 'portrait-image', faces: !!imgs, istate });
    await shot('portrait-image');

    // backgrounds: a video, then a picture
    await probe('bgStyle', { action: 'set-background', path: ${JSON.stringify(VIDEO)} });
    const bgv = await until('document.querySelector("#bg video") && document.querySelector("#bg video").readyState >= 2', 20000);
    await sleep(800);
    out({ step: 'background-video', ready: !!bgv, playing: await js('(() => { const v = document.querySelector("#bg video"); return !!v && !v.paused && v.currentTime > 0; })()') });
    await shot('background-video');
    await probe('bgStyle', { action: 'set-background', path: ${JSON.stringify(PICTURE)} });
    const bgi = await until('document.getElementById("bg").style.backgroundImage.indexOf("file:") >= 0 && !document.querySelector("#bg video")', 20000);
    await sleep(800);
    // did the CSS background actually load? an image set as a CSS background can be checked with a probe <img> on the same URL
    const painted = await js('(async () => { const m = /url\\\\("(.+?)"\\\\)/.exec(document.getElementById("bg").style.backgroundImage); if (!m) return false; return await new Promise(r => { const i = new Image(); i.onload = () => r(i.naturalWidth > 0); i.onerror = () => r(false); i.src = m[1]; }); })()');
    out({ step: 'background-image', set: !!bgi, loads: painted });
    await shot('background-image');

    // UNC: the same URL shape the app builds for a path on a share (file:////host/share/...), through the admin share of
    // this very machine. 'self' must cover it too, or a project on a network drive would lose its background.
    const uncImg = ${JSON.stringify(UNC_PICTURE && uncUrl(UNC_PICTURE))};
    const uncVid = ${JSON.stringify(UNC_VIDEO && uncUrl(UNC_VIDEO))};
    if (uncImg) {
      const r = await js('(async () => { const url = ' + JSON.stringify(uncImg) + ';' +
        ' const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i.naturalWidth > 0); i.onerror = () => r(false); i.src = url; });' +
        ' const video = await new Promise(r => { const v = document.createElement("video"); v.muted = true; v.onloadeddata = () => r(true); v.onerror = () => r(false); v.src = ' + JSON.stringify(uncVid) + '; setTimeout(() => r(false), 8000); });' +
        ' return { url, img, video }; })()');
      out({ step: 'unc', ...r });
    } else out({ step: 'unc', skipped: true });

    // the socket to the host is still up after all of that
    out({ step: 'socket', open: await js('ws.readyState === 1') });
    await sleep(2500);

    // NEGATIVE CONTROL: four things the policy must refuse. The probe passes only if the detector saw each one.
    const before = await js('window.__csp.length');
    phase = 'control';
    await js(\`(() => {
      const s = document.createElement('script'); s.textContent = 'window.__inlineRan = true'; document.head.append(s);          // inline script
      try { (0, eval)('window.__evalRan = true'); } catch (e) { /* refused is the point */ }                                      // eval
      const i = new Image(); i.src = 'https://example.invalid/csp-control.png';                                                    // a web image
      try { new WebSocket('ws://example.invalid:9/'); } catch (e) { /* refused */ }                                                  // a web socket
      return true; })()\`);
    await sleep(1500);
    out({ step: 'control', inlineRan: await js('window.__inlineRan === true'), evalRan: await js('window.__evalRan === true') });
    const all = await js('window.__csp');
    out({ step: 'violations', all, controlFrom: before });
  } catch (err) {
    out({ step: 'crash', error: String(err && err.stack || err) });
  }
  out({ step: 'console', seen, errors });
  app.exit(0);
});
`;

// ---- phase 2 helpers: the product itself, driven over its probe port (the pattern of verify/probe-repo-browser.js) ----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
// The root and every descendant of it, by PID (a process-table read; nothing is matched by name).
function descendantsOf(root) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1048576 });
  let rows = [];
  try { rows = JSON.parse(r.stdout); } catch { return [root]; }
  const found = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of rows) if (found.has(p.ParentProcessId) && !found.has(p.ProcessId)) { found.add(p.ProcessId); grew = true; }
  }
  return [...found];
}
async function runRealApp() {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CUSTOM_') && k !== 'ELECTRON_RUN_AS_NODE'));
  const registry = path.join(tmp, 'registry-real');
  fs.mkdirSync(registry, { recursive: true });
  const env = {
    ...inherited,
    CLAUDE_CUSTOM_BIN: CMD_EXE, CLAUDE_CUSTOM_CWD: dev,
    CLAUDE_CUSTOM_TABS_PROBE: String(port), CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: registry, CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits-real'), CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads-real'),
  };
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, `--user-data-dir=${path.join(tmp, 'userData-real')}`], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
  hygiene.registerChild(child);
  const app = { port, token, out: '' };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  const view = (action, args = {}) => command(app, { cmd: 'view', action, args });
  const hostSeen = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
  const out = { ok: false, detail: '', csp: [], renderer: 0, binExists: fs.existsSync(CMD_EXE), hostPid: null, hostAliveAtEnd: false, left: [], treeSize: 0 };
  try {
    const up = await waitFor(async () => {
      const st = await command(app, { cmd: 'state' });
      const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
      if (!sel || !sel.started) return null;
      if (Number.isInteger(sel.pid)) { out.hostPid = sel.pid; hostSeen.add(sel.pid); }
      const v = await view('state');
      return v && v.ok && v.sent ? v : null;
    }, 150000, 500);
    if (!up) { out.detail = `no window: ${app.out.slice(-400)}`; return out; }
    const shown = [];
    for (const id of ['agents', 'vault', 'bugvault', 'models', 'fog', 'git', 'projects', 'wand', 'resources', 'style']) {
      await view('select', { id });
      await sleep(600);
      const st = await view('state');
      if ((st.groups || []).some(g => (g.panels || []).includes(id))) shown.push(id);
    }
    await view('select', { id: 'fog' });
    const rp = (what, extra) => view('repoProbe', { what, ...(extra || {}) });
    await waitFor(async () => { const s = await rp('state'); return s && s.rows && s.rows.some(r => r.path === 'src') ? s : null; });
    await rp('click', { path: 'src' });
    await waitFor(async () => { const s = await rp('state'); return s && s.rows && s.rows.some(r => r.path === 'src/app.js') ? s : null; });
    await rp('click', { path: 'src/app.js' });
    const reader = await waitFor(async () => { const s = await rp('reader.state'); return s && s.open && s.cmMounted ? s : null; });
    await view('openMenu', { which: 'layout' });
    await sleep(400);
    await view('closeMenu');
    await view('bgStyle', { action: 'set-background', path: VIDEO });
    await sleep(2500);
    await view('bgStyle', { action: 'set-background', path: PICTURE });
    await sleep(2000);
    await sleep(1500);
    // The tab must be ALIVE: a host whose claude binary is missing exits at once (host.js: process.exit on pty exit), so a host
    // still up after all of this is proof the shell ran. Its pid comes from the tab list.
    try { process.kill(out.hostPid, 0); out.hostAliveAtEnd = true; } catch { out.hostAliveAtEnd = false; }
    out.ok = shown.length === 10 && !!reader && out.binExists && out.hostAliveAtEnd;
    out.detail = `panels shown ${shown.length}/10, reader ${reader ? 'open with CodeMirror' : 'did NOT open'}, shell ${CMD_EXE} ${out.binExists ? 'exists' : 'MISSING'}, host pid ${out.hostPid} ${out.hostAliveAtEnd ? 'alive after the run' : 'DEAD'}`;
  } finally {
    await command(app, { cmd: 'quit' }, 8000);
    await sleep(1500);
    // Whatever ignored `quit` goes now, by PID: every process in the tree this probe started (Miguel F2), then a list of survivors.
    // The tab's host is spawned detached by the app, so it is not under the Electron PID: add it (and its pty) by the pid the tab list gave.
    const tree = [...new Set([...descendantsOf(child.pid), ...(out.hostPid ? descendantsOf(out.hostPid) : [])])];
    hygiene._emergencyCleanup('phase2-done');
    hostSeen.killAll();   // start-proven: recorded when the tab list first gave the pid
    await sleep(1500);
    out.left = tree.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    out.treeSize = tree.length;
    out.renderer = (app.out.match(/\[renderer:/g) || []).length;
    out.csp = app.out.split('\n').filter(l => /Content[- ]Security[- ]Policy|Refused to/i.test(l));
  }
  return out;
}

(async () => {
  const errs = [
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x1f4f9a:s=320x180:r=15:d=2', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-pix_fmt', 'yuv420p', VIDEO]),
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x9a3a1f:s=320x180', '-frames:v', '1', PICTURE]),
  ].filter(Boolean);
  check('ffmpeg made a real webm and a real picture', errs.length === 0, errs.join(' | ').slice(0, 300));
  if (errs.length) { cleanup(); process.exit(1); }

  // a repo to browse
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: dev, stdio: 'pipe', windowsHide: true });
  fs.mkdirSync(path.join(dev, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'src', 'app.js'), "'use strict';\nconst a = 1;\nmodule.exports = { a };\n");
  fs.writeFileSync(path.join(dev, 'README.md'), '# probe\n');
  execFileSync('git', [...GIT, 'add', '-A'], { cwd: dev, stdio: 'pipe', windowsHide: true });
  execFileSync('git', [...GIT, 'commit', '-q', '-m', 'init'], { cwd: dev, stdio: 'pipe', windowsHide: true });

  UNC_PICTURE = fs.existsSync(toUnc(PICTURE) || '') ? toUnc(PICTURE) : null;
  UNC_VIDEO = UNC_PICTURE ? toUnc(VIDEO) : null;
  console.log(`      UNC path available: ${UNC_PICTURE ? UNC_PICTURE : 'no (admin share off): UNC check skipped'}`);
  const port = String(await freePort());
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CUSTOM_') && k !== 'ELECTRON_RUN_AS_NODE'));
  const env = {
    ...inherited,
    CLAUDE_CUSTOM_BIN: CMD_EXE,
    CLAUDE_CUSTOM_CWD: dev, CLAUDE_CUSTOM_PORT: port, CLAUDE_CUSTOM_TOKEN: 'probe-token',
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'forge'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
  };
  fs.mkdirSync(env.CLAUDE_CUSTOM_PORTRAITS, { recursive: true });
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });

  const host = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { cwd: ROOT, env });
  hygiene.registerChild(host);
  let hostOut = '';
  host.stdout.on('data', d => { hostOut += d; });
  host.stderr.on('data', d => { hostOut += d; });
  await new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (/listening on ws:/.test(hostOut)) { clearInterval(t); resolve(); }
      else if (/EADDRINUSE|ReferenceError|TypeError|SyntaxError/.test(hostOut)) { clearInterval(t); reject(new Error('host failed:\n' + hostOut)); }
    }, 100);
    setTimeout(() => { clearInterval(t); reject(new Error('host did not listen within 20s:\n' + hostOut)); }, 20000);
  });

  const mainFile = path.join(tmp, 'probe-main.js');
  fs.writeFileSync(mainFile, mainSource(port));
  const electron = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [mainFile], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
  hygiene.registerChild(electron);
  const events = [];
  let carry = '';
  electron.stdout.on('data', (d) => {
    carry += d;
    let i;
    while ((i = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, i).replace(/\r$/, ''); carry = carry.slice(i + 1);
      if (line.startsWith('@@')) { try { const e = JSON.parse(line.slice(2)); events.push(e); console.log(`      [step] ${e.step}`); } catch { /* partial */ } }
    }
  });
  let errOut = '';
  electron.stderr.on('data', d => { errOut += d; });
  const killer = setTimeout(() => { console.log('FAIL: probe timed out after 300s'); hygiene._emergencyCleanup('timeout'); }, 300000);
  await new Promise((resolve) => electron.on('exit', resolve));
  clearTimeout(killer);
  hygiene._emergencyCleanup('done');

  const step = (name) => events.find(e => e.step === name) || {};
  const crash = step('crash');
  check('the probe ran to the end without a crash', !crash.error && !!step('console').seen, crash.error || '');
  check('the real page came up and the WebSocket to the host opened', step('ready').ok === true);
  console.log(`      policy in the page: ${step('policy').csp}`);
  check('the page carries the policy', /script-src 'self'/.test(step('policy').csp || ''));

  const panels = step('panels').panels || [];
  check(`every panel was shown (${panels.map(p => p.id).join(', ')})`, panels.length === 10 && panels.every(p => p.shown), panels.filter(p => !p.shown).map(p => p.id).join(','));
  const reader = step('reader');
  check('the Files tab opened a file in the reader and CodeMirror (the injected <script>) mounted', reader.open === true && reader.cmMounted === true, reader);
  const pv = step('portrait-video');
  check('a VIDEO portrait (file:///, <video>) loaded and plays', pv.faces === true && (pv.vstate || []).length > 0 && pv.vstate.every(v => !v.err && v.rs >= 2), pv);
  const pi = step('portrait-image');
  check('a PICTURE portrait (file:///, <img>) loaded', pi.faces === true && (pi.istate || []).length > 0 && pi.istate.every(i => i.complete && i.w > 0), pi);
  const bv = step('background-video');
  check('a VIDEO background (file:///, <video>) loaded and plays', bv.ready === true && bv.playing === true, bv);
  const bi = step('background-image');
  check('a PICTURE background (CSS background-image: file:///) is set and the file loads', bi.set === true && bi.loads === true, bi);
  const unc = step('unc');
  if (unc.skipped) console.log('      (UNC check skipped: this machine has no admin share)');
  else check('a UNC picture and video (file:////localhost/C$/...) load under the policy', unc.img === true && unc.video === true, unc);
  check('the WebSocket to the host is still open after all of it', step('socket').open === true);

  // The control and the verdict. Every violation from the exercise is recorded BEFORE the control ran.
  const ctl = step('control');
  const v = step('violations');
  const all = v.all || [];
  const exercise = all.slice(0, v.controlFrom || 0);
  const control = all.slice(v.controlFrom || 0);
  const consoleSeen = (step('console').seen) || [];
  const exerciseConsole = consoleSeen.filter(x => x.phase !== 'control');
  const controlConsole = consoleSeen.filter(x => x.phase === 'control');
  console.log(`      violations while exercising the page: ${exercise.length} events, ${exerciseConsole.length} console messages`);
  for (const x of exercise) console.log(`        EVENT   ${x.directive} blocked=${x.blocked} ${x.src || ''}:${x.line || ''}`);
  for (const x of exerciseConsole) console.log(`        CONSOLE ${x.text}`);
  check('ZERO CSP violations across every panel, the reader, portraits and backgrounds', exercise.length === 0 && exerciseConsole.length === 0);

  const sawDirective = (d) => control.some(x => String(x.directive).startsWith(d));
  check('control: the inline script was refused and did not run', ctl.inlineRan === false && sawDirective('script-src'), control.map(x => x.directive));
  check('control: eval was refused and did not run', ctl.evalRan === false);
  check('control: a web image was refused and the detector saw it', control.some(x => /example\.invalid/.test(x.blocked) && /^img-src|^default-src/.test(x.directive)), control.map(x => `${x.directive} ${x.blocked}`));
  check('control: a web socket was refused and the detector saw it', control.some(x => /^connect-src/.test(x.directive)), control.map(x => `${x.directive} ${x.blocked}`));

  // ---- PHASE 2: the REAL app (app/main.js, its tab shell, its real webPreferences) -------------------------------------------
  // Phase 1 loads the page in a throwaway main. This launches the product itself with the probe port on (which makes main print
  // every renderer console message) and exercises each panel through the same probe hook. Same verdict: zero violations.
  const real = await runRealApp();
  console.log(`      real app: ${real.renderer} renderer console lines, ${real.csp.length} CSP violations`);
  for (const l of real.csp) console.log(`        ${l}`);
  check("REAL app/main.js: the window came up, every panel was shown, the reader opened, and the tab's shell is alive", real.ok === true, real.detail);
  check("REAL app: its console route is live (it printed renderer lines; a CSP refusal prints through the same route, as phase 1's control shows)", real.renderer > 0, `${real.renderer} lines`);
  check(`REAL app: every process this probe started is gone (${real.treeSize} in the tree)`, (real.left || []).length === 0, `left: ${(real.left || []).join(',') || 'none'}`);
  check('REAL app/main.js: ZERO CSP violations', real.ok === true && real.csp.length === 0);

  check('control: the console route (what phase 2 reads) printed Refused-to lines for the control too', controlConsole.length >= 3, controlConsole.map(x => x.text.slice(0, 70)));

  const errors = step('console').errors || [];
  console.log(`      other console errors (not CSP): ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log(`        ${e}`);
  console.log(`      screenshots: ${shots}`);
  if (failures) console.log('---- host log (tail) ----\n' + hostOut.split('\n').slice(-15).join('\n') + (errOut ? '\n---- electron stderr ----\n' + errOut.slice(-800) : ''));
  if (!process.env.CSP_PROBE_SHOTS) cleanup();
  console.log(failures === 0 ? 'PASS: no CSP violations, and the detector is live' : `FAIL: ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.log('FAIL: probe could not start:', err && err.message);
  hygiene._emergencyCleanup('startup-failed');
  cleanup();
  process.exit(1);
});
