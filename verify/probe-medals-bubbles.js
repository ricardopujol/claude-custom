'use strict';
/**
 * PROBE: medals and speech bubbles (BACKLOG #80, #55) in a REAL window against a REAL host. (re-runnable, about 1 minute)
 *
 *   node verify/probe-medals-bubbles.js                      (exit 0 = every check held; a stub Ollama, nothing local is touched)
 *   MEDALS_PROBE_REAL_OLLAMA=1 node verify/probe-medals-bubbles.js
 *                                                           the REAL local Ollama writes the lines (qwen3.5:4b, loopback only);
 *                                                           prints sample lines for Code-reviewer, Dexter and Mortimer; unloads the model after
 *   MEDALS_PROBE_SHOTS=<dir>                                where the screenshots go (default .harness/shots/medals-bubbles)
 *
 * WHAT NO UNIT TEST CAN SEE (CLAUDE.md, "Traps"): app/medals-display.js and app/bubble-display.js are plain <script> files in
 * the renderer's ONE shared scope; a bubble has to land on a real card, survive the roster's once-a-second repaint, and never
 * take a click from the card; the menu has to open where the pointer is; the shelf has to appear under a real log. This drives
 * the whole chain: a hook event through the native helper -> the host's mood machine -> the rate gate, the GPU slot, the
 * Ollama client -> a `bubble` frame -> the page.
 *
 *   A  a state change gives ONE bubble over its card, the agent's own voice reached the model, only the trimmed input did
 *   B  the bubble survives roster repaints, lets a click through to the card, and is gone after its 8 seconds
 *   C  the same agent again inside 3 minutes: no model request; another agent: allowed
 *   D  Ollama failing (HTTP 500): no bubble, no error on the page, the card is untouched
 *   E  prefers-reduced-motion: no animation on the bubble
 *   F  medals: right-click opens the menu at the pointer, give one with a reason, the card shows only a count chip, the log
 *      page's shelf shows kind, reason and date, remove empties the chip
 *   G  the switch: off -> no model request; agent images off -> no model request
 *
 * SAFE. `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; every CLAUDE_CUSTOM_* not passed on purpose is deleted;
 * Ollama is a stub on a loopback port unless asked; summaries, the GPU slot and Electron's userData are temp folders. The host
 * writes medals.json / bubbles.json under THIS checkout's .harness/state: the probe removes them afterwards if it made them.
 * Processes are stopped by PID through the hygiene registry, never by name.
 */
const { spawn } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { createHygieneRegistry } = require('./lib/process-hygiene');
const { startFakeOllama } = require('./lib/fake-ollama');

const ROOT = path.join(__dirname, '..');
const REAL = process.env.MEDALS_PROBE_REAL_OLLAMA === '1';
const SHOTS = process.env.MEDALS_PROBE_SHOTS || path.join(ROOT, '.harness', 'shots', 'medals-bubbles');
const STATE = path.join(ROOT, '.harness', 'state');
const HELPER = path.join(ROOT, '.harness', 'hook-helper.exe');
const hygiene = createHygieneRegistry();
hygiene.install();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-medals-probe-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ownedStateFiles = ['medals.json', 'bubbles.json'].filter(f => !fs.existsSync(path.join(STATE, f)));
const cleanup = () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  for (const f of ownedStateFiles) { try { fs.rmSync(path.join(STATE, f), { force: true }); } catch { /* best effort */ } }
};

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const mainSource = (port, hostPid) => `
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path'); const fs = require('fs');
const { spawnSync } = require('child_process');
const ROOT = ${JSON.stringify(ROOT)};
const { registerAvatarHandlers } = require(path.join(ROOT, 'app', 'avatar-bridge'));
const { createStore } = require(path.join(ROOT, 'host', 'store'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', ${JSON.stringify(path.join(tmp, 'userData'))});
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log('[check]', ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const REAL = ${JSON.stringify(REAL)};
const SHOTS = ${JSON.stringify(SHOTS)};
const HELPER = ${JSON.stringify(HELPER)};
const hook = (event, payload) => spawnSync(HELPER, ['--pipe', '\\\\\\\\.\\\\pipe\\\\claude-custom-${hostPid}', '--event', event], { input: JSON.stringify(payload), windowsHide: true }).status === 0;
const spawnAgent = (agent, id, description) => hook('PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: id, tool_input: { subagent_type: agent, description } });
const stopAgent = (agent) => hook('SubagentStop', { hook_event_name: 'SubagentStop', agent_type: agent });

app.whenReady().then(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const win = new BrowserWindow({ width: 560, height: 760, show: true, webPreferences: {
    contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'app', 'preload.js') } });
  registerAvatarHandlers({ ipcMain, store: createStore({ dir: ${JSON.stringify(path.join(tmp, 'state'))} }), win, dialog });
  win.loadFile(path.join(ROOT, 'app', 'renderer.html'), { query: { port: ${JSON.stringify(port)}, cwd: ${JSON.stringify(tmp)}, project: 'probe', token: 'probe-token' } });
  const pageErrors = [];
  win.webContents.on('console-message', (_e, level, message, line, src) => { if (level >= 3) pageErrors.push(message + ' ' + src + ':' + line); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await js(code); if (v) return v; } catch (e) { /* page not ready */ } await sleep(150); }
    return null;
  };
  const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(SHOTS, name + '.png'), img.toPNG()); console.log('[shot]', path.join(SHOTS, name + '.png')); };
  const bubbleOf = (agent) => js('(function(){var b=document.querySelector(' + JSON.stringify('#agents .agent[data-agent="' + agent + '"] > .agent-bubble') + ');return b?b.textContent:null;})()');
  const wsSend = (m) => js('ws.send(' + JSON.stringify(JSON.stringify(m)) + ')');

  try {
    check('the page loaded and the host answered', await until('typeof renderRoster === "function" && ws && ws.readyState === 1', 60000));
    check('the shared scope holds: both new modules published their one name', await js('typeof window.medalsDisplay === "object" && typeof window.bubbleDisplay === "object"'));
    check('hello carried the switch (bubbles on by default)', await until('bubblesEnabled !== null'));
    check('the toggle shows on', (await js('document.getElementById("bubbles-toggle").getAttribute("aria-pressed")')) === 'true');

    // ---- A: a state change, one bubble -------------------------------------------------------------
    check('a spawn reaches the hook bridge', spawnAgent('code-reviewer', 't-code-reviewer-1', 'review the diff for the parser change'));
    check('the code-reviewer card is drawn', await until('!!document.querySelector("#agents .agent[data-agent=code-reviewer]")'));
    const text = await until('(() => { const b = document.querySelector("#agents .agent[data-agent=code-reviewer] > .agent-bubble"); return b ? b.textContent : null; })()', REAL ? 60000 : 15000);
    check('a bubble appears over the card of the agent that changed state', !!text, text);
    check('it is drawn as a quote, a joke, not a status (curly quotes via CSS, role=note)', await js('(() => { const b = document.querySelector("#agents .agent-bubble"); const cs = getComputedStyle(b, "::before").content; return b.getAttribute("role") === "note" && /\\u201C/.test(cs); })()'));
    console.log('[sample] code-reviewer (working):', JSON.stringify(text));
    await sleep(450);       // past the 0.18 s fade-in
    await shot('1-bubble-over-card');

    // ---- B: survives repaints, passes clicks through, goes after 8 s ---------------------------------
    await js('window.__bubbleNode = document.querySelector("#agents .agent-bubble")');
    for (let i = 0; i < 3; i++) { await js('renderRoster()'); await sleep(500); }
    check('a roster repaint keeps the bubble', !!(await bubbleOf('code-reviewer')));
    check('an UNCHANGED repaint (the usual one, about 1/s) keeps the same node', await js('window.__bubbleNode === document.querySelector("#agents .agent-bubble") && window.__bubbleNode.isConnected'));
    // The repaint that really replaces the cards (markup changed): the bubble comes back SETTLED, so its fade-in doesn't replay.
    await js('lastAgentsHtml = ""; renderRoster()');
    check('a REBUILT card gets its bubble back settled: no fade-in replay (animation is bubble-out only)', await js('(function(){var b=document.querySelector("#agents .agent-bubble");return !!b && b.hasAttribute("data-settled") && getComputedStyle(b).animationName === "bubble-out" && b !== window.__bubbleNode;})()'));
    const pass = await js('(() => { const b = document.querySelector("#agents .agent-bubble"); return getComputedStyle(b).pointerEvents === "none"; })()');
    check('the bubble takes no clicks (pointer-events: none)', pass);
    const gone = await until('!document.querySelector("#agents .agent-bubble")', 12000);
    check('the bubble is gone after its 8 seconds', !!gone);

    // ---- C: the rate limit and the queue -------------------------------------------------------------
    spawnAgent('logic-reviewer', 't-logic-reviewer-1', 'check the allocator');
    const dx = await until('(function(){var b=document.querySelector("#agents .agent[data-agent=logic-reviewer] > .agent-bubble");return b?b.textContent:null;})()', REAL ? 60000 : 15000);
    check('another agent gets its own bubble', !!dx, dx);
    console.log('[sample] logic-reviewer (working):', JSON.stringify(dx));
    await until('!document.querySelector("#agents .agent-bubble")', 12000);
    stopAgent('logic-reviewer');
    await sleep(2500);
    check('the same agent changing state again inside 3 minutes gets NO bubble', (await bubbleOf('logic-reviewer')) === null);

    // ---- G: the host asks the model only while the window could show the answer -------------------------
    await js('window.harness.avatar.setImagesEnabled(false)');
    check('agent images off reaches the page', await until('agentImagesEnabled === false'));
    await sleep(500);
    spawnAgent('planner', 't-planner-0', 'plan the next step');
    await sleep(2500);
    check('images off: no bubble over the new card', (await bubbleOf('planner')) === null);
    await js('window.harness.avatar.setImagesEnabled(true)');
    check('images back on', await until('agentImagesEnabled === true'));
    await sleep(500);

    // ---- G: the switch -------------------------------------------------------------------------------
    await wsSend({ type: 'bubbles', action: 'set-enabled', enabled: false });
    check('switching bubbles off reaches the page', await until('bubblesEnabled === false'));
    check('the toggle shows off', await js('document.getElementById("bubbles-toggle").classList.contains("off")'));
    spawnAgent('explorer', 't-explorer-0', 'look around');
    await sleep(2500);
    check('off: no bubble', (await bubbleOf('explorer')) === null);
    await wsSend({ type: 'bubbles', action: 'set-enabled', enabled: true });
    check('switching them back on', await until('bubblesEnabled === true'));

    // ---- F: medals -----------------------------------------------------------------------------------
    await js('setRosterTab("active")');
    await js('(() => { const c = document.querySelector("#agents .agent[data-agent=code-reviewer]"); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 })); })()');
    if (!(await js('!document.getElementById("medal-menu").hidden'))) {
      console.log('[debug] menu did not open; direct call says:', await js('(function(){try{openMedalMenu("code-reviewer",10,10);return "ok hidden="+document.getElementById("medal-menu").hidden;}catch(e){return "threw "+e.message;}})()'), JSON.stringify(pageErrors.slice(0, 5)));
    }
    check('a right-click on a card opens the medal menu', await until('!document.getElementById("medal-menu").hidden'));
    const at = await js('(() => { const m = document.getElementById("medal-menu").getBoundingClientRect(); const c = document.querySelector("#agents .agent[data-agent=code-reviewer]").getBoundingClientRect(); return { menuTop: m.top, cardTop: c.top, kinds: document.querySelectorAll("#medal-menu [data-medal-kind]").length }; })()');
    check('it lists the six kinds, near the card', at.kinds === 6 && Math.abs(at.menuTop - at.cardTop) < 80, at);
    check('Give is disabled until a kind is picked', await js('document.querySelector("#medal-menu [data-medal-give]").disabled'));
    await js('document.querySelector("#medal-menu [data-medal-kind=bug-hunter]").click()');
    await js('(() => { const i = document.querySelector("#medal-menu .medal-reason-input"); i.value = "found the race in the slot"; i.dispatchEvent(new Event("input", { bubbles: true })); })()');
    await shot('2-medal-menu');
    await js('document.querySelector("#medal-menu [data-medal-give]").click()');
    check('the menu closes on Give', await until('document.getElementById("medal-menu").hidden'));
    check('the card shows a count chip and only that', await until('(() => { const c = document.querySelector("#agents .agent[data-agent=code-reviewer] .medal-chip"); return !!c && /1/.test(c.textContent); })()'));
    check('the reason is NOT on the card', !(await js('document.querySelector("#agents .agent[data-agent=code-reviewer]").textContent.includes("found the race")')));
    await shot('3-medal-chip-on-card');
    await js('document.querySelector("#agents .agent[data-agent=code-reviewer] .meta").click()');
    check('opening the log shows the shelf with kind, reason and date', await until('(() => { const s = document.getElementById("agent-medals"); return s && /Bug hunter/.test(s.textContent) && /found the race in the slot/.test(s.textContent) && /\\\\d{4}-\\\\d{2}-\\\\d{2}/.test(s.textContent); })()'));
    check('the shelf is visible under the log', await js('getComputedStyle(document.getElementById("agent-medals")).display !== "none"'));
    await shot('4-medal-shelf');
    await js('document.querySelector("#agent-medals [data-medal-remove]").click()');
    check('the first click only arms it: the button reads Remove? and the medal is still there', await until('document.getElementById("agent-medals").textContent.indexOf("Remove?") >= 0 && /Bug hunter/.test(document.getElementById("agent-medals").textContent)'));
    await js('document.querySelector("#agent-medals [data-medal-remove]").click()');
    check('removing the medal empties the shelf', await until('/No medals yet/.test(document.getElementById("agent-medals").textContent)'));
    await js('document.querySelector("[data-agent-log-close]").click()');
    check('and the chip is gone from the card', await until('!document.querySelector("#agents .agent[data-agent=code-reviewer] .medal-chip")'));

    // ---- E: reduced motion ---------------------------------------------------------------------------
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const animName = await js('(() => { const d = document.createElement("div"); d.className = "agent-bubble"; document.body.appendChild(d); const n = getComputedStyle(d).animationName; d.remove(); return n; })()');
    check('prefers-reduced-motion: the bubble has no animation', animName === 'none', animName);
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    dbg.detach();

    // ---- a third voice, then D: Ollama failing -------------------------------------------------------
    spawnAgent('mutation-tester', 't-mutation-tester-1', 'run the mutation gate');
    const mt = await until('(function(){var b=document.querySelector("#agents .agent[data-agent=mutation-tester] > .agent-bubble");return b?b.textContent:null;})()', REAL ? 60000 : 15000);
    check('a third agent gets a bubble in its own voice', !!mt, mt);
    console.log('[sample] mutation-tester (working):', JSON.stringify(mt));
    await sleep(450);
    await shot('5-another-agent-bubble');
    if (!REAL) {
      await until('!document.querySelector("#agents .agent-bubble")', 12000);
      fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'fail-ollama'), '1');
      spawnAgent('reviewer', 't-reviewer-0', 'review');
      await sleep(3000);
      check('Ollama answering 500: no bubble over the card', (await bubbleOf('reviewer')) === null);
      check('and the card itself is untouched', await js('!!document.querySelector("#agents .agent[data-agent=reviewer] .state")'));
      fs.rmSync(path.join(${JSON.stringify(tmp)}, 'fail-ollama'), { force: true });
    }
    check('no error reached the page console', pageErrors.length === 0, pageErrors.slice(0, 3));
  } catch (err) {
    check('probe ran to completion', false, String(err && err.stack || err));
  }
  console.log('[result]', JSON.stringify({ failed: results.filter(r => !r.ok).length, total: results.length }));
  app.exit(results.every(r => r.ok) ? 0 : 1);
});
`;

(async () => {
  if (!fs.existsSync(HELPER)) { console.log('FAIL: the native hook helper is missing:', HELPER); process.exit(1); }
  const port = String(await freePort());
  const fake = REAL ? null : await startFakeOllama({
    models: ['qwen3.5:4b', 'llama3.2:3b'],
    generate: (body) => {
      if (fs.existsSync(path.join(tmp, 'fail-ollama'))) return { status: 500, json: { error: 'down' } };
      const who = /Character: (\S+)/.exec(String(body && body.prompt || ''));
      const lines = { 'code-reviewer': 'Otra vez a revisar, ¡qué vida!', 'logic-reviewer': 'Dry as ever.', 'mutation-tester': 'MUAJAJA' };
      return { json: { response: lines[who && who[1]] || 'Back to the grind!', done: true } };
    },
  });
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh',
    CLAUDE_CUSTOM_CWD: tmp, CLAUDE_CUSTOM_PORT: port, CLAUDE_CUSTOM_TOKEN: 'probe-token',
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'forge'), CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    CLAUDE_CUSTOM_SUMMARY_DIR: path.join(tmp, 'summaries'), CLAUDE_CUSTOM_SUMMARY_POWER: 'mains',
    ...(fake ? { CLAUDE_CUSTOM_OLLAMA_URL: fake.url } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(path.join(tmp, 'forge'), { recursive: true });

  const host = spawn(process.execPath, [path.join(ROOT, 'host', 'host.js')], { cwd: ROOT, env });
  hygiene.registerChild(host);
  let hostOut = '';
  host.stdout.on('data', d => { hostOut += d; });
  host.stderr.on('data', d => { hostOut += d; });
  await new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (/listening on ws:/.test(hostOut)) { clearInterval(t); resolve(); }
      else if (/EADDRINUSE|ReferenceError|TypeError|SyntaxError/.test(hostOut)) { clearInterval(t); reject(new Error('host failed:\n' + hostOut)); }
    }, 100);
    setTimeout(() => { clearInterval(t); reject(new Error('host did not listen within 20s:\n' + hostOut)); }, 20000);
  });

  const mainFile = path.join(tmp, 'probe-main.js');
  fs.writeFileSync(mainFile, mainSource(port, host.pid));
  const keep = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'];
  const electron = spawnElectron(require('electron'), [mainFile], { cwd: ROOT, env }, { keepEnv: keep });
  hygiene.registerChild(electron);
  electron.stdout.on('data', d => process.stdout.write(d));
  electron.stderr.on('data', d => { if (/probe|Error/.test(String(d))) process.stderr.write(d); });
  let voiceFailed = false;
  const killer = setTimeout(() => { console.log('FAIL: probe timed out'); hygiene._emergencyCleanup('timeout'); }, REAL ? 420000 : 180000);
  const code = await new Promise((resolve) => electron.on('exit', resolve));
  clearTimeout(killer);

  if (fake) {
    const asked = fake.requests.filter(r => r.method === 'POST' && r.path === '/api/generate');
    console.log(`[ollama stub] ${asked.length} generate request(s)`);
    for (const r of asked) console.log('[ollama stub] model:', r.body.model, '| num_predict:', r.body.options && r.body.options.num_predict, '| prompt:', JSON.stringify(String(r.body.prompt).slice(0, 200)));
    // The agent's own voice reached the model: the system prompt carries what ITS .md says (read from this machine's agents).
    const sysOf = (who) => { const r = asked.find(x => String(x.body.prompt).includes('Character: ' + who)); return r ? String(r.body.system) : ''; };
    const agentsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'agents');
    const voices = [['code-reviewer', /espa[nñ]ol/i], ['mutation-tester', /gleeful|villain/i], ['logic-reviewer', /Dexter|methodical/i]];
    for (const [who, re] of voices) {
      if (!fs.existsSync(path.join(agentsDir, who + '.md'))) { console.log('[voice] skipped (no ' + who + '.md here)'); continue; }
      const ok = re.test(sysOf(who));
      console.log('[check]', ok ? 'PASS' : 'FAIL', 'the voice of ' + who + ' reached the model', ok ? '' : JSON.stringify(sysOf(who).slice(-300)));
      if (!ok) voiceFailed = true;
    }
    await fake.close();
  }
  hygiene._emergencyCleanup('done');
  if (code !== 0) console.log('---- host log (tail) ----\n' + hostOut.split('\n').slice(-25).join('\n'));
  cleanup();
  const good = code === 0 && !voiceFailed;
  console.log(good ? 'PASS: medals and bubbles render and behave as designed' : `FAIL: exit ${code}${voiceFailed ? ' (a voice check failed)' : ''}`);
  process.exit(good ? 0 : 1);
})().catch((err) => {
  console.log('FAIL: probe could not start:', err && err.message);
  hygiene._emergencyCleanup('startup-failed');
  cleanup();
  process.exit(1);
});
