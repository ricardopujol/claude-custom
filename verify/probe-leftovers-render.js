'use strict';
/**
 * PROBE: the Resources panel's "Leftovers" section (BACKLOG #74 item 6) drawn in a REAL Electron window. (re-runnable)
 *
 *   node verify/probe-leftovers-render.js        (exit 0 = every check held; the screenshot path is printed)
 *
 * No unit test can see the page: every renderer script is a plain <script> sharing ONE global scope (CLAUDE.md, the
 * first trap), so a module can load in a test and still abort in the window. This loads the page's own <style> blocks
 * and every `*-display.js` script renderer.html lists, in that order, into one window, feeds resourcesDisplay a fixed
 * payload with all four kinds plus a stopped row, and checks: no script error, the section is above Machine, its four
 * group titles are drawn, nothing overflows the 300 px column, and no row carries a click target. One Electron, started
 * through verify/lib/launch-electron.js (ledgered, killed by PID in a finally), closed by app.quit().
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchElectron } = require('./lib/launch-electron');

const ROOT = path.join(__dirname, '..');
const out = process.env.LEFTOVERS_PROBE_SHOTS || path.join(ROOT, '.harness', 'probe-leftovers-render');
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-left-'));

const html = fs.readFileSync(path.join(ROOT, 'app', 'renderer.html'), 'utf8');
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
const scripts = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map(m => m[1]).filter(s => /display\.js$|^dock-|^side-tabs/.test(s));
const MB = 1024 * 1024;
const row = (o) => ({ pid: 100, start: '5', name: 'probe', what: 'probe-x', bytes: 230 * MB, ageMs: 12 * 60000, reapable: true, reapInMs: 3 * 60000, ...o });
const payload = {
  status: { stale: false, expired: false, ageMs: 0 }, machine: { cpu: 20, mem: { usedBytes: 10 * 1024 * MB, totalBytes: 32 * 1024 * MB } },
  model: {
    measuring: false, machine: { cpu: 20, mem: { usedBytes: 10 * 1024 * MB, totalBytes: 32 * 1024 * MB }, ours: { cpu: 3, bytes: 900 * MB } },
    project: { cpu: 3, bytes: 900 * MB, rows: [], self: { cpu: 1, bytes: 400 * MB, parts: [] } }, windows: [], background: null,
  },
  leftovers: {
    reapAfterMs: 15 * 60000,
    stuck: [row({ pid: 11, what: 'Electron', bytes: 85 * MB, reapable: false, reapInMs: null, ageMs: 40 * 60000 })],
    probes: [row(), row({ pid: 101, what: 'a-very-long-probe-label-that-must-ellipsise-and-not-overflow-the-dock-column', reapInMs: 0 })],
    shells: [row({ pid: 30, what: 'bash.exe', session: 'feat-leftovers-readout', reapable: false, reapInMs: null, ageMs: 3 * 3600000, bytes: 9 * MB })],
    mcp: [row({ pid: 50, what: 'chrome-devtools-mcp', session: 'main', reapable: false, reapInMs: null, bytes: 117 * MB, ageMs: 5 * 3600000 })],
    stopped: [{ kind: 'probe-window', pid: 7, what: 'probe-y', bytes: 120 * MB, at: 1 }],
  },
};

const MAIN = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 340, height: 760, show: true, webPreferences: { contextIsolation: true } });
  await win.loadFile(${JSON.stringify(path.join(tmp, 'page.html'))});
  win.show(); await new Promise(r => setTimeout(r, 1500));
  const result = await win.webContents.executeJavaScript(\`(() => {
    const root = document.getElementById('resources-root');
    const sec = root.querySelector('.res-left');
    const h3s = [...root.querySelectorAll('h3')].map(h => h.firstChild.textContent.trim());
    return {
      errors: window.__errors,
      api: typeof window.resourcesDisplay,
      h3s,
      subs: [...root.querySelectorAll('.res-sub')].map(e => e.textContent),
      overflow: root.scrollWidth > root.clientWidth,
      clickTargets: sec ? sec.querySelectorAll('[data-res-act]').length : -1,
      rows: sec ? sec.querySelectorAll('.res-child').length : 0,
    };
  })()\`);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(${JSON.stringify(path.join(out, 'leftovers.png'))}, img.toPNG());
  fs.writeFileSync(${JSON.stringify(path.join(tmp, 'result.json'))}, JSON.stringify(result));
  app.quit();
});
`;

fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'cc-probe-leftovers', main: 'main.js' }));
fs.writeFileSync(path.join(tmp, 'main.js'), MAIN);
fs.writeFileSync(path.join(tmp, 'page.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style>
<script>window.__errors = []; window.addEventListener('error', e => { if (/resources-display.js/.test(e.filename)) window.__errors.push(String(e.message)); });</script></head>
<body><div id="resources-body" class="panel on" style="display:block;width:300px"><div id="resources-root"></div></div>
${scripts.map(s => `<script src="${path.join(ROOT, 'app', s).replace(/\\/g, '/')}"></script>`).join('\n')}
<script>
  var D = window.resourcesDisplay;
  document.getElementById('resources-root').innerHTML = D.html(D.view(D.withPayload(D.emptyState(), ${JSON.stringify(payload)})));
</script></body></html>`);

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failed++; };

(async () => {
  let handle;
  try {
    handle = await launchElectron({ args: [tmp, `--user-data-dir=${path.join(tmp, 'ud')}`], label: 'probe-leftovers-render', stdio: 'ignore' });
    const deadline = Date.now() + 60000;
    const file = path.join(tmp, 'result.json');
    while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
    if (!fs.existsSync(file)) throw new Error('the window never reported');
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(r.api === 'object', 'resourcesDisplay is loaded in the shared plain-script scope');
    check(Array.isArray(r.errors) && r.errors.length === 0, `no script error in the window (${JSON.stringify(r.errors)})`);
    check(r.h3s[0] === 'Leftovers' && r.h3s.indexOf('Machine') > 0, `the section sits above Machine (${r.h3s.join(', ')})`);
    check(JSON.stringify(r.subs) === JSON.stringify(['Stuck closing', 'Probe windows nobody runs', 'Agent shells', 'MCP servers', 'Stopped automatically']), `group titles (${r.subs.join(' | ')})`);
    check(r.rows === 5, `five rows drawn (${r.rows})`);
    check(!r.overflow, 'nothing overflows the 300 px column');
    check(r.clickTargets === 0, 'no row is a click target');
    console.log(`screenshot: ${path.join(out, 'leftovers.png')}`);
  } catch (err) {
    console.log('FAIL ', err && err.message);
    failed++;
  } finally {
    if (handle) await handle.stop({ polite: () => {} });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.exit(failed ? 1 : 0);
})();
