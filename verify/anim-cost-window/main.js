'use strict';
/**
 * The window verify/probe-anim-cost.js measures (BACKLOG #62, the video switch's open question). Started ONLY through
 * verify/lib/launch-electron.js. One normal (visible) window: a background layer playing the clip under test, a real
 * xterm.js terminal on top (transparent, as in the app) that never stops writing, and optionally a few animated
 * agent portraits. Every few seconds it samples app.getAppMetrics() (CPU % of one core and private KB per Electron
 * process type), writes the samples and the pid list to the --out file, and quits after --ms.
 *
 *   electron main.js --variant=<gif|mp4|webm|still|portrait-gif> --file=<clip> --portrait=<gif> --ms=120000 --out=<json>
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const variant = arg('variant', 'still');
const file = arg('file', '');
const portrait = arg('portrait', '');
const totalMs = Number(arg('ms', '120000'));
const out = arg('out', '');
const SETTLE_MS = 10000;
const SAMPLE_MS = 5000;

// Measured as a person watching sees it: the window is VISIBLE to Chromium even when another window covers it or the
// machine is busy (an occluded window is throttled to nothing, which would make every clip look free).
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const samples = [];
let pids = [];
let pageVisible = null;
let win = null;

function take() {
  const metrics = app.getAppMetrics();
  pids = metrics.map((m) => m.pid);
  const byType = {};
  for (const m of metrics) {
    const t = m.type === 'Tab' ? 'renderer' : m.type === 'Browser' ? 'main' : m.type.toLowerCase();
    byType[t] = byType[t] || { count: 0, cpu: 0, privateKB: 0 };
    byType[t].count += 1;
    byType[t].cpu += m.cpu.percentCPUUsage;
    byType[t].privateKB += (m.memory && m.memory.privateBytes) || 0;
  }
  samples.push({ at: Date.now(), byType, pageVisible });
  save(false);
  if (win && !win.isDestroyed()) win.webContents.executeJavaScript('document.visibilityState').then((v) => { pageVisible = v; }, () => {});
}

function save(done) {
  if (!out) return;
  const tmp = out + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ variant, done, pids, samples }, null, 1));
  fs.renameSync(tmp, out);
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280, height: 720, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const query = { variant, file, portrait, xterm: path.join(require.resolve('@xterm/xterm/package.json'), '..') };
  win.loadFile(path.join(__dirname, 'index.html'), { query });
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      take();
      const timer = setInterval(take, SAMPLE_MS);
      setTimeout(() => { clearInterval(timer); save(true); app.quit(); }, totalMs - SETTLE_MS);
    }, SETTLE_MS);
  });
});
app.on('window-all-closed', () => app.quit());
