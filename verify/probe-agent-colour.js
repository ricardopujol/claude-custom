'use strict';
/* Backlog #65: the agent cards' "working" state is the one agent blue, never the user's accent.  (re-runnable)

     node verify/probe-agent-colour.js        (exit 0 = every check held; PORT=<n> optional)

   A REAL window, because the colour is shared across two documents (the tab page and the tab
   strip each link app/agent-colour.css) and no unit test can see a stylesheet link resolve.
   The project is given an unusual accent (#00ff88) the way the Style tab writes one (look.json).
   Then, over the Chromium debugging port:

     - both documents compute --agent to #6aa5d8
     - a working agent card's face ring and state label compute to rgb(106, 165, 216), not the accent

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
const PORT = Number(process.env.PORT) || 7726;
const CDP = PORT + 1000;
const ACCENT = '#00ff88';
const AGENT = '#6aa5d8';
const AGENT_RGB = 'rgb(106, 165, 216)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-agent-colour-'));
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

    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      try { ready = (await evalIn(view, "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")) === ACCENT; } catch { /* page still loading */ }
      if (!ready) await sleep(500);
    }
    check('the odd accent reached the tab page (--accent)', ready);
    if (!ready) return;

    const token = "getComputedStyle(document.documentElement).getPropertyValue('--agent').trim().toLowerCase()";
    check('the tab page reads --agent from the shared stylesheet', (await evalIn(view, token)) === AGENT);
    check('the tab strip reads --agent from the shared stylesheet', (await evalIn(strip, token)) === AGENT);

    // A working card, built the way the roster builds one (class + data-state, a face, a state label).
    const c = await evalIn(view, `(() => {
      const card = document.createElement('div');
      card.className = 'agent'; card.setAttribute('data-state', 'working');
      card.innerHTML = '<div class="face"></div><div class="state">working</div>';
      document.body.appendChild(card);
      const ring = getComputedStyle(card.querySelector('.face')).boxShadow;
      const label = getComputedStyle(card.querySelector('.state')).color;
      card.remove();
      return { ring, label };
    })()`);
    check('a working card\'s face ring is the agent blue, not the accent', String(c.ring).includes(AGENT_RGB), c.ring);
    check('a working card\'s state label is the agent blue, not the accent', c.label === AGENT_RGB, c.label);

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
