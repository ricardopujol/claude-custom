'use strict';
/* Backlog #64: the accent a person picks must be the only accent on screen.  (re-runnable)

     node verify/probe-accent.js        (exit 0 = every check held; OUT=<png> and PORT=<n> optional)

   A REAL window, because the places that kept the default yellow are in two different
   documents (the tab's page and the tab strip's own page) plus xterm's JS theme, and
   no unit test can see across those. The project is given an unusual accent (#00ff88)
   the way the Style tab writes one (look.json), a model family is seated so the
   model's colour cue is live (opus is amber, i.e. yellow), and the computed styles
   are read back over the Chromium debugging port:

     - the tab page: the active panel tab, the model and effort chips, the xterm cursor,
       and a scan of EVERY element for the default accent or the family colours
     - the strip page: the selected tab's line, and the same scan
     - a live change (the Style tab's picker preview) reaches the strip too

   Two PNGs are written beside OUT: <name>.png (the tab page) and <name>.strip.png.

   Safe: the host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing billable runs.
   ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* variable are removed from the child's
   environment (Claude Code is an Electron app and exports them). Only the two processes
   started here are killed, by pid. */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const REPO = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 7716;
const CDP = PORT + 1000;
const OUT = process.env.OUT || path.join(REPO, '.harness', 'probe-accent.png');
const ACCENT = '#00ff88';
const ACCENT_RGB = 'rgb(0, 255, 136)';
const LIVE = '#ff00aa';
const LIVE_RGB = 'rgb(255, 0, 170)';
// The default accent and the family cues: none may survive on a surface that is meant to be the accent.
const STRAY = { 'default accent': 'rgb(208, 140, 74)', 'opus amber': 'rgb(224, 160, 48)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-accent-'));
fs.mkdirSync(path.join(project, '.claude-custom'));
fs.writeFileSync(path.join(project, '.claude-custom', 'look.json'),
  JSON.stringify({ version: 1, accentColor: ACCENT }, null, 2));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_')) delete env[k];
Object.assign(env, {
  CLAUDE_CUSTOM_PORT: String(PORT),
  CLAUDE_CUSTOM_CWD: project,
  CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
  CLAUDE_CUSTOM_SIDE_TAB: 'style',   // the Style tab is open, so its accent picker exists
  CLAUDE_CUSTOM_REGISTRY: path.join(project, 'registry'),
  CLAUDE_CUSTOM_PORTRAITS: path.join(project, 'portraits'),
  CLAUDE_CUSTOM_UPLOADS: path.join(project, 'uploads'),
});

const children = [];
const killTree = (c) => {
  if (!c || !c.pid) return;
  try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
};
const cleanup = () => {
  children.forEach(killTree);
  try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* best effort */ }
};

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// A minimal Chrome DevTools Protocol client for one page.
function cdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      send: (method, params = {}) => new Promise((res) => {
        const n = ++id;
        waiting.set(n, res);
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
      close: () => ws.close(),
    }));
  });
}
const evalIn = async (page, expression) => {
  const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.error || (r.result && r.result.exceptionDetails)) {
    throw new Error(JSON.stringify(r.error || r.result.exceptionDetails).slice(0, 400));
  }
  return r.result.result.value;
};
async function shot(page, file) {
  // An occluded window never answers a capture: bring it forward, and never wait for ever.
  await page.send('Page.bringToFront');
  const r = await Promise.race([
    page.send('Page.captureScreenshot', { format: 'png' }),
    sleep(15000).then(() => { throw new Error('captureScreenshot did not answer in 15 s'); }),
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  return file;
}

// Every element's painted colours, looked for among the stray ones. Runs in the page.
const SCAN = `(() => {
  const stray = ${JSON.stringify(STRAY)};
  const props = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor',
    'borderLeftColor', 'outlineColor', 'boxShadow', 'backgroundImage'];
  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    for (const p of props) {
      for (const [name, rgb] of Object.entries(stray)) {
        if (String(cs[p]).includes(rgb)) hits.push(name + ' in ' + p + ' of ' + (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ').join('.')));
      }
    }
  }
  return hits.slice(0, 12);
})()`;

// Ctrl-C / termination: stop only the two processes started here (by pid) and remove the temp dir.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

(async () => {
  let host;
  let electron;
  try {
    host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(host);
    let hostLog = '';
    host.stdout.on('data', (d) => { hostLog += d; });
    host.stderr.on('data', (d) => { hostLog += d; });
    await sleep(3500);
    if (!/listening/i.test(hostLog)) { console.error('host did not start:\n' + hostLog); process.exitCode = 1; return; }

    electron = spawn(path.join(REPO, 'node_modules', '.bin', 'electron.cmd'), ['.', `--remote-debugging-port=${CDP}`], {
      cwd: REPO, env, stdio: 'ignore', shell: true,
    });
    children.push(electron);

    // Both pages up: the strip (tab-strip.html) and the tab's view (renderer.html).
    let targets = [];
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      try {
        targets = (await getJson(`http://127.0.0.1:${CDP}/json`)).filter((t) => t.type === 'page');
        if (targets.some((t) => /tab-strip\.html/.test(t.url)) && targets.some((t) => /renderer\.html/.test(t.url))) break;
      } catch { /* not listening yet */ }
      await sleep(500);
    }
    const stripT = targets.find((t) => /tab-strip\.html/.test(t.url));
    const viewT = targets.find((t) => /renderer\.html/.test(t.url));
    check('both pages came up (strip and tab view)', !!(stripT && viewT));
    if (!stripT || !viewT) return;
    const strip = await cdpClient(stripT.webSocketDebuggerUrl);
    const view = await cdpClient(viewT.webSocketDebuggerUrl);

    // The look reaches the page by the host's welcome message; wait for it.
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      try { ready = (await evalIn(view, "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")) === ACCENT; } catch { /* page still loading */ }
      if (!ready) await sleep(500);
    }
    check('the chosen accent reached the tab page (--accent)', ready);
    if (!ready) return;

    // Seat a model family so its colour cue is live (opus = amber), as a real session has.
    await evalIn(view, "sessionModelFallback = 'claude-opus-4-1'; renderTopBar(); true");
    await sleep(1200);

    const v = await evalIn(view, `(() => {
      const css = (sel, p) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[p] : null; };
      const root = getComputedStyle(document.documentElement);
      return {
        accent: root.getPropertyValue('--accent').trim(),
        modelAccent: root.getPropertyValue('--model-accent').trim(),
        cursor: term.options.theme.cursor,
        panelTab: { color: css('.zone-tabs button.on', 'color'), line: css('.zone-tabs button.on', 'borderBottomColor') },
        chip: css('.tb-chip', 'borderTopColor'),
        stray: ${SCAN},
      };
    })()`);
    check('the active panel tab is the chosen accent', v.panelTab.color === ACCENT_RGB && v.panelTab.line === ACCENT_RGB,
      `colour ${v.panelTab.color}, line ${v.panelTab.line}`);
    check('the model and effort chips are the chosen accent', v.chip === ACCENT_RGB, `border ${v.chip}`);
    check('--model-accent is the chosen accent', v.modelAccent === ACCENT, v.modelAccent);
    check('the terminal cursor is the chosen accent', String(v.cursor).toLowerCase() === ACCENT, String(v.cursor));
    check('no element on the tab page paints the default accent or a family colour', v.stray.length === 0, v.stray.join('; '));

    const s = await evalIn(strip, `(() => {
      const sel = document.querySelector('.tab.selected');
      return { accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        line: sel ? getComputedStyle(sel).boxShadow : null, stray: ${SCAN} };
    })()`);
    check('the selected worktree tab\'s line is the chosen accent', !!s.line && s.line.includes(ACCENT_RGB), String(s.line));
    check('no element on the strip paints the default accent', s.stray.length === 0, s.stray.join('; '));

    // A live change (the Style tab's picker preview) must reach every surface, not just the page.
    await evalIn(view, `(() => { const p = document.getElementById('style-accent'); if (!p) return false;
      p.value = '${LIVE}'; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(800);
    const live = await evalIn(view, `({ panel: getComputedStyle(document.querySelector('.zone-tabs button.on')).color,
      cursor: term.options.theme.cursor })`);
    const liveStrip = await evalIn(strip, `getComputedStyle(document.querySelector('.tab.selected')).boxShadow`);
    check('a live preview moves the panel tab and cursor', live.panel === LIVE_RGB && String(live.cursor).toLowerCase() === LIVE, JSON.stringify(live));
    check('a live preview moves the strip\'s line', String(liveStrip).includes(LIVE_RGB), String(liveStrip));

    // Put the committed accent back before the picture.
    await evalIn(view, `(() => { const p = document.getElementById('style-accent'); p.value = '${ACCENT}';
      p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(800);
    console.log('screenshot:', await shot(view, OUT));
    console.log('screenshot:', await shot(strip, OUT.replace(/(\.png)?$/i, '.strip.png')));
    view.close();
    strip.close();
  } catch (err) {
    check('the probe ran to the end', false, err && err.message);
  } finally {
    cleanup();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks held');
    process.exit(failures ? 1 : 0);
  }
})();
