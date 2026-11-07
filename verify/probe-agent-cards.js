'use strict';
/**
 * The roster's agent cards, measured in a real window (heavy: run it through scripts/with-heavy-lock.js).
 *
 * A. BACKLOG #17 F4: "the roster rebuild can drop a click" (pre-existing since PR #68). A card's button (its medal
 *    button) is pressed with REAL input events (webContents.sendInputEvent: mouseDown, then mouseUp at the same point),
 *    and between the two the roster is rebuilt three ways:
 *      1. not at all (the control case: the click must land);
 *      2. renderRoster() with nothing changed (what every 1 s `processes` frame does while an agent runs);
 *      3. a real hook event that changes ANOTHER card's markup (a Bash call starting on a second agent), so the
 *         roster's markup is replaced while the button is held.
 *    Each case records whether a `click` reached the button. Then the repaint rate: how many times the roster's
 *    markup is really replaced in 10 s of an agent working with no new events, and in 10 s of one hook event a second.
 *
 * `claude` is replaced by cmd.exe (CLAUDE_CUSTOM_BIN) so nothing is billed. Everything goes to temp folders.
 *
 *   node scripts/with-heavy-lock.js node verify/probe-agent-cards.js
 */
const { spawn, spawnSync } = require('child_process');
const { spawnElectron, noteChild } = require('./lib/launch-electron');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const mainSource = (port, helper, pipe) => `
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const { probeWindowOptions } = require(path.join(ROOT, 'host', 'probe-window'));
app.setPath('userData', ${JSON.stringify(path.join(os.tmpdir(), 'cc-agent-cards-userdata-' + process.pid))});
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log('[check]', ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Hook events go from HERE, through the real native helper into the real hook bridge (an Electron main process is a
// node: no round trip to the parent, whose stdin pipe an Electron main never read on Windows).
const { spawnSync } = require('child_process');
const HELPER = ${JSON.stringify(helper)};
const PIPE = ${JSON.stringify(pipe)};
const send = (event, payload) => {
  const r = spawnSync(HELPER, ['--pipe', PIPE, '--event', event], { input: JSON.stringify(payload), windowsHide: true });
  if (r.status !== 0) throw new Error('helper exited ' + r.status + ' for ' + event);
};
let n = 0;
const by = (name) => ({ agent_id: 'a' + name + '-' + String(4242 + name.length).padStart(16, '0'), agent_type: name });
// One step of churn: probe-churn's Bash call starts (running) or ends (working): its card's markup changes either way.
let flying = null;
const churn = () => {
  if (flying) { send('PostToolUse', { tool_name: 'Bash', tool_use_id: flying, tool_input: { command: 'step' }, tool_response: { exit_code: 0 }, ...by('probe-churn') }); flying = null; }
  else { flying = 'tu' + (++n); send('PreToolUse', { tool_name: 'Bash', tool_use_id: flying, tool_input: { command: 'step' }, ...by('probe-churn') }); }
};
const need = async (what) => {
  if (what === 'churn') churn();
  if (what === 'busy') for (let i = 0; i < 10; i++) { churn(); await sleep(1000); }
};

app.whenReady().then(async () => {
  const win = new BrowserWindow(probeWindowOptions({ width: 1000, height: 800, show: true, webPreferences: {
    contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'app', 'preload.js') } }));
  win.loadFile(path.join(ROOT, 'app', 'renderer.html'), { query: {
    port: ${JSON.stringify(port)}, cwd: ${JSON.stringify(ROOT)}, project: 'probe', token: 'probe-token' } });
  win.webContents.on('console-message', (_e, level, message, line, src) => { if (level >= 2) console.log('[page]', message, src + ':' + line); });
  // Every page call has its own limit: an executeJavaScript that never resolves (a page still loading) must not hang the probe.
  const js = (code) => Promise.race([win.webContents.executeJavaScript(code),
    new Promise((_, reject) => setTimeout(() => reject(new Error('page call timed out: ' + code.slice(0, 60))), 10000))]);
  console.log('[step] window created');
  win.webContents.on('did-finish-load', () => console.log('[step] page loaded'));
  win.webContents.on('render-process-gone', (_e, d) => console.log('[step] renderer gone', JSON.stringify(d)));
  const until = async (code, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await js(code); if (v) return v; } catch (e) { /* page not ready */ } await sleep(100); }
    return null;
  };

  try {
    check('the renderer and the host are up', await until('typeof renderRoster === "function" && ws && ws.readyState === 1', 90000));
    for (const name of ['probe-click', 'probe-churn']) {
      send('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_' + (++n), tool_input: { subagent_type: name } });
      send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), tool_input: { command: 'hi' }, tool_response: { exit_code: 0 }, ...by(name) });
    }
    // A fresh profile keeps the roster in the hidden panel store: put it on screen, selected, through the dock's own path.
    console.log('[dock] ' + await js('(() => { try { commitPlacement(DTm.show(settledLayout(), "agents"), { justThisTab: true, select: "agents" }); selectModule("agents"); } catch (e) { return "show failed: " + e.message; }' +
      ' const p = document.querySelector("[data-panel=agents]"); return JSON.stringify({ inStore: !!p.closest("#panel-store"), parent: p.parentElement && (p.parentElement.id || p.parentElement.className), layout: placementLayout() }); })()'));
    await js('setRosterTab("active")');
    const onScreen = '(() => { const r = document.getElementById("agents").getBoundingClientRect(); return r.width > 100 && r.height > 100; })()';
    if (!await until(onScreen, 5000)) {
      // Still in the store: lift the panel out as it is, fixed on the right. The cards, their CSS and the ONE roster click handler on
      // #agents are untouched; only where the panel sits differs from a docked one.
      console.log('[dock] the dock did not place it; lifting the panel out of the store');
      await js('(() => { const p = document.querySelector("[data-panel=agents]"); document.body.appendChild(p); Object.assign(p.style, { position: "fixed", right: "0", top: "40px", width: "380px", height: "640px", display: "flex", flexDirection: "column", zIndex: 50, background: "var(--bg, #111)" }); p.hidden = false; return true; })()');
    }
    check('the roster is on screen', await until(onScreen, 10000));
    check('both cards are on the roster', await until('document.querySelectorAll("#agents .agent[data-agent^=\\'probe-\\']").length === 2', 30000));
    // What reached the page: every click (capture phase, so nothing in the page can hide it from us), and every time the
    // roster's markup was really replaced (paintAgents -> setRosterHtml -> replaceChildren is a childList mutation).
    await js('window.__clicks = []; window.__repaints = 0;' +
      ' document.addEventListener("click", (e) => { const t = e.target; window.__clicks.push({ onButton: !!(t && t.closest && t.closest("[data-medal-open]")), tag: t && t.tagName, id: t && t.id || null, cls: t && String(t.className || "") }); }, true);' +
      ' new MutationObserver(() => { window.__repaints++; }).observe(document.getElementById("agents"), { childList: true }); true');
    const BTN = '#agents .agent[data-agent=\\'probe-click\\'] [data-medal-open]';
    // The point, and what is really under it (a press that lands on something else measures nothing).
    const point = async () => js('(() => { const b = document.querySelector("' + BTN + '"); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect();' +
      ' const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2); const at = document.elementFromPoint(x, y);' +
      ' return { x, y, w: r.width, h: r.height, dpr: window.devicePixelRatio, inner: [window.innerWidth, window.innerHeight], onButton: !!(at && at.closest && at.closest("[data-medal-open]")), at: at ? at.tagName + "." + String(at.className || "") : null }; })()');
    const closeMenu = () => js('(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); if (typeof medalMenuEl !== "undefined" && medalMenuEl) medalMenuEl.hidden = true; return true; })()');
    const press = async (between) => {
      await closeMenu();
      await sleep(300);
      const p = await point();
      console.log('[point] ' + JSON.stringify(p));
      await js('window.__clicks = []; window.__repaints = 0; true');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(80);
      await between();
      await sleep(80);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(300);
      return JSON.parse(await js('JSON.stringify({ clicks: window.__clicks, repaints: window.__repaints })'));
    };

    const plain = await press(async () => {});
    check('1. a plain press and release reaches the button (the control case)', plain.clicks.some(c => c.onButton), plain);

    const same = await press(async () => { await js('renderRoster(); renderRoster(); renderRoster(); true'); });
    check('2. renderRoster() with nothing changed replaces no markup', same.repaints === 0, same.repaints);
    check('2. ...and the click lands', same.clicks.some(c => c.onButton), same);

    const changed = await press(async () => {
      await need('churn');
      await until('window.__repaints > 0', 5000);
    });
    check('3. a real hook event on ANOTHER agent replaced the roster markup while the button was held', changed.repaints > 0, changed.repaints);
    const landed = changed.clicks.some(c => c.onButton);
    console.log('[F4] click with the roster rebuilt between mousedown and mouseup: ' + (landed ? 'LANDED' : 'DROPPED') + ' ' + JSON.stringify(changed));
    check('3. the case ran to an answer (landed or dropped, recorded above)', changed.repaints > 0);

    // The repaint rate. Quiet: an agent working, no events, processes frames every second.
    await js('window.__repaints = 0; true');
    await sleep(10000);
    const quiet = await js('window.__repaints');
    console.log('[F4] markup replacements in 10 s of a working agent with no events: ' + quiet);
    check('quiet: the 1 s processes frames replace no markup', quiet === 0, quiet);
    await js('window.__repaints = 0; true');
    await need('busy');
    const busy = await js('window.__repaints');
    console.log('[F4] markup replacements in 10 s of one Bash call starting or ending a second on another agent: ' + busy);
    check('busy: the roster is replaced when a card changes', busy > 0, busy);
  } catch (err) {
    check('probe ran to completion', false, String(err && err.stack || err));
  }
  console.log('[result]', JSON.stringify({ failed: results.filter(r => !r.ok).length, total: results.length }));
  // app.exit alone left this window running until the parent's timeout (measured twice): destroy it, then leave.
  try { win.destroy(); } catch { /* already gone */ }
  process.exit(results.every(r => r.ok) ? 0 : 1);
});
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function run() {
  const helper = process.env.CLAUDE_CUSTOM_HELPER || path.join(ROOT, '.harness', 'hook-helper.exe');
  const mainHelper = fs.existsSync(helper) ? helper : path.join(ROOT, '..', 'dev', '.harness', 'hook-helper.exe');
  if (!fs.existsSync(mainHelper)) { check('the native hook helper exists', false, mainHelper); return; }

  const hygiene = createHygieneRegistry();
  hygiene.install();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-cards-'));
  const port = String(await freePort());
  const sessionId = 'agentcards' + process.pid;
  const pipe = `claude-custom-${sessionId}`;
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh',
    CLAUDE_CUSTOM_CWD: tmp, CLAUDE_CUSTOM_PORT: port, CLAUDE_CUSTOM_TOKEN: 'probe-token',
    CLAUDE_CUSTOM_SESSION_ID: sessionId, CLAUDE_CUSTOM_HELPER: mainHelper,
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'forge'), CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const host = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { cwd: ROOT, env });
  noteChild(host);
  hygiene.registerChild(host);
  let hostOut = '';
  host.stdout.on('data', d => { hostOut += d; });
  host.stderr.on('data', d => { hostOut += d; });
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };
  try {
    await new Promise((resolve, reject) => {
      const t = setInterval(() => {
        if (/hook bridge listening on/.test(hostOut) && /listening on ws:/.test(hostOut)) { clearInterval(t); resolve(); }
        else if (/EADDRINUSE|ReferenceError|TypeError|SyntaxError/.test(hostOut)) { clearInterval(t); reject(new Error('host failed:\n' + hostOut)); }
      }, 100);
      setTimeout(() => { clearInterval(t); reject(new Error('host did not listen within 20s:\n' + hostOut)); }, 20000);
    });

    const mainFile = path.join(tmp, 'probe-main.js');
    fs.writeFileSync(mainFile, mainSource(port, mainHelper, pipe));
    const electron = spawnElectron(require('electron'), [mainFile], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_TOKEN', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_SESSION_ID', 'CLAUDE_CUSTOM_HELPER'] });
    hygiene.registerChild(electron);
    electron.stdout.on('data', d => process.stdout.write(d));
    // Only the page's own lines: the main-process IPC noise (no handler for chrome:getSettings ...) is the bare probe main's.
    electron.stderr.on('data', d => { if (/probe|\[page\]|SyntaxError|TypeError|ReferenceError/.test(String(d))) process.stderr.write(d); });
    const killer = setTimeout(() => {
      console.log('FAIL: probe timed out after 240s');
      try { require('../host/kill-tree').killPidTree(electron.pid); } catch { /* the sweep below still runs */ }   // kill-ok(held-handle): our own child
      hygiene._emergencyCleanup('timeout');
    }, 240000);
    const code = await new Promise((resolve) => electron.on('exit', resolve));
    clearTimeout(killer);
    check('the window probe passed', code === 0, `exit ${code}`);
    if (code !== 0) console.log('---- host log (tail) ----\n' + hostOut.split('\n').slice(-25).join('\n'));
  } finally {
    hygiene._emergencyCleanup('done');
    cleanup();
  }
}

run().then(() => {
  console.log(failures ? `\nprobe-agent-cards: ${failures} FAILED` : '\nprobe-agent-cards: every check held');
  process.exit(failures ? 1 : 0);
}).catch((err) => {
  console.log('FAIL: probe could not run:', err && err.stack || err);
  process.exit(1);
});
