'use strict';
/* Backlog #66: the indexing field in a REAL window.  (re-runnable)

     node verify/probe-indexing-strip.js        (exit 0 = every check held; PORT=<n> optional)
     INDEXING_PROBE_SHOTS=<dir>                 keep the screenshots there (default: a temp folder, printed)

   Unit tests can't see the shared-global-scope trap (CLAUDE.md), a view stacked over another, or the keyboard moving
   between two documents, so this drives the real thing over the Chromium debugging port:

     1  the strip page has the field, the chip names the project, the counter says "0 filed", and both scripts
        loaded (indexingDisplay and tabStrip are both defined: neither aborted the other)
     2  a note typed into the field and Enter: the field clears, the note is journaled, and (propose mode, the shipped
        mode) the toast view appears over the tab view asking where it goes, with the best guess named
     3  "File it" writes exactly one new backlog item with the note verbatim; the counter says "1 filed"
     4  Undo puts the backlog back byte for byte
     5  the field keeps the keyboard across publishes; Esc hands it back; Ctrl+Alt+N in the tab view takes it again
     6  the list opens from the counter, shows the note, and closes again

   Safe: the host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing billable runs; Ollama is a fake one in this
   process (verify/lib/fake-ollama.js), so the real model and its slot are untouched; the journal, the slot folder and
   the project docs are temp files (CLAUDE_CUSTOM_INDEXING_JOURNAL, CLAUDE_CUSTOM_SUMMARY_DIR, a temp project). The real
   documentation is never touched. ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* variable are removed from the
   children's environment first. Only the two processes started here are killed, by their own pid. */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { startFakeOllama } = require('./lib/fake-ollama');

const REPO = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 7740 + Math.floor(Math.random() * 50);
const CDP = PORT + 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-indexing-'));
const project = path.join(tmp, 'probeproj');
const docs = path.join(project, 'documentation');
fs.mkdirSync(docs, { recursive: true });
const BACKLOG = path.join(docs, 'PROBE_BACKLOG.md');
const BACKLOG_TEXT = '# probe — Backlog\n\n## 1. The wand runs skills\nbody\n\n## 2. A resource panel\nmore\n';
fs.writeFileSync(path.join(docs, 'PROBE_BUILD_LOG.md'), '# log\n');
fs.writeFileSync(BACKLOG, BACKLOG_TEXT);
fs.writeFileSync(path.join(docs, 'PROBE_HISTORY.md'), '# history\n');
const JOURNAL = path.join(tmp, 'state', 'indexing-notes.jsonl');
const shots = process.env.INDEXING_PROBE_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'cc-indexing-shots-'));
fs.mkdirSync(shots, { recursive: true });

const children = [];
const killTree = (c) => {
  if (!c || !c.pid) return;
  try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
};
let fake = null;
const cleanup = async () => {
  children.forEach(killTree);
  if (fake) await fake.close();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
};

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('no answer from the debugging port')));
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
      // Every call is bounded: a page that stops painting answers some calls (a screenshot) never.
      send: (method, params = {}) => new Promise((res) => {
        const n = ++id;
        const t = setTimeout(() => { waiting.delete(n); res({ error: { message: `${method}: no answer in 10 s` } }); }, 10_000);
        waiting.set(n, (m) => { clearTimeout(t); res(m); });
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
const pages = async () => (await getJson(`http://127.0.0.1:${CDP}/json`)).filter((t) => t.type === 'page');
async function waitFor(fn, ms = 15000, step = 250) {
  const until = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}
async function shoot(page, name) {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  if (r.result && r.result.data) fs.writeFileSync(path.join(shots, name), Buffer.from(r.result.data, 'base64'));
}
// Main's probe driver (app/tab-shell.js handleProbeCommand): a key sent to the selected view through sendInputEvent,
// which is what goes through before-input-event. A key typed over CDP doesn't (measured: the shortcut never fired).
const DRIVER = PORT + 2000;
const DRIVER_TOKEN = require('crypto').randomBytes(16).toString('hex');
function command(cmd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const sock = require('net').connect({ host: '127.0.0.1', port: DRIVER });
    let buf = '';
    const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done({ ok: false, error: `no reply to ${cmd.cmd}` }), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ ...cmd, token: DRIVER_TOKEN }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done({ ok: false, error: 'unparseable reply' }); } }
    });
    sock.on('error', (e) => done({ ok: false, error: e.message }));
  });
}
const key = (page, type, k, code, vk, mods = 0) =>
  page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanup().then(() => process.exit(130)); });
}

(async () => {
  try {
    fake = await startFakeOllama({
      generate: (body) => {
        const p = body && typeof body.prompt === 'string' ? body.prompt : '';
        if (p.includes('Which describes it best?')) return { json: { response: '{"answer": "A"}' } };
        if (p.includes('Write a short title')) return { json: { response: '{"title": "Tabs glow when a session needs me"}' } };
        return { json: { response: 'Working on: the probe\nWhere it stands: running\nNext: done' } };
      },
    });

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_')) delete env[k];
    Object.assign(env, {
      CLAUDE_CUSTOM_PORT: String(PORT),
      CLAUDE_CUSTOM_CWD: project,
      CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
      CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
      CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
      CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
      CLAUDE_CUSTOM_OLLAMA_URL: fake.url,
      CLAUDE_CUSTOM_SUMMARY_DIR: path.join(tmp, 'summaries'),
      CLAUDE_CUSTOM_SUMMARY_POWER: 'mains',
      CLAUDE_CUSTOM_INDEXING_JOURNAL: JOURNAL,
    });
    const electronEnv = { ...env, CLAUDE_CUSTOM_TABS_PROBE: String(DRIVER), CLAUDE_CUSTOM_TABS_PROBE_TOKEN: DRIVER_TOKEN };

    const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(host);
    let hostLog = '';
    host.stdout.on('data', (d) => { hostLog += d; });
    host.stderr.on('data', (d) => { hostLog += d; });
    if (!(await waitFor(() => /listening/i.test(hostLog), 15000))) { check('the host started', false, hostLog.slice(-400)); return; }

    const electron = spawn(path.join(REPO, 'node_modules', '.bin', 'electron.cmd'), ['.', `--remote-debugging-port=${CDP}`], {
      cwd: REPO, env: electronEnv, stdio: 'ignore', shell: true,
    });
    children.push(electron);
    const both = await waitFor(async () => {
      const t = await pages();
      const s = t.find((x) => /tab-strip\.html/.test(x.url));
      const v = t.find((x) => /renderer\.html/.test(x.url));
      return s && v ? { s, v } : null;
    }, 40000, 500);
    check('the window is alive: strip and tab view came up', !!both);
    if (!both) return;
    const strip = await cdpClient(both.s.webSocketDebuggerUrl);
    const view = await cdpClient(both.v.webSocketDebuggerUrl);

    // 1 -------------------------------------------------------------------------------------------------------------
    const s1 = await waitFor(() => evalIn(strip, `(() => {
      const chip = document.getElementById('index-chip');
      return chip && chip.textContent !== '…' ? {
        field: !!document.getElementById('index-note'), chip: chip.textContent,
        count: document.getElementById('index-count').textContent,
        scripts: typeof window.indexingDisplay === 'object' && typeof window.tabStrip === 'object',
      } : null; })()`), 45000);
    check('1 the field is in the strip', !!(s1 && s1.field));
    check('1 the chip names the project', !!s1 && s1.chip === 'probeproj', s1 && s1.chip);
    check('1 the counter says 0 filed', !!s1 && s1.count === '0 filed', s1 && s1.count);
    check('1 both strip scripts loaded (no shared-scope abort)', !!s1 && s1.scripts === true);
    await shoot(strip, '1-strip.png');

    // 2 -------------------------------------------------------------------------------------------------------------
    const NOTE = 'tabs should glow when a session needs me';
    await evalIn(strip, "document.getElementById('index-note').focus()");
    await strip.send('Input.insertText', { text: NOTE });
    await key(strip, 'keyDown', 'Enter', 'Enter', 13);
    await key(strip, 'keyUp', 'Enter', 'Enter', 13);
    const cleared = await waitFor(() => evalIn(strip, "document.getElementById('index-note').value === ''"));
    check('2 Enter clears the field', !!cleared);
    const journaled = await waitFor(() => fs.existsSync(JOURNAL) && fs.readFileSync(JOURNAL, 'utf8').includes(NOTE));
    check('2 the note is journaled first, verbatim', !!journaled);
    const toastT = await waitFor(async () => (await pages()).find((x) => /indexing-overlay\.html\?part=toast/.test(x.url)));
    check('2 the toast view exists', !!toastT);
    if (!toastT) return;
    const toast = await cdpClient(toastT.webSocketDebuggerUrl);
    const asking = await waitFor(() => evalIn(toast, `(() => { const t = document.querySelector('.toast'); return t && t.dataset.kind === 'asking'
      ? { line: t.querySelector('.t1').textContent, w: innerWidth, h: innerHeight } : null; })()`), 45000);
    check('2 propose mode: the toast asks where it goes', !!asking, asking && asking.line);
    check('2 ...with the best guess named (a new item)', !!asking && /Best guess: New backlog item/.test(asking.line), asking && asking.line);
    // Main sizes the view from the page's report, one round trip after the page draws: wait for it to settle.
    const sized = await waitFor(() => evalIn(toast, '(innerWidth === 420 && innerHeight > 40 && innerHeight < 300) ? `${innerWidth}x${innerHeight}` : null'), 10000);
    check('2 the toast view is sized to the toast (bottom right, 420 wide)', !!sized,
      sized || (await evalIn(toast, '`${innerWidth}x${innerHeight}`').catch(() => '?')));
    check('2 nothing written yet', fs.readFileSync(BACKLOG, 'utf8') === BACKLOG_TEXT);
    await shoot(toast, '2-toast-asking.png');

    // 3 -------------------------------------------------------------------------------------------------------------
    await evalIn(toast, "[...document.querySelectorAll('button')].find(b => /File it/.test(b.textContent)).click()");
    const filed = await waitFor(() => evalIn(toast, `(() => { const t = document.querySelector('.toast');
      return t && t.dataset.kind === 'filed' ? t.querySelector('.t1').textContent : null; })()`));
    check('3 File it files it, and the toast says where', !!filed, filed);
    const after = fs.readFileSync(BACKLOG, 'utf8');
    check('3 exactly one new item, the note verbatim',
      after === BACKLOG_TEXT + '\n## 3. Tabs glow when a session needs me (captured ' + new Date().toLocaleDateString('sv-SE') + ', indexing assistant)\nRicardo: "' + NOTE + '"\n',
      JSON.stringify(after.slice(BACKLOG_TEXT.length)));
    const count1 = await waitFor(() => evalIn(strip, "(() => { const c = document.getElementById('index-count').textContent; return c === '1 filed' ? c : null; })()"));
    check('3 the counter says 1 filed', !!count1);
    await shoot(toast, '3-toast-filed.png');

    // 4 -------------------------------------------------------------------------------------------------------------
    await evalIn(toast, "[...document.querySelectorAll('button')].find(b => b.textContent === 'Undo').click()");
    const undone = await waitFor(() => evalIn(toast, `(() => { const t = document.querySelector('.toast');
      return t && t.dataset.kind === 'undone' ? t.textContent : null; })()`));
    check('4 Undo says so', !!undone, undone);
    check('4 the backlog is back byte for byte', fs.readFileSync(BACKLOG, 'utf8') === BACKLOG_TEXT);

    // 5 -------------------------------------------------------------------------------------------------------------
    await evalIn(strip, "document.getElementById('index-note').focus()");
    await sleep(4000);
    check('5 the field keeps the keyboard across publishes',
      (await evalIn(strip, "document.activeElement && document.activeElement.id")) === 'index-note');
    await key(strip, 'keyDown', 'Escape', 'Escape', 27);
    await key(strip, 'keyUp', 'Escape', 'Escape', 27);
    await sleep(500);
    check('5 Esc leaves the field', (await evalIn(strip, "document.activeElement && document.activeElement.id")) !== 'index-note');
    const sent = await command({ cmd: 'key', key: 'n', modifiers: ['control', 'alt'] });
    check('5 the driver sent Ctrl+Alt+N to the tab view', sent.ok === true, JSON.stringify(sent));
    const back = await waitFor(() => evalIn(strip, "document.activeElement && document.activeElement.id === 'index-note'"), 5000);
    check('5 Ctrl+Alt+N in the tab view focuses the field', !!back);

    // 6 -------------------------------------------------------------------------------------------------------------
    await evalIn(strip, "document.getElementById('index-count').click()");
    const listT = await waitFor(async () => (await pages()).find((x) => /indexing-overlay\.html\?part=list/.test(x.url)));
    check('6 the list view exists', !!listT);
    if (listT) {
      const list = await cdpClient(listT.webSocketDebuggerUrl);
      const rows = await waitFor(() => evalIn(list, `(() => { const p = document.querySelector('.pop');
        return p ? [...p.querySelectorAll('.row')].map(r => r.querySelector('.what').textContent + ' | ' + r.querySelector('.where').textContent) : null; })()`));
      check('6 the list shows today\'s note, undone', !!rows && rows.length === 1 && /tabs should glow/.test(rows[0]) && /Undone/.test(rows[0]), JSON.stringify(rows));
      await shoot(list, '6-list.png');
      await evalIn(strip, "document.getElementById('index-count').click()");
      const closed = await waitFor(() => evalIn(list, "!document.querySelector('.pop')"), 5000);
      check('6 the counter closes it again', !!closed);
      list.close();
    }
    toast.close();
    view.close();
    strip.close();
    console.log(`\nscreenshots: ${shots}`);
  } catch (err) {
    check('the probe ran to the end', false, err && err.message);
  } finally {
    await cleanup();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks held');
    process.exit(failures ? 1 : 0);
  }
})();
