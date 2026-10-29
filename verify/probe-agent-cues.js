'use strict';
/**
 * The agent cues (BACKLOG #155, #156, #78), measured in a real window. Heavy: take heavy-lock.ps1 first
 * (`node scripts/with-heavy-lock.js node verify/probe-agent-cues.js`). About 2.5 minutes: it waits past 90 s of real time.
 *
 * A real host and a real window, `claude` replaced by cmd.exe (CLAUDE_CUSTOM_BIN) so nothing is billed. Hook events go through the
 * real native helper into the real hook bridge. The window's `attention` and `tab:status` messages to main are recorded by the
 * probe's own main process (what the real main would turn into a toast and a strip badge).
 *
 *   A. a backgrounded Bash keeps a card "waiting" (hourglass, "waiting…", "on: ...", minutes) past 90 s, awake, not red yet
 *   B. a held cross-session message (the CLI's own Notification text) badges the tab (messages: 1), knocks once (two oscillators,
 *      220 then 196 Hz) and raises ONE toast that waits to be clicked; while the tab is looked at it knocks and badges nothing
 *   C. a finished turn (Stop) raises no toast
 *
 *   node verify/probe-agent-cues.js
 */
const { spawn, spawnSync } = require('child_process');
const { spawnElectron, noteChild } = require('./lib/launch-electron');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HELD = 'A message from another session needs your approval';
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const mainSource = (port) => `
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const { probeWindowOptions } = require(path.join(ROOT, 'host', 'probe-window'));
app.setPath('userData', ${JSON.stringify(path.join(os.tmpdir(), 'cc-agent-cues-userdata-' + process.pid))});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const attention = [];
const statuses = [];
ipcMain.on('attention', (_e, s) => { attention.push(s); console.log('[attention]', JSON.stringify(s)); });
ipcMain.on('tab:status', (_e, s) => statuses.push(s));
const results = [];
const check = (name, ok, detail) => { results.push(!!ok); console.log('[check]', ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };

app.whenReady().then(async () => {
  const win = new BrowserWindow(probeWindowOptions({ width: 1000, height: 800, show: true, webPreferences: {
    contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'app', 'preload.js'), autoplayPolicy: 'no-user-gesture-required' } }));
  win.loadFile(path.join(ROOT, 'app', 'renderer.html'), { query: { port: ${JSON.stringify(port)}, cwd: ${JSON.stringify(ROOT)}, project: 'probe', token: 'probe-token' } });
  win.webContents.on('console-message', (_e, level, message, line, src) => { if (level >= 2) console.log('[page]', message, src + ':' + line); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await js(code); if (v) return v; } catch (e) { /* page not ready */ } await sleep(200); }
    return null;
  };
  const card = (agent) => js('(() => { const c = document.querySelector("#agents .agent[data-agent=\\'' + agent + '\\']"); if (!c) return null;' +
    ' const b = c.querySelector(".state-badge"); const s = c.querySelector(".state"); const n = c.querySelector(".wait-note");' +
    ' return { state: c.dataset.state, detail: c.dataset.detail, words: s && s.textContent.trim(), badge: b ? b.textContent : null,' +
    ' note: n ? n.textContent : null, late: n ? n.dataset.late : null, noteColour: n ? getComputedStyle(n).color : null }; })()');

  try {
    check('the renderer and the host are up', await until('typeof renderRoster === "function" && ws && ws.readyState === 1'));
    check('peerCue is the one global the new file adds', await js('typeof peerCue === "object" && typeof peerCue.scanHeldMessage === "function"'));
    await js('setRosterTab("active")');

    // ---- A. waiting on a background task
    const launchedAt = Date.now();
    console.log('[need] background-task');
    check('the card turns "waiting" once its backgrounded task has been quiet a while', await until('(() => { const c = document.querySelector("#agents .agent[data-agent=\\'probe-bg\\']"); return c && c.dataset.detail === "bgwait"; })()', 70000));
    const first = await card('probe-bg');
    check('hourglass, "waiting…", base state still working', first && first.badge === '\\u231B' && first.words === 'waiting…' && first.state === 'working', first);
    check('it says what it waits on, with minutes, and is not red', first && /^on: Run the unit tests · (<1|\\d+) min$/.test(first.note) && first.late === 'false', first);
    await sleep(Math.max(0, 100000 - (Date.now() - launchedAt)));
    const late = await card('probe-bg');
    check('past 90 s it is still there, still waiting, still awake', late && late.detail === 'bgwait' && late.state === 'working', late);
    check('and the minutes are counted', late && /· \\d+ min$|· <1 min$/.test(late.note || ''), late && late.note);
    console.log('[need] stop');
    await sleep(1500);

    // ---- B. a held cross-session message
    await js('window.__osc = []; (function () { const P = window.AudioContext.prototype; const orig = P.createOscillator; P.createOscillator = function () { const o = orig.call(this); window.__osc.push(o); return o; }; })()');
    await js('document.hasFocus = () => false');          // the tab is not being looked at
    const before = attention.length;
    console.log('[need] held-message');
    check('one toast is raised for it', await (async () => { const end = Date.now() + 8000; while (Date.now() < end) { if (attention.length > before) return true; await sleep(200); } return false; })());
    await sleep(800);
    const raised = attention.slice(before);
    check('exactly one attention message reached main', raised.length === 1, raised.length);
    const t = raised[0] && raised[0].toast;
    check('it is a toast that waits to be clicked, naming the message', t && t.requireInteraction === true && t.silent === false && /message/i.test(t.title + ' ' + t.body), t);
    check('and the taskbar flashes', raised[0] && raised[0].flashTaskbar === true);
    const last = statuses[statuses.length - 1];
    check('the tab status carries messages: 1 (the strip draws the envelope from it)', last && last.messages === 1, last && last.messages);
    const osc = await js('window.__osc.map(o => o.frequency.value)');
    check('the knock played once: two notes, 220 then 196 Hz', JSON.stringify(osc) === '[220,196]', osc);
    check('and the body says the page is not muted', await js('peerCue.readMuted(localStorage) === false'));

    // while looking at the tab: no knock, no new badge
    await js('document.hasFocus = () => true');
    console.log('[need] held-message-again');
    await sleep(7000);
    const osc2 = await js('window.__osc.length');
    const last2 = statuses[statuses.length - 1];
    check('looking at the tab: no second knock and the count stays 1', osc2 === 2 && last2.messages === 1, { osc: osc2, messages: last2.messages });
    check('and no toast for what you are looking at', attention.slice(before + 1).every(s => s.toast === null), attention.slice(before + 1));

    // ---- C. a finished turn
    await js('document.hasFocus = () => false');
    const beforeStop = attention.length;
    console.log('[need] finish');
    await sleep(6000);
    const done = attention.slice(beforeStop);
    check('a finished turn reached the window as a cue', done.some(s => s.badge === 'done'), done);
    check('and raised no toast', done.length > 0 && done.every(s => s.toast === null), done);
  } catch (err) {
    check('probe ran to completion', false, String(err && err.stack || err));
  }
  console.log('[result]', JSON.stringify({ failed: results.filter(r => !r).length }));
  app.exit(0);
});
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

(async () => {
  const helper = process.env.CLAUDE_CUSTOM_HELPER || path.join(ROOT, '.harness', 'hook-helper.exe');
  const mainHelper = fs.existsSync(helper) ? helper : path.join(ROOT, '..', 'dev', '.harness', 'hook-helper.exe');
  if (!fs.existsSync(mainHelper)) { check('the native hook helper exists', false, mainHelper); process.exit(1); }

  const hygiene = createHygieneRegistry();
  hygiene.install();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-cues-'));
  const port = String(await freePort());
  const sessionId = 'agentcues' + process.pid;
  const pipe = `claude-custom-${sessionId}`;
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh',
    CLAUDE_CUSTOM_CWD: tmp, CLAUDE_CUSTOM_PORT: port, CLAUDE_CUSTOM_TOKEN: 'probe-token',
    CLAUDE_CUSTOM_SESSION_ID: sessionId, CLAUDE_CUSTOM_HELPER: mainHelper,
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'forge'), CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_') && !(k in { CLAUDE_CUSTOM_BIN: 1, CLAUDE_CUSTOM_CWD: 1, CLAUDE_CUSTOM_PORT: 1, CLAUDE_CUSTOM_TOKEN: 1, CLAUDE_CUSTOM_SESSION_ID: 1, CLAUDE_CUSTOM_HELPER: 1, CLAUDE_CUSTOM_PORTRAITS: 1, CLAUDE_CUSTOM_UPLOADS: 1 })) delete env[k];

  const host = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { cwd: ROOT, env });
  noteChild(host);
  hygiene.registerChild(host);
  let hostOut = '';
  host.stdout.on('data', d => { hostOut += d; });
  host.stderr.on('data', d => { hostOut += d; });
  try {
    await new Promise((resolve, reject) => {
      const t = setInterval(() => {
        if (/hook bridge listening on/.test(hostOut) && /listening on ws:/.test(hostOut)) { clearInterval(t); resolve(); }
        else if (/EADDRINUSE|ReferenceError|TypeError|SyntaxError/.test(hostOut)) { clearInterval(t); reject(new Error('host failed:\n' + hostOut)); }
      }, 100);
      setTimeout(() => { clearInterval(t); reject(new Error('host did not listen within 20s:\n' + hostOut)); }, 20000);
    });

    const send = (event, payload) => {
      const r = spawnSync(mainHelper, ['--pipe', pipe, '--event', event], { input: JSON.stringify(payload), windowsHide: true });
      if (r.status !== 0) throw new Error(`helper exited ${r.status} for ${event}`);
    };
    let n = 0;
    const id = 'aprobe-bg-0000000000001000';
    const by = { agent_id: id, agent_type: 'probe-bg' };

    // the window asks, line by line, for the next step (so the host and the page are up first)
    const steps = {
      'background-task': () => {
        send('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_' + (++n), tool_input: { subagent_type: 'probe-bg' } });
        send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), tool_input: { command: 'hi' }, tool_response: { exit_code: 0 }, ...by });
        send('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), tool_input: { command: 'npm test', description: 'Run the unit tests', run_in_background: true }, ...by });
      },
      stop: () => { send('Stop', {}); },
      'held-message': () => { send('Notification', { notification_type: 'permission_prompt', message: HELD }); },
      'held-message-again': () => { send('Notification', { notification_type: 'permission_prompt', message: HELD }); },
      finish: () => { send('Stop', {}); },
    };
    const mainFile = path.join(tmp, 'probe-main.js');
    fs.writeFileSync(mainFile, mainSource(port));
    const electron = spawnElectron(require('electron'), [mainFile], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_TOKEN', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_SESSION_ID', 'CLAUDE_CUSTOM_HELPER'] });
    hygiene.registerChild(electron);
    let passed = 0; let failed = 0;
    electron.stdout.on('data', d => {
      const text = String(d);
      process.stdout.write(d);
      passed += (text.match(/\[check\] PASS/g) || []).length;
      failed += (text.match(/\[check\] FAIL/g) || []).length;
      for (const m of text.matchAll(/\[need\] ([a-z-]+)/g)) {
        const step = steps[m[1]];
        if (step) { try { step(); } catch (e) { console.log('FAIL: step ' + m[1] + ' -> ' + e.message); failures++; } }
      }
    });
    electron.stderr.on('data', d => { if (/probe|Error/.test(String(d))) process.stderr.write(d); });
    const killer = setTimeout(() => { console.log('FAIL: probe timed out after 300s'); hygiene._emergencyCleanup('timeout'); }, 300000);
    const code = await new Promise((resolve) => electron.on('exit', resolve));
    clearTimeout(killer);
    check('the window probe ran every check', passed > 0, { passed, failed });
    check('and none failed', failed === 0 && code === 0, `exit ${code}`);
    if (failed || code !== 0) console.log('---- host log (tail) ----\n' + hostOut.split('\n').slice(-25).join('\n'));
  } finally {
    hygiene._emergencyCleanup('done');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(failures ? `\nprobe-agent-cues: ${failures} FAILED` : '\nprobe-agent-cues: every check held');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.log('FAIL: probe could not run:', err && err.stack || err);
  process.exit(1);
});
