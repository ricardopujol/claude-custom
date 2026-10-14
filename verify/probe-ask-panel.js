'use strict';
/**
 * PROBE: the Ask the repo panel (BACKLOG #33), in a REAL window with a REAL session host. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-ask-panel.js        (exit 0 = every check held)
 *   ASK_PROBE_SHOTS=<dir>                                              where the screenshots go
 *
 * The unit tests pin the pure state, the controller's flow, the host service and the markup. No unit test can see the page: the five ask
 * scripts share ONE global scope with the other renderer scripts (CLAUDE.md), a click is a real click, "cards before words" is about
 * paint order, a highlight is a real selection, and open-at-line is the real code reader. This starts a real window and a real host
 * (whose index, search and service are the production ones), with a FAKE Ollama (verify/lib/fake-ollama.js) standing in for the model, then:
 *
 *   1  the scripts loaded in the shared scope; the panel opens from its tab on the NAMING card (first use), name pre-filled with chips;
 *      NOTHING was indexed before the panel was first opened
 *   2  naming it: a name and a face; the label reads "<name> · <model> · local"; the empty panel has the two steps and real example questions;
 *      opening the panel started the first index, and the status line says so
 *   3  a typed question: the waiting view shows the three named steps and the "Where to look" cards BEFORE the words; then the answer,
 *      with its citation as a link; a click on a card opens the code reader AT that line
 *   4  What's this? on the reader with the explainer OFF (the record has no entry): the panel says so in words, and does not ask a model
 *   5  the settings: the model choice (Local / Haiku / Sonnet) changes the label ("... Claude, uses your plan"); Local is the default
 *   6  the record now has the local model passing: What's this? explains at the person's level, with Simpler / Deeper (a sibling), a
 *      highlighted phrase drilled into with a breadcrumb that goes back
 *   7  Ollama stopped: the plain sentence, the places the search still found as cards, and Start Ollama + Ask Claude instead
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN) and NO step asks a Claude model (that would feed the prompt to cmd.exe's
 * stdin), so nothing bills; Start Ollama and Ask Claude instead are checked for presence and never clicked. ELECTRON_RUN_AS_NODE and every
 * CLAUDE_CUSTOM_* variable of an enclosing tab are stripped; the project is a temp git repo; registry, portraits, uploads, user data, the
 * Ask index and the explainer record are temp. Files of THIS checkout the app writes (the layout files) are snapshotted and put back.
 * Only PIDs this probe started are killed (never by name).
 */

const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const { startFakeOllama } = require('./lib/fake-ollama');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.harness', 'state');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-ask-'));
const dev = path.join(tmp, 'proj', 'dev');
const userData = path.join(tmp, 'user-data');
const indexDir = path.join(tmp, 'ask-index');
const recordFile = path.join(tmp, 'ask-record.json');
const shots = process.env.ASK_PROBE_SHOTS || path.join(ROOT, '.harness', 'probe-ask');
fs.mkdirSync(shots, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

async function waitFor(fn, ms = 20000, step = 200) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const LAYOUT_FILE = path.join(STATE_DIR, 'layout-global.json');
const TREE_FILE = path.join(STATE_DIR, 'layout-tree.json');
const snaps = [snapshotFile(LAYOUT_FILE), snapshotFile(TREE_FILE)];
hygiene.addCleanup(() => snaps.forEach(s => s.restore()));
hygiene.install();

async function launchApp(cwd, ollamaUrl) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CUSTOM_')));
  const env = {
    ...inherited,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    CLAUDE_CUSTOM_OLLAMA_URL: ollamaUrl,
    CLAUDE_CUSTOM_ASK_RECORD: recordFile,
    CLAUDE_CUSTOM_ASK_INDEX_DIR: indexDir,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env },
    { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS',
      'CLAUDE_CUSTOM_OLLAMA_URL', 'CLAUDE_CUSTOM_ASK_RECORD', 'CLAUDE_CUSTOM_ASK_INDEX_DIR'] });
  hygiene.registerChild(child);
  const app = { port, token, child, out: '', exited: false };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; hygiene.unregisterSpawnedTree(child.pid); });
  return app;
}

function command(app, cmd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: app.port });
    let buf = '';
    const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done({ ok: false, error: `no reply to ${cmd.cmd} in ${timeoutMs}ms` }), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ ...cmd, token: app.token }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done({ ok: false, error: 'unparseable reply' }); } }
    });
    sock.on('error', (e) => done({ ok: false, error: e.message }));
  });
}
const view = (app, action, args = {}) => command(app, { cmd: 'view', action, args });

const seenPids = require('./lib/seen-pids').createSeenPids();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(ROOT, '.harness', 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: path.join(ROOT, '.harness'), port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) out.push(id);
  }
  return out;
}
function killEverything() {
  for (const id of hostsOfThisRun()) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}
hygiene.addCleanup(killEverything);

async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? v : null;
  }, 45000);
}

const LOCK_JS = [
  "'use strict';",
  '// A tiny lock used by the probe.',
  'function acquireLock(path) {',
  "  return path + '.lock';",
  '}',
  'function releaseLock(path) {',
  '  // the lock is released here',
  '  return path.length > 0;',
  '}',
  'module.exports = { acquireLock, releaseLock };',
  '',
].join('\n');
const OTHER_JS = [
  "'use strict';",
  'function renderToolbar(items) {',
  "  return items.map((i) => '<b>' + i + '</b>').join('');",
  '}',
  'module.exports = { renderToolbar };',
  '',
].join('\n');

const QUESTION_ANSWER = 'The lock is released in lib/lock.js:6-9.\n\n- lib/lock.js:7: the comment marks where the release happens.';
const EXPLAIN_ANSWER = 'This is a lock file helper. It builds a name and checks it.\n\nWhere it shows up\n- lib/lock.js:3: where the name is built.';

async function main() {
  fs.mkdirSync(path.join(dev, 'lib'), { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dev, 'lib', 'lock.js'), LOCK_JS);
  fs.writeFileSync(path.join(dev, 'lib', 'toolbar.js'), OTHER_JS);
  fs.writeFileSync(path.join(dev, 'README.md'), '# probe\n\nA tiny repository for the Ask panel probe.\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'init');
  for (const f of [LAYOUT_FILE, TREE_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  fs.writeFileSync(recordFile, JSON.stringify({ version: 1, passed: {} }));

  const fake = await startFakeOllama({
    models: ['qwen3.5:4b'],
    generate: (body) => {
      const isExplain = typeof body.system === 'string' && body.system.includes('Reader level');
      if (isExplain && /highlighted/.test(body.prompt)) return { json: { response: 'A lock file is a small marker file that says someone is working.', done: true } };
      if (isExplain) return { json: { response: EXPLAIN_ANSWER, done: true }, delayMs: 300 };
      return { json: { response: QUESTION_ANSWER, done: true }, delayMs: 2500 };
    },
  });
  hygiene.addCleanup(() => fake.close());

  const indexBefore = fs.existsSync(indexDir) ? fs.readdirSync(indexDir).length : 0;
  const app = await launchApp(dev, fake.url);
  const ready = await viewReady(app);
  check('the window came up with a session', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  const st = () => view(app, 'askState');
  const doIt = (a) => view(app, 'askDo', a);
  const reader = (what, extra = {}) => view(app, 'repoProbe', { what, ...extra });
  const shot = async (name) => { await sleep(250); await command(app, { cmd: 'screenshot', file: path.join(shots, name) }); };

  // 1 -----------------------------------------------------------------------------------------------------------------------
  const indexMid = fs.existsSync(indexDir) ? fs.readdirSync(indexDir).length : 0;
  check('1: nothing was indexed before the panel was first opened', indexMid === indexBefore && fake.count('POST', '/api/embed') === 0, `${indexBefore} -> ${indexMid}`);
  await view(app, 'select', { id: 'ask' });
  const s1 = await waitFor(async () => { const s = await st(); return s && s.ok && s.shown ? s : null; }, 10000, 200);
  check('1: the Ask panel opens from its tab', !!s1);
  if (!s1) return;
  check('1: the five ask scripts loaded in the shared plain-script scope', s1.scope === true);
  check('1: first use shows the naming card, and no question box yet', s1.view === 'naming' && s1.form.hidden === true, JSON.stringify([s1.view, s1.form]));
  check('1: the name is pre-filled and there are chips, faces and an upload', /value="Professor Byte"/.test(s1.html) && /data-act="chip" data-name="Ada"/.test(s1.html) && /data-act="face"/.test(s1.html) && /data-act="upload"/.test(s1.html));
  check('1: the reader\'s What\'s this? button is there', s1.readerAsk.hidden === false);
  await shot('ask-1-naming.png');

  // 2 -----------------------------------------------------------------------------------------------------------------------
  await doIt({ op: 'click', act: 'chip', text: 'Ada' });
  await doIt({ op: 'click', act: 'face' });
  await doIt({ op: 'click', act: 'name-save' });
  const s2 = await waitFor(async () => { const s = await st(); return s.view === 'empty' ? s : null; }, 8000, 150);
  check('2: saving the name leaves the empty panel', !!s2);
  if (!s2) return;
  check('2: the label reads name, model and where it runs', s2.label === 'Ada · qwen3.5:4b · local', s2.label);
  check('2: the question box is there; the two steps and real example questions show', s2.form.hidden === false && /Select code in a file/.test(s2.text) && s2.buttons.filter(b => b.act === 'example').length >= 1, JSON.stringify(s2.buttons.filter(b => b.act === 'example').map(b => b.text)));
  const s2b = await waitFor(async () => { const s = await st(); return s.status && /files read/.test(s.status) ? s : null; }, 30000, 300);
  check('2: opening the panel started the first index; the status line says how many files', !!s2b, JSON.stringify(s2b && s2b.status));
  check('2: with no embedding model it says so (keywords only), never a silent downgrade', !!s2b && /keywords only/.test(s2b.status), s2b && s2b.status);
  const indexAfter = fs.existsSync(indexDir) ? fs.readdirSync(indexDir).length : 0;
  check('2: the index is on disk now', indexAfter === indexBefore + 1, `${indexBefore} -> ${indexAfter}`);
  check('2: the explainer is off on the local model (no passed record), said in the status line', !!s2b && /explaining code is off on this model/.test(s2b.status));
  await shot('ask-2-empty.png');

  // 3 -----------------------------------------------------------------------------------------------------------------------
  await doIt({ op: 'type', text: 'Where is the lock released?' });
  await doIt({ op: 'submit' });
  const w = await waitFor(async () => { const s = await st(); return s.view === 'waiting' && s.cards.length > 0 ? s : null; }, 8000, 100);
  check('3: the waiting view shows the "Where to look" cards BEFORE the words', !!w, JSON.stringify(w && [w.view, w.cards.length]));
  check('3: the three named steps, the first one done', !!w && w.stages.length === 3 && /found \d+ place/.test(w.stages[0][1]) && /done/.test(w.stages[0][0]) && /loading the model/.test(w.stages[1][1]) && /writing the answer/.test(w.stages[2][1]), JSON.stringify(w && w.stages));
  check('3: a card names a real file and line', !!w && w.cards.some(c => c.file === 'lib/lock.js' && Number(c.line) >= 1), JSON.stringify(w && w.cards.map(c => c.where)));
  await shot('ask-3-waiting.png');
  const a3 = await waitFor(async () => { const s = await st(); return s.view === 'answer' ? s : null; }, 20000, 200);
  check('3: then the answer', !!a3);
  if (!a3) return;
  check('3: the words, with the citation as a link to a place we know', /released in/.test(a3.text) && a3.buttons.some(b => b.act === 'open' && /lib\/lock\.js:6-9/.test(b.text)), JSON.stringify(a3.buttons.filter(b => b.act === 'open').map(b => b.text)));
  check('3: the cards come from the checked citations, with their lines and why', a3.cards.some(c => c.file === 'lib/lock.js' && c.line === '6' && /releaseLock/.test(c.code)) && a3.cards.some(c => /comment marks/.test(c.why)), JSON.stringify(a3.cards.map(c => [c.where, c.why])));
  check('3: it says who answered, "Ada · qwen3.5:4b · local"', /Ada · qwen3\.5:4b · local/.test(a3.text));
  check('3: a typed question has Ask Claude instead, and no Simpler / Deeper', a3.buttons.some(b => b.act === 'ask-claude') && !a3.buttons.some(b => b.act === 'reask'));
  await shot('ask-3-answer.png');
  const askedFake = fake.requests.filter(r => r.path === '/api/generate').length;
  check('3: exactly one model call for the question, and it went to the local Ollama', askedFake === 1, String(askedFake));
  await doIt({ op: 'click', act: 'open', text: 'lib/lock.js:6' });
  const r3 = await waitFor(async () => { const r = await reader('reader.state'); return r && r.ok && r.open && r.path === 'lib/lock.js' && r.selection ? r : null; }, 10000, 200);
  check('3: a click on a card opens the code reader at that line', !!r3 && r3.selection.start === 6, JSON.stringify(r3 && [r3.path, r3.selection]));

  // 4 -----------------------------------------------------------------------------------------------------------------------
  await reader('reader.select', { from: 3, to: 5 });
  const gens = fake.requests.filter(r => r.path === '/api/generate').length;
  await reader('reader.ask');
  const s4 = await waitFor(async () => { const s = await st(); return s.view === 'note' && s.entry && s.entry.reason === 'explainer-off' ? s : null; }, 8000, 150);
  check('4: What\'s this? with the explainer off says so in words, in the panel', !!s4 && /hasn't passed the quality check/.test(s4.text), s4 && s4.text.slice(0, 200));
  check('4: no model was asked', fake.requests.filter(r => r.path === '/api/generate').length === gens);
  check('4: the panel came to the front for it', !!s4 && s4.shown === true);
  await shot('ask-4-explainer-off.png');

  // 5 -----------------------------------------------------------------------------------------------------------------------
  await doIt({ op: 'settings', model: 'haiku', level: 'new', aboutMe: 'Learning Python, background in C# audio.' });
  const s5 = await waitFor(async () => { const s = await st(); return s.profile.model === 'haiku' ? s : null; }, 5000, 100);
  check('5: choosing Haiku in the settings changes the label: Claude, on your plan', !!s5 && s5.label === 'Ada · Haiku · Claude, uses your plan', s5 && s5.label);
  check('5: the profile kept the level and About me', !!s5 && s5.profile.level === 'new');
  await doIt({ op: 'settings', model: 'local', level: 'comfortable' });
  const s5b = await waitFor(async () => { const s = await st(); return s.profile.model === 'local' ? s : null; }, 5000, 100);
  check('5: and back to Local', !!s5b && s5b.label === 'Ada · qwen3.5:4b · local');
  check('5: no model call was made by choosing', fake.requests.filter(r => r.path === '/api/generate').length === gens);

  // 6 -----------------------------------------------------------------------------------------------------------------------
  fs.writeFileSync(recordFile, JSON.stringify({ version: 1, passed: { 'qwen3.5:4b': { new: 9, comfortable: 9, of: 10 } } }));
  await doIt({ op: 'refresh' });
  const s6 = await waitFor(async () => { const s = await st(); return s.host && s.host.models.find(m => m.id === 'local' && m.explainer) ? s : null; }, 8000, 150);
  check('6: the host reads the passed record at run time; the explainer is on for the local model', !!s6);
  check('6: the header now says who it explains for', !!s6 && /explaining for: Comfortable/.test(s6.top), s6 && s6.top);
  await reader('reader.select', { from: 3, to: 5 });
  await reader('reader.ask');
  const e6 = await waitFor(async () => { const s = await st(); return s.view === 'answer' && s.entry && s.entry.kind === 'explain' ? s : null; }, 20000, 200);
  check('6: What\'s this? explains the selected code', !!e6, JSON.stringify(e6 && e6.entry));
  if (!e6) return;
  const explainReq = fake.requests.filter(r => r.path === '/api/generate').at(-1).body;
  check('6: the model was given the selected lines with their real numbers, the level and no question to write', /Selected code \(lib\/lock\.js, lines 3-5\):\n3: function acquireLock/.test(explainReq.prompt) && /Reader level: Comfortable/.test(explainReq.system));
  check('6: the answer links its place and offers Simpler / Deeper', e6.buttons.some(b => b.act === 'reask' && b.text === 'Simpler') && e6.buttons.some(b => b.act === 'reask' && b.text === 'Deeper'));
  check('6: the breadcrumb starts at "lib/lock.js:3-5"', e6.entry && e6.trail.length === 1 && e6.trail[0] === 'lib/lock.js:3-5', JSON.stringify(e6.trail));
  await shot('ask-6-explained.png');
  await doIt({ op: 'click', act: 'reask', text: 'Simpler' });
  const sim = await waitFor(async () => { const s = await st(); return s.view === 'answer' && s.entry && s.entry.id === e6.entry.id + 1 ? s : null; }, 15000, 200);
  check('6: Simpler asks again once; the new answer is its own step', !!sim);
  const simReq = fake.requests.filter(r => r.path === '/api/generate').at(-1).body;
  check('6: and the model was told to make it simpler', /simpler/i.test(simReq.system));
  await doIt({ op: 'select', chars: 11 });
  const hl = await waitFor(async () => { const s = await st(); return s.highlight && s.highlight.hidden === false ? s : null; }, 5000, 150);
  check('6: highlighting words of the answer offers "What\'s this?" for them', !!hl, JSON.stringify(hl && hl.highlight));
  if (hl) {
    await doIt({ op: 'click', act: 'drill' });
    const dr = await waitFor(async () => { const s = await st(); return s.view === 'answer' && s.trail.length === 2 ? s : null; }, 15000, 200);
    check('6: drilling in is one step with a breadcrumb: the code, then the words', !!dr && /^lib\/lock\.js:3-5$/.test(dr.trail[0]), JSON.stringify(dr && dr.trail));
    const drReq = fake.requests.filter(r => r.path === '/api/generate').at(-1).body;
    check('6: the model got the highlighted words and the answer they came from', /highlighted "/.test(drReq.prompt));
    await shot('ask-6-drill.png');
    if (dr) {
      await doIt({ op: 'click', act: 'goto' });
      const back = await waitFor(async () => { const s = await st(); return s.trail.length === 1 ? s : null; }, 5000, 150);
      check('6: any earlier step of the breadcrumb is clickable and goes back to it', !!back, JSON.stringify(back && back.trail));
    }
  }

  // 7 -----------------------------------------------------------------------------------------------------------------------
  await fake.close();
  await doIt({ op: 'type', text: 'Where is the toolbar rendered?' });
  await doIt({ op: 'submit' });
  const d7 = await waitFor(async () => { const s = await st(); return s.view === 'note' && s.entry && s.entry.reason === 'ollama-down' ? s : null; }, 30000, 250);
  check('7: with Ollama stopped the panel says so in plain words', !!d7 && /Ollama isn't running, so Ada can't answer this yet\. The places below come from the search alone\./.test(d7.text), d7 && d7.text.slice(0, 300));
  check('7: the places the search still found show as cards', !!d7 && d7.cards.length >= 1, JSON.stringify(d7 && d7.cards.map(c => c.where)));
  check('7: Start Ollama and Ask Claude instead are offered (and not clicked)', !!d7 && d7.buttons.some(b => b.act === 'start-ollama') && d7.buttons.some(b => b.act === 'ask-claude'));
  await shot('ask-7-ollama-down.png');

  const errors = (app.out.match(/\[renderer:[a-z]+\].*/g) || []).filter(l => /error|not defined|undefined is not|cannot read/i.test(l));
  check('the renderer reported no errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(`screenshots: ${shots}`);
  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 10000);
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    snaps.forEach(s => s.restore());
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
