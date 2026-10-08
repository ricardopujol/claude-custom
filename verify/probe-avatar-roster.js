'use strict';
/**
 * The avatar chain, RENDERED (BACKLOG C #3, #13, #18).
 *
 * WHY A PROBE. The unit tests prove the decisions (app/portrait-media-display.js,
 * host/portraits.js). They cannot prove that the real renderer, loaded as
 * plain <script> tags in a real window against a real host, actually (a) shows
 * a global default video, (b) PLAYS it, (c) pauses it when the window is hidden
 * or the face is scrolled off, and (d) removes every <video> and every
 * file:// source from the roster when "agent images" is turned off. CLAUDE.md:
 * "No unit test can see this. Render it in a real window."
 *
 * SAFE TO RUN. `claude` is replaced by cmd.exe (CLAUDE_CUSTOM_BIN), so no
 * session starts and nothing is billed. The toggle's store, Electron's
 * userData, the forge portraits folder AND the host's uploads folder
 * (CLAUDE_CUSTOM_UPLOADS) are throwaway temp folders, so the probe never
 * touches a real global default picture in the repo's `.harness`.
 *
 * Needs ffmpeg on PATH to make a real, decodable webm.
 *
 *   node verify/probe-avatar-roster.js        (exit 0 = every check passed)
 */
const { spawn, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { createHygieneRegistry } = require('./lib/process-hygiene');

const ROOT = path.join(__dirname, '..');
// Both children are registered, so Ctrl+C or a crash kills their whole trees
// instead of orphaning a host and an Electron (Miguel I1, PR #64).
const hygiene = createHygieneRegistry();
hygiene.install();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-avatar-probe-'));
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };

const VIDEO = path.join(tmp, 'clip.webm');
try {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=3',
    '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', VIDEO], { stdio: 'ignore' });
} catch (err) {
  console.log('MEASUREMENT SKIPPED: ffmpeg is not available to generate a real test clip.');
  cleanup();
  process.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const mainSource = (port) => `
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path'); const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const { registerAvatarHandlers } = require(path.join(ROOT, 'app', 'avatar-bridge'));
const { createStore } = require(path.join(ROOT, 'host', 'store'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion'); // an occluded probe window would report hidden and pause every video
app.setPath('userData', ${JSON.stringify(path.join(tmp, 'userData'))});
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log('[check]', ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: {
    contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'app', 'preload.js') } });
  registerAvatarHandlers({ ipcMain, store: createStore({ dir: ${JSON.stringify(path.join(tmp, 'state'))} }), win, dialog });
  win.loadFile(path.join(ROOT, 'app', 'renderer.html'), { query: {
    port: ${JSON.stringify(port)}, cwd: ${JSON.stringify(tmp)}, project: 'probe', token: 'probe-token' } });
  win.webContents.on('console-message', (_e, level, message, line, src) => { if (level >= 2) console.log('[page]', message, src + ':' + line); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await js(code); if (v) return v; } catch (e) { /* page not ready */ } await sleep(150); }
    return null;
  };
  const wsSend = (m) => js('ws.send(' + JSON.stringify(JSON.stringify(m)) + ')');
  const vids = () => js('[...document.querySelectorAll("#agents video")].map(v => ({ paused: v.paused, t: v.currentTime, rs: v.readyState, err: v.error && v.error.code, ns: v.networkState, src: v.getAttribute("src") }))');
  const rendererMem = () => app.getAppMetrics().filter(m => m.type === 'Tab').reduce((n, m) => n + m.memory.workingSetSize, 0);

  try {
    check('the roster script loaded and the host answered',
      await until('typeof setRosterTab === "function" && ws && ws.readyState === 1'));
    await js('setRosterTab("inactive")');
    check('the Inactive tab lists agents', await until('document.querySelectorAll("#agents .agent[data-agent]").length > 2', 60000));
    check('main answered the images toggle (on by default)', await until('agentImagesEnabled === true'));
    check('the hover pencil is drawn on faces', await js('document.querySelectorAll("#agents .face .face-pencil").length > 0'));
    check('baseline: no video in the roster', (await vids()).length === 0);

    await wsSend({ type: 'portrait', action: 'set-global', path: ${JSON.stringify(VIDEO)} });
    check('a global default video reaches every face', await until('document.querySelectorAll("#agents .face video").length > 2'));
    await sleep(1200);
    let v = await vids();
    check('it is a cache-busted file URL to _global/default.webm', /_global\\/default\\.webm\\?v=\\d+/.test((v[0] || {}).src || ''), (v[0] || {}).src);
    const style = await js('styleState.avatars.global');
    check('the Style row knows the global default', style && style.set === true && style.file === 'default.webm', style);
    const playing = v.filter(x => !x.paused && x.t > 0).length;
    check('the visible videos are actually PLAYING', playing > 0, { playing, total: v.length, first: v[0], vis: await js('document.visibilityState'), n: await js('document.querySelectorAll(\"#agents video\").length') });

    // Dexter F1 / Miguel I2 (PR #64): a repaint runs about once a second while
    // anything is running; the SAME <video> node must survive it and keep going.
    await js('(() => { const v = [...document.querySelectorAll("#agents video")].find(x => !x.paused); window.__kept = v; v.__mark = "kept"; })()');
    for (let i = 0; i < 3; i++) { await js('renderRoster()'); await sleep(700); }
    const kept = await js('({ same: !!window.__kept && window.__kept.__mark === "kept" && document.contains(window.__kept), playing: !window.__kept.paused, src: !!window.__kept.getAttribute("src") })');
    check('repaints keep the same <video> node, still loaded and playing (no restart)', kept.same && kept.playing && kept.src, kept);
    const progress = await js('(async () => { const v = window.__kept; const a = v.currentTime; await new Promise(r => setTimeout(r, 900)); return { a, b: v.currentTime }; })()');
    check('and its clock keeps moving across repaints', progress.b !== progress.a, progress);

    const memOn = rendererMem();

    win.hide();
    await sleep(1200);
    const hiddenState = await js('document.visibilityState');
    v = await vids();
    check('hidden window: document.visibilityState is hidden', hiddenState === 'hidden', hiddenState);
    check('hidden window: every video is paused', v.every(x => x.paused), v.map(x => x.paused));
    win.show();
    await sleep(1200);
    v = await vids();
    check('shown again: the on-screen videos play again', v.some(x => !x.paused), v.map(x => x.paused));

    await js('(() => { const a = document.getElementById("agents"); a.style.flex = "none"; a.style.height = "70px"; a.scrollTop = a.scrollHeight; })()');
    await sleep(1200);
    v = await vids();
    const paused = v.filter(x => x.paused).length;
    check('scrolled off: faces out of view are paused, the ones in view play', paused > 0 && paused < v.length, { paused, total: v.length });
    await js('(() => { const a = document.getElementById("agents"); a.style.flex = ""; a.style.height = ""; a.scrollTop = 0; })()');

    // ---- #18 the toggle -------------------------------------------------------
    await js('window.harness.avatar.setImagesEnabled(false)');
    check('turning images off is pushed to the page', await until('agentImagesEnabled === false'));
    await sleep(600);
    const dom = await js('({ videos: document.querySelectorAll("video").length, imgs: document.querySelectorAll("img[src^=\\'file:\\']").length, html: document.getElementById("agents").innerHTML })');
    check('off: no <video> anywhere in the document', dom.videos === 0, dom.videos);
    check('off: no file:// image source left', dom.imgs === 0, dom.imgs);
    check('off: the roster HTML contains no "<video" and no "file://"', !/<video/.test(dom.html) && !/file:\\/\\//.test(dom.html));
    check('off: faces are the initials placeholder', /face-placeholder/.test(dom.html));
    await sleep(1500);
    const memOff = rendererMem();
    console.log('[memory] renderer working set, video playing:', Math.round(memOn / 1024), 'MB; images off:', Math.round(memOff / 1024), 'MB (informational: workingSetSize is KB, one sample, GC noise)');

    const persisted = await js('window.harness.avatar.getImagesEnabled()');
    check('the off state is what main stores', persisted === false, persisted);

    await js('window.harness.avatar.setImagesEnabled(true)');
    check('turning images back on restores the videos', await until('document.querySelectorAll("#agents .face video").length > 2'));

    // Dexter F3 (PR #64): a change made by ANOTHER window's host (here: the file
    // removed straight from disk, not through this window's socket) must reach
    // this window, or its idle faces point at a deleted file.
    fs.rmSync(path.join(${JSON.stringify(path.join(tmp, 'uploads'))}, '_global', 'default.webm'), { force: true });
    check('a Reset made by another window (file removed on disk) reaches this window: placeholders, no dangling video',
      await until('document.querySelectorAll("#agents video").length === 0 && document.querySelectorAll("#agents .face-placeholder").length > 2', 15000));

    await wsSend({ type: 'portrait', action: 'reset-global' });
    check('Reset removes the default: no videos, placeholder faces again',
      await until('document.querySelectorAll("#agents video").length === 0 && document.querySelectorAll("#agents .face-placeholder").length > 2'));
    const after = await js('styleState.avatars.global');
    check('the Style row says none set', after && after.set === false, after);
  } catch (err) {
    check('probe ran to completion', false, String(err && err.stack || err));
  }
  console.log('[result]', JSON.stringify({ failed: results.filter(r => !r.ok).length, total: results.length }));
  app.exit(results.every(r => r.ok) ? 0 : 1);
});
`;

(async () => {
  const port = String(await freePort());
  const portraitsDir = path.join(tmp, 'forge');
  fs.mkdirSync(portraitsDir, { recursive: true });
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh',
    CLAUDE_CUSTOM_CWD: tmp, CLAUDE_CUSTOM_PORT: port, CLAUDE_CUSTOM_TOKEN: 'probe-token',
    CLAUDE_CUSTOM_PORTRAITS: portraitsDir,
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  // Claude Code is itself an Electron app: never let this leak into the children.
  delete env.ELECTRON_RUN_AS_NODE;

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
  const electron = spawnElectron(require('electron'), [mainFile], { cwd: ROOT, env });
  hygiene.registerChild(electron);
  let out = '';
  electron.stdout.on('data', d => { out += d; process.stdout.write(d); });
  electron.stderr.on('data', d => { if (/probe|Error/.test(String(d))) process.stderr.write(d); });
  const killer = setTimeout(() => { console.log('FAIL: probe timed out after 150s'); hygiene._emergencyCleanup('timeout'); }, 150000);
  const code = await new Promise((resolve) => electron.on('exit', resolve));
  clearTimeout(killer);
  hygiene._emergencyCleanup('done');
  cleanup();
  if (code !== 0) console.log('---- host log (tail) ----\n' + hostOut.split('\n').slice(-25).join('\n'));
  console.log(code === 0 ? 'PASS: the avatar chain renders as designed' : `FAIL: exit ${code}`);
  process.exit(code === 0 ? 0 : 1);
})().catch((err) => {
  console.log('FAIL: probe could not start:', err && err.message);
  hygiene._emergencyCleanup('startup-failed');
  cleanup();
  process.exit(1);
});
