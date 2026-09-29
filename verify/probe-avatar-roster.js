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
 * session starts and nothing is billed. The toggle's store and Electron's
 * userData are throwaway temp folders; the forge portraits folder is an empty
 * temp folder so the global default is what every Inactive-tab face resolves
 * to. The only thing written under the repo is `.harness/portraits/_global`
 * (the host's real uploads folder), which the probe resets before exiting.
 *
 * Needs ffmpeg on PATH to make a real, decodable webm.
 *
 *   node verify/probe-avatar-roster.js        (exit 0 = every check passed)
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
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
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const { registerAvatarHandlers } = require(path.join(ROOT, 'app', 'avatar-bridge'));
const { createStore } = require(path.join(ROOT, 'host', 'store'));
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
  const vids = () => js('[...document.querySelectorAll("#agents video")].map(v => ({ paused: v.paused, t: v.currentTime, rs: v.readyState, src: v.getAttribute("src") }))');
  const rendererMem = () => app.getAppMetrics().filter(m => m.type === 'Tab').reduce((n, m) => n + m.memory.workingSetSize, 0);

  try {
    check('the roster script loaded and the host answered',
      await until('typeof setRosterTab === "function" && ws && ws.readyState === 1'));
    await js('setRosterTab("inactive")');
    check('the Inactive tab lists agents', await until('document.querySelectorAll("#agents .agent[data-agent]").length > 2', 60000));
    check('main answered the images toggle (on by default)', await until('agentImagesEnabled === true'));
    check('the hover pencil is drawn on faces', await js('document.querySelectorAll("#agents .face .face-edit").length > 0'));
    check('baseline: no video in the roster', (await vids()).length === 0);

    await wsSend({ type: 'portrait', action: 'set-global', path: ${JSON.stringify(VIDEO)} });
    check('a global default video reaches every face', await until('document.querySelectorAll("#agents .face video").length > 2'));
    await sleep(1200);
    let v = await vids();
    check('it is a cache-busted file URL to _global/default.webm', /_global\\/default\\.webm\\?v=\\d+/.test((v[0] || {}).src || ''), (v[0] || {}).src);
    const style = await js('styleState.avatars.global');
    check('the Style row knows the global default', style && style.set === true && style.file === 'default.webm', style);
    const playing = v.filter(x => !x.paused && x.t > 0).length;
    check('the visible videos are actually PLAYING', playing > 0, { playing, total: v.length });

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
  };
  // Claude Code is itself an Electron app: never let this leak into the children.
  delete env.ELECTRON_RUN_AS_NODE;

  const host = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { cwd: ROOT, env });
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
  const electron = spawn(require('electron'), [mainFile], { cwd: ROOT, env });
  let out = '';
  electron.stdout.on('data', d => { out += d; process.stdout.write(d); });
  electron.stderr.on('data', d => { if (/probe|Error/.test(String(d))) process.stderr.write(d); });
  const killer = setTimeout(() => { console.log('FAIL: probe timed out after 150s'); try { electron.kill(); } catch { /* gone */ } }, 150000);
  const code = await new Promise((resolve) => electron.on('exit', resolve));
  clearTimeout(killer);
  try { host.kill(); } catch { /* gone */ }
  // Whatever happened, leave the host's real uploads folder as we found it.
  try { fs.rmSync(path.join(ROOT, '.harness', 'portraits', '_global'), { recursive: true, force: true }); } catch { /* best effort */ }
  cleanup();
  if (code !== 0) console.log('---- host log (tail) ----\n' + hostOut.split('\n').slice(-25).join('\n'));
  console.log(code === 0 ? 'PASS: the avatar chain renders as designed' : `FAIL: exit ${code}`);
  process.exit(code === 0 ? 0 : 1);
})().catch((err) => {
  console.log('FAIL: probe could not start:', err && err.message);
  cleanup();
  process.exit(1);
});
