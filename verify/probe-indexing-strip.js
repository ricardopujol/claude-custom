'use strict';
const { killChildTree } = require('../host/kill-tree');
/* Backlog #66: the indexing field in a REAL window.  (re-runnable)

     node verify/probe-indexing-strip.js        (exit 0 = every check held; PORT=<n> optional)
     INDEXING_PROBE_SHOTS=<dir>                 keep the screenshots there (default: a temp folder, printed)

   DESIGN_INDEXING_ASSISTANT.md "Revised 2026-10-05 (evening)": no model, a verbatim inbox. Unit tests can't see the
   shared-global-scope trap (CLAUDE.md), a view stacked over another, or the keyboard moving between two documents, so
   this drives the real thing over the Chromium debugging port:

     1  the strip page has the field, the chip names the project, the counter says "0 filed", and both scripts
        loaded (indexingDisplay and tabStrip are both defined: neither aborted the other)
     2  a note typed into the field and Enter: the field clears, the note is journaled, the toast over the tab view
        says "Added to the inbox" with the note's first line and Undo, and the backlog has a `## Inbox` right after
        the status block holding exactly `- YYYY-MM-DD HH:MM · <the note>`; the counter says "1 filed"
     3  Undo takes exactly that entry out (the inbox heading it created stays)
     4  the field keeps the keyboard across publishes; Esc hands it back; Ctrl+Alt+N in the tab view takes it again
     5  with no backlog file, a note creates it (title, Inbox, the note) and the toast says "Created the backlog and
        filed your note" with Undo; Undo removes the file too (#79)
     6  the list opens from the counter, shows both notes, and closes again
     7  with no documentation folder at all, a note makes the folder, the backlog and the sync-docs .gitignore block
        (Ricardo, 2026-10-09); Undo takes all three out again

   Safe: the host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing billable runs; the journal and the project docs
   are temp files (CLAUDE_CUSTOM_INDEXING_JOURNAL, a temp project), so the real documentation is never touched. The
   host's own "where are we" summary is pointed at a fake Ollama (verify/lib/fake-ollama.js) and a temp slot folder, so
   the real model is never asked anything. ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* variable are removed from the
   children's environment first. Only the two processes started here are killed, by their own pid. */
const { spawn, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { startFakeOllama } = require('./lib/fake-ollama');
const { stampOf } = require('../host/indexing-doc');

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
fs.mkdirSync(path.join(project, '.git'));             // a backlog is only ever created in a git root (PR #138)
fs.writeFileSync(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
const BACKLOG = path.join(docs, 'PROBE_BACKLOG.md');
const BACKLOG_TEXT = '# probe — Backlog\n\n**Status (2026-10-05):** a probe.\n\n## 1. The wand runs skills\nbody\n\n## 2. A resource panel\nmore\n';
fs.writeFileSync(path.join(docs, 'PROBE_BUILD_LOG.md'), '# log\n');
fs.writeFileSync(BACKLOG, BACKLOG_TEXT);
const JOURNAL = path.join(tmp, 'state', 'indexing-notes.jsonl');
const shots = process.env.INDEXING_PROBE_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'cc-indexing-shots-'));
fs.mkdirSync(shots, { recursive: true });

const children = [];
const killTree = (c) => {
  if (!c || !c.pid) return;
  try { killChildTree(c); } catch { /* already gone */ }
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
    fake = await startFakeOllama({});              // the host's summary job only; the field asks no model

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

    const electron = spawnElectron(require('electron'), ['.', `--remote-debugging-port=${CDP}`], {
      cwd: REPO, env: electronEnv, stdio: ['ignore', 'pipe', 'pipe'],
    }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_INDEXING_JOURNAL', 'CLAUDE_CUSTOM_OLLAMA_URL', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_SUMMARY_DIR', 'CLAUDE_CUSTOM_SUMMARY_POWER', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
    children.push(electron);
    let electronLog = '';
    electron.stdout.on('data', (d) => { electronLog += d; });
    electron.stderr.on('data', (d) => { electronLog += d; });
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
    if (!s1) {
      const why = await evalIn(strip, "JSON.stringify({ href: location.href, ready: document.readyState, field: !!document.getElementById('index-note'), chip: (document.getElementById('index-chip') || {}).textContent, display: typeof window.indexingDisplay, bridge: typeof (window.strip && window.strip.indexSubmit) })").catch((e) => e.message);
      console.log(`      strip page: ${why}
      electron log (tail):
${electronLog.slice(-3000)}`);
    }
    check('1 the field is in the strip', !!(s1 && s1.field));
    check('1 the chip names the project', !!s1 && s1.chip === 'probeproj', s1 && s1.chip);
    check('1 the counter says 0 filed', !!s1 && s1.count === '0 filed', s1 && s1.count);
    check('1 both strip scripts loaded (no shared-scope abort)', !!s1 && s1.scripts === true);
    await shoot(strip, '1-strip.png');

    // 2 -------------------------------------------------------------------------------------------------------------
    const NOTE = 'tabs should glow when a session needs me';
    await evalIn(strip, "document.getElementById('index-note').focus()");
    await strip.send('Input.insertText', { text: NOTE });
    const enterAt = Date.now();
    await key(strip, 'keyDown', 'Enter', 'Enter', 13);
    await key(strip, 'keyUp', 'Enter', 'Enter', 13);
    const cleared = await waitFor(() => evalIn(strip, "document.getElementById('index-note').value === ''"));
    check('2 Enter clears the field', !!cleared);
    const journaled = await waitFor(() => fs.existsSync(JOURNAL) && fs.readFileSync(JOURNAL, 'utf8').includes(NOTE));
    check('2 the note is journaled, verbatim', !!journaled);
    const toastT = await waitFor(async () => (await pages()).find((x) => /indexing-overlay\.html\?part=toast/.test(x.url)));
    check('2 the toast view exists', !!toastT);
    if (!toastT) return;
    const toast = await cdpClient(toastT.webSocketDebuggerUrl);
    const added = await waitFor(() => evalIn(toast, `(() => { const t = document.querySelector('.toast'); return t && t.dataset.kind === 'added'
      ? { line: t.querySelector('.t1').textContent, note: t.querySelector('.note').textContent,
          undo: [...t.querySelectorAll('button')].some(b => b.textContent === 'Undo') } : null; })()`), 45000);
    console.log(`      the first toast showed ${Date.now() - enterAt} ms after Enter (its view's renderer starts with it)`);
    if (!added) {
      const why = await evalIn(toast, "JSON.stringify({ href: location.href, ready: document.readyState, root: (document.getElementById('root') || {}).innerHTML, w: innerWidth, h: innerHeight, display: typeof window.indexingDisplay, bridge: typeof (window.indexing && window.indexing.onState) })").catch((e) => e.message);
      console.log(`      toast page: ${String(why).slice(0, 600)}`);
    }
    check('2 the toast says "Added to the inbox" with the note\'s first line and Undo',
      !!added && added.line === 'Added to the inbox' && added.note === NOTE && added.undo, JSON.stringify(added));
    const sized = await waitFor(() => evalIn(toast, '(innerWidth === 420 && innerHeight > 40 && innerHeight < 300) ? `${innerWidth}x${innerHeight}` : null'), 10000);
    check('2 the toast view is sized to the toast (bottom right, 420 wide)', !!sized,
      sized || (await evalIn(toast, '`${innerWidth}x${innerHeight}`').catch(() => '?')));
    const stamp = stampOf(Date.now());
    const after = fs.readFileSync(BACKLOG, 'utf8');
    const WITH_INBOX = BACKLOG_TEXT.replace('## 1. The wand', '## Inbox\n- ENTRY\n\n## 1. The wand');
    // The minute can turn between the Enter and this read: accept the stamp of the minute before as well.
    const okAfter = [stamp, stampOf(Date.now() - 60_000)].some(s => after === WITH_INBOX.replace('- ENTRY', `- ${s} · ${NOTE}`));
    check('2 the backlog has a ## Inbox right after the status block, holding exactly the note', okAfter, JSON.stringify(after.slice(0, 260)));
    const count1 = await waitFor(() => evalIn(strip, "(() => { const c = document.getElementById('index-count').textContent; return c === '1 filed' ? c : null; })()"));
    check('2 the counter says 1 filed', !!count1);
    await shoot(toast, '2-toast-added.png');

    // 3 -------------------------------------------------------------------------------------------------------------
    await evalIn(toast, "[...document.querySelectorAll('button')].find(b => b.textContent === 'Undo').click()");
    const undone = await waitFor(() => evalIn(toast, `(() => { const t = document.querySelector('.toast');
      return t && t.dataset.kind === 'undone' ? t.querySelector('.t1').textContent : null; })()`));
    check('3 Undo says so', undone === 'Undone. Removed from the inbox.', undone);
    check('3 the entry is gone and nothing else changed (the inbox heading stays)',
      fs.readFileSync(BACKLOG, 'utf8') === WITH_INBOX.replace('- ENTRY\n', ''), JSON.stringify(fs.readFileSync(BACKLOG, 'utf8').slice(0, 200)));

    // 4 -------------------------------------------------------------------------------------------------------------
    await evalIn(strip, "document.getElementById('index-note').focus()");
    await sleep(4000);
    check('4 the field keeps the keyboard across publishes',
      (await evalIn(strip, "document.activeElement && document.activeElement.id")) === 'index-note');
    await key(strip, 'keyDown', 'Escape', 'Escape', 27);
    await key(strip, 'keyUp', 'Escape', 'Escape', 27);
    await sleep(500);
    check('4 Esc leaves the field', (await evalIn(strip, "document.activeElement && document.activeElement.id")) !== 'index-note');
    const sent = await command({ cmd: 'key', key: 'n', modifiers: ['control', 'alt'] });
    check('4 the driver sent Ctrl+Alt+N to the tab view', sent.ok === true, JSON.stringify(sent));
    const back = await waitFor(() => evalIn(strip, "document.activeElement && document.activeElement.id === 'index-note'"), 5000);
    check('4 Ctrl+Alt+N in the tab view focuses the field', !!back);

    // 5 (#79) -------------------------------------------------------------------------------------------------------
    fs.unlinkSync(BACKLOG);
    const NOTE2 = 'a note with nowhere to go';
    await evalIn(strip, "document.getElementById('index-note').focus()");
    await strip.send('Input.insertText', { text: NOTE2 });
    await key(strip, 'keyDown', 'Enter', 'Enter', 13);
    await key(strip, 'keyUp', 'Enter', 'Enter', 13);
    const created = await waitFor(() => evalIn(toast, `(() => { const t = document.querySelector('.toast'); return t && t.dataset.kind === 'added'
      ? { line: t.querySelector('.t1').textContent, undo: [...t.querySelectorAll('button')].some(b => b.textContent === 'Undo') } : null; })()`));
    check('5 no backlog file: the toast says it created the backlog and filed the note, with Undo',
      !!created && created.line === 'Created the backlog and filed your note' && created.undo, JSON.stringify(created));
    const madeText = fs.existsSync(BACKLOG) ? fs.readFileSync(BACKLOG, 'utf8') : null;
    check('5 ...the file has a title, an Inbox and exactly the note',
      madeText !== null && /^# probeproj — Feature & Bug Backlog\n\n## Inbox\n- \d{4}-\d\d-\d\d \d\d:\d\d · a note with nowhere to go\n$/.test(madeText),
      JSON.stringify(madeText));
    const count2 = await waitFor(() => evalIn(strip, "(() => { const c = document.getElementById('index-count').textContent; return c === '1 filed' ? c : null; })()"));
    check('5 the counter says 1 filed', !!count2, count2);
    await shoot(toast, '5-toast-created-backlog.png');
    await evalIn(toast, "[...document.querySelectorAll('button')].find(b => b.textContent === 'Undo').click()");
    const undone2 = await waitFor(() => evalIn(toast, `(() => { const t = document.querySelector('.toast');
      return t && t.dataset.kind === 'undone' ? t.querySelector('.t1').textContent : null; })()`));
    check('5 Undo says so', undone2 === 'Undone. Removed from the inbox.', undone2);
    check('5 ...and the note was the only content, so the file it created is gone too', !fs.existsSync(BACKLOG));

    // 6 -------------------------------------------------------------------------------------------------------------
    await evalIn(strip, "document.getElementById('index-count').click()");
    const listT = await waitFor(async () => (await pages()).find((x) => /indexing-overlay\.html\?part=list/.test(x.url)));
    check('6 the list view exists', !!listT);
    if (listT) {
      const list = await cdpClient(listT.webSocketDebuggerUrl);
      const rows = await waitFor(() => evalIn(list, `(() => { const p = document.querySelector('.pop');
        return p ? [...p.querySelectorAll('.row')].map(r => r.querySelector('.what').textContent + ' | ' + r.querySelector('.where').textContent
          + ' | ' + [...r.querySelectorAll('button')].map(b => b.textContent).join(',')) : null; })()`));
      check('6 the list shows today\'s two notes: both undone',
        !!rows && rows.length === 2 && /nowhere to go \| Undone \| ?$/.test(rows[0]) && /tabs should glow when a session needs me \| Undone \| ?$/.test(rows[1]),
        JSON.stringify(rows));
      await shoot(list, '6-list.png');
      await evalIn(strip, "document.getElementById('index-count').click()");
      const closed = await waitFor(() => evalIn(list, "!document.querySelector('.pop')"), 5000);
      check('6 the counter closes it again', !!closed);
      list.close();
    }
    // 7 (#79, 2026-10-09) -------------------------------------------------------------------------------------------
    fs.rmSync(docs, { recursive: true, force: true });
    const IGNORE = path.join(project, '.gitignore');
    const NEW_BACKLOG = path.join(docs, 'PROBEPROJ_BACKLOG.md');
    await evalIn(strip, "document.getElementById('index-note').focus()");
    await strip.send('Input.insertText', { text: 'a note with no folder either' });
    await key(strip, 'keyDown', 'Enter', 'Enter', 13);
    await key(strip, 'keyUp', 'Enter', 'Enter', 13);
    const made3 = await waitFor(() => evalIn(toast, `(() => { const t = document.querySelector('.toast'); return t && t.dataset.kind === 'added' ? t.querySelector('.t1').textContent : null; })()`));
    check('7 no documentation folder: the toast says it created the backlog and filed the note', made3 === 'Created the backlog and filed your note', made3);
    check('7 ...the folder and the backlog exist, with the note', fs.existsSync(NEW_BACKLOG) && /· a note with no folder either\n$/.test(fs.readFileSync(NEW_BACKLOG, 'utf8')));
    const ignoreText = fs.existsSync(IGNORE) ? fs.readFileSync(IGNORE, 'utf8') : '';
    check('7 ...and the repo has a .gitignore with the sync-docs block', ignoreText.includes('# --- sync-docs (gitignore) ---') && ignoreText.includes('documentation/*'), JSON.stringify(ignoreText));
    await shoot(toast, '7-toast-created-folder.png');
    await evalIn(toast, "[...document.querySelectorAll('button')].find(b => b.textContent === 'Undo').click()");
    const undone3 = await waitFor(() => evalIn(toast, `(() => { const t = document.querySelector('.toast'); return t && t.dataset.kind === 'undone' ? t.querySelector('.t1').textContent : null; })()`));
    check('7 Undo says so', undone3 === 'Undone. Removed from the inbox.', undone3);
    check('7 ...and the folder and the .gitignore it made are gone too', !fs.existsSync(docs) && !fs.existsSync(IGNORE));

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
