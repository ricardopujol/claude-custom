'use strict';
/**
 * BACKLOG #10, measured in a REAL Chromium rather than assumed from unit tests.
 *
 * Two things no unit test can see (CLAUDE.md, "Traps"): app/agent-log-display.js
 * loaded as a plain <script> must publish its one global without colliding, and
 * the HTML it produces must become the DOM we mean -- hostile transcript text as
 * TEXT, never as an element.
 *
 * What runs: the REAL host session (host/agent-log-session.js) reads a REAL
 * transcript file laid out the way the CLI lays it out -- including a line still
 * being written -- and the frames it emits are fed to the REAL display module in
 * an Electron window. It never starts `claude` and never touches ~/.claude.
 *
 *   node verify/probe-agent-log.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogSession } = require('../host/agent-log-session');
const { projectDirName } = require('../host/project-dir');

const CWD = 'C:/probe/agent-log';
const HOSTILE = '"><img src=x onerror="document.title=\'pwned\'">';
const T = '2026-09-29T12:00:00.000Z';
const line = o => JSON.stringify(o) + '\n';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-alog-'));
  const sub = path.join(tmp, 'projects', projectDirName(CWD), 'sess1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, 'agent-live1.jsonl');
  fs.writeFileSync(path.join(sub, 'agent-live1.meta.json'), JSON.stringify({ agentType: 'probe-agent' }));
  const half = line({ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text: 'the second message' }] } });
  fs.writeFileSync(file,
    line({ type: 'user', timestamp: T, message: { content: 'do the thing' } }) +
    line({ type: 'attachment', attachment: { type: 'environment' } }) +
    line({ type: 'assistant', timestamp: T, message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: HOSTILE } }] } }) +
    line({ type: 'user', timestamp: T, message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'exit 1', is_error: true }] } }) +
    half.slice(0, 25));

  const frames = [];
  const session = createLogSession({
    cwd: CWD, projectsDir: path.join(tmp, 'projects'),
    invocations: () => [{ name: 'probe-agent', agentId: 'live1' }],
    send: f => frames.push(f),
    setIntervalFn: () => ({}), clearIntervalFn: () => {},
  });
  await session.open('probe-agent');
  const afterFirst = frames.length;
  fs.appendFileSync(file, half.slice(25));
  await session.poll();
  session.close();

  const page = path.join(tmp, 'page.html');
  const displayJs = path.join(__dirname, '..', 'app', 'agent-log-display.js');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>alog</title>
<div id="agent-log"></div>
<script src="file:///${displayJs.replace(/\\/g, '/')}"></script>`);
  fs.writeFileSync(path.join(tmp, 'main.js'), `
const { app, BrowserWindow } = require('electron');
const frames = ${JSON.stringify(frames)};
app.on('ready', async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(${JSON.stringify(page)});
  const out = await win.webContents.executeJavaScript(\`(() => {
    const d = window.agentLogDisplay;
    const r = { published: typeof d, leaks: ['emptyLog','openLog','applyFrame','renderAgentLog'].filter(k => typeof window[k] !== 'undefined') };
    if (!d) return r;
    let m = d.openLog('probe-agent');
    const snap = [];
    for (const f of \${JSON.stringify(frames)}) {
      m = d.applyFrame(m, f);
      document.getElementById('agent-log').innerHTML = d.renderAgentLog(m);
      snap.push(document.querySelectorAll('.alog-entry').length);
    }
    r.entriesAfterEachFrame = snap;
    r.imgElements = document.querySelectorAll('img').length;
    r.titleTouched = document.title !== 'alog';
    r.firstCommandText = (document.querySelector('.alog-tool_use .alog-sum') || {}).textContent;
    r.errorRows = document.querySelectorAll('.alog-error').length;
    r.dimmedUnknown = document.querySelectorAll('.alog-unknown').length;
    r.status = (document.querySelector('.alog-status') || {}).textContent;
    r.notes = [...document.querySelectorAll('.alog-note')].map(n => n.textContent);
    r.summaries = [...document.querySelectorAll('.alog-entry .alog-sum')].map(n => n.textContent);
    return r;
  })()\`);
  console.log('RESULT ' + JSON.stringify(out));
  app.quit();
});
`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;      // CLAUDE.md: inherited from Claude Code, turns Electron into plain Node
  const child = spawn(require('electron'), [path.join(tmp, 'main.js')], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, env });
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  const kill = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 20000);
  await new Promise(resolve => child.on('exit', resolve));
  clearTimeout(kill);
  fs.rmSync(tmp, { recursive: true, force: true });

  const m = /RESULT (.*)/.exec(stdout);
  console.log('host frames        :', frames.length, `(${afterFirst} before the partial line was completed)`);
  if (!m) { console.log('NO RESULT from the window:\n' + stdout); process.exit(1); }
  const r = JSON.parse(m[1]);
  console.log('window result      :', JSON.stringify(r, null, 2));
  const ok = r.published === 'object' && r.leaks.length === 0 && r.imgElements === 0 && !r.titleTouched
    && r.firstCommandText === HOSTILE && r.errorRows === 1 && r.dimmedUnknown === 1
    && r.summaries[r.summaries.length - 1] === 'the second message';
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
