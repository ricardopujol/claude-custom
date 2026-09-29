'use strict';
/* The tool belt in a REAL window (BACKLOG #17).

     node verify/probe-loadout.js

   Why this exists. Every renderer script shares ONE global scope; a top-level
   name declared twice aborts the second file, and the panel it draws silently
   never renders. No unit test can see that -- each test require()s a module
   into its own scope (CLAUDE.md, "Traps"). test/renderer-scope.test.js catches
   the collision in a vm; only a real Chromium proves the belt actually draws,
   the buttons actually click, and the host's answer actually comes back.

   What it does, all through the real paths:
     1. starts a real host (node host/host.js) and a real Electron window
        attached to it, with Chromium's remote-debugging port open;
     2. fires a real PreToolUse(Agent) into the host's hook bridge so an agent
        card exists;
     3. drives the WINDOW over CDP: clicks the card's `belt` button, checks the
        picker and its "applies to the next run" / "current run isn't affected"
        copy, clicks Pace: haiku (renderer -> websocket -> host -> store ->
        broadcast -> renderer), then clicks Pace: opus, which the host must
        refuse, and checks the refusal is on screen and STAYS there across a
        re-render (PR #64 N1: an echo must not wipe it);
     4. reads .harness/state/loadout.json and feeds the real host/loadout-hook.js
        the payload of a spawn, to close the loop: what the window wrote is what
        the hook applies;
     5. writes a screenshot (CDP Page.captureScreenshot of a NORMAL window --
        offscreen: true hangs capture on this machine).

   ELECTRON_RUN_AS_NODE is deleted before spawning Electron (Claude Code is an
   Electron app and the variable is inherited; without this the child starts as
   plain Node with errors that name anything but the cause).

   Cost: no model prompt is ever sent. The host starts the CLI in a pty, as it
   always does, and this probe types nothing into it. It writes
   .harness/state/loadout.json and removes it at the end.

   Prints PASS / FAIL per claim; SKIP with the reason when Electron or the host
   cannot start. Exit code is the number of FAILs. */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { killPidTree } = require('../host/kill-tree');

const REPO = path.join(__dirname, '..');
const PORT = Number(process.env.PROBE_PORT) || 7793;
const CDP = Number(process.env.PROBE_CDP) || 9337;
const AGENT = 'code-reviewer';
const STATE_DIR = path.join(REPO, '.harness', 'state');
const LOADOUT_FILE = path.join(STATE_DIR, 'loadout.json');
const SHOT = process.env.OUT || path.join(REPO, '.harness', 'loadout-belt.png');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures++;
};

// --- CDP ---------------------------------------------------------------------
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function connectCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await getJson(`http://127.0.0.1:${CDP}/json`);
      const page = targets.find(t => t.type === 'page' && /renderer\.html/.test(t.url));
      if (page) return openCdp(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return null;
}

function openCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const problems = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      // What the page itself complained about: an uncaught exception, or console.error.
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        problems.push(`${(d.exception && d.exception.description) || d.text} (${String(d.url || '').split('/').pop()}:${d.lineNumber})`);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        problems.push('console.error: ' + m.params.args.map(a => a.value || a.description).join(' '));
      }
    });
    // A CDP call that never answers (captureScreenshot on a hidden window does
    // exactly that) must not hang the probe: it resolves to an error after 20 s.
    const send = (method, params = {}) => new Promise((res) => {
      const n = ++id;
      const timer = setTimeout(() => { pending.delete(n); res({ error: { message: `${method} timed out` } }); }, 20000);
      pending.set(n, (m) => { clearTimeout(timer); res(m); });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    ws.on('open', () => resolve({
      send,
      problems,
      close: () => ws.close(),
      // Evaluate in the page and hand back the value.
      async eval(expression) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception));
        return r.result && r.result.result ? r.result.result.value : undefined;
      },
    }));
    ws.on('error', reject);
  });
}

async function waitFor(cdp, expression, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await cdp.eval(expression); if (v) return v; } catch { /* page still loading */ }
    await sleep(250);
  }
  return null;
}

// A real hook event into the host's real bridge: newline JSON over the pipe.
function fireHook(pipe, event, payload) {
  return new Promise((resolve) => {
    const sock = net.connect(pipe, () => { sock.end(JSON.stringify({ event, payload }) + '\n'); });
    sock.on('close', resolve);
    sock.on('error', resolve);
  });
}

async function main() {
  let electronExe;
  try { electronExe = require('electron'); } catch { console.log('SKIP: the electron package is not installed'); return -1; }
  if (typeof electronExe !== 'string') { console.log('SKIP: require("electron") did not give an executable path'); return -1; }

  try { fs.unlinkSync(LOADOUT_FILE); } catch { /* nothing to remove */ }
  try { fs.unlinkSync(SHOT); } catch { /* nothing to remove */ }

  const env = { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT), CLAUDE_CUSTOM_CWD: REPO };
  delete env.ELECTRON_RUN_AS_NODE;     // inherited from any Claude Code session; would start Electron as plain Node

  const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let hostLog = '';
  host.stdout.on('data', d => { hostLog += d; });
  host.stderr.on('data', d => { hostLog += d; });

  let app = null;
  let cdp = null;
  const cleanup = async () => {
    try { if (cdp) cdp.close(); } catch { /* already gone */ }
    if (app && app.pid) { try { killPidTree(app.pid); } catch { /* best effort */ } }
    if (host.pid) { try { killPidTree(host.pid); } catch { /* best effort */ } }
    try { fs.unlinkSync(LOADOUT_FILE); } catch { /* nothing to remove */ }
  };

  try {
    let pipe = null;
    for (let i = 0; i < 40 && !pipe; i++) {
      await sleep(500);
      pipe = (hostLog.match(/hook bridge listening on (\S+)/) || [])[1];
    }
    if (!pipe) { console.log(`SKIP: the host did not come up -- the hook bridge only starts when .harness/hook-helper.exe exists (build it from helper/) (${hostLog.trim().slice(-200)})`); return -1; }
    console.log(`host up on :${PORT}, bridge ${pipe}`);

    app = spawn(electronExe, [REPO, `--remote-debugging-port=${CDP}`], {
      env: { ...env, CLAUDE_CUSTOM_SIDE_TAB: 'agents' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let appLog = '';
    app.stdout.on('data', d => { appLog += d; });
    app.stderr.on('data', d => { appLog += d; });

    cdp = await connectCdp();
    if (!cdp) { console.log(`SKIP: no renderer page appeared over CDP (${appLog.trim().slice(-300)})`); return -1; }

    await cdp.send('Runtime.enable');     // replays anything the page already threw
    // The plain-script scope trap: if loadout-display.js were aborted by a
    // name collision, this is 'undefined' and every claim below fails.
    const scope = await waitFor(cdp, "typeof window.loadoutDisplay === 'object' && typeof loadoutDisplay.view === 'function'");
    check('loadout-display.js loaded in the shared plain-script scope', !!scope);

    await fireHook(pipe, 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Agent',
      tool_input: { subagent_type: AGENT, prompt: 'Review the diff', description: 'probe' } });
    const card = await waitFor(cdp, `!!document.querySelector('.agent[data-agent="${AGENT}"]')`);
    check('an agent card exists for the hooked spawn', !!card);
    if (!card) {
      console.log('      #agents:', JSON.stringify(await cdp.eval("(document.getElementById('agents')||{}).innerHTML")).slice(0, 300));
      console.log('      page problems:', cdp.problems.slice(0, 5).join(' | ') || 'none');
      console.log('      host log:', hostLog.split('\n').filter(l => /hook|PreToolUse|bridge/.test(l)).slice(-5).join(' | '));
      return failures;
    }

    const hasButton = await cdp.eval(`!!document.querySelector('.agent[data-agent="${AGENT}"] button[data-loadout-toggle="${AGENT}"]')`);
    check('the card has a belt <button>', hasButton);

    // --- open the picker ---------------------------------------------------------
    await cdp.eval(`document.querySelector('button[data-loadout-toggle="${AGENT}"]').click()`);
    const note = await waitFor(cdp, `(document.querySelector('.agent[data-agent="${AGENT}"] .belt-note')||{}).textContent`, 5000);
    check('the picker opens and says it applies to the next run', /next run/i.test(note || ''), JSON.stringify(note));
    check('the agent is running right now, so it says the current run isn\'t affected',
      /current run isn't affected/.test(note || ''), JSON.stringify(note));
    const rows = await cdp.eval(`document.querySelectorAll('.agent[data-agent="${AGENT}"] button[data-loadout-act]').length`);
    check('the picker lists all six items as buttons', rows === 6, `rows=${rows}`);

    // --- equip through the real control path ------------------------------------------
    await cdp.eval(`document.querySelector('button[data-loadout-item="pace-haiku"][data-loadout-agent="${AGENT}"]').click()`);
    const strip = await waitFor(cdp,
      `((document.querySelector('.agent[data-agent="${AGENT}"] .belt-strip')||{}).textContent||'').includes('Pace: haiku')`, 8000);
    check('equip: the host answered and the strip shows Pace: haiku', !!strip);
    let onDisk = null;
    try { onDisk = JSON.parse(fs.readFileSync(LOADOUT_FILE, 'utf8')); } catch { /* checked below */ }
    check('equip: the host wrote .harness/state/loadout.json',
      !!onDisk && JSON.stringify(onDisk.agents[AGENT]) === JSON.stringify(['pace-haiku']), JSON.stringify(onDisk));

    // --- a conflicting equip is refused, visibly, and stays visible ------------------------
    const before = fs.readFileSync(LOADOUT_FILE, 'utf8');
    await cdp.eval(`document.querySelector('button[data-loadout-item="pace-opus"][data-loadout-agent="${AGENT}"]').click()`);
    const err = await waitFor(cdp, `(document.querySelector('.agent[data-agent="${AGENT}"] .belt-error')||{}).textContent`, 8000);
    check('refusal: the host\'s reason is on screen', /model/.test(err || ''), JSON.stringify(err));
    check('refusal: the file is untouched', fs.readFileSync(LOADOUT_FILE, 'utf8') === before);
    // A re-render (any mood message) and a settle must not wipe it (PR #64 N1).
    await fireHook(pipe, 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Agent',
      tool_input: { subagent_type: 'logic-reviewer', prompt: 'x', description: 'second card' } });
    await sleep(1500);
    const still = await cdp.eval(`(document.querySelector('.agent[data-agent="${AGENT}"] .belt-error')||{}).textContent`);
    check('refusal: still visible after a re-render and 1.5 s', still === err && !!still, JSON.stringify(still));

    // --- close the loop with the real hook -------------------------------------------------
    const hookOut = spawnSync(process.execPath, [path.join(REPO, 'host', 'loadout-hook.js'), '--state', STATE_DIR], {
      input: JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: AGENT, prompt: 'Review the diff', description: 'x' } }),
      encoding: 'utf8', windowsHide: true,
    });
    let updated = null;
    try { updated = JSON.parse(hookOut.stdout).hookSpecificOutput.updatedInput; } catch { /* checked below */ }
    check('the real hook applies what the window wrote', !!updated && updated.model === 'haiku', hookOut.stdout.slice(0, 200));

    // --- unequip ------------------------------------------------------------------------------
    await cdp.eval(`document.querySelector('button[data-loadout-item="pace-haiku"][data-loadout-agent="${AGENT}"]').click()`);
    const gone = await waitFor(cdp, `!document.querySelector('.agent[data-agent="${AGENT}"] .belt-strip')`, 8000);
    check('unequip: the strip is gone', !!gone);

    // --- photograph it: equip once more so the picture shows a belt -----------------------------------
    await cdp.eval(`document.querySelector('button[data-loadout-item="review-twice"][data-loadout-agent="${AGENT}"]').click()`);
    await waitFor(cdp, `((document.querySelector('.agent[data-agent="${AGENT}"] .belt-strip')||{}).textContent||'').includes('review twice')`, 8000);
    await cdp.eval(`document.querySelector('button[data-loadout-item="pace-opus"][data-loadout-agent="${AGENT}"]').click()`);
    await sleep(800);
    // The window can be reported hidden (document.visibilityState) when another
    // window covers it or it has not been shown; a hidden page never paints, so
    // ask for it to come forward first.
    await cdp.send('Page.bringToFront');
    await cdp.eval("(document.querySelector('.belt-picker')||document.body).scrollIntoView({ block: 'nearest' })");
    await sleep(500);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot.error) console.log('      screenshot:', shot.error.message, '(visibility:', await cdp.eval('document.visibilityState'), ')');
    if (shot.result && shot.result.data) {
      fs.writeFileSync(SHOT + '.tmp', Buffer.from(shot.result.data, 'base64'));
      fs.renameSync(SHOT + '.tmp', SHOT);
    }
    check('a screenshot of the real window exists', fs.existsSync(SHOT) && fs.statSync(SHOT).size > 5000,
      fs.existsSync(SHOT) ? `${SHOT} (${fs.statSync(SHOT).size} bytes)` : 'missing');

    check('the renderer reported no errors', cdp.problems.length === 0, cdp.problems.slice(0, 3).join(' | '));
  } finally {
    await cleanup();
  }
  return failures;
}

if (require.main === module) {
  main().then((n) => {
    console.log(n < 0 ? '\nskipped' : n ? `\n${n} FAILED` : '\nall passed');
    process.exit(n > 0 ? n : 0);
  })
    .catch((err) => { console.error('probe failed:', err && err.stack); process.exit(1); });
}

module.exports = { fireHook };
