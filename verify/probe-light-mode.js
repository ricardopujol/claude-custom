'use strict';
/* Backlog #25 (light mode): renders the REAL Electron window three times against one host and one project --
   dark, then light after a flip, then light again after a re-roll -- and writes a PNG each time.

   Why a real window: the Style tab, the mode buttons, the light veil and the terminal colours live in
   renderer.html/renderer.js, loaded as plain <script>s sharing ONE global scope. A unit test cannot see a
   collision that aborts a whole file (CLAUDE.md's first trap).

   The flip and the re-roll are made through host/style.js directly, between launches -- exactly what another
   window of the same folder would do. The host keeps running, so it still holds the CLI theme it STARTED with
   ('dark'): the second and third shots must show the note "Claude's colours switch next time you open this project".

   What to look for in the PNGs:
     1. dark: the dark palette, the Style tab open on the Colours section with Dark seated, the Darkness slider,
        and NO note.
     2. light: a light app colour with dark text, the terminal on the same light colour with dark text, the
        Light button seated, the Brightness slider, the light veil over the gradient picture, and the note.
     3. light, re-rolled: a different light palette (the picture and the mode unchanged), still readable.
     4. light, no picture of its own: the generated art IS shown, under a white veil that keeps the text readable.
     5. dark again, no picture of its own: the generated art is back, the dark palette as in shot 1.

   Usage:  node verify/probe-light-mode.js        (OUT_DIR=<dir> and PORT=<n> optional)
   Takes the heavy-work lock first (C:\Users\ricar\.claude\scripts\heavy-lock.ps1): one Electron at a time. */
const { spawn } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const REPO = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 7725;
const OUT_DIR = process.env.OUT_DIR || path.join(REPO, '.harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { generateLook, lookFailures } = require('../host/palette-gen');
const { setMode, rerollLook, readLook, resetBackground } = require('../host/style');

// A real PNG with no dependency: a diagonal gradient, so the veil over it is visible.
function gradientPng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = Math.round(255 * x / w);
      raw[i + 1] = Math.round(255 * y / h);
      raw[i + 2] = 200;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The project: an explicit DARK look (mode 'dark', so the CLI is started with theme dark) and a picture of its own.
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-light-'));
const lookDir = path.join(project, '.claude-custom');
fs.mkdirSync(lookDir);
fs.writeFileSync(path.join(lookDir, 'background.png'), gradientPng(96, 64));
const dark = generateLook(() => 0.37);
fs.writeFileSync(path.join(lookDir, 'look.json'), JSON.stringify({
  version: 1, ...dark, darkness: 0.6, mode: 'dark',
  background: { file: 'background.png', setAt: new Date().toISOString() },
}, null, 2));
console.log('project:', project);

// A probe run from a claude-custom tab inherits that tab's CLAUDE_CUSTOM_PROJECT_* and would show the REAL
// project's look: keep only the two this probe means.
const env = { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: project };
for (const k of Object.keys(env)) {
  if (k.startsWith('CLAUDE_CUSTOM_') && k !== 'CLAUDE_CUSTOM_PORT' && k !== 'CLAUDE_CUSTOM_CWD') delete env[k];
}
delete env.ELECTRON_RUN_AS_NODE;

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
});
let hostLog = '';
host.stdout.on('data', d => { hostLog += d.toString(); });
host.stderr.on('data', d => { hostLog += d.toString(); });

function shoot(name, delayMs = 12000) {
  const out = path.join(OUT_DIR, `probe-light-mode-${name}.png`);
  try { fs.rmSync(out, { force: true }); } catch { /* none yet */ }
  return new Promise((resolve) => {
    const electron = spawnElectron(require('electron'), ['.'], {
      cwd: REPO,
      env: { ...env, CLAUDE_CUSTOM_SCREENSHOT: out, CLAUDE_CUSTOM_SCREENSHOT_DELAY: String(delayMs), CLAUDE_CUSTOM_SIDE_TAB: 'style' },
      stdio: 'inherit',
    }, { keepEnv: ['CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_SCREENSHOT', 'CLAUDE_CUSTOM_SCREENSHOT_DELAY', 'CLAUDE_CUSTOM_SIDE_TAB'] });
    electron.on('exit', () => {
      let size = 0;
      try { size = fs.statSync(out).size; } catch { /* no file */ }
      resolve({ out, size });
    });
  });
}

function finish(code) {
  try { host.kill(); } catch { /* already gone */ }
  try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(code);
}

(async () => {
  await sleep(3500);
  if (!/listening/i.test(hostLog)) { console.error('host did not start:\n' + hostLog); finish(1); return; }

  const shots = [];
  const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); finish(1); throw new Error(msg); } };

  shots.push(await shoot('1-dark', 25000));

  const flipped = setMode({ cwd: project, mode: 'light', rng: () => 0.41 });
  check(flipped.ok && flipped.look.mode === 'light', 'flip to light: ' + JSON.stringify(flipped));
  check(lookFailures(flipped.look, { mode: 'light' }).length === 0, 'the light palette passes the gates');
  shots.push(await shoot('2-light'));

  const rolled = rerollLook({ cwd: project, rng: () => 0.83 });
  check(rolled.ok && rolled.look.mode === 'light', 're-roll stays light: ' + JSON.stringify(rolled));
  check(rolled.look.appColor !== flipped.look.appColor, 're-roll changed the palette');
  check(readLook(project).other.appColor === dark.appColor, 'the dark look is still kept');
  shots.push(await shoot('3-light-rerolled'));

  // Light with the GENERATED art (no picture of its own): the art shows under a white veil.
  resetBackground({ cwd: project });
  shots.push(await shoot('4-light-generated-art'));

  // Back to dark with the generated art: it returns, and the stored dark look is exactly as it was.
  const back = setMode({ cwd: project, mode: 'dark', rng: () => 0.5 });
  check(back.ok && back.look.mode === 'dark' && back.look.appColor === dark.appColor, 'flip back to dark restores the dark look');
  shots.push(await shoot('5-dark-generated-art'));

  for (const s of shots) console.log(`screenshot: ${s.out} (${s.size} bytes)`);
  check(shots.every(s => s.size > 0), 'every screenshot was written');
  console.log('OK -- inspect the five PNGs by eye, see the header of this file');
  finish(0);
})().catch((err) => { console.error(err && err.message); finish(1); });
