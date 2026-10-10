'use strict';
/**
 * PROBE: docs drift (backlog #39 job 2, host/drift-service.js) in a REAL window with a REAL host and a FAKE Ollama.
 * (re-runnable, about 4 minutes: the host looks for a merge once a minute, which is the design's own constant and is waited out)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-docs-drift.js        (exit 0 = every check held)
 *   DOCS_DRIFT_PROBE_SHOTS=<dir>                                       also keep the screenshots there
 *
 * The unit tests pin the decisions. No unit test can see a merge made in a real git repo noticed by a real host, a note travel
 * host -> websocket -> page, the list painted above the Git dial in a real window (the plain-<script> scope of
 * app/docs-drift-display.js), or a dismissal persisted by the host. This runs the whole chain over a temp project (container
 * with dev\ on develop and a documentation\ folder), and Ollama is verify/lib/fake-ollama.js.
 *
 *   A  nothing merged yet: the list is not on the page
 *   B  a branch is merged into develop: the model is asked ONCE, with the diff and the doc that names the changed file
 *      (and the build log's Now), qwen3.5:4b, thinking off, a reply budget big enough for a whole answer
 *   C  the note is painted above the Git dial: doc, the sentence, the commit, why, labelled as a local model's guess
 *   D  Dismiss hides it, the host remembers (a note on disk is dismissed), and it is not asked about again
 *   E  the model is not installed: said plainly, nothing asked, the merge is kept for later; the model comes back and the
 *      pending merge is read without any new merge
 *   F  READ-ONLY: every document is byte-for-byte what the probe wrote, develop is where the probe left it, only Ollama's
 *      endpoints were asked, nothing was pulled, the GPU slot is released
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* not
 * passed on purpose are deleted; registry, portraits, uploads, notes and user data are temp folders; Ollama is a fake on a
 * loopback port; the project is a temp git repo. The only processes killed are hosts whose folder is inside the probe's temp
 * folder and the window it started, by PID: never by name.
 */

const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { startFakeOllama } = require('./lib/fake-ollama');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-drift-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const docsDir = path.join(dev, 'documentation');
const userData = path.join(tmp, 'user-data');
const summaryDir = path.join(tmp, 'summaries');
const notesDir = path.join(summaryDir, 'docs-drift');
const shots = process.env.DOCS_DRIFT_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

async function waitFor(fn, ms = 20000, step = 250) {
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

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_OLLAMA_URL', 'CLAUDE_CUSTOM_SUMMARY_DIR',
  'CLAUDE_CUSTOM_SUMMARY_POWER'];

async function launchApp(cwd, ollamaUrl) {
  const port = await freePort();
  const token = crypto.randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    CLAUDE_CUSTOM_OLLAMA_URL: ollamaUrl,
    CLAUDE_CUSTOM_SUMMARY_DIR: summaryDir,
    CLAUDE_CUSTOM_SUMMARY_POWER: 'mains',
  };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: PASSED_ENV });
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

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) out.push(id);
  }
  return out;
}
function killEverything() {
  for (const id of hostsOfThisRun()) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}
hygiene.addCleanup(killEverything);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' }).trim();

const stateOf = async (app) => {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
  return st;
};
const view = (app, action, args = {}) => command(app, { cmd: 'view', action, args });
const driftState = async (app) => { const r = await view(app, 'driftState'); return r && r.ok ? r : null; };
const shoot = (app, name) => command(app, { cmd: 'screenshot', file: path.join(shots, `${name}.png`) });

// --- the project the probe merges into ------------------------------------------------------------------------
const SENTENCE = 'The reader polls the source every 30 seconds (POLL_MS in host/poller.js).';
const DOCS = {
  'CLAUDECUSTOM_BUILD_LOG.md': '# Log\n\n## Now\n\nThe probe project is on develop.\n\n## Other\n\nnothing\n',
  'DESIGN_PROBE.md': `# Probe design\n\nThe reader is small.\n${SENTENCE}\nIt never blocks the UI.\n`,
  'DESIGN_UNRELATED.md': '# Unrelated\n\nNothing here names a changed file.\n',
};
const hashOf = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
const docHashes = () => Object.fromEntries(Object.keys(DOCS).map(n => [n, hashOf(path.join(docsDir, n))]));

function mergeChange(branch, value) {
  git(dev, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(dev, 'host', 'poller.js'), `'use strict';\nconst POLL_MS = ${value};\nmodule.exports = { POLL_MS };\n`);
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', `change the poll to ${value}`);
  git(dev, 'checkout', '-q', 'develop');
  git(dev, 'merge', '-q', '--no-ff', '-m', `Merge pull request #1 from probe/${branch}`, branch);
  return git(dev, 'rev-parse', 'HEAD');
}

const notesFile = () => (fs.existsSync(notesDir) ? fs.readdirSync(notesDir).filter(f => f.endsWith('.json')).map(f => path.join(notesDir, f))[0] : null);
const savedNotes = () => { const f = notesFile(); try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; } };

async function main() {
  fs.mkdirSync(path.join(dev, 'host'), { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dev, 'host', 'poller.js'), "'use strict';\nconst POLL_MS = 30000;\nmodule.exports = { POLL_MS };\n");
  fs.writeFileSync(path.join(dev, '.gitignore'), 'documentation/\n.claude-custom/\n');
  for (const [n, t] of Object.entries(DOCS)) fs.writeFileSync(path.join(docsDir, n), t);
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'init');
  const hashesBefore = docHashes();

  let evidence = '+const POLL_MS = 10000;';
  const fake = await startFakeOllama({
    models: ['qwen3.5:4b'],
    generate: () => ({
      delayMs: 800,
      json: { response: JSON.stringify([{ doc: 'DESIGN_PROBE.md', sentence: SENTENCE, evidence, why: 'The poll interval in host/poller.js is now shorter.' }]), done: true },
    }),
  });
  hygiene.addCleanup(() => { try { fake.close(); } catch { /* closed */ } });

  const app = await launchApp(container, fake.url);
  const devHost = await waitFor(async () => {
    const st = await stateOf(app);
    return ((st && st.hosts) || []).find(x => x.label === 'develop' && x.started && Number.isInteger(x.pid)) || null;
  }, 60000);
  check('0: the window is up and the dev host is running', !!devHost, devHost ? `pid ${devHost.pid}` : `exited=${app.exited} out=${app.out.slice(-600)}`);
  if (!devHost) return;
  await view(app, 'select', { id: 'git' });                        // the Git panel is where the list lives
  await sleep(1500);

  // A -----------------------------------------------------------------------------
  const first = await waitFor(() => driftState(app), 15000);
  check('A: nothing merged yet: the list is on the page but hidden and empty', !!first && first.hidden === true && first.rows.length === 0 && first.text === '', JSON.stringify(first && [first.hidden, first.text]));

  // The host's first look (10 s after it starts) only records where develop is.
  const marked = await waitFor(() => { const n = savedNotes(); return n && n.processed ? n : null; }, 60000, 500);
  check('A: the host\'s first look records where develop is, and asks the model nothing about merges from before', !!marked && fake.count('POST', '/api/generate') === 0, JSON.stringify(marked));

  // B -----------------------------------------------------------------------------
  const merge1 = mergeChange('feat/b', 10000);
  const asked = await waitFor(() => (fake.count('POST', '/api/generate') >= 1 ? true : null), 120000, 500);
  check('B: after the merge the model is asked (within the host\'s minute)', !!asked, `generate calls: ${fake.count('POST', '/api/generate')}`);
  const gens = fake.requests.filter(r => r.method === 'POST' && r.path === '/api/generate');
  const body = gens[0] && gens[0].body;
  const prompt = body ? String(body.prompt) : '';
  check('B: ...with the diff, the doc that names the changed file, and the build log\'s Now',
    prompt.includes('+const POLL_MS = 10000;') && prompt.includes(SENTENCE) && prompt.includes('DESIGN_PROBE.md') && prompt.includes('The probe project is on develop.'), JSON.stringify(prompt.slice(0, 160)));
  check('B: ...and NOT the doc that names nothing changed', !prompt.includes('DESIGN_UNRELATED.md') && !prompt.includes('Nothing here names a changed file'));
  check('B: qwen3.5:4b, thinking off, not streamed, num_ctx 8192, a reply budget for a whole answer',
    !!body && body.model === 'qwen3.5:4b' && body.think === false && body.stream === false && body.options.num_ctx === 8192 && body.options.num_predict >= 600, JSON.stringify(body && { m: body.model, t: body.think, o: body.options }));

  // C -----------------------------------------------------------------------------
  const shown = await waitFor(async () => { const s = await driftState(app); return s && s.rows.length === 1 ? s : null; }, 20000);
  check('C: the note reaches the page and is painted', !!shown, JSON.stringify(await driftState(app)));
  if (shown) {
    const r = shown.rows[0];
    check('C: ...the doc, the sentence, why, and the merge (short commit, subject)', r.doc === 'DESIGN_PROBE.md' && r.sentence === SENTENCE
      && r.why === 'The poll interval in host/poller.js is now shorter.' && r.meta.includes(merge1.slice(0, 9)) && r.meta.includes('Merge pull request #1 from probe/feat/b'), JSON.stringify(r));
    check('C: ...labelled as a local model\'s guess, never as a verdict', /local model/.test(shown.label) && /may be wrong/.test(shown.label), shown.label);
    check('C: ...visible (it has a size on screen), not hidden', shown.hidden === false && shown.shown === true);
    await sleep(300);
    await shoot(app, '1-note');
  }

  // D -----------------------------------------------------------------------------
  const dismissed = await view(app, 'driftDismiss');
  check('D: Dismiss is clickable', !!dismissed.ok, JSON.stringify(dismissed));
  const gone = await waitFor(async () => { const s = await driftState(app); return s && s.rows.length === 0 && s.hidden === true ? s : null; }, 10000);
  check('D: the note is gone from the page and the section is hidden', !!gone);
  const store1 = savedNotes();
  check('D: the host remembers: the note is on disk, marked dismissed', !!store1 && store1.notes.length === 1 && store1.notes[0].dismissed === true, JSON.stringify(store1));
  await sleep(4000);
  check('D: ...and the model was not asked again', fake.count('POST', '/api/generate') === 1);

  // E -----------------------------------------------------------------------------
  fake.set({ models: [] });                                        // the model is not installed
  evidence = '+const POLL_MS = 5000;';
  const generatesBefore = fake.count('POST', '/api/generate');
  const merge2 = mergeChange('feat/c', 5000);
  const off = await waitFor(async () => { const s = await driftState(app); return s && /ollama pull qwen3\.5:4b/.test(s.note || '') ? s : null; }, 120000, 1000);
  check('E: the model is not installed: said plainly, with the command to install it', !!off, JSON.stringify(await driftState(app)));
  check('E: ...nothing was asked of the model, and nothing was pulled', fake.count('POST', '/api/generate') === generatesBefore && !fake.requests.some(r => r.path === '/api/pull'));
  check('E: ...the merge is kept for later (the mark did not move past it)', (savedNotes() || {}).processed !== merge2, JSON.stringify((savedNotes() || {}).processed));
  if (off) await shoot(app, '2-model-missing');
  fake.set({ models: ['qwen3.5:4b'] });
  const back = await waitFor(async () => { const s = await driftState(app); return s && s.rows.length === 1 && !s.note ? s : null; }, 150000, 1000);
  check('E: the model comes back: the pending merge is read with no new merge, the note appears and the warning clears', !!back, JSON.stringify(await driftState(app)));
  check('E: ...and it is the second merge\'s', !!back && back.rows[0].meta.includes(merge2.slice(0, 9)), JSON.stringify(back && back.rows));

  // F -----------------------------------------------------------------------------
  check('F: every document is byte-for-byte what the probe wrote', JSON.stringify(docHashes()) === JSON.stringify(hashesBefore));
  check('F: develop is where the probe left it (the host never moved a branch)', git(dev, 'rev-parse', 'develop') === merge2 && git(dev, 'branch', '--show-current') === 'develop');
  check('F: the project has no new tracked or untracked file from the host', git(dev, 'status', '--porcelain') === '', git(dev, 'status', '--porcelain'));
  const paths = new Set(fake.requests.map(r => r.method + ' ' + r.path));
  check('F: only Ollama\'s three endpoints were asked', [...paths].every(p => ['GET /', 'GET /api/tags', 'POST /api/generate'].includes(p)), JSON.stringify([...paths]));
  const slot = path.join(summaryDir, '.job.lock');
  check('F: the shared GPU slot is released', !fs.existsSync(slot));

  await command(app, { cmd: 'quit' });
  await fake.close();
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    hygiene._emergencyCleanup('done');
    console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
