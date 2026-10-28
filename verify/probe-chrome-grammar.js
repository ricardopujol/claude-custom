'use strict';
/* The chrome grammar (option A, Ricardo's picks 2026-10-26), measured in the REAL renderer.html at 1280 / 1600 / 1920 px.
 *
 *     node verify/probe-chrome-grammar.js [outDir]      (exit 0 = every check held at every width; 1 = a check failed; 2 = a width was not measured)
 *
 * WHAT IT CHECKS, per width, on a busy header (the same fixture shape as probe-header-fit.js):
 *   - the header holds no "$" (no cost chip) and the session chips are lines / time only
 *   - every chip is the one shape: the same height (24 px), an icon, a value; the micro-bars are 28 px wide
 *   - no header text is under 12 px
 *   - IBM Plex Sans and JetBrains Mono really load from app/ (document.fonts), and nothing breaks the CSP
 *   - the warnings are ONE chip with a count, and the loading state (HP running) is a dashed chip with no sentence
 *   - nothing in the header clips at 1280 and up
 *   - the rail is regrouped Work / Repo / Me with two separators between the groups
 * Screenshots: header-<width>.png (the header, with the warnings), header-loading-<width>.png (HP loading), rail-<width>.png (the rail),
 * under the output folder.
 *
 * Loads app/renderer.html alone (no host, no claude, no profile). Same two traps as probe-quota-header.js: ELECTRON_RUN_AS_NODE is
 * inherited (deleted below), and offscreen:true hangs capturePage (a normal window is used).
 */
const { spawnElectron } = require('./lib/launch-electron');
const path = require('path');
const { loadWithRetry } = require('./lib/load-with-retry');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_')) delete env[k];
  const child = spawnElectron(require('electron'), [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: true, env });
  child.on('exit', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow } = require('electron');
const { probeWindowOptions } = require('../host/probe-window');
const fs = require('fs');

const OUT_DIR = process.argv[2] || path.join(__dirname, '..', '.harness', 'chrome-grammar');
// 640 x 480 is the smallest window main.js allows (minWidth / minHeight); 900 and 1024 are the common small ones.
const WIDTHS = [640, 900, 1024, 1280, 1600, 1920];
const COMPACT_BELOW = 1400;     // under this the chips drop their micro-bars and labels (renderer.html, round 2 of Ricardo's look)
const heightFor = (width) => (width <= 640 ? 480 : 640);
// Every chip and button the header must keep showing, however narrow: only the CLI session chips (#status-fields) and the folder (it ellipsizes) may give way.
const MUST_SHOW = ['#hdr-warn', '.chip-hp', '#tb-resources', '.chip-model', '.chip-effort', '.chip-ctx', '#mode', '#usage', '#quota', '#layout-btn', '#focus-btn', '#shortcuts-btn'];
// The two children built to give way (probe-header-fit.js): the folder ellipsizes, and the CLI status chips (opt-in, #27) shrink first.
const MAY_CLIP = new Set(['title', 'cwd', 'status-fields']);
// The rail in the dock hides Claude's panel until it is used (app/dock-tree.js HIDDEN_UNTIL_USED), so it is not in the order.
const WANT_ORDER = 'agents,git,fog,resources,map,schedules|ask,changes,preview|style,vault,wand,games,models,projects,bugvault';

const FIXTURE = `(() => {
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  set('title', 'claude-custom');
  set('cwd', 'C:/Users/ricar/VibeCode/claude-custom/feat-chrome-grammar');
  window.__res = (cpu, ram, gpu) => { const G = 1024 ** 3; resChipOn = true;
    resPayload = { status: {}, machine: { cpu, mem: ram === null ? null : { usedBytes: ram / 100 * 32 * G, totalBytes: 32 * G }, gpu: { busy: gpu, mem: gpu === null ? null : { usedBytes: 4.2 * G, totalBytes: 8 * G } } } };
    renderResourcesChip(); };
  window.__res(23, 52, 8);
  set('tb-model', 'claude-sonnet-5-5'); set('tb-effort', 'high');
  if (typeof renderStatusFields === 'function') {
    chromeSettings.statusInHeader = true;
    renderStatusFields({ costUsd: 12.34, linesAdded: 214, linesRemoved: 38, durationMs: 3900000, over200k: false });
  }
  if (typeof renderMode === 'function') renderMode('acceptEdits');
  renderHealth({ state: 'healthy', fraction: 0.93, passed: 1840, failed: 3, total: 1843, runner: 'node', running: false, tookMs: 52000 });
  const wl = document.getElementById('wt-lock'); wl.hidden = false; wl.textContent = '!'; wl.title = 'No session lock (EPERM): a second window on this worktree would not be stopped';
  const wh = document.getElementById('wt-health'); wh.hidden = false; wh.textContent = '3 behind develop'; wh.title = 'This branch is 3 commits behind develop';
  renderWarnings();
  renderUsage({ ok: true, absent: 0, stale: 0,
    session: { input: 30e6, output: 32e6, cacheWrite: 4.1e6, cacheRead: 900e6, total: 966e6 },
    project: { input: 90e6, output: 91e6, cacheWrite: 21e6, cacheRead: 2.1e9, total: 2.3e9, sessions: 14 },
    milestone: null });
  const soon = new Date(Date.now() + 42 * 60000).toISOString();
  renderQuota({ ok: true, state: 'fresh', windows: [
    { key: 'session', label: '5h', percent: 41, severity: 'normal', resetsAt: soon, isActive: true, lockedReason: null },
    { key: 'weekly_all', label: 'week', percent: 62, severity: 'normal', resetsAt: new Date(Date.now() + 3 * 86400000).toISOString(), isActive: false, lockedReason: null },
  ] });
  return true;
})()`;

const MEASURE = `(async () => {
  const must = ${JSON.stringify(MUST_SHOW)}.map((sel) => { const el = document.querySelector('header ' + sel); if (!el) return { sel, missing: true };
    const r = el.getBoundingClientRect(); return { sel, shown: el.offsetParent !== null && r.width > 0, inView: r.left >= -0.5 && r.right <= window.innerWidth + 0.5, cut: el.scrollWidth > el.clientWidth + 1 }; });
  const resSvg = document.querySelectorAll('#tb-resources svg').length;
  await document.fonts.ready;
  const vw = window.innerWidth;
  const header = document.querySelector('header');
  const kids = [];
  for (const el of header.children) {
    if (el.hidden || getComputedStyle(el).display === 'none') continue;
    const r = el.getBoundingClientRect();
    kids.push({ name: String(el.id || el.className || el.tagName.toLowerCase()).split(' ')[0], left: Math.round(r.left), right: Math.round(r.right),
      cut: el.scrollWidth > el.clientWidth + 1, past: r.right > vw + 0.5 });
  }
  const chips = [...header.querySelectorAll('.chip, #top-bar > .tb-chip, #usage, #quota, #mode')]
    .filter(el => el.offsetParent !== null).map(el => Math.round(el.getBoundingClientRect().height));
  const widths = [...header.querySelectorAll('.chip, #top-bar > .tb-chip, #usage, #quota, #mode')].filter(el => el.offsetParent !== null)
    .map(el => (el.id || el.className.split(' ').slice(0, 2).join('.')) + '=' + Math.round(el.getBoundingClientRect().width) + '/' + el.scrollWidth);
  const small = [];
  for (const el of header.querySelectorAll('*')) {
    if (el.offsetParent === null || el.closest('svg')) continue;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px < 12) small.push((el.id || el.className || el.tagName) + ' ' + px);
  }
  const bars = [...header.querySelectorAll('#hp .track, #quota .meter .track, #usage .milestone .track')].filter(el => el.offsetParent !== null)
    .map(el => Math.round(el.getBoundingClientRect().width));
  const fonts = {
    loaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '') + ' ' + f.weight) };
  const warn = document.getElementById('hdr-warn');
  const sfChips = [...document.querySelectorAll('#status-fields .sf-chip')].map(c => c.textContent.trim());
  return JSON.stringify({ vw, must, resSvg, usageTitle: document.getElementById('usage').title, grpTitles: [...document.querySelectorAll('#usage .grp')].map(g => g.title), kids, chips, widths, small, bars, fonts,
    dollar: header.textContent.includes('$'), sfChips,
    warn: { hidden: warn.hidden, text: document.getElementById('hdr-warn-n').textContent, title: warn.title },
    uiFont: getComputedStyle(document.body).fontFamily, csp: window.__csp });
})()`;

const RAIL = `(() => {
  const ids = TABS.map(t => t.id);
  const layout = dockTree.startLayout(ids);       // what the app opens with: every panel a tab on the dock's own rail
  const plan = dockTreeView.treePlan(layout, { active: {}, foldAll: false }, TABS, { width: 440, height: 600 }, { faceSize: () => 77 });
  dockTreeView.applyBoxes(plan, document);
  const rail = document.querySelector('.drail');
  if (!rail) return JSON.stringify({ found: false });
  const r = rail.getBoundingClientRect();
  const seps = [...rail.children].filter(c => c.classList.contains('rail-sep'));
  return JSON.stringify({ found: true, rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    order: [...rail.children].map(c => c.classList.contains('rail-sep') ? '|' : c.dataset.module),
    overflowY: getComputedStyle(rail).overflowY, railId: rail.dataset.rail || null, seps: seps.length, sepRoles: seps.every(s => s.getAttribute('role') === 'separator') });
})()`;

const bail = setTimeout(() => { console.error('TIMED OUT'); process.exit(2); }, 240000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function shot(win, rect, file) {
  for (let i = 0; i < 20; i++) {
    const png = (await win.webContents.capturePage(rect)).toPNG();
    if (png.length > 0) { fs.writeFileSync(file, png); return png.length; }
    await sleep(400);
  }
  throw new Error(`capture of ${file} stayed empty`);
}

app.on('window-all-closed', () => {});

app.on('ready', async () => {
  let failed = 0;
  const measured = [];
  let error = null;
  const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const width of WIDTHS) {
      const win = await loadWithRetry({
        open: () => new BrowserWindow(probeWindowOptions({ width, height: heightFor(width), show: true, frame: false, useContentSize: true, enableLargerThanScreen: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false } })),
        load: (w) => w.loadFile(path.join(__dirname, '..', 'app', 'renderer.html')), attempts: 3, timeoutMs: 40000,
      });
      win.setContentSize(width, heightFor(width));              // a window wider than the screen's work area is clamped at creation; this asks again
      for (let i = 0; i < 50; i++) {
        if (await win.webContents.executeJavaScript("typeof renderUsage === 'function' && typeof renderQuota === 'function' && typeof renderWarnings === 'function'")) break;
        await sleep(200);
      }
      await sleep(600);
      await win.webContents.executeJavaScript(FIXTURE);
      await sleep(500);
      const m = JSON.parse(await win.webContents.executeJavaScript(MEASURE));
      console.log(`\n== ${width}px (viewport ${m.vw}) ==`);
      const clipped = m.kids.filter(k => (k.cut || k.past) && !MAY_CLIP.has(k.name));
      if (clipped.length) console.log('  chip widths: ' + m.widths.join(' '));
      if (clipped.length) console.log('  header children: ' + m.kids.map(k => `${k.name} ${k.left}..${k.right}${k.cut ? ' CUT' : ''}`).join(' | '));
      check(clipped.length === 0, `nothing clips${clipped.length ? ': ' + clipped.map(k => k.name).join(', ') : ''}`);
      const lost = m.must.filter(k => k.missing || !k.shown || !k.inView || k.cut);
      check(lost.length === 0, `every header chip and button stays visible and unclipped${lost.length ? ': ' + JSON.stringify(lost) : ''}`);
      check(/Every session/.test(m.usageTitle), "the project total is in the usage chip's hover, whichever groups the width hides");
      check(m.grpTitles.length > 0 && m.grpTitles.every(t => /Every session/.test(t)), "each usage group's own hover carries the project total");
      check(m.resSvg === 0, 'the resources chip draws no graphs in the header (figures only)');
      check(!m.dollar, 'no "$" anywhere in the header');
      check(m.sfChips.length === 2 && m.sfChips.every(t => !t.includes('$')), `session chips are lines and time: ${JSON.stringify(m.sfChips)}`);
      check(m.chips.length >= 8 && new Set(m.chips).size === 1 && m.chips[0] === 24, `${m.chips.length} chips, all ${[...new Set(m.chips)].join('/')} px tall`);
      if (width >= COMPACT_BELOW) check(m.bars.length > 0 && m.bars.every(w => w === 28), `micro-bars are 28 px: ${JSON.stringify(m.bars)}`);
      else check(m.bars.length === 0, `compact: no micro-bars: ${JSON.stringify(m.bars)}`);
      check(m.small.length === 0, `no header text under 12 px${m.small.length ? ': ' + m.small.join(', ') : ''}`);
      check(m.fonts.loaded.some(f => f.startsWith('IBM Plex Sans')) && m.fonts.loaded.some(f => f.startsWith('JetBrains Mono')), `bundled fonts load: ${m.fonts.loaded.join(', ')}`);
      check(/IBM Plex Sans/.test(m.uiFont), `the page's font is ${m.uiFont.split(',')[0]}`);
      check(m.csp.length === 0, `no CSP violation${m.csp.length ? ': ' + m.csp.join('; ') : ''}`);
      check(!m.warn.hidden && m.warn.text === '2' && m.warn.title.split('\n').length === 2, `one warnings chip with a count: "${m.warn.text}", hover has ${m.warn.title.split('\n').length} lines`);
      await sleep(200);
      await shot(win, { x: 0, y: 0, width, height: 44 }, path.join(OUT_DIR, `header-${width}.png`));
      // The resources chip (Ricardo's pick A): `CPU 23% · RAM 52% · GPU 8%`, amber from 75 and red from 90 on the number alone, `23 · 52 · 8` up to 1000 px.
      const resOf = async () => JSON.parse(await win.webContents.executeJavaScript(`(() => { const el = document.getElementById('tb-resources'); const col = (s) => { const n = el.querySelector(s); return n ? getComputedStyle(n).color : null; };
        return JSON.stringify({ text: el.innerText.replace(/\\s+/g, ' ').trim(), title: el.title, vals: [...el.querySelectorAll('.tbr-v')].map(n => getComputedStyle(n).color), label: col('.tbr-l'), labelShown: el.querySelector('.tbr-l').offsetParent !== null,
          border: getComputedStyle(el).borderColor, chipColor: getComputedStyle(el).color, kids: el.scrollWidth <= el.clientWidth + 1, inView: el.getBoundingClientRect().right <= window.innerWidth + 0.5 }); })()`));
      const calm = await resOf();
      const wantText = width <= 1100 ? '23 · 52 · 8' : 'CPU 23% · RAM 52% · GPU 8%';
      check(calm.text === wantText, `resources chip reads "${wantText}": ${JSON.stringify(calm.text)}`);
      check(calm.title.includes('RAM 16.6 of 32.0 GB (52%)') && calm.title.includes('GPU 8% (4.2 of 8.0 GB)') && /^CPU 23%/.test(calm.title), 'the full labelled figures are the chip hover');
      check(new Set(calm.vals).size === 1 && calm.labelShown === (width > 1100), `a calm chip: one number colour, labels ${width > 1100 ? 'shown' : 'dropped'}`);
      await win.webContents.executeJavaScript('window.__res(80, 52, 8); true');
      const amber = await resOf();
      check(amber.vals[0] !== amber.vals[1] && amber.vals[1] === calm.vals[1] && amber.label === calm.label && amber.border === calm.border && amber.chipColor === calm.chipColor, `amber: only the CPU number changes colour ${JSON.stringify(amber.vals)}`);
      await shot(win, { x: 0, y: 0, width, height: 44 }, path.join(OUT_DIR, `header-res-amber-${width}.png`));
      await win.webContents.executeJavaScript('window.__res(95, 91, 8); true');
      const red = await resOf();
      check(red.vals[0] === red.vals[1] && red.vals[0] !== amber.vals[0] && red.vals[2] === calm.vals[2] && red.label === calm.label, `red: CPU and RAM numbers turn red, GPU stays ${JSON.stringify(red.vals)}`);
      await shot(win, { x: 0, y: 0, width, height: 44 }, path.join(OUT_DIR, `header-res-red-${width}.png`));
      const tight = await win.webContents.executeJavaScript(`(() => { const r = document.getElementById('tb-resources').getBoundingClientRect(); return r.right <= window.innerWidth + 0.5 && document.getElementById('tb-resources').scrollWidth <= document.getElementById('tb-resources').clientWidth + 1; })()`);
      check(tight === true, 'the red chip (widest) still fits and is not cut');
      await win.webContents.executeJavaScript('window.__res(null, null, null); true');
      check((await resOf()).text.replace(/[^—]/g, '') === '———', 'a missing reading is a dash for each metric, never 0');
      await win.webContents.executeJavaScript('window.__res(23, 52, 8); true');
      // Loading and unknown: a dashed chip, never a sentence.
      await win.webContents.executeJavaScript(`renderHealth({ state: 'unknown', fraction: null, runner: 'node', running: true }); true`);
      await sleep(200);
      const hp = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({ text: document.getElementById('hp').textContent.trim(), dashed: getComputedStyle(document.querySelector('.chip-hp')).borderStyle, shimmer: getComputedStyle(document.querySelector('.chip-hp')).animationName, stale: document.getElementById('hp').classList.contains('stale') })`));
      check(hp.dashed === 'dashed' && hp.shimmer === 'chip-shimmer' && !/[a-z]{4,}/i.test(hp.text.replace(/^HP/, '')), `running HP is a shimmering dashed chip with no sentence: ${JSON.stringify(hp)}`);
      check(hp.stale && hp.text.includes('1840/1843'), 'a running HP keeps its last known value, dimmed');
      await win.webContents.executeJavaScript(`renderHealth({ state: 'unknown', fraction: null, runner: 'node', running: false }); true`);
      const hu = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({ dashed: getComputedStyle(document.querySelector('.chip-hp')).borderStyle, shimmer: getComputedStyle(document.querySelector('.chip-hp')).animationName })`));
      check(hu.dashed === 'dashed' && hu.shimmer === 'none', `an unknown HP is dashed and still: ${JSON.stringify(hu)}`);
      await win.webContents.executeJavaScript(`renderHealth({ state: 'unknown', fraction: null, runner: 'node', running: true }); true`);
      await shot(win, { x: 0, y: 0, width, height: 44 }, path.join(OUT_DIR, `header-loading-${width}.png`));
      const rail = JSON.parse(await win.webContents.executeJavaScript(RAIL));
      check(rail.found && rail.seps === 2 && rail.sepRoles, `the rail has two separators: ${rail.found ? rail.order.join(' ') : 'no rail'}`);
      if (rail.found) {
        check(rail.overflowY === 'auto' || rail.overflowY === 'scroll', `a rail taller than the window scrolls (rail ${rail.railId}, overflow-y ${rail.overflowY}), so every group stays reachable at the 480 px floor`);
        const r = rail.rect;
        check(rail.order.join(',').replace(/,\|,/g, '|') === WANT_ORDER, 'the rail reads Work | Repo | Me in the picked order');
        await sleep(200);
        await shot(win, { x: Math.max(0, r.x - 4), y: Math.max(0, r.y), width: r.width + 8, height: Math.min(r.height, heightFor(width) - r.y) }, path.join(OUT_DIR, `rail-${width}.png`));
      }
      win.destroy();
      measured.push(width);
    }
  } catch (err) {
    console.error('probe failed:', err && err.stack);
    error = err && err.message ? err.message : String(err);
  } finally {
    clearTimeout(bail);
    const unmeasured = WIDTHS.filter(w => !measured.includes(w));
    if (unmeasured.length) { console.log(`\ncould not measure ${unmeasured.join(', ')}: ${error || 'unknown error'}`); process.exitCode = 2; }
    else if (failed) { console.log(`\n${failed} check(s) failed`); process.exitCode = 1; }
    else console.log(`\nall checks held at ${WIDTHS.join(' / ')}; shots in ${OUT_DIR}`);
    app.quit();
  }
});
