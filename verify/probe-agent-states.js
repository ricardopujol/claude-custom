'use strict';
/**
 * The finer card states (BACKLOG #55), measured. Two parts.
 *
 * A. THE SIGNALS (free, no window, no billed call). For each state, is the signal the CLI really sends?
 *    - the installed CLI's own hook-input schema: the base object has `agent_id` ("present only when the hook fires
 *      from within a subagent") and the Notification input is that base plus notification_type, so a prompt raised
 *      inside a subagent can name it; the types that wait on a person all exist;
 *    - the hooks this harness registers cover the tools: Bash both ways, Read/Grep/Glob/Edit/Write/NotebookEdit
 *      PreToolUse only (so reading and writing last a short while, not "until done");
 *    - the REAL recorded session (test/hooks-real-subagent-failure.fixture.jsonl) replayed through the machine:
 *      what detail each agent showed, step by step.
 *
 * B. THE LOOK (--window; heavy: take heavy-lock.ps1 first). A real host and a real window: hook events sent through
 *    the real native helper into the real hook bridge, one agent per state, then the DOM and a screenshot per state.
 *    `claude` is replaced by cmd.exe (CLAUDE_CUSTOM_BIN) so nothing is billed. Everything it writes goes to temp
 *    folders and to .harness/shots-agent-states/.
 *
 *   node verify/probe-agent-states.js               (part A)
 *   node verify/probe-agent-states.js --window      (parts A and B)
 */
const { spawn, spawnSync } = require('child_process');
const { spawnElectron, noteChild } = require('./lib/launch-electron');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WINDOW = process.argv.includes('--window');
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

// ---- A. the signals ----------------------------------------------------------------------------------------------

function partA() {
  console.log('-- A. the signals');
  const { execFileSync } = require('child_process');
  let bundle = null;
  try {
    const base = path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim(), '@anthropic-ai', 'claude-code');
    for (const rel of ['bin/claude.exe', 'bin/claude', 'cli.js']) {
      const p = path.join(base, rel);
      if (fs.existsSync(p)) { bundle = p; break; }
    }
  } catch { /* reported below */ }
  check('found the installed Claude Code bundle', Boolean(bundle), bundle || 'npm root -g has no @anthropic-ai/claude-code');
  if (bundle) {
    const text = fs.readFileSync(bundle).toString('latin1');
    // indexOf only: a regex over a 250 MB string takes minutes.
    const at = text.indexOf('agent_id:o().optional().describe("Subagent identifier. Present only when the hook fires from within a subagent');
    check('the base hook input carries an optional agent_id (present only inside a subagent)', at !== -1);
    const n = text.indexOf('hook_event_name:C("Notification"),message:o(),title:o().optional(),notification_type:o()');
    check('the Notification input schema is the base plus notification_type', n !== -1);
    // The schema only says agent_id MAY be there; what matters is whether the call site that builds the input passes the tool-use
    // context ($d(session, mode, ..., toolUseContext) sets agent_id from it). Read the builders, not the schema (PR #154 round 2, N1).
    const argsBefore = (marker) => {
      const at = text.indexOf(marker);
      if (at === -1) return null;
      const m = /\.\.\.[\w$]+\(([^()]*(?:\([^()]*\)[^()]*)*)\),\s*$/.exec(text.slice(Math.max(0, at - 160), at));
      return m ? m[1].split(',').length : null;
    };
    const notifyArgs = argsBefore('hook_event_name:"Notification",message:');
    check('a Notification is built WITHOUT the tool-use context (two arguments), so it never names an agent', notifyArgs === 2, 'arguments: ' + notifyArgs);
    const permArgs = argsBefore('hook_event_name:"PermissionRequest",tool_name:');
    check('a PermissionRequest is built WITH the tool-use context, so it names the agent', permArgs !== null && permArgs >= 4, 'arguments: ' + permArgs);
    check('the CLI decides a PermissionRequest only from a hook result (permissionRequestResult), never from a silent hook', text.includes('permissionRequestResult'));
    for (const t of ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'idle_prompt']) {
      check(`the CLI knows the notification type ${t}`, text.includes(`"${t}"`));
    }
  }

  const { buildHarnessSettings } = require('../host/settings-writer');
  const hooks = buildHarnessSettings({ helperPath: 'h.exe', pipeName: 'p', occupancy: true }).hooks;
  const matcherCovers = (list, tool) => list.some(e => new RegExp(`^(?:${e.matcher})$`).test(tool));
  check('Bash: PreToolUse and PostToolUse are hooked (running starts and ends)',
    matcherCovers(hooks.PreToolUse, 'Bash') && matcherCovers(hooks.PostToolUse, 'Bash') && matcherCovers(hooks.PostToolUseFailure, 'Bash'));
  for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit']) {
    check(`${tool}: PreToolUse is hooked, PostToolUse is not (a short-lived state)`,
      matcherCovers(hooks.PreToolUse, tool) && !matcherCovers(hooks.PostToolUse, tool));
  }
  check('Notification is hooked', Array.isArray(hooks.Notification));
  const withPerm = buildHarnessSettings({ helperPath: 'h.exe', pipeName: 'p', permissionRequest: true }).hooks;
  check('PermissionRequest is hooked, every tool, short timeout', Boolean(withPerm.PermissionRequest) && withPerm.PermissionRequest[0].matcher === '' && withPerm.PermissionRequest[0].hooks[0].timeout <= 2);
  const helperSrc = fs.readFileSync(path.join(ROOT, 'helper', 'hook-helper.cs'), 'utf8');
  check('the helper prints nothing and only exits 0 (observe-only: output is how a hook decides)', !/Console\.(Out|Write)/.test(helperSrc) && [...helperSrc.matchAll(/return\s+(-?\d+)\s*;/g)].every(m => m[1] === '0'));

  const { createMoodMachine } = require('../host/mood-machine');
  const stream = fs.readFileSync(path.join(ROOT, 'test', 'hooks-real-subagent-failure.fixture.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  let t = 1_000_000;
  const m = createMoodMachine({ now: () => t });
  const seen = [];
  m.on('change', c => seen.push(`${c.agent}:${c.state}/${c.detail}`));
  const tools = {};
  for (const e of stream) {
    const p = e.payload || {};
    if (p.tool_name) tools[p.tool_name] = (tools[p.tool_name] || 0) + 1;
    t += 50;
    m.handle(e);
  }
  console.log(`   real recorded session: ${stream.length} events, tools ${JSON.stringify(tools)}`);
  console.log(`   details it showed: ${seen.join('  ->  ')}`);
  check('the real recording shows a Bash in flight as running', seen.some(s => s.endsWith('/running')));
  check('and ends with no finer state lingering', m.roster().every(r => r.detail === r.state), JSON.stringify(m.roster()));
}

// ---- B. the look -------------------------------------------------------------------------------------------------

const STATES = ['working', 'reading', 'writing', 'running', 'waiting', 'stuck', 'helper'];
const SHOTS = path.join(ROOT, '.harness', 'shots-agent-states');

const mainSource = (port) => `
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const { probeWindowOptions } = require(path.join(ROOT, 'host', 'probe-window'));
app.setPath('userData', ${JSON.stringify(path.join(os.tmpdir(), 'cc-agent-states-userdata-' + process.pid))});
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log('[check]', ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const STATES = ${JSON.stringify(STATES)};
const SHOTS = ${JSON.stringify(SHOTS)};

app.whenReady().then(async () => {
  const win = new BrowserWindow(probeWindowOptions({ width: 1000, height: 800, show: true, webPreferences: {
    contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'app', 'preload.js') } }));
  win.loadFile(path.join(ROOT, 'app', 'renderer.html'), { query: {
    port: ${JSON.stringify(port)}, cwd: ${JSON.stringify(ROOT)}, project: 'probe', token: 'probe-token' } });
  win.webContents.on('console-message', (_e, level, message, line, src) => { if (level >= 2) console.log('[page]', message, src + ':' + line); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await js(code); if (v) return v; } catch (e) { /* page not ready */ } await sleep(150); }
    return null;
  };
  const shot = async (name, clip) => {
    await win.webContents.capturePage(clip); await sleep(300);   // the first capture after a layout change is the frame BEFORE it
    const img = await win.webContents.capturePage(clip);
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), img.toPNG());
    console.log('[shot]', path.join(SHOTS, name + '.png'));
  };
  const read = (agent) => js('(() => { const c = document.querySelector("#agents .agent[data-agent=\\'' + agent + '\\']"); if (!c) return null;' +
    ' const b = c.querySelector(".state-badge"); const s = c.querySelector(".state"); const r = c.getBoundingClientRect(); const f = c.querySelector(".face").getBoundingClientRect();' +
    ' return { state: c.dataset.state, detail: c.dataset.detail, words: s && s.textContent, wordsColour: s && getComputedStyle(s).color,' +
    ' badge: b ? b.textContent : null, badgeAnim: b ? getComputedStyle(b).animationName : null, badgeRect: b ? (() => { const x = b.getBoundingClientRect(); return { l: x.left, t: x.top, w: x.width, h: x.height }; })() : null,' +
    ' face: { l: f.left, t: f.top, w: f.width, h: f.height }, rect: { l: r.left, t: r.top, w: r.width, h: r.height } }; })()');

  try {
    check('the renderer and the host are up', await until('typeof renderRoster === "function" && ws && ws.readyState === 1'));
    check('agentStateDisplay is the one global the file adds', await js('typeof agentStateDisplay === "object" && typeof agentStateDisplay.describeState === "function"'));
    await js('setRosterTab("active")');
    check('every state has a card (the harness fed real hook events)', await until('document.querySelectorAll("#agents .agent[data-agent^=\\'probe-\\']").length === ' + STATES.length, 40000));
    await sleep(800);
    // Reading and writing last 5 s from their PreToolUse: ask the harness for them only now, then read at once.
    console.log('[need] file-tools');
    check('reading and writing cards show their state', await until(
      '(() => { const g = n => document.querySelector("#agents .agent[data-agent=\\'" + n + "\\']"); return g("probe-reading") && g("probe-reading").dataset.detail === "reading" && g("probe-writing").dataset.detail === "writing"; })()', 10000));
    const want = { working: ['', 'working'], reading: ['\\u{1F4D6}', 'Reading'], writing: ['\\u270F\\uFE0F', 'Writing'], running: ['\\u25B6\\uFE0F', 'Running'],
      waiting: ['\\u270B', 'Waiting on you'], stuck: ['\\u26A0\\uFE0F', 'Stuck'], helper: ['\\u23F3', 'Waiting on helper'] };
    const rows = {};
    for (const s of STATES) rows[s] = await read('probe-' + s);
    for (const s of STATES) {
      const r = rows[s];
      check(s + ': the card exists with data-detail=' + s + (s === 'stuck' ? ' (data-state stressed)' : ''), r && r.detail === s && r.state === (s === 'stuck' ? 'stressed' : 'working'), r && { state: r.state, detail: r.detail });
      if (!r) continue;
      if (s === 'working') { check('working: no badge, today\\'s look', r.badge === null); continue; }
      check(s + ': corner badge ' + want[s][0], r.badge === want[s][0], r.badge);
      check(s + ': words under the name', r.words && r.words.toLowerCase() === want[s][1].toLowerCase(), r.words);
      const b = r.badgeRect, f = r.face;
      check(s + ': the badge sits on the portrait\\'s lower-right corner', b && Math.abs((b.l + b.w) - (f.l + f.w)) <= 8 && Math.abs((b.t + b.h) - (f.t + f.h)) <= 8, { b, f });
    }
    check('words differ in colour: waiting is not stuck is not working', new Set([rows.waiting.wordsColour, rows.stuck.wordsColour, rows.working.wordsColour]).size === 3,
      [rows.waiting.wordsColour, rows.stuck.wordsColour, rows.working.wordsColour]);
    check('waiting pulses', rows.waiting.badgeAnim === 'badge-pulse', rows.waiting.badgeAnim);
    check('no other badge pulses', STATES.filter(s => s !== 'waiting' && rows[s].badge).every(s => rows[s].badgeAnim === 'none'));

    // Photographs. The roster scrolls and a window of this size cannot show eight cards, so nothing here scrolls: a
    // <style> (which survives the roster's repaints) hides every card but the one being photographed, and the overview
    // zooms the roster out until all of them fit.
    const only = (s) => js('(() => { let st = document.getElementById("probe-only"); if (!st) { st = document.createElement("style"); st.id = "probe-only"; document.head.appendChild(st); } st.textContent = ' +
      JSON.stringify(s ? '#agents .agent:not([data-agent="probe-' + s + '"]) { display: none !important; }' : '') + '; })()');
    await js('document.getElementById("agents").style.zoom = "0.5"');
    await sleep(700);
    await shot('roster-all-states', await js('(() => { const r = document.getElementById("agents").getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.left) - 4), y: Math.floor(r.top), width: Math.ceil(r.width) + 4, height: Math.max(1, Math.min(Math.ceil(r.height), Math.floor(window.innerHeight - r.top) - 2)) }; })()'));
    await js('document.getElementById("agents").style.zoom = ""');
    for (const s of STATES) {
      await only(s);
      await sleep(600);
      const r = await read('probe-' + s);
      if (r) await shot('state-' + s, { x: Math.max(0, Math.floor(r.rect.l)), y: Math.max(0, Math.floor(r.rect.t)), width: Math.ceil(r.rect.w), height: Math.ceil(r.rect.h) });
    }
    await only(null);

    // prefers-reduced-motion: no pulse.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(300);
    const reduced = await read('probe-waiting');
    check('prefers-reduced-motion: the waiting badge does not pulse', reduced && reduced.badgeAnim === 'none', reduced && reduced.badgeAnim);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    win.webContents.debugger.detach();

    // the linger ends: reading and writing go back to plain working with no further event.
    check('reading and writing fall back to working once their moment passes', await until(
      '(() => { const g = n => document.querySelector("#agents .agent[data-agent=\\'" + n + "\\']"); return g("probe-reading") && g("probe-reading").dataset.detail === "working" && g("probe-writing").dataset.detail === "working"; })()', 15000));
    const after = await read('probe-reading');
    check('and their badge is gone', after && after.badge === null, after && after.badge);
    check('the waiting, stuck, helper and running cards keep theirs (signals still hold)',
      (await read('probe-waiting')).detail === 'waiting' && (await read('probe-stuck')).detail === 'stuck'
      && (await read('probe-helper')).detail === 'helper' && (await read('probe-running')).detail === 'running');
  } catch (err) {
    check('probe ran to completion', false, String(err && err.stack || err));
  }
  console.log('[result]', JSON.stringify({ failed: results.filter(r => !r.ok).length, total: results.length }));
  app.exit(results.every(r => r.ok) ? 0 : 1);
});
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function partB() {
  console.log('-- B. the look (real host, real helper, real window)');
  const helper = process.env.CLAUDE_CUSTOM_HELPER || path.join(ROOT, '.harness', 'hook-helper.exe');
  const mainHelper = fs.existsSync(helper) ? helper : path.join(ROOT, '..', 'dev', '.harness', 'hook-helper.exe');
  if (!fs.existsSync(mainHelper)) { check('the native hook helper exists', false, mainHelper); return; }

  const hygiene = createHygieneRegistry();
  hygiene.install();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-states-'));
  const port = String(await freePort());
  const sessionId = 'agentstates' + process.pid;
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
  noteChild(host);   // the lock's work record covers a host / claude this probe started by hand (BACKLOG #112)
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

    // A real hook event, through the real native helper, into the real bridge.
    const send = (event, payload) => {
      const r = spawnSync(mainHelper, ['--pipe', pipe, '--event', event], { input: JSON.stringify(payload), windowsHide: true });
      if (r.status !== 0) throw new Error(`helper exited ${r.status} for ${event}`);
    };
    let n = 0;
    const idOf = (s) => `aprobe-${s}-${String(1000 + STATES.indexOf(s)).padStart(16, '0')}`;
    const by = (s) => ({ agent_id: idOf(s), agent_type: 'probe-' + s });
    const spawnAgent = (s, parent) => send('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_' + (++n),
      tool_input: { subagent_type: 'probe-' + s }, ...(parent ? by(parent) : {}) });
    const bash = (s, command) => send('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), tool_input: { command }, ...by(s) });
    for (const s of STATES) spawnAgent(s);
    // every agent speaks once, so the host knows its id
    for (const s of STATES) send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), tool_input: { command: 'hi-' + s }, tool_response: { exit_code: 0 }, ...by(s) });

    // stuck: the same call three times
    for (let i = 0; i < 3; i++) send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu' + (++n), tool_input: { command: 'again' }, tool_response: { exit_code: 0 }, ...by('stuck') });
    // helper: a foreground child it launched
    send('PreToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_' + (++n), tool_input: { subagent_type: 'kid-of-helper' }, ...by('helper') });
    // running: a Bash with no result yet
    bash('running', 'npm test');
    // waiting: a permission prompt that names the agent
    send('PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: { file_path: 'C:/x/y.js' }, permission_suggestions: [], ...by('waiting') });
    // reading / writing last a few seconds, so they are sent when the window asks, not before it has started
    const fileTools = () => {
      send('PreToolUse', { tool_name: 'Read', tool_use_id: 'tu' + (++n), tool_input: { file_path: 'C:/x/y.js' }, ...by('reading') });
      send('PreToolUse', { tool_name: 'Edit', tool_use_id: 'tu' + (++n), tool_input: { file_path: 'C:/x/y.js', old_string: 'a', new_string: 'b' }, ...by('writing') });
    };
    let sentFileTools = false;
    const mainFile = path.join(tmp, 'probe-main.js');
    fs.writeFileSync(mainFile, mainSource(port));
    const electron = spawnElectron(require('electron'), [mainFile], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_TOKEN', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_SESSION_ID', 'CLAUDE_CUSTOM_HELPER'] });
    hygiene.registerChild(electron);
    electron.stdout.on('data', d => {
      process.stdout.write(d);
      if (!sentFileTools && /\[need\] file-tools/.test(String(d))) { sentFileTools = true; fileTools(); }
    });
    electron.stderr.on('data', d => { if (/probe|Error/.test(String(d))) process.stderr.write(d); });
    const killer = setTimeout(() => { console.log('FAIL: probe timed out after 120s'); hygiene._emergencyCleanup('timeout'); }, 120000);
    const code = await new Promise((resolve) => electron.on('exit', resolve));
    clearTimeout(killer);
    check('the window probe passed', code === 0, `exit ${code}`);
    if (code !== 0) console.log('---- host log (tail) ----\n' + hostOut.split('\n').slice(-25).join('\n'));
  } finally {
    hygiene._emergencyCleanup('done');
    cleanup();
  }
}

(async () => {
  partA();
  if (WINDOW) await partB();
  console.log(failures ? `\nprobe-agent-states: ${failures} FAILED` : '\nprobe-agent-states: every check held');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.log('FAIL: probe could not run:', err && err.stack || err);
  process.exit(1);
});
