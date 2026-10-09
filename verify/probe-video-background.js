'use strict';
/**
 * PROBE: backlog #34, video backgrounds and "Match colours to this background", in a REAL window with
 * a REAL host. (re-runnable)
 *
 *   node verify/probe-video-background.js        (exit 0 = every check held)
 *   VIDEO_PROBE_SHOTS=<dir>                       also keep screenshots there
 *
 * The unit tests pin the pieces (the play rule, the signature check, the quantiser, the palette
 * gates); none can see a window decode a clip, minimise, or paint a look. This does, with files it
 * generates itself with ffmpeg (nothing is downloaded), and checks:
 *
 *   1  a small webm loop is accepted, drawn as a muted looping <video> filling the window, under
 *      the darkness veil, and PLAYS (currentTime advances)
 *   2  a renamed program (.mp4 that isn't one) is refused at upload; the playing video and its file
 *      are untouched
 *   3  MINIMISE stops it (paused, currentTime holds, main's flag says minimised); RESTORE resumes it
 *   4  reduced motion (the OS setting, emulated) holds frame zero and never plays; off, it plays again
 *   5  Match colours on the VIDEO: the look changes, takes the clip's hue, passes the contrast gates
 *      on disk AND as painted (the CSS variables the window actually uses)
 *   6  an mp4 plays too (a decoder the app may not ship is a real finding, not a skip)
 *   7  an IMAGE replaces the video (no <video> left), and Match colours takes the picture's hue
 *   8  a corrupt video that passes the signature check: the Style tab says it can't be played and
 *      there is NO background (not black, not frozen); the file stays; Match colours is disabled
 *   9  memory and CPU, same run: no background, image, video playing, video minimised -- against
 *      #20's recorded baseline (verify/probe-memory-footprint.js), which is context, not a threshold
 *
 * MEASURED 2026-10-02 (Electron 33, Windows 11, a 320x180 2 s VP9 loop in a 1186x730 view): every
 * check passes, mp4 (H.264) included. Harness private bytes (Electron, host, ConPTY), medians of
 * three snapshots 2 s apart after a 15 s settle:
 *
 *     no background 387.8 MB  (gpu 122)   cpu  0.6% of a core
 *     image         416.0 MB  (gpu 176)   cpu  0.5%
 *     video playing 431.4 MB  (gpu 161)   cpu  8.2%
 *     video minimised 364.5 MB (gpu 129)  cpu  1.4%     <- stopped, back to the idle floor
 *     no background, again 437.3 MB (gpu 194) cpu 1.6%
 *
 * The same state measures 388 then 437 MB across the run, so memory moves ~50 MB with no change at
 * all: a video's memory cost is inside that noise (+44 MB over the first baseline, GPU +39 MB);
 * its CPU cost is not (+7.6 points of one core while it plays, none once minimised). #20's recorded
 * idle (2026-09-27, before tabs) was 336.8 MB harness / 15 processes: not like-for-like, context only.
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE
 * and every CLAUDE_CUSTOM_* the probe does not set are deleted; registry, portraits, uploads and user
 * data are temp folders; the project is a temp git repo. Only PIDs this probe started are killed
 * (verify/lib/process-hygiene.js), never a process by name.
 */

const { spawnSync, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { projectRoots } = require(path.join(ROOT, 'host', 'project-roots'));
const { readLook, LOOK_DIR_NAME } = require(path.join(ROOT, 'host', 'style'));
const { lookFailures, hexToOklch } = require(path.join(ROOT, 'host', 'palette-gen'));
const { contrastRatio } = require(path.join(ROOT, 'host', 'look'));
const { summarize } = require('./probe-memory-footprint');

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MB = (b) => (b / 1048576).toFixed(1);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-video-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const userData = path.join(tmp, 'user-data');
const media = path.join(tmp, 'media');
const shots = process.env.VIDEO_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(media, { recursive: true });
fs.mkdirSync(shots, { recursive: true });

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

// --- the media this probe makes ----------------------------------------------------
// A blue field with an orange square sliding across it, 2 s at 15 fps: seamless enough to loop, and
// every frame has the same dominant colour (blue) so a match is predictable. The picture is a flat
// rust colour, a different hue, so a second match must move.
const BLUE = '0x1f4f9a';
const ORANGE = '0xe0a020';
const RUST = '0x9a3a1f';

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, encoding: 'utf8' });
  return r.status === 0 ? null : (r.error ? r.error.message : r.stderr);
}

function makeMedia() {
  const clip = ['-f', 'lavfi', '-i', `color=c=${BLUE}:s=320x180:r=15:d=2`, '-f', 'lavfi', '-i', `color=c=${ORANGE}:s=40x40:r=15:d=2`,
    '-filter_complex', "[0][1]overlay=x='mod(t*120,280)':y=60,format=yuv420p"];
  const files = {
    webm: path.join(media, 'loop.webm'), mp4: path.join(media, 'loop.mp4'), png: path.join(media, 'rust.png'),
    corrupt: path.join(media, 'corrupt.webm'), fake: path.join(media, 'program.mp4'),
  };
  const errs = [
    ffmpeg([...clip, '-c:v', 'libvpx-vp9', '-b:v', '200k', files.webm]),
    ffmpeg([...clip, '-c:v', 'libx264', '-movflags', '+faststart', files.mp4]),
    ffmpeg(['-f', 'lavfi', '-i', `color=c=${RUST}:s=320x180`, '-frames:v', '1', files.png]),
  ].filter(Boolean);
  // Passes the signature (EBML header) and then is noise: the decoder, not the upload, must refuse it.
  fs.writeFileSync(files.corrupt, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), require('crypto').randomBytes(4096)]));
  // A program wearing a video's name.
  fs.writeFileSync(files.fake, Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(2048, 7)]));
  return { files, errs };
}

// --- launching the app -------------------------------------------------------------
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
  const keep = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
    'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS'];
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_') && !keep.includes(k)) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
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
const view = (app, action, args = {}) => command(app, { cmd: 'view', action, args });

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
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

async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.add(h.pid);
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started || !Number.isInteger(sel.pid)) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? { st, host: sel } : null;
  }, 45000);
}

// --- reading the page and the look on disk -------------------------------------------
const bgState = async (app) => view(app, 'bgState');
const lookNow = () => readLook(stateRoot);
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
const hueOf = (hex) => hexToOklch(hex).h;

let stateRoot = container;

async function setBackground(app, file) {
  return view(app, 'bgStyle', { action: 'set-background', path: file });
}

// Is the video moving? Two reads apart; a 2 s loop never lands on the same instant twice by chance.
async function moves(app, gapMs = 400) {
  const a = await bgState(app);
  await sleep(gapMs);
  const b = await bgState(app);
  return !!(a.video && b.video && !b.video.paused && b.video.currentTime !== a.video.currentTime);
}
async function holds(app, gapMs = 700) {
  const a = await bgState(app);
  await sleep(gapMs);
  const b = await bgState(app);
  return !!(a.video && b.video && b.video.paused && b.video.currentTime === a.video.currentTime);
}
const videoReady = (app) => waitFor(async () => {
  const s = await bgState(app);
  return s.video && s.video.readyState >= 2 && s.video.width > 0 ? s : null;
}, 15000);

// The text of the look as painted: the CSS variables the window really uses, checked the way the
// gates check the derived palette (host/palette-gen.js lookFailures does the full set on disk).
function paintedContrastFailures(vars) {
  const out = [];
  const need = (fg, bg, min, label) => {
    if (!/^#[0-9a-f]{6}$/i.test(fg) || !/^#[0-9a-f]{6}$/i.test(bg)) { out.push(`${label}: not a colour (${fg} on ${bg})`); return; }
    if (contrastRatio(fg, bg) < min) out.push(`${label}: ${contrastRatio(fg, bg).toFixed(2)}:1 < ${min}`);
  };
  for (const surface of ['bg', 'chrome']) {
    need(vars.text, vars[surface], 4.5, `text on ${surface}`);
    need(vars.accent, vars[surface], 4.5, `accent on ${surface}`);
    need(vars.dim, vars[surface], 4.5, `dim on ${surface}`);
  }
  if (vars.onAccent) need(vars.onAccent, vars.accent, 4.5, 'label on accent');
  return out;
}

// --- memory and CPU ------------------------------------------------------------------
function processTable() {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,' +
    'PrivatePageCount,UserModeTime,KernelModeTime | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1048576 });
  return JSON.parse(ps.stdout);
}

// Median of three snapshots two seconds apart, plus the CPU the whole tree burned across them.
async function measure(name, rootPid) {
  const snaps = [];
  for (let i = 0; i < 3; i++) {
    const procs = processTable();
    const { tree, summary } = summarize(procs, rootPid);
    const cpu100ns = tree.reduce((a, p) => a + (Number(p.UserModeTime) || 0) + (Number(p.KernelModeTime) || 0), 0);
    snaps.push({ at: Date.now(), summary, cpu100ns });
    if (i < 2) await sleep(2000);
  }
  const sorted = [...snaps].sort((a, b) => a.summary.harnessPrivateBytes - b.summary.harnessPrivateBytes);
  const mid = sorted[1].summary;
  const wallS = (snaps[2].at - snaps[0].at) / 1000;
  const cpuPct = ((snaps[2].cpu100ns - snaps[0].cpu100ns) / 1e7 / wallS) * 100;
  const roles = (r) => (mid.byRole[r] ? mid.byRole[r].privateBytes : 0);
  console.log(`   ${name.padEnd(26)} harness ${MB(mid.harnessPrivateBytes).padStart(7)} MB private` +
    `  renderer ${MB(roles('electron:renderer')).padStart(6)}  gpu ${MB(roles('electron:gpu-process')).padStart(6)}` +
    `  cpu ${cpuPct.toFixed(1).padStart(5)}% of one core  (${mid.processes} processes)`);
  return { name, harnessBytes: mid.harnessPrivateBytes, rendererBytes: roles('electron:renderer'), gpuBytes: roles('electron:gpu-process'), cpuPct };
}

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: dev, stdio: 'pipe', windowsHide: true });
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dev, stdio: 'pipe', windowsHide: true });
  if (!fs.existsSync(path.join(HARNESS_DIR, 'hook-helper.exe'))) {
    check('the install has .harness/hook-helper.exe (else the host has no status pipe)', false, 'run setup-worktree first');
    return;
  }
  stateRoot = projectRoots({}, container).stateRoot;

  const { files, errs } = makeMedia();
  check('ffmpeg made the test webm, mp4 and picture (nothing downloaded)', errs.length === 0, errs.join(' | ').slice(0, 300));
  if (errs.length) return;

  const app = await launchApp(container);
  const ready = await viewReady(app);
  check('the window came up with a session', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  // Startup is still burning CPU and allocating for several seconds after the window is up (a first
  // run measured 106% of a core here and a baseline 190 MB above the image run): settle first.
  await sleep(15000);

  // The baseline of THIS run: no background of the person's own yet.
  const memory = [];
  memory.push(await measure('no background', app.child.pid));

  // 1 -----------------------------------------------------------------------------
  const set = await setBackground(app, files.webm);
  check('1: the page took the set-background request', set.ok === true, JSON.stringify(set));
  const first = await videoReady(app);
  check('1: a webm is accepted and drawn as a <video> in #bg', !!first && first.hasBg && first.hasCustomBg && first.bgImage === '',
    JSON.stringify(first && { video: first.video && first.video.src, hasBg: first.hasBg, bgImage: first.bgImage }));
  if (!first) return;
  check('1: it is muted, looping, never audio', first.video.muted === true && first.video.loop === true);
  check('1: it fills the window and sits under the darkness veil',
    first.video.rect.width >= first.renderer.width - 1 && first.video.rect.height >= first.renderer.height - 1 && first.veil > 0,
    `video ${Math.round(first.video.rect.width)}x${Math.round(first.video.rect.height)}, window ${Math.round(first.renderer.width)}x${Math.round(first.renderer.height)}, veil ${first.veil}`);
  check('1: it PLAYS: currentTime advances', await waitFor(() => moves(app), 8000, 100) === true, JSON.stringify((await bgState(app)).video));
  const onDisk = fs.readdirSync(path.join(stateRoot, LOOK_DIR_NAME)).filter(f => f.startsWith('background.'));
  check('1: it is copied in as background.webm (and only that)', onDisk.length === 1 && onDisk[0] === 'background.webm', onDisk.join(','));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '1-video.png') });

  // 2 -----------------------------------------------------------------------------
  const before = fs.readFileSync(path.join(stateRoot, LOOK_DIR_NAME, 'background.webm'));
  await setBackground(app, files.fake);
  const refused = await waitFor(async () => { const s = await bgState(app); return s.error && /not a real \.mp4/.test(s.error) ? s : null; }, 8000);
  check('2: a program renamed .mp4 is refused, and the Style tab says why', !!refused, JSON.stringify(refused && refused.error));
  const after = fs.readFileSync(path.join(stateRoot, LOOK_DIR_NAME, 'background.webm'));
  check('2: ...and the playing video and its file are untouched', before.equals(after)
    && fs.readdirSync(path.join(stateRoot, LOOK_DIR_NAME)).filter(f => f.startsWith('background.')).length === 1 && await moves(app));

  // memory with the video playing, while the window is up and visible
  await sleep(3000);
  memory.push(await measure('video playing', app.child.pid));

  // 3 -----------------------------------------------------------------------------
  const min = await command(app, { cmd: 'window-state', state: 'minimize' });
  check('3: the window minimised', min.ok === true && min.minimized === true, JSON.stringify(min));
  const stopped = await waitFor(async () => { const s = await bgState(app); return s.video && s.video.paused && s.playback.minimised === true ? s : null; }, 8000);
  check('3: MINIMISE stops it, and main said why (minimised: true)', !!stopped, JSON.stringify(stopped && stopped.playback));
  check('3: ...and it holds its place (currentTime does not move)', await holds(app));
  await sleep(3000);
  memory.push(await measure('video minimised', app.child.pid));
  const res = await command(app, { cmd: 'window-state', state: 'restore' });
  check('3: the window restored', res.ok === true && res.minimized === false, JSON.stringify(res));
  check('3: RESTORE resumes it', await waitFor(() => moves(app), 10000, 150) === true, JSON.stringify((await bgState(app)).video));

  // 4 -----------------------------------------------------------------------------
  const rm = await command(app, { cmd: 'reduced-motion', on: true });
  check('4: reduced motion emulated on', rm.ok === true, JSON.stringify(rm));
  const still = await waitFor(async () => { const s = await bgState(app); return s.reducedMotion && s.video && s.video.paused ? s : null; }, 8000);
  check('4: reduced motion pauses it on the first frame', !!still && still.video.currentTime === 0, JSON.stringify(still && still.video));
  await sleep(800);
  const still2 = await bgState(app);
  check('4: ...and it never plays while the setting is on', still2.video.paused && still2.video.currentTime === 0);
  check('4: ...and the Style tab says why it is still (Miguel M2)', /reduced motion/.test(still2.paused || ''), JSON.stringify(still2.paused));
  const rmOff = await command(app, { cmd: 'reduced-motion', on: false });
  check('4: turned off, the emulation is cleared and the debugger let go (Miguel M8)', rmOff.ok === true && rmOff.attached === false, JSON.stringify(rmOff));
  check('4: with the setting off it plays again', await waitFor(() => moves(app), 10000, 150) === true);
  check('4: ...and the note is gone', (await bgState(app)).paused === null);

  // 5 -----------------------------------------------------------------------------
  const look0 = lookNow();
  const painted0 = (await bgState(app)).vars;
  const m = await view(app, 'bgMatch');
  check('5: the Match colours button was there and enabled', m.ok === true, JSON.stringify(m));
  const matched = await waitFor(() => { const l = lookNow(); return l.appColor && l.appColor !== look0.appColor ? l : null; }, 10000);
  check('5: Match colours on the video changes the look', !!matched, JSON.stringify({ before: look0.appColor, after: lookNow().appColor }));
  if (matched) {
    check('5: the new look passes every contrast gate on disk', lookFailures(matched).length === 0, lookFailures(matched).join('; '));
    check('5: the app colour has the clip\'s hue (blue) and the accent a different one',
      hueGap(hueOf(matched.appColor), hueOf('#1f4f9a')) < 20 && hueGap(hueOf(matched.accentColor), hueOf(matched.appColor)) > 40,
      `app hue ${hueOf(matched.appColor).toFixed(0)}, accent hue ${hueOf(matched.accentColor).toFixed(0)}, clip hue ${hueOf('#1f4f9a').toFixed(0)}`);
    const painted = await waitFor(async () => { const s = await bgState(app); return s.vars.bg === matched.appColor ? s.vars : null; }, 8000);
    check('5: the window painted it (its CSS variables moved with the look)', !!painted && painted.bg !== painted0.bg, JSON.stringify(painted));
    if (painted) {
      const bad = paintedContrastFailures(painted);
      check('5: ...and as painted it passes the contrast gates', bad.length === 0, bad.join('; '));
    }
    check('5: the video kept playing through the repaint', await moves(app));
    await command(app, { cmd: 'screenshot', file: path.join(shots, '5-matched.png') });
  }
  const videoLook = matched || look0;

  // 6 -----------------------------------------------------------------------------
  await setBackground(app, files.mp4);
  const mp4 = await waitFor(async () => {
    const s = await bgState(app);
    return s.video && /\.mp4/.test(fs.readdirSync(path.join(stateRoot, LOOK_DIR_NAME)).join(',')) && s.video.readyState >= 2 ? s : null;
  }, 15000);
  const mp4Note = (await bgState(app)).note;
  check('6: an mp4 is accepted and plays', !!mp4 && await waitFor(() => moves(app), 8000, 150) === true,
    mp4 ? '' : `no playing <video>; the Style tab says: ${JSON.stringify(mp4Note)}`);
  check('6: ...replacing the webm (one background file on disk)',
    fs.readdirSync(path.join(stateRoot, LOOK_DIR_NAME)).filter(f => f.startsWith('background.')).join(',') === 'background.mp4');

  // 7 -----------------------------------------------------------------------------
  await setBackground(app, files.png);
  const img = await waitFor(async () => { const s = await bgState(app); return s.video === null && /background\.png/.test(s.bgImage) ? s : null; }, 10000);
  check('7: an image replaces the video: no <video> left, a CSS background image instead', !!img, JSON.stringify(img && img.bgImage));
  await sleep(3000);
  memory.push(await measure('image background', app.child.pid));
  const look1 = lookNow();
  await sleep(300);
  const m2 = await view(app, 'bgMatch');
  check('7: Match colours is available on an image', m2.ok === true, JSON.stringify(m2));
  const matched2 = await waitFor(() => { const l = lookNow(); return l.appColor && l.appColor !== look1.appColor ? l : null; }, 10000);
  check('7: it takes the picture\'s hue (rust), not the clip\'s (blue), and passes the gates',
    !!matched2 && lookFailures(matched2).length === 0 && hueGap(hueOf(matched2.appColor), hueOf('#9a3a1f')) < 20
      && hueGap(hueOf(matched2.appColor), hueOf(videoLook.appColor)) > 60,
    matched2 ? `app hue ${hueOf(matched2.appColor).toFixed(0)} vs picture ${hueOf('#9a3a1f').toFixed(0)}; ${lookFailures(matched2).join('; ')}` : 'no change');

  // 8 -----------------------------------------------------------------------------
  await setBackground(app, files.corrupt);
  const broken = await waitFor(async () => { const s = await bgState(app); return s.note && /can't be played/.test(s.note) ? s : null; }, 15000);
  check('8: a corrupt video that passes the signature says it can\'t be played, with a reason', !!broken, JSON.stringify(broken && broken.note));
  if (broken) {
    check('8: ...and there is NO background: no <video>, no image, no has-bg (never black or frozen)',
      broken.video === null && broken.bgImage === '' && broken.hasBg === false && broken.hasCustomBg === false, JSON.stringify(broken));
    check('8: ...Match colours is disabled (no frame to read)', broken.matchDisabled === true);
    check('8: ...the file stays', fs.existsSync(path.join(stateRoot, LOOK_DIR_NAME, 'background.webm')));
    // the re-announce of the same file (a darkness change) must not retry or flicker
    await view(app, 'bgStyle', { action: 'set-look', look: { darkness: 0.6 } });
    await sleep(500);
    const again = await bgState(app);
    check('8: ...and an unrelated re-announce does not bring a broken video back', again.video === null && again.hasBg === false && !!again.note);
  }
  await command(app, { cmd: 'screenshot', file: path.join(shots, '8-corrupt.png') });

  // a good file after a broken one is tried afresh
  await setBackground(app, files.webm);
  const recovered = await videoReady(app);
  check('8: a good video after a broken one plays again, and the note is gone',
    !!recovered && recovered.note === null && await waitFor(() => moves(app), 8000, 150) === true);

  // 9 -----------------------------------------------------------------------------
  // Back to the generated art, then measured again: the first baseline is only a baseline if the
  // same state, reached again after all this, costs the same.
  await view(app, 'bgStyle', { action: 'reset-background' });
  await waitFor(async () => { const s = await bgState(app); return s.video === null && s.hasCustomBg === false ? s : null; }, 8000);
  await sleep(3000);
  memory.push(await measure('no background (again)', app.child.pid));
  console.log('\nmemory and CPU (private bytes of the HARNESS: Electron, host, ConPTY; this run, same session):');
  console.log('   #20 recorded baseline (2026-09-27, before tabs; context, not a threshold): idle harness 336.8 MB private, 15 processes');
  const order = ['no background', 'image background', 'video playing', 'video minimised', 'no background (again)'];
  const byName = Object.fromEntries(memory.map(x => [x.name, x]));
  for (const n of order) check(`9: measured "${n}"`, !!byName[n]);
  if (byName['no background'] && byName['video playing']) {
    console.log(`   video playing vs no background: harness ${((byName['video playing'].harnessBytes - byName['no background'].harnessBytes) / 1048576).toFixed(1)} MB,` +
      ` gpu ${((byName['video playing'].gpuBytes - byName['no background'].gpuBytes) / 1048576).toFixed(1)} MB,` +
      ` cpu ${(byName['video playing'].cpuPct - byName['no background'].cpuPct).toFixed(1)} points`);
  }
  if (byName['video minimised'] && byName['video playing']) {
    check('9: minimised, the video costs less CPU than while playing (it really stopped)',
      byName['video minimised'].cpuPct < byName['video playing'].cpuPct,
      `${byName['video minimised'].cpuPct.toFixed(1)}% vs ${byName['video playing'].cpuPct.toFixed(1)}%`);
  }
  const errors = (app.out.match(/\[renderer:[a-z]+\].*/g) || []).filter((l) => /error|not defined|undefined is not|cannot read/i.test(l));
  check('the renderer reported no errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await command(app, { cmd: 'quit' });
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    hygiene._emergencyCleanup('done');     // kills the window and, via the cleanup, every host it started
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    if (process.env.VIDEO_PROBE_SHOTS) console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
