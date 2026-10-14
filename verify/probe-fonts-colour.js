'use strict';
/**
 * PROBE: backlog #88 (fonts) and #92 (plain colour background), in a REAL window with a REAL host. (re-runnable)
 *
 *   node verify/probe-fonts-colour.js        (exit 0 = every check held)
 *   FONTS_PROBE_SHOTS=<dir>                   also keep screenshots there
 *
 * The unit tests pin the decisions (which font wins, what is fixed-width, what a look stores); none can see a window paint with
 * a font, or find out that a script aborted in the shared scope. This does, against the fonts installed on THIS machine:
 *
 *   1  the list is every installed family (main enumerates; Electron 33 has no queryLocalFonts), and the fixed-width filter is
 *      the renderer's own measurement: Consolas is on the terminal list, Arial is not
 *   2  picking a terminal font changes xterm's font, the monospace variable and what the Files tree and the reader path compute
 *   3  the size (10-24) changes xterm's size; an out-of-range size is clamped by main
 *   4  picking an interface font changes what the page body computes
 *   5  a project's own terminal font wins over the app-wide one on this project, and Reset hands it back
 *   6  a font that is not installed, and an unsafe name, never leave the stack without its fallbacks / never get stored
 *   7  the search narrows the list, case-insensitively
 *   8  Plain colour: no media element, no image, the app colour as the background, the darkness slider darkens it (0 = as is),
 *      the picture's file stays on disk, and Image / video brings the picture back
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* the
 * probe does not set are deleted; registry, portraits, uploads and user data are temp folders; the project is a temp git repo.
 * Main's install-wide records (the app-wide fonts, layouts, toggles) go to a temp folder through the probe seam
 * CLAUDE_CUSTOM_UI_STATE_DIR, so the real `.harness/state` and any window of the person's own are never touched. Only PIDs this probe started are killed
 * (verify/lib/process-hygiene.js), never a process by name.
 */

const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { projectRoots } = require(path.join(ROOT, 'host', 'project-roots'));
const { readLook, writeLook, LOOK_DIR_NAME } = require(path.join(ROOT, 'host', 'style'));

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-fonts-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const userData = path.join(tmp, 'user-data');
const shots = process.env.FONTS_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });

// main's install-wide records for THIS run only (the probe seam in host/probe-seams.js).
const uiState = path.join(tmp, 'ui-state');
fs.mkdirSync(uiState, { recursive: true });
const FONTS_FILE = path.join(uiState, 'fonts-global.json');

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

// A real PNG with no dependency, so "the picture is showing" is unmistakable.
function gradientPng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
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
      raw[i] = Math.round(255 * x / w); raw[i + 1] = Math.round(255 * y / h); raw[i + 2] = 200;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// --- launching the app (as verify/probe-video-background.js does) -----------------
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
    CLAUDE_CUSTOM_SIDE_TAB: 'style',
    CLAUDE_CUSTOM_UI_STATE_DIR: uiState,
  };
  const keep = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
    'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_SIDE_TAB', 'CLAUDE_CUSTOM_UI_STATE_DIR'];
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_') && !keep.includes(k)) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: keep });
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
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started || !Number.isInteger(sel.pid)) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? { st, host: sel } : null;
  }, 45000);
}

const fontsState = (app) => view(app, 'fontsState');
const startsWithFamily = (stack, family) => typeof stack === 'string' && stack.replace(/^["']/, '').toLowerCase().startsWith(family.toLowerCase());
let stateRoot = container;

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
  const png = path.join(tmp, 'pic.png');
  fs.writeFileSync(png, gradientPng(96, 64));
  // A look to start from, so the project is not seeded with a random (maybe light) one: dark, one known app colour, no veil.
  writeLook(stateRoot, { version: 1, appColor: '#204060', mode: 'dark', darkness: 0 });

  const app = await launchApp(container);
  const ready = await viewReady(app);
  check('the window came up with a session', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  await sleep(4000);

  // 1 -----------------------------------------------------------------------------
  const t0 = Date.now();
  const first = await waitFor(async () => { const s = await fontsState(app); return s.list && s.list.loaded && s.settings ? s : null; }, 20000);
  check('1: the page asked main for the installed fonts and got a list', !!first, JSON.stringify(first ? first.list : await fontsState(app)).slice(0, 600));
  if (!first) return;
  console.log(`   list: ${first.list.count} families, ${first.list.fixed} fixed-width (listed and measured in ${Date.now() - t0} ms incl. startup wait)`);
  check('1: it is a real list (dozens of families), not a stub', first.list.count >= 30, String(first.list.count));
  check('1: some, but not all, are fixed-width (the filter filters)', first.list.fixed >= 1 && first.list.fixed < first.list.count, `${first.list.fixed} of ${first.list.count}`);
  check('1: the settings arrived from main and are unset on a fresh install', first.settings.terminalFont === null && first.settings.terminalSize === null && first.settings.uiFont === null, JSON.stringify(first.settings));
  const term = await view(app, 'fontsSearch', { kind: 'term', query: '' });
  const allRows = new Set(term.rows || []);
  const ui = await view(app, 'fontsSearch', { kind: 'ui', query: '' });
  check('1: the terminal list shows a subset of the interface list', term.ok && ui.ok && term.rows.length < ui.rows.length, `${term.rows && term.rows.length} < ${ui.rows && ui.rows.length}`);
  const uiAll = new Set(ui.rows || []);
  const mono = ['Consolas', 'Cascadia Mono', 'Courier New'].find((f) => allRows.has(f));
  check('1: Consolas / Cascadia Mono / Courier New is on the terminal list', !!mono, [...allRows].slice(0, 12).join(', '));
  check('1: Arial is on the interface list and NOT on the terminal list', uiAll.has('Arial') && !allRows.has('Arial'));
  if (!mono) return;

  // 7 (first, while the lists are fresh) ---------------------------------------------
  const q = await view(app, 'fontsSearch', { kind: 'term', query: mono.slice(0, 4).toUpperCase() });
  check('7: the search narrows the list, case-insensitively', q.ok && q.rows.includes(mono) && q.rows.length < allRows.size
    && q.rows.every((r) => r.toLowerCase().includes(mono.slice(0, 4).toLowerCase())), JSON.stringify(q.rows && q.rows.slice(0, 5)));
  await view(app, 'fontsSearch', { kind: 'term', query: '' });

  // 2 -----------------------------------------------------------------------------
  const before = await fontsState(app);
  await view(app, 'fontsPick', { kind: 'term', font: mono });
  const picked = await waitFor(async () => { const s = await fontsState(app); return startsWithFamily(s.term.fontFamily, mono) ? s : null; }, 8000);
  check('2: picking a terminal font changes xterm\'s font', !!picked, JSON.stringify((picked || before).term));
  if (picked) {
    check('2: ...the stack keeps the fallbacks behind it', /monospace$/.test(picked.term.fontFamily), picked.term.fontFamily);
    check('2: ...the monospace UI variable follows', startsWithFamily(picked.vars.mono, mono), picked.vars.mono);
    check('2: ...the Files tree computes it', startsWithFamily(picked.computed.filesTree, mono), String(picked.computed.filesTree));
    check('2: ...the reader path computes it', startsWithFamily(picked.computed.readerPath, mono), String(picked.computed.readerPath));
    check('2: ...and it is stored by main', picked.settings.terminalFont === mono, JSON.stringify(picked.settings));
    const disk = JSON.parse(fs.readFileSync(FONTS_FILE, 'utf8'));
    check('2: ...in .harness/state/fonts-global.json', disk.terminalFont === mono, JSON.stringify(disk));
  }

  // 3 -----------------------------------------------------------------------------
  await view(app, 'fontsSet', { settings: { ...(picked ? picked.settings : {}), terminalSize: 18 } });
  const sized = await waitFor(async () => { const s = await fontsState(app); return s.term.fontSize === 18 ? s : null; }, 8000);
  check('3: the size changes xterm\'s size', !!sized, JSON.stringify((sized || {}).term));
  const big = await view(app, 'fontsSet', { settings: { ...(picked ? picked.settings : {}), terminalSize: 99 } });
  check('3: an out-of-range size is clamped by main to 24', big.saved && big.saved.terminalSize === 24, JSON.stringify(big));
  await view(app, 'fontsSet', { settings: { ...(picked ? picked.settings : {}), terminalSize: 14 } });

  // 4 -----------------------------------------------------------------------------
  await view(app, 'fontsPick', { kind: 'ui', font: 'Arial' });
  const uiPicked = await waitFor(async () => { const s = await fontsState(app); return startsWithFamily(s.computed.body, 'Arial') ? s : null; }, 8000);
  check('4: picking an interface font changes what the page computes', !!uiPicked, String((await fontsState(app)).computed.body));
  check('4: ...with the fallbacks behind it', !!uiPicked && /sans-serif$/.test(uiPicked.vars.ui), uiPicked && uiPicked.vars.ui);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '1-fonts-picked.png') });

  // 5 -----------------------------------------------------------------------------
  const other = [...allRows].find((f) => f !== mono && f !== 'Lucida Console') || mono;
  await view(app, 'fontsPick', { kind: 'project', font: other });
  const proj = await waitFor(async () => { const s = await fontsState(app); return s.projectFont === other && startsWithFamily(s.term.fontFamily, other) ? s : null; }, 8000);
  check('5: a project\'s own terminal font wins on this project', !!proj, JSON.stringify((await fontsState(app)).term));
  check('5: ...it is written to the project\'s look.json', readLook(stateRoot).terminalFont === other, String(readLook(stateRoot).terminalFont));
  check('5: ...the app-wide pick is untouched', !!proj && proj.settings.terminalFont === mono);
  await view(app, 'bgStyle', { action: 'set-look', look: { terminalFont: null } });
  const back = await waitFor(async () => { const s = await fontsState(app); return s.projectFont === null && startsWithFamily(s.term.fontFamily, mono) ? s : null; }, 8000);
  check('5: Reset hands the terminal back to the app-wide font', !!back, JSON.stringify((await fontsState(app)).term));

  // an override naming a font that is not installed here still shows the app-wide pick behind it (Dexter 2, PR #175)
  await view(app, 'fontsSet', { settings: { terminalFont: mono } });
  await view(app, 'bgStyle', { action: 'set-look', look: { terminalFont: 'Iosevka Not Installed' } });
  const chain = await waitFor(async () => { const s = await fontsState(app); return startsWithFamily(s.term.fontFamily, 'Iosevka Not Installed') ? s : null; }, 8000);
  check('5: an uninstalled override keeps the app-wide pick behind it', !!chain && chain.term.fontFamily.startsWith(`"Iosevka Not Installed", "${mono}", `), chain && chain.term.fontFamily);
  await view(app, 'bgStyle', { action: 'set-look', look: { terminalFont: null } });

  // 6 -----------------------------------------------------------------------------
  await view(app, 'fontsSet', { settings: { terminalFont: 'Nonexistent Font XYZ', terminalSize: 14, uiFont: null } });
  const missing = await waitFor(async () => { const s = await fontsState(app); return startsWithFamily(s.term.fontFamily, 'Nonexistent') ? s : null; }, 8000);
  check('6: a font that is not installed keeps the fallback stack behind it (never blank)', !!missing && /Cascadia Mono.*monospace$/.test(missing.term.fontFamily), missing && missing.term.fontFamily);
  const unsafe = await view(app, 'fontsSet', { settings: { terminalFont: mono, terminalSize: 14, uiFont: 'a;b{c}' } });
  check('6: an unsafe name is never stored', unsafe.saved && unsafe.saved.uiFont === null, JSON.stringify(unsafe));
  await view(app, 'fontsSet', { settings: { terminalFont: null, terminalSize: null, uiFont: null } });
  const reset = await waitFor(async () => {
    const s = await fontsState(app);
    return s.vars.ui === '"Segoe UI", system-ui, sans-serif' && /^ui-monospace, "Cascadia Mono"/.test(s.vars.mono)
      && s.term.fontFamily === first.term.fontFamily && s.term.fontSize === first.term.fontSize ? s : null;     // the registry theme's own font, as at the start
  }, 8000);
  check('6: clearing every pick puts the built-in stacks back', !!reset, JSON.stringify(await fontsState(app).then((s) => ({ vars: s.vars, term: s.term }))));

  // 8 -----------------------------------------------------------------------------
  await view(app, 'bgStyle', { action: 'set-background', path: png });
  const pic = await waitFor(async () => { const s = await fontsState(app); return s.bg.hasCustomBg && s.bg.image.includes('background.png') && !s.bg.plainColour ? s : null; }, 10000);
  check('8: with a picture set, #bg shows it and no plain colour', !!pic, JSON.stringify(pic && pic.bg));
  const bgFile = path.join(stateRoot, LOOK_DIR_NAME, 'background.png');
  await view(app, 'bgStyle', { action: 'set-look', look: { backgroundMode: 'colour' } });
  const plain = await waitFor(async () => { const s = await fontsState(app); return s.bg.plainColour ? s : null; }, 10000);
  check('8: Plain colour: no image, no video, no still, and the plain-colour class is on', !!plain && plain.bg.image === '' && !plain.bg.video && !plain.bg.still && plain.bg.hasPlainClass, JSON.stringify(plain && plain.bg));
  check('8: ...the background is the app colour (#204060)', !!plain && plain.bg.color === 'rgb(32, 64, 96)', plain && plain.bg.color);
  check('8: ...at darkness 0 the veil is clear: the colour as it is', !!plain && plain.bg.veil === 0, plain && String(plain.bg.veil));
  check('8: ...the darkness slider is offered (nothing else to darken)', !!plain && plain.bg.slider === true && plain.bg.modeButtons.colour && plain.bg.modeButtons.image);
  check('8: ...the picture\'s file is still on disk, and so is its record', fs.existsSync(bgFile) && !!readLook(stateRoot).background);
  await view(app, 'bgStyle', { action: 'set-look', look: { darkness: 0.6 } });
  const dark = await waitFor(async () => { const s = await fontsState(app); return s.bg.veil === 0.6 ? s : null; }, 8000);
  check('8: raising the darkness darkens the colour (veil 0.6, not clear)', !!dark && dark.bg.veilColor !== 'rgba(0, 0, 0, 0)', dark && `${dark.bg.veil} ${dark.bg.veilColor}`);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '2-plain-colour.png') });
  // an app colour equal to the CLI's own text (#c7cede) must not hide it in Plain colour (Dexter 1, PR #175)
  await view(app, 'bgStyle', { action: 'set-look', look: { appColor: '#c7cede', darkness: 0 } });
  const same = await waitFor(async () => { const s = await fontsState(app); return s.bg.appColor === '#c7cede' && s.bg.veil === 0 ? s : null; }, 8000);
  check('8: an app colour equal to the CLI text is painted readable in Plain colour, not as that colour', !!same && same.bg.color !== 'rgb(199, 206, 222)', same && same.bg.color);
  await view(app, 'bgStyle', { action: 'set-look', look: { appColor: '#204060' } });
  await waitFor(async () => { const s = await fontsState(app); return s.bg.appColor === '#204060' ? s : null; }, 8000);
  await view(app, 'bgStyle', { action: 'set-look', look: { backgroundMode: null } });
  const again = await waitFor(async () => { const s = await fontsState(app); return !s.bg.plainColour && s.bg.hasCustomBg && s.bg.image.includes('background.png') ? s : null; }, 10000);
  check('8: Image / video brings the picture back (restored from the file that stayed)', !!again, JSON.stringify(again && again.bg));

  const errors = (app.out.match(/\[renderer:[a-z]+\].*/g) || []).filter((l) => /error|not defined|undefined is not|cannot read/i.test(l));
  check('the renderer reported no errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await command(app, { cmd: 'quit' });
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    hygiene._emergencyCleanup('done');     // kills the window and, via the cleanup, every host it started
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    if (process.env.FONTS_PROBE_SHOTS) console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
