'use strict';
/* #37 in a REAL window: local paths in the terminal become links, a click opens
   or reveals through app/file-link.js, and a long path is linked across the
   rows Ink broke it into. No host, no claude, no tokens: the probe writes
   Ink-shaped text into the page's own xterm (the shapes measured by
   verify/probe-file-link-rows.js) and moves a real mouse over real cells.

     node verify/probe-file-links.js

   What runs for real: renderer.html with every script (so the one-global-scope
   trap is in play), the preload bridge, xterm's link provider, app/file-link.js
   against real files in a temp folder. What is stubbed: Electron's `shell`.
   Nothing is opened or shown in Explorer; the calls are recorded instead.
   The ipcMain handlers are this probe's copies of main.js's two (main.js's own
   are pinned by test/main-shell-wiring.test.js).

   ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* variable are stripped before
   the relaunch. The temp folder is removed at the end.

   RESULT 2026-10-02 (feat/terminal-file-links): 12/12 PASS. Both modules load
   in the shared scope; notes.md opens; run.ps1 is revealed, never opened, and
   the hover says so first; "Reaper Projects\...\a b.xlsx" links to its real
   end; a 3-row path is linked from its first and last row and a click opens
   the whole path; a missing path is no link; `notes.md:3` resolves against
   the tab folder. */
const { spawnElectron } = require('./lib/launch-electron');
const path = require('path');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_')) delete env[k];
  const child = spawnElectron(require('electron'), [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: true, env });
  child.on('exit', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const fileLink = require('../app/file-link');

const REPO = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-file-links-'));
const results = {};
let failed = 0;
const check = (name, ok, detail) => {
  results[name] = { ok, detail };
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
};

// The files the text names.
const NOTES = path.join(ROOT, 'notes.md');
const SCRIPT = path.join(ROOT, 'run.ps1');
const SPACED = path.join(ROOT, 'Reaper Projects', 'Pinshot', 'a b.xlsx');
const LONG = path.join(ROOT, 'a-deliberately-long-folder-name', 'and-another-folder-to-cross-the-edge',
  'and-one-more-for-good-measure', 'file.txt');
const MISSING = path.join(ROOT, 'nope', 'missing.txt');
for (const f of [NOTES, SCRIPT, SPACED, LONG]) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'probe\n');
}

const shellCalls = [];
const stubShell = {
  openPath: async (p) => { shellCalls.push(['open', p]); return ''; },
  showItemInFolder: (p) => { shellCalls.push(['reveal', p]); },
};
const fileFs = { stat: (p) => fs.promises.stat(p), realpath: (p) => fs.promises.realpath(p) };
ipcMain.handle('tab:checkPaths', (_e, lists) => fileLink.check(lists, ROOT, fileFs));
ipcMain.handle('tab:openPath', (_e, p) => fileLink.open(p, ROOT, fileFs, stubShell));
// The page asks for the window-chrome settings at load; nothing here needs them.
ipcMain.handle('chrome:getSettings', () => null);

// Ink's wrap as measured: content width cols-1, "● " on the first row, the
// rest indented 2; a word longer than the room is broken mid-word.
function inkWrap(text, cols) {
  const width = cols - 1 - 2;
  const rows = [];
  let cur = '';
  const push = () => { rows.push((rows.length ? '  ' : '● ') + cur); cur = ''; };
  for (const w of text.split(' ')) {
    if (cur && cur.length + 1 + w.length <= width) { cur += ` ${w}`; continue; }
    if (cur) push();
    let rest = w;
    while (rest.length > width) { cur = rest.slice(0, width); push(); rest = rest.slice(width); }
    cur = rest;
  }
  if (cur) push();
  return rows;
}

async function finish() {
  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exitCode = failed === 0 ? 0 : 1;
  app.quit();
}
const bail = setTimeout(() => { console.error('TIMED OUT'); failed++; finish(); }, 90000);

app.on('ready', async () => {
  try {
    const win = new BrowserWindow({
      width: 1100, height: 760, show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
        preload: path.join(REPO, 'app', 'preload.js') },
    });
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) console.log(`      [page error] ${String(message).slice(0, 200)}`);
    });
    await win.loadFile(path.join(REPO, 'app', 'renderer.html'),
      { query: { port: '1', token: 'probe', cwd: ROOT } }).catch(() => {});
    const js = (src) => win.webContents.executeJavaScript(src);
    for (let t = 0; t < 40 && !(await js(`typeof term === 'object' && !!term.element`)); t++) await sleep(250);

    check('one global scope: both modules defined',
      await js(`typeof window.filePathParse === 'object' && typeof window.terminalRows === 'object'`));

    const cols = await js(`term.cols`);
    const lines = [
      ...inkWrap(`Wrote ${NOTES} and the script ${SCRIPT} for you.`, cols), '',
      ...inkWrap(`The sheet is ${SPACED} now.`, cols), '',
      ...inkWrap(`Saved it to ${LONG} as asked.`, cols), '',
      ...inkWrap(`Not there: ${MISSING} at all.`, cols), '',
      ...inkWrap('Relative: notes.md:3 is the line.', cols),
    ];
    await js(`term.reset(); term.write(${JSON.stringify(lines.join('\r\n'))}); true`);
    await sleep(500);

    // Where a substring sits on screen: the n-th row containing it (viewport row, col).
    const cellOf = async (needle, nth = 0) => JSON.parse(await js(`(() => {
      const b = term.buffer.active; let seen = 0;
      for (let y = b.viewportY; y < b.viewportY + term.rows; y++) {
        const s = b.getLine(y).translateToString(true);
        const x = s.indexOf(${JSON.stringify(needle)});
        if (x !== -1 && seen++ === ${nth}) return JSON.stringify({ row: y - b.viewportY, col: x + 1 });
      }
      return 'null';
    })()`));
    const pointAt = async ({ row, col }) => JSON.parse(await js(`(() => {
      const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      const d = term._core._renderService.dimensions.css.cell;
      return JSON.stringify({ x: Math.round(r.left + (${col} + 0.5) * d.width), y: Math.round(r.top + (${row} + 0.5) * d.height) });
    })()`));
    const hover = async (needle, nth = 0) => {
      const c = await cellOf(needle, nth);
      if (!c) return { found: false };
      const p = await pointAt(c);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
      await sleep(150);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
      await sleep(900);
      return { found: true, p, text: await js(`document.getElementById('link-target').hidden ? '' : document.getElementById('link-target').textContent`) };
    };
    const click = async (p) => {
      const before = shellCalls.length;
      win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(900);
      return shellCalls.slice(before);
    };
    win.focus(); win.webContents.focus();

    let h = await hover('notes.md');
    check('notes.md: hover says it opens', h.text === 'Opens notes.md in its default app', h.text);
    let calls = h.found ? await click(h.p) : [];
    check('notes.md: a click opens it', calls.length === 1 && calls[0][0] === 'open' && calls[0][1] === NOTES, calls);

    h = await hover('run.ps1');
    check('run.ps1: hover says Explorer, not run',
      h.text === "Shows run.ps1 in Explorer (it could run, so it isn't opened)", h.text);
    calls = h.found ? await click(h.p) : [];
    check('run.ps1: a click reveals, never opens', calls.length === 1 && calls[0][0] === 'reveal' && calls[0][1] === SCRIPT, calls);

    h = await hover('a b.xlsx');
    check('a path with spaces: linked to its real end', h.text === 'Opens a b.xlsx in its default app', h.text);

    // The long path spans rows: hover its first row and its last.
    h = await hover('a-deliberately');
    check('long path, first row: linked', h.text === 'Opens file.txt in its default app', h.text);
    h = await hover('file.txt');
    check('long path, last row: linked', h.text === 'Opens file.txt in its default app', h.text);
    calls = h.found ? await click(h.p) : [];
    check('long path: a click opens the whole path', calls.length === 1 && calls[0][1] === LONG, calls);

    h = await hover('missing.txt');
    check('a path that does not exist is not a link', h.found && h.text === '', h.text);

    h = await hover('notes.md:3');
    check('a relative name:line resolves against the tab folder', h.text === 'Opens notes.md in its default app', h.text);

    // Exactly the three clicks reached the (stubbed) shell, nothing on hover (PR #92 Miguel S7).
    check('only the three clicks reached the shell', JSON.stringify(shellCalls.map(c => c[0])) === '["open","reveal","open"]', shellCalls);
  } catch (err) {
    console.error('probe error:', err && err.stack);
    failed++;
  }
  clearTimeout(bail);
  await finish();
});
