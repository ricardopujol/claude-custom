'use strict';
/**
 * Does a `<video autoplay loop muted playsinline src="file:///...">` --
 * exactly what app/renderer.js's faceHtml emits for an uploaded video
 * portrait -- actually PLAY under this app's real webPreferences?
 *
 * FF7's brief calls this out by name: app/main.js is off-limits for this
 * change, so if `file:///` video cannot play under the webPreferences it
 * already sets, the fix belongs to whoever owns that file, not to a
 * workaround smuggled in here. This measures the claim rather than assuming
 * it either way.
 *
 * Deliberately isolated, same shape as verify/probe-renderer-origin.js: a
 * throwaway page and a throwaway Electron main script, never the real
 * app/main.js or host/host.js. `webPreferences` below is copied verbatim from
 * app/main.js so the answer is about the app's real configuration, not a
 * probe-only one that happens to differ.
 *
 *   node verify/probe-portrait-video.js
 */

const { spawn } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-video-probe-'));
function cleanup() { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }

// A REAL, decodable video file -- not a renamed empty file, which every
// browser correctly refuses to play and would make this probe lie in the
// encouraging direction. Generated with ffmpeg if available; otherwise this
// probe says so and exits rather than reporting a false pass.
const VIDEO = path.join(tmp, 'portrait.webm');
try {
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=2',
    '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', VIDEO,
  ], { stdio: 'ignore' });
} catch (err) {
  console.log('MEASUREMENT SKIPPED: ffmpeg is not available to generate a real test clip.');
  console.log('(', err && err.message, ')');
  cleanup();
  process.exit(1);
}
if (!fs.existsSync(VIDEO) || fs.statSync(VIDEO).size === 0) {
  console.log('MEASUREMENT SKIPPED: ffmpeg ran but produced no usable file.');
  cleanup();
  process.exit(1);
}

const src = 'file:///' + VIDEO.replace(/\\/g, '/');
fs.writeFileSync(path.join(tmp, 'page.html'), `<!doctype html><meta charset="utf-8">
<title>video probe</title>
<style>video{width:64px;height:64px}</style>
<body>
  <video id="v" class="face-media" src="${src}" autoplay loop muted playsinline></video>
</body>`);

fs.writeFileSync(path.join(tmp, 'main.js'), `
const { app, BrowserWindow } = require('electron');
app.on('ready', () => {
  const win = new BrowserWindow({
    width: 200, height: 200, show: false,
    // Copied verbatim from app/main.js -- the whole point is to measure
    // THIS app's real configuration, contextIsolation on / nodeIntegration
    // off, not a looser probe-only setup.
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(${JSON.stringify(path.join(tmp, 'page.html'))});
  win.webContents.on('did-finish-load', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 400));
      const state = await win.webContents.executeJavaScript(\`(() => {
        const v = document.getElementById('v');
        return { readyState: v.readyState, paused: v.paused, currentTime: v.currentTime, error: v.error && v.error.message };
      })()\`);
      results.push(state);
    }
    console.log('PROBE_RESULT ' + JSON.stringify(results));
    app.quit();
  });
  setTimeout(() => app.quit(), 8000);
});
`);

// ELECTRON_RUN_AS_NODE MUST BE STRIPPED -- Claude Code is itself Electron, so
// a probe launched from inside a session inherits it and the child starts as
// plain Node, with errors that name anything but the cause.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electron = require('electron');
const child = spawnElectron(electron, [path.join(tmp, 'main.js')], {
  stdio: ['ignore', 'pipe', 'inherit'],
  windowsHide: true,
  env,
});

let out = '';
child.stdout.on('data', d => { out += d.toString(); process.stdout.write(d); });

child.on('exit', () => {
  const m = out.match(/PROBE_RESULT (\[.*\])/);
  console.log('');
  console.log('  MEASURED file:/// <video> playback under app/main.js\'s real webPreferences');
  console.log('  ---------------------------------------------------------------------------');
  if (!m) {
    console.log('  NO RESULT CAPTURED -- the page likely never finished loading.');
    cleanup();
    process.exit(1);
  }
  const samples = JSON.parse(m[1]);
  for (const s of samples) console.log('  ', JSON.stringify(s));
  const advanced = samples[samples.length - 1].currentTime > samples[0].currentTime;
  const noError = samples.every(s => !s.error);
  const hadData = samples.some(s => s.readyState >= 2);
  console.log('');
  console.log('  currentTime advanced across samples :', advanced);
  console.log('  reached readyState >= HAVE_CURRENT_DATA:', hadData);
  console.log('  no decode error reported            :', noError);
  console.log('  CONCLUSION: file:/// video', (advanced && noError) ? 'PLAYS.' : 'DID NOT PLAY.');
  console.log('');
  cleanup();
  process.exit(advanced && noError ? 0 : 1);
});
