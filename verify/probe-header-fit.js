'use strict';
/* Does the tab header fit? Measured in the REAL renderer.html at 1000 / 1200 / 1600 px, with a busy header.
 *
 *     node verify/probe-header-fit.js [outDir]        (exit 0 = nothing clips at 1200 and 1600)
 *     HEADER_FIT_BASELINE=1 node ...                  only measure and print, never fail (the before-run for BACKLOG #42)
 *
 * WHAT IT DOES. Loads app/renderer.html (same CSS, same markup path as the real tab view; no host, no claude), fills
 * the header with a fixture as busy as a real session's (long folder, model + effort, resources chip, cost/lines/time,
 * permission mode, usage with a project line, three quota windows), and for each width reports every header child that
 * CLIPS: its text is cut (scrollWidth > clientWidth), or it ends past the window edge, or it was squeezed to nothing.
 * #42's rule: at 1200 (the app's default window) and 1600 nothing clips. At 1000 the cwd may ellipsize (it is the one
 * thing built to), and that is the only allowed clip.
 *
 * It then opens the shortcuts sheet (#43, when the build has one) and checks the card sits inside the window and under the
 * header, with a screenshot of each width.
 *
 * Same two traps as probe-quota-header.js: ELECTRON_RUN_AS_NODE is inherited (deleted below), and offscreen:true hangs
 * capturePage (a normal window is used).
 *
 * MEASURED 2026-10-09, before #42 (develop @ a7be3f7): see the PR body.
 */

const { spawnElectron } = require('./lib/launch-electron');
const path = require('path');
const { loadWithRetry } = require('./lib/load-with-retry');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnElectron(require('electron'), [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: true, env });
  child.on('exit', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow } = require('electron');
const fs = require('fs');

// HEADER_FIT_APP_DIR=<dir holding app/ and node_modules/>: measure another checkout's renderer (the before-run on develop).
const APP_ROOT = process.env.HEADER_FIT_APP_DIR || path.join(__dirname, '..');
const OUT_DIR = process.argv[2] || path.join(__dirname, '..', '.harness', 'header-shots');
const BASELINE = process.env.HEADER_FIT_BASELINE === '1';
const WIDTHS = [1000, 1200, 1600];
// The two children built to give way, by design (test/renderer-status-fields.test.js, Miguel L2 Y1): the folder ellipsizes, and the
// CLI status fields (opt-in, #27) shrink first. Everything else must fit.
const MAY_CLIP = new Set(['cwd', 'status-fields']);

const FIXTURE = `(() => {
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('title', 'claude-custom');
  set('cwd', 'C:\\\\Users\\\\ricar\\\\VibeCode\\\\claude-custom\\\\feat-shortcuts-header');
  set('tb-resources', 'CPU 23% · 5.1 / 31 GB');
  set('tb-model', 'Sonnet 5.5'); set('tb-effort', 'high');
  const sf = document.getElementById('status-fields');
  if (sf) { sf.textContent = '$1.23  │  +10/-2  │  1h05'; sf.hidden = false; }
  if (typeof renderMode === 'function') renderMode('acceptEdits');
  renderUsage({ ok: true, absent: 0, stale: 0,
    session: { input: 30e6, output: 32e6, cacheWrite: 4.1e6, cacheRead: 900e6, total: 966e6 },
    project: { input: 90e6, output: 91e6, cacheWrite: 21e6, cacheRead: 2.1e9, total: 2.3e9, sessions: 14 },
    milestone: null });
  const soon = new Date(Date.now() + 42 * 60000).toISOString();
  renderQuota({ ok: true, state: 'fresh', windows: [
    { key: 'session', label: '5h', percent: 41, severity: 'normal', resetsAt: soon, isActive: true, lockedReason: null },
    { key: 'weekly_all', label: 'week', percent: 62, severity: 'normal', resetsAt: new Date(Date.now() + 3 * 86400000).toISOString(), isActive: false, lockedReason: null },
    { key: 'weekly_scoped', label: 'Fable', percent: 18, severity: 'normal', resetsAt: new Date(Date.now() + 3 * 86400000).toISOString(), isActive: false, lockedReason: null },
  ] });
  return true;
})()`;

// Every direct child of the header (and the "?" button once it exists), with the facts that say it is cut.
const MEASURE = `(() => {
  const vw = window.innerWidth;
  const out = [];
  for (const el of document.querySelector('header').children) {
    if (el.hidden || getComputedStyle(el).display === 'none') continue;
    const r = el.getBoundingClientRect();
    const name = el.id || el.className || el.tagName.toLowerCase();
    const cut = el.scrollWidth > el.clientWidth + 1;
    const past = r.right > vw + 0.5;
    out.push({ name: String(name).split(' ')[0], left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, cut, past, text: (el.textContent || '').trim().slice(0, 60) });
  }
  return JSON.stringify({ vw, kids: out });
})()`;

const bail = setTimeout(() => { console.error('TIMED OUT'); process.exit(2); }, 240000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// A capture taken before the window has painted comes back empty (the first of a later window did): retry until it has pixels.
async function shot(win, rect, file) {
  for (let i = 0; i < 20; i++) {
    const png = (await win.webContents.capturePage(rect)).toPNG();
    if (png.length > 0) { fs.writeFileSync(file, png); return png.length; }
    await sleep(400);
  }
  throw new Error(`capture of ${file} stayed empty`);
}

// One window per width, each destroyed before the next: without this the last one closing quits the app mid-probe.
app.on('window-all-closed', () => {});

app.on('ready', async () => {
  let failed = 0;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const width of WIDTHS) {
      // A load that hangs or fails (ERR_FAILED -2) on a busy machine is retried in a fresh window, not read as a clip.
      const win = await loadWithRetry({
        open: () => new BrowserWindow({ width, height: 640, show: true, frame: false, useContentSize: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false } }),
        load: (w) => w.loadFile(path.join(APP_ROOT, 'app', 'renderer.html')), attempts: 3, timeoutMs: 40000,
      });
      // The page is ready when its renderer script has defined what the fixture calls (a fixed sleep raced on a cold start).
      for (let i = 0; i < 50; i++) {
        if (await win.webContents.executeJavaScript("typeof renderUsage === 'function' && typeof renderQuota === 'function'")) break;
        await sleep(200);
      }
      await sleep(600);
      await win.webContents.executeJavaScript(FIXTURE);
      await sleep(400);
      const m = JSON.parse(await win.webContents.executeJavaScript(MEASURE));
      const clipped = m.kids.filter(k => (k.cut || k.past) && !MAY_CLIP.has(k.name));
      console.log(`\n== ${width}px (viewport ${m.vw}) ==`);
      for (const k of m.kids) {
        const flag = (k.cut || k.past) ? (MAY_CLIP.has(k.name) ? 'ellipsis' : 'CLIPS') : 'ok';
        console.log(`  ${flag.padEnd(8)} ${k.name.padEnd(14)} ${String(k.left).padStart(5)}..${String(k.right).padEnd(5)} ` +
          `w=${k.width} scroll=${k.scrollWidth}/${k.clientWidth}  ${JSON.stringify(k.text)}`);
      }
      await sleep(300);   // a capture taken the instant the fixture lands can come back empty
      const file = path.join(OUT_DIR, `header-${width}.png`);
      await shot(win, { x: 0, y: 0, width, height: 40 }, file);
      console.log(`  shot ${file}`);
      if (clipped.length && width >= 1200) {
        console.log(`  -> ${clipped.length} clipped at ${width}: ${clipped.map(k => k.name).join(', ')}`);
        failed++;
      }
      // A DEGRADED header: a failed quota read and an unread usage say why in words, which is the longest text the header ever holds.
      // The controls (layout, focus, "?") must stay on screen; the notes clip instead of pushing them off the window.
      if (width >= 1200) {
        await win.webContents.executeJavaScript(`(() => { renderQuota({ ok: false, state: 'absent', windows: [], error: 'usage endpoint returned 429' });
          renderUsage({ ok: false, absent: 2, stale: 0, session: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }, project: { input: 5e6, output: 5e6, cacheWrite: 0, cacheRead: 0, sessions: 3 } }); return true; })()`);
        await sleep(300);
        const d = JSON.parse(await win.webContents.executeJavaScript(MEASURE));
        const controls = d.kids.filter(k => ['layout-btn', 'focus-btn', 'shortcuts-btn'].includes(k.name));
        const off = controls.filter(k => k.right > d.vw + 0.5 || k.width < 10);
        console.log(`  degraded header (quota note + lower-bound usage): controls ${controls.map(k => `${k.name} ${k.left}..${k.right}`).join(', ')}  -> ${off.length || controls.length < 3 ? 'CONTROLS PUSHED OFF' : 'ok'}`);
        if (off.length || controls.length < 3) failed++;
        await shot(win, { x: 0, y: 0, width, height: 40 }, path.join(OUT_DIR, `header-degraded-${width}.png`));
        await win.webContents.executeJavaScript(FIXTURE);
        await sleep(400);
      }
      // The shortcuts sheet (#43): a build without one has no window.toggleShortcutsPage and skips this.
      const sheet = await win.webContents.executeJavaScript(`(() => {
        if (typeof window.toggleShortcutsPage !== 'function') return null;
        window.toggleShortcutsPage();
        const card = document.querySelector('#shortcuts-sheet .sc-card').getBoundingClientRect();
        const bar = document.querySelector('header').getBoundingClientRect();
        const body = document.getElementById('shortcuts-body');
        return JSON.stringify({ left: Math.round(card.left), right: Math.round(card.right), top: Math.round(card.top), bottom: Math.round(card.bottom),
          headerBottom: Math.round(bar.bottom), vw: window.innerWidth, vh: window.innerHeight, rows: body.querySelectorAll('.sc-row').length,
          bodyScrolls: body.scrollHeight > body.clientHeight });
      })()`);
      if (sheet) {
        const c = JSON.parse(sheet);
        const fits = c.left >= 0 && c.right <= c.vw && c.bottom <= c.vh && c.top >= c.headerBottom && c.rows > 0;
        console.log(`  sheet card ${c.left}..${c.right} x ${c.top}..${c.bottom} in ${c.vw}x${c.vh}, header ends ${c.headerBottom}, ${c.rows} rows${c.bodyScrolls ? ' (scrolls)' : ''}  -> ${fits ? 'ok' : 'DOES NOT FIT'}`);
        if (!fits) failed++;
        await sleep(200);
        const file2 = path.join(OUT_DIR, `sheet-${width}.png`);
        await shot(win, { x: 0, y: 0, width, height: 640 }, file2);
        console.log(`  shot ${file2}`);
      }
      win.destroy();
    }
  } catch (err) {
    console.error('probe failed:', err && err.stack);
    failed++;
  } finally {
    clearTimeout(bail);
    console.log(failed && !BASELINE ? `\n${failed} width(s) clip` : '\nno clipping at 1200 / 1600 (or baseline run)');
    process.exitCode = failed && !BASELINE ? 1 : 0;
    app.quit();
  }
});
