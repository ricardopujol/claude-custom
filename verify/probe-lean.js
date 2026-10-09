'use strict';
/**
 * PROBE: lean mode (BACKLOG #62, documentation/DESIGN_LEAN_MODE.md) in a REAL window with REAL hosts. (re-runnable; HEAVY:
 * take ~/.claude/scripts/heavy-lock.ps1 first)
 *
 *   node verify/probe-lean.js            (exit 0 = every check held)
 *   LEAN_PROBE_SHOTS=<dir>               keep the screenshots there
 *   LEAN_PROBE_SKIP_MEASURE=1            only the behaviour checks, no memory/CPU table
 *
 * The unit tests pin the state machine, the bridge, the decisions and the wiring; none can see the page actually drop its
 * panels, swap the terminal's renderer, hold a GIF still, or the strip's button reach main. This does, over a temp git
 * project with two worktrees (three tabs), the host's `claude` being cmd.exe (nothing bills):
 *
 *   1  normal: the strip has the Lean button and no chip; the dock and header show; the terminal has its renderer
 *   2  the strip's ☾ Lean button: the page goes lean (class, no dock panel shown, no header, no bar), the terminal fills the
 *      page, the strip shows `☾ lean` with Back to normal; the project's colours and terminal theme are the SAME as before;
 *      scrollback is intact and typing still reaches the terminal and keeps it lean
 *   3  Back to normal: the same panels as before are shown again, the renderer is back
 *   4  a /bedtime night (a real ScheduleWakeup hook through the native helper) turns it on by itself and the chip says
 *      `bedtime HH:MM`; typing keeps it lean; the night ending turns it off
 *   5  the button always wins: Back to normal during a night stays normal; and a night starting while it is on by hand
 *      leaves it on when the night ends
 *   6  a working agent shows as a still portrait in the corner (no video, no animation) and the roster panel is not drawn
 *   7  a GIF background becomes its first frame (a canvas) while lean and the GIF again after; a webm holds frame zero
 *      while lean and plays again after
 *   8  the memory / CPU table: normal vs lean, per process type, on one busy tab and on three busy tabs
 *
 * Only PIDs this probe started are stopped (verify/lib/process-hygiene.js + launch-electron.js), never a process by name.
 */

const { spawnSync, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const HELPER = path.join(HARNESS_DIR, 'hook-helper.exe');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));
const { descendants, role } = require('./probe-memory-footprint');

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MB = (b) => (b / 1048576).toFixed(0);
const tmp = tmpDir('cc-probe-lean-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featA = path.join(container, 'feat-a');
const featB = path.join(container, 'feat-b');
const userData = path.join(tmp, 'user-data');
const media = path.join(tmp, 'media');
const shots = process.env.LEAN_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(media, { recursive: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

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

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS'];

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
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: PASSED_ENV });
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

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
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

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true });

function hook(hostPid, event, payload) {
  const r = spawnSync(HELPER, ['--pipe', `\\\\.\\pipe\\claude-custom-${hostPid}`, '--event', event],
    { input: JSON.stringify(payload), windowsHide: true });
  return r.status === 0;
}

const stateOf = async (app) => {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
  return st;
};
const view = (app, action, args = {}) => command(app, { cmd: 'view', action, args });
const leanPage = async (app) => { const r = await view(app, 'leanState'); return r && r.ok ? r : null; };
const stripLean = async (app) => { const st = await stateOf(app); return st && st.stripChrome && st.stripChrome.lean ? st.stripChrome.lean : null; };
const press = (app, button) => command(app, { cmd: 'strip-lean', button });
const typeInto = (app, text) => view(app, 'gitTermInput', { data: text });
const screenOf = async (app) => { const r = await view(app, 'gitScreen'); return r && r.ok ? String(r.text) : ''; };
const shoot = (app, name) => command(app, { cmd: 'screenshot', file: path.join(shots, `${name}.png`) });

const NIGHT_PROMPT = '/bedtime overnight run (lean probe). Continue the task list.';
const schedule = (pid, prompt, delaySeconds) => {
  const input = { delaySeconds, reason: 'probe', prompt, noop: false };
  hook(pid, 'PreToolUse', { session_id: 'probe', tool_name: 'ScheduleWakeup', tool_input: input });
  hook(pid, 'PostToolUse', { session_id: 'probe', tool_name: 'ScheduleWakeup', tool_input: input,
    tool_response: { scheduledFor: Date.now() + delaySeconds * 1000, clampedDelaySeconds: delaySeconds, wasClamped: false } });
};
const stopLoop = (pid) => hook(pid, 'PreToolUse', { session_id: 'probe', tool_name: 'ScheduleWakeup', tool_input: { stop: true } });

// --- the media this probe makes (ffmpeg, local) -----------------------------------------------------------------
function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, encoding: 'utf8' });
  return r.status === 0 ? null : (r.error ? r.error.message : r.stderr);
}
function makeMedia() {
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12:duration=2'];
  const files = { gif: path.join(media, 'loop.gif'), webm: path.join(media, 'loop.webm') };
  const errs = [
    ffmpeg([...src, '-vf', 'split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0', files.gif]),
    ffmpeg([...src, '-c:v', 'libvpx-vp9', '-b:v', '200k', files.webm]),
  ].filter(Boolean);
  return { files, errs };
}

// --- memory and CPU, per process type ---------------------------------------------------------------------------
function processTable() {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,' +
    'PrivatePageCount,UserModeTime,KernelModeTime | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1048576 });
  return JSON.parse(ps.stdout);
}

// Two snapshots `windowMs` apart: private bytes from the second, CPU % of one core from the CPU-time delta of the
// processes present in both.
async function measureRoles(name, rootPid, windowMs = 20000) {
  const a = processTable();
  const treeA = descendants(a, rootPid);
  const at = Date.now();
  await sleep(windowMs);
  const b = processTable();
  const treeB = descendants(b, rootPid);
  const wallS = (Date.now() - at) / 1000;
  const cpuOf = (p) => (Number(p.UserModeTime) || 0) + (Number(p.KernelModeTime) || 0);
  const before = new Map(treeA.map(p => [p.ProcessId, p]));
  const roles = {};
  for (const p of treeB) {
    const r = role(p);
    const e = roles[r] = roles[r] || { count: 0, privateBytes: 0, cpuPct: 0 };
    e.count++;
    e.privateBytes += p.PrivatePageCount || 0;
    const prev = before.get(p.ProcessId);
    if (prev && prev.CommandLine === p.CommandLine) e.cpuPct += ((cpuOf(p) - cpuOf(prev)) / 1e7 / wallS) * 100;
  }
  return { name, roles };
}

// "electron" total = every Electron process (main, renderers, gpu, utility); the rest is what the harness adds.
function tableRows(m) {
  const get = (r) => m.roles[r] || { count: 0, privateBytes: 0, cpuPct: 0 };
  const ele = Object.entries(m.roles).filter(([r]) => r.startsWith('electron:'));
  const sum = (f) => ele.reduce((s, [, v]) => s + v[f], 0);
  return {
    name: m.name,
    renderer: get('electron:renderer'), gpu: get('electron:gpu-process'), main: get('electron:main'), host: get('host'),
    electronMB: sum('privateBytes'), electronCpu: sum('cpuPct'),
  };
}

function printTable(rows) {
  const f = (x) => x.toFixed(1);
  console.log('\n| state | renderer MB (n) | GPU MB | main MB | Electron total MB | renderer CPU % | GPU CPU % | main CPU % | host CPU % | Electron CPU % |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.name} | ${MB(r.renderer.privateBytes)} (${r.renderer.count}) | ${MB(r.gpu.privateBytes)} | ${MB(r.main.privateBytes)} | ${MB(r.electronMB)} | ${f(r.renderer.cpuPct)} | ${f(r.gpu.cpuPct)} | ${f(r.main.cpuPct)} | ${f(r.host.cpuPct)} | ${f(r.electronCpu)} |`);
  }
}

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', '-b', 'feat/a', featA);
  git(dev, 'worktree', 'add', '-q', '-b', 'feat/b', featB);
  if (!fs.existsSync(HELPER)) { check('the native hook helper exists (.harness/hook-helper.exe)', false, HELPER); return; }
  const { files, errs } = makeMedia();
  check('ffmpeg made the test gif and webm (nothing downloaded)', errs.length === 0, errs.join(' | ').slice(0, 300));

  const app = await launchApp(container);
  const devHost = await waitFor(async () => {
    const st = await stateOf(app);
    return ((st && st.hosts) || []).find(x => x.label === 'develop' && x.started && Number.isInteger(x.pid)) || null;
  }, 60000);
  check('0: the window is up and the dev host is running', !!devHost, devHost ? `pid ${devHost.pid}` : `exited=${app.exited} out=${app.out.slice(-600)}`);
  if (!devHost) return;
  await sleep(1500);
  const devPid = devHost.pid;
  await sleep(10000);          // the page and the terminal settle

  // 1 -------------------------------------------------------------------------------------------
  const n0 = await leanPage(app);
  const s0 = await stripLean(app);
  check('1: normal: the Lean button shows, there is no chip, and the strip is not lean', !!s0 && s0.btnHidden === false && s0.chipHidden === true && s0.bodyLean === false, JSON.stringify(s0));
  check('1: normal: the dock shows panels, the header shows, the page is not lean', !!n0 && n0.leanOn === false && n0.bodyLean === false && n0.shown.length > 0 && n0.headerVisible === true, n0 ? JSON.stringify({ shown: n0.shown, header: n0.headerVisible }) : 'no state');
  console.log(`      (info) the terminal's WebGL renderer in normal mode: ${n0 && n0.webgl}`);
  if (!n0) return;
  await typeInto(app, 'echo scroll-marker-A\r');
  await typeInto(app, 'for /L %i in (1,1,60) do @echo scrollback line %i\r');
  await waitFor(async () => (await screenOf(app)).includes('scrollback line 60'), 15000);
  const before = await leanPage(app);
  await shoot(app, '1-normal');

  // 2 -------------------------------------------------------------------------------------------
  const pressed = await press(app, 'lean-btn');
  check('2: the strip\'s Lean button was pressed (its click handler ran)', pressed.ok === true, JSON.stringify(pressed));
  const lean = await waitFor(async () => { const p = await leanPage(app); return p && p.leanOn ? p : null; }, 10000);
  check('2: the page went lean: class, no panel shown, no zone, no header, no bar', !!lean && lean.bodyLean && lean.shown.length === 0 && lean.zonesVisible === 0 && lean.headerVisible === false && lean.barVisible === false,
    lean ? JSON.stringify({ shown: lean.shown, zones: lean.zonesVisible, header: lean.headerVisible }) : 'no lean');
  if (!lean) return;
  check('2: the terminal fills the page', lean.termRect.left <= 1 && lean.termRect.top <= 1 && lean.termRect.width >= lean.page.width - 2 && lean.termRect.height >= lean.page.height - 2,
    JSON.stringify({ rect: lean.termRect, page: lean.page }));
  check('2: the terminal swapped its WebGL renderer for the default one', lean.webgl === false, `normal ${n0.webgl} -> lean ${lean.webgl}`);
  check('2: the project\'s colours and terminal theme are untouched', JSON.stringify(lean.look) === JSON.stringify(n0.look) && JSON.stringify(lean.termTheme) === JSON.stringify(n0.termTheme),
    JSON.stringify({ normal: n0.look, lean: lean.look }));
  // the terminal has more room while lean (more columns and rows), so baseY moves with the reflow; what must not move is the history
  check('2: scrollback survived the renderer swap (no line lost)', lean.buffer.length >= before.buffer.length, JSON.stringify({ before: before.buffer, lean: lean.buffer }));
  const sLean = await waitFor(async () => { const s = await stripLean(app); return s && s.chipHidden === false ? s : null; }, 8000);
  check('2: the strip shows "☾ lean" with Back to normal, no bedtime part, and the Lean button is gone', !!sLean && sLean.label === '\u263E lean' && sLean.night === null && sLean.back === 'Back to normal' && sLean.btnHidden === true && sLean.bodyLean === true, JSON.stringify(sLean));
  await typeInto(app, 'echo typed-while-lean\r');
  const typed = await waitFor(async () => (await screenOf(app)).includes('typed-while-lean'), 10000);
  const stillLean = await leanPage(app);
  check('2: typing still reaches the terminal, and keeps it lean', !!typed && !!stillLean && stillLean.leanOn === true);
  await shoot(app, '2-lean-by-hand');

  // 3 -------------------------------------------------------------------------------------------
  await press(app, 'lean-back');
  const back = await waitFor(async () => { const p = await leanPage(app); return p && !p.leanOn ? p : null; }, 10000);
  check('3: Back to normal: the same panels are shown again, the header too', !!back && JSON.stringify(back.shown.slice().sort()) === JSON.stringify(n0.shown.slice().sort()) && back.headerVisible === true,
    back ? JSON.stringify({ shown: back.shown, was: n0.shown }) : 'still lean');
  check('3: ...and the terminal has its renderer back', !!back && back.webgl === n0.webgl, `normal ${n0.webgl} -> back ${back && back.webgl}`);
  const sBack = await stripLean(app);
  check('3: ...and the strip is normal again', !!sBack && sBack.btnHidden === false && sBack.chipHidden === true && sBack.bodyLean === false, JSON.stringify(sBack));
  await shoot(app, '4-back-to-normal');

  // 3b: the vault in the layout must not take the keyboard when lean ends (PR #140 Dexter F1) ---------------------------
  await view(app, 'show', { id: 'vault', justThisTab: true });
  await sleep(1000);
  await view(app, 'state', { focusTerm: true });
  await press(app, 'lean-btn');
  await waitFor(async () => { const p = await leanPage(app); return p && p.leanOn ? p : null; }, 10000);
  await press(app, 'lean-back');
  await waitFor(async () => { const p = await leanPage(app); return p && !p.leanOn ? p : null; }, 10000);
  await sleep(800);
  const afterVault = await leanPage(app);
  check('3b: with the vault in the layout, leaving lean leaves the keyboard in the terminal, not #vault-search', !!afterVault && afterVault.typedFocus === true && afterVault.focusId !== 'vault-search',
    afterVault ? JSON.stringify({ focusId: afterVault.focusId, inTerm: afterVault.typedFocus, shown: afterVault.shown }) : 'no state');
  await view(app, 'move', { id: 'vault', target: 'hide', justThisTab: true });
  await sleep(500);

  // 4 -------------------------------------------------------------------------------------------
  const startedNear = Date.now();
  schedule(devPid, NIGHT_PROMPT, 1800);
  const night = await waitFor(async () => { const p = await leanPage(app); return p && p.leanOn ? p : null; }, 15000);
  check('4: a /bedtime night (a real ScheduleWakeup hook) turned lean on by itself', !!night && night.bodyLean === true);
  const sNight = await waitFor(async () => { const s = await stripLean(app); return s && s.chipHidden === false && s.night ? s : null; }, 8000);
  const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  check('4: ...and the chip says "bedtime HH:MM" with the night\'s start', !!sNight && [hhmm(startedNear), hhmm(Date.now())].some(t => sNight.night === `bedtime ${t}`), JSON.stringify(sNight));
  await typeInto(app, 'echo typed-in-the-night\r');
  await sleep(1500);
  check('4: typing keeps it lean', (await leanPage(app)).leanOn === true);
  await shoot(app, '3-lean-by-bedtime');
  stopLoop(devPid);
  const over = await waitFor(async () => { const p = await leanPage(app); return p && !p.leanOn ? p : null; }, 20000);
  check('4: the night ending turned lean off', !!over && (await stripLean(app)).chipHidden === true);

  // 5 -------------------------------------------------------------------------------------------
  schedule(devPid, NIGHT_PROMPT + ' second night', 1800);
  await waitFor(async () => { const p = await leanPage(app); return p && p.leanOn ? p : null; }, 15000);
  await press(app, 'lean-back');
  const wins = await waitFor(async () => { const p = await leanPage(app); return p && !p.leanOn ? p : null; }, 10000);
  await sleep(2500);
  check('5: the button always wins: Back to normal during a night stays normal', !!wins && (await leanPage(app)).leanOn === false);
  stopLoop(devPid);
  await sleep(2500);
  check('5: ...and the night ending afterwards changes nothing', (await leanPage(app)).leanOn === false);
  await press(app, 'lean-btn');
  await waitFor(async () => { const p = await leanPage(app); return p && p.leanOn ? p : null; }, 10000);
  schedule(devPid, NIGHT_PROMPT + ' third night', 1800);
  await sleep(2500);
  const handChip = await stripLean(app);
  check('5: a night starting while it is on by hand leaves it by hand (no "bedtime" on the chip)', !!handChip && handChip.chipHidden === false && handChip.night === null, JSON.stringify(handChip));
  stopLoop(devPid);
  await sleep(2500);
  check('5: ...and the night ending leaves it on', (await leanPage(app)).leanOn === true);

  // 6: portraits, while lean ----------------------------------------------------------------------------------
  hook(devPid, 'PreToolUse', { session_id: 'probe', tool_name: 'Agent', tool_input: { subagent_type: 'electron-pro', description: 'probe' }, tool_use_id: 'toolu_lean1' });
  const faces = await waitFor(async () => { const p = await leanPage(app); return p && p.faces.count >= 1 ? p : null; }, 20000);
  check('6: a working agent shows as a still portrait in the corner (an image, a canvas or the initials placeholder: never a video)', !!faces && faces.faces.shown === true && faces.faces.videos === 0 && faces.faces.stills + faces.faces.imgs + faces.faces.placeholders >= 1 && faces.faces.titles.some(t => /^electron-pro is working/.test(t)),
    faces ? JSON.stringify(faces.faces) : 'no faces');
  await shoot(app, '5-lean-portraits');
  hook(devPid, 'SubagentStop', { session_id: 'probe', agent_id: 'toolu_lean1', agent_type: 'electron-pro' });

  // 7: backgrounds -----------------------------------------------------------------------------------------------
  if (!errs.length) {
    await press(app, 'lean-back');
    await waitFor(async () => { const p = await leanPage(app); return p && !p.leanOn ? p : null; }, 10000);
    await view(app, 'bgStyle', { action: 'set-background', path: files.gif });
    const gifN = await waitFor(async () => { const p = await leanPage(app); return p && p.bg.hasBg && /\.gif/.test(p.bg.cssImage) ? p : null; }, 15000);
    check('7: a GIF background is the CSS background while normal', !!gifN && gifN.bg.still === null, gifN ? gifN.bg.cssImage.slice(0, 80) : 'not set');
    await press(app, 'lean-btn');
    const gifL = await waitFor(async () => { const p = await leanPage(app); return p && p.leanOn && p.bg.still ? p : null; }, 15000);
    check('7: ...while lean it is its first frame (a canvas) and the animated CSS background is gone', !!gifL && gifL.bg.cssImage === '' && gifL.bg.still.width === 160, gifL ? JSON.stringify(gifL.bg) : 'no still');
    await shoot(app, '6-lean-gif-still');
    await press(app, 'lean-back');
    const gifB = await waitFor(async () => { const p = await leanPage(app); return p && !p.leanOn && /\.gif/.test(p.bg.cssImage) ? p : null; }, 15000);
    check('7: ...and the GIF is back after Back to normal', !!gifB && gifB.bg.still === null);

    await view(app, 'bgStyle', { action: 'set-background', path: files.webm });
    const vidN = await waitFor(async () => {
      const p = await leanPage(app);
      if (!p || !p.bg.video || p.bg.video.paused) return null;
      await sleep(400);
      const q = await leanPage(app);
      return q && q.bg.video && q.bg.video.currentTime !== p.bg.video.currentTime ? q : null;
    }, 20000);
    check('7: a webm background plays while normal', !!vidN);
    await press(app, 'lean-btn');
    const vidL = await waitFor(async () => { const p = await leanPage(app); return p && p.leanOn && p.bg.video && p.bg.video.paused ? p : null; }, 15000);
    await sleep(800);
    const vidL2 = await leanPage(app);
    check('7: ...while lean it is held on frame zero', !!vidL && !!vidL2 && vidL2.bg.video.paused === true && vidL2.bg.video.currentTime === 0, vidL2 ? JSON.stringify(vidL2.bg.video) : 'none');
    await press(app, 'lean-back');
    const vidB = await waitFor(async () => {
      const p = await leanPage(app);
      if (!p || p.leanOn || !p.bg.video || p.bg.video.paused) return null;
      await sleep(400);
      const q = await leanPage(app);
      return q && q.bg.video && q.bg.video.currentTime !== p.bg.video.currentTime ? q : null;
    }, 20000);
    check('7: ...and plays again after Back to normal', !!vidB);
    await view(app, 'bgStyle', { action: 'reset-background' });
    await waitFor(async () => { const p = await leanPage(app); return p && !p.bg.hasBg ? p : null; }, 10000);
  }

  // 8: memory and CPU ----------------------------------------------------------------------------------------------
  // Each scenario is measured normal, lean, normal, lean: the second pair is the run-to-run noise (and any growth while the
  // sessions keep streaming), so a saving is believed only where both pairs agree. 20 s of CPU time per reading, after 8 s.
  if (!process.env.LEAN_PROBE_SKIP_MEASURE) {
    const rows = [];
    const setLean = async (on) => {
      const now = await leanPage(app);
      if (!now || now.leanOn !== on) await press(app, on ? 'lean-btn' : 'lean-back');
      await waitFor(async () => { const p = await leanPage(app); return p && p.leanOn === on ? p : null; }, 10000);
      await sleep(8000);
    };
    const ab = async (scenario) => {
      for (const [n, on] of [[1, false], [1, true], [2, false], [2, true]]) {
        await setLean(on);
        rows.push(tableRows(await measureRoles(`${on ? 'lean' : 'normal'} ${n}: ${scenario}`, app.child.pid)));
      }
    };
    const busy = async () => typeInto(app, 'for /L %i in (1,1,3000000) do @echo busy session output line %i with some padding to look like a stream\r');

    // A: the panels a working session keeps open (git rings, resources sampler, agents), the terminal idle
    await setLean(false);
    await command(app, { cmd: 'select', label: 'develop' });
    await sleep(2000);
    // Several panels at once: tabs of one zone only count as shown while selected, so each goes to its own edge.
    await view(app, 'move', { id: 'git', target: 'bottom', justThisTab: true });
    await view(app, 'move', { id: 'resources', target: 'left', justThisTab: true });
    await view(app, 'show', { id: 'agents', justThisTab: true });
    await sleep(10000);
    const open = await leanPage(app);
    console.log(`      (info) panels shown for the measurement: ${open && open.shown.join(', ')}`);
    await ab('panels open, idle terminal');

    // B: one busy tab
    await busy();
    await sleep(40000);
    await ab('1 busy tab, panels open');

    // C: three busy tabs
    for (const label of ['feat/a', 'feat/b']) {
      const sel = await command(app, { cmd: 'select', label });
      const ok = sel.ok && await waitFor(async () => { const st = await stateOf(app); return (st.hosts || []).find(h => h.label === label && h.started) || null; }, 60000);
      check(`8: the ${label} tab started`, !!ok);
      await sleep(4000);
      await busy();
    }
    await sleep(40000);
    await ab('3 busy tabs');
    printTable(rows);
    fs.writeFileSync(path.join(HARNESS_DIR, 'lean-footprint.json'), JSON.stringify({ measuredAt: new Date().toISOString(), rows }, null, 2));
  }

  await command(app, { cmd: 'quit' });
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();      // our hosts, by proven start (verify/lib/seen-pids.js); the window's own tree goes with launch-electron's exit sweep
    console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
