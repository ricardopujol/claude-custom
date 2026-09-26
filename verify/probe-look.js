'use strict';
/* Renders the real Electron window for a project that HAS a look, and writes a
   PNG to inspect by eye.

   Why a real window: the Style tab, the palette and the veils live in
   renderer.html/renderer.js, loaded as plain <script>s sharing ONE global
   scope. A unit test `require`s each module into its own scope, so a name
   collision that silently aborts a whole file is invisible to every test --
   CLAUDE.md's first trap. Only a rendered window shows it.

   What to look for in the PNG:
     - a dark red app colour (header, sidebar, terminal background) instead of
       the default blue, with visible panel/border edges
     - pale yellow UI text (header, sidebar), while the CLI text keeps its own
     - the generated test image behind the terminal, darkened toward the red
     - the Style tab open, showing Colours / Background image / Inactive windows

   Usage:  node verify/probe-look.js        (OUT=<png> and PORT=<n> optional)

   ELECTRON_RUN_AS_NODE is deleted from the child's env: Claude Code is itself
   an Electron app, and an inherited value starts the child as plain Node with
   errors that name anything but the cause (CLAUDE.md). */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const REPO = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 7712;
const OUT = process.env.OUT || path.join(REPO, '.harness', 'probe-look.png');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A real PNG with no dependency: a 96x64 diagonal gradient, so "the image is
// showing" is unmistakable and "it is stretched or tiled" is visible too.
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
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The project, with a look written the way host/style.js writes one.
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-look-'));
const lookDir = path.join(project, '.claude-custom');
fs.mkdirSync(lookDir);
fs.writeFileSync(path.join(lookDir, 'background.png'), gradientPng(96, 64));
fs.writeFileSync(path.join(lookDir, 'look.json'), JSON.stringify({
  version: 1, appColor: '#3a1418', textColor: '#f3e3a0', darkness: 0.6,
  background: { file: 'background.png', setAt: new Date().toISOString() },
}, null, 2));
console.log('project:', project);

const env = { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: project };
delete env.ELECTRON_RUN_AS_NODE;

const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
});
let hostLog = '';
host.stdout.on('data', d => { hostLog += d.toString(); });
host.stderr.on('data', d => { hostLog += d.toString(); });

(async () => {
  await sleep(3500);
  if (!/listening/i.test(hostLog)) { console.error('host did not start:\n' + hostLog); process.exit(1); }

  const electron = spawn(path.join(REPO, 'node_modules', '.bin', 'electron.cmd'), ['.'], {
    cwd: REPO,
    env: { ...env, CLAUDE_CUSTOM_SCREENSHOT: OUT, CLAUDE_CUSTOM_SCREENSHOT_DELAY: '12000',
      CLAUDE_CUSTOM_SIDE_TAB: 'style' },
    stdio: 'inherit',
    shell: true,
  });

  electron.on('exit', () => {
    try { host.kill(); } catch { /* already gone */ }
    let size = 0;
    try { size = fs.statSync(OUT).size; } catch { /* no file */ }
    try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* best effort */ }
    if (!size) { console.error('FAIL: no screenshot at', OUT, '\nhost log:\n' + hostLog); process.exit(1); }
    console.log(`screenshot: ${OUT} (${size} bytes) -- inspect it by eye, see the header of this file`);
    process.exit(0);
  });
})();
