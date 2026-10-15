'use strict';
/**
 * PROBE: the Ask explainer joins the roster (BACKLOG #33 gamification), in a REAL window with a REAL session host. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-ask-gamify.js        (exit 0 = every check held)
 *   ASK_GAMIFY_SHOTS=<dir>                                             where the screenshots go
 *
 * No unit test can see the page (CLAUDE.md, "Traps"): app/ask-explainer-display.js is a plain <script> in the renderer's ONE shared scope,
 * the card is drawn by renderer.js from a frame the real host sends, the ring and badge are CSS on a real element, and "Active while a
 * panel is open" is a socket-per-window fact only a running host holds. This starts a real window and a real host (production Ask service,
 * explainer state and counts store) with a FAKE Ollama standing in for the model, then:
 *
 *   A  not on the roster until it is named (the host already sends its frame); named: on Active, tagged "local helper", Persona shows its
 *      name and Role shows "Ask the repo"; sorted like an agent (a working agent above it); counts read "0 questions · 0 places opened"
 *   B  asking: the card and the panel header go working with the writing badge and "writing the explanation"; the answer lands and it
 *      sleeps again with "1 question"
 *   C  opening a place from the answer makes it happy (ring + words), "1 place opened", and 8 s later asleep again
 *   D  medals: from its card and from the panel's 🏅 (the same give menu, titled with its name), the chip counts them, the log page shows
 *      the counts and the shelf with reasons, a medal comes off in two clicks
 *   E  a rename keeps the medals and the counts (they are keyed by the fixed id)
 *   F  Ollama stopped: stressed with the warning; the next good answer is not needed to see it, the panel's header wears the same
 *   G  the panel hidden: the card moves to Inactive (counts and medal kept); shown again: back on Active
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN) and NO step asks a Claude model, so nothing bills. ELECTRON_RUN_AS_NODE and
 * every CLAUDE_CUSTOM_* variable of an enclosing tab are stripped; the project is a temp git repo; registry, portraits, uploads, user data,
 * the Ask index and the explainer record are temp. The install-wide files the host writes under THIS checkout's .harness/state (the layout,
 * medals.json, ask-counts.json) are snapshotted and put back. Only PIDs this probe started are killed (never by name).
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
const shots = process.env.ASK_GAMIFY_SHOTS || path.join(ROOT, '.harness', 'probe-ask-gamify');
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
const MEDALS_FILE = path.join(STATE_DIR, 'medals.json');
const COUNTS_FILE = path.join(STATE_DIR, 'ask-counts.json');
const snaps = [snapshotFile(LAYOUT_FILE), snapshotFile(TREE_FILE), snapshotFile(MEDALS_FILE), snapshotFile(COUNTS_FILE)];
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


// a 1x1 PNG: the forge's generated pictures (tmp/portraits/<agent>/sleeping.png) are this
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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
const QUESTION_ANSWER = 'The lock is released in lib/lock.js:6-9.\n\n- lib/lock.js:7: the comment marks where the release happens.';

async function main() {
  fs.mkdirSync(path.join(dev, 'lib'), { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dev, 'lib', 'lock.js'), LOCK_JS);
  fs.writeFileSync(path.join(dev, 'README.md'), '# probe\n\nA tiny repository for the Ask gamification probe.\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'init');
  for (const f of [LAYOUT_FILE, TREE_FILE, MEDALS_FILE, COUNTS_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  fs.writeFileSync(recordFile, JSON.stringify({ version: 1, passed: {} }));
  for (const agent of ['naomi', 'paris']) { fs.mkdirSync(path.join(tmp, 'portraits', agent), { recursive: true }); fs.writeFileSync(path.join(tmp, 'portraits', agent, 'sleeping.png'), PNG); }

  const fake = await startFakeOllama({
    models: ['qwen3.5:4b'],
    generate: () => ({ json: { response: QUESTION_ANSWER, done: true }, delayMs: 3500 }),
  });
  hygiene.addCleanup(() => fake.close());

  const app = await launchApp(dev, fake.url);
  const ready = await viewReady(app);
  check('the window came up with a session', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  const ex = () => view(app, 'explainerState');
  const exDo = (a) => view(app, 'explainerDo', a);
  const st = () => view(app, 'askState');
  const doIt = (a) => view(app, 'askDo', a);
  const shot = async (name) => { await sleep(300); await command(app, { cmd: 'screenshot', file: path.join(shots, name) }); };
  const until = (pred, ms = 8000) => waitFor(async () => { const s = await ex(); return s && s.ok && pred(s) ? s : null; }, ms, 150);

  // A -----------------------------------------------------------------------------------------------------------------------
  const a0 = await ex();
  check('A: the shared-scope script loaded (askExplainerDisplay is defined in the real window)', a0.scope === true);
  check('A: the host already sends the explainer\'s frame (asleep, no panel open, counts 0 and 0)', !!a0.frame && a0.frame.state === 'sleeping' && a0.frame.panels === 0 && a0.frame.counts && a0.frame.counts.questions === 0 && a0.frame.counts.places === 0, JSON.stringify(a0.frame));
  check('A: not on the roster until it is named (neither tab)', a0.card === null && !a0.order.includes('ask-explainer'));
  await exDo({ op: 'tab', tab: 'inactive' });
  check('A: ... nor on Inactive', (await ex()).card === null);
  await exDo({ op: 'tab', tab: 'active' });

  // The Ask tab shares a group with the Agents tab by default, so looking at the roster would hide the panel (and put the explainer on
  // Inactive: "open" is on screen). Give the panel a cell of its own, as the design says it can have, so both are on screen at once.
  await view(app, 'dock', { id: 'ask', target: { edge: 'left' } });
  await view(app, 'select', { id: 'ask' });
  await view(app, 'select', { id: 'agents' });
  const s1 = await waitFor(async () => { const s = await st(); return s && s.ok && s.shown && s.portraits && s.portraits.suggestions.length === 2 ? s : null; }, 20000, 200);
  check('A: the Ask panel opens on the naming card', !!s1 && s1.view === 'naming');
  if (!s1) return;
  await doIt({ op: 'click', act: 'chip', text: 'Ada' });
  await doIt({ op: 'click', act: 'face', text: '' });
  await doIt({ op: 'click', act: 'name-save' });
  await waitFor(async () => (await st()).view === 'empty', 8000, 150);
  await exDo({ op: 'fakeAgent', agent: 'miguel', state: 'working' });
  await exDo({ op: 'fakeAgent', agent: 'zed', state: 'sleeping' });
  const a1 = await until(s => s.card !== null && s.frame && s.frame.panels >= 1);
  check('A: once named, with the panel open, it is on the Active tab', !!a1, JSON.stringify(a1 && a1.frame));
  if (!a1) return;
  check('A: tagged "local helper"; Persona mode shows its name big and its role small', a1.card.tag === 'local helper' && a1.card.name === 'Ada' && a1.card.alt === 'Ask the repo', JSON.stringify([a1.card.tag, a1.card.name, a1.card.alt]));
  check('A: the card shows the picture picked on the naming card (naomi\'s), the same as the panel header', a1.card.hasFace === true && /naomi/.test(a1.card.faceSrc || ''), String(a1.card.faceSrc));
  check('A: asleep, no badge; the counts read "0 questions · 0 places opened"', a1.card.state === 'sleeping' && a1.card.badge === null && a1.card.counts === '0 questions · 0 places opened', JSON.stringify([a1.card.state, a1.card.counts]));
  check('A: sorted like an agent: the working agent first, then the others by state', a1.order.indexOf('miguel') < a1.order.indexOf('ask-explainer'), JSON.stringify(a1.order));
  check('A: the panel header wears the same ring state (asleep), and offers a 🏅', !!a1.header && a1.header.state === 'sleeping' && a1.header.medalBtn === true, JSON.stringify(a1.header));
  await exDo({ op: 'names', mode: 'role' });
  const a2 = await until(s => s.card && s.card.name === 'Ask the repo');
  check('A: Role mode shows "Ask the repo" big and its name small', !!a2 && a2.card.alt === 'Ada', JSON.stringify(a2 && [a2.card.name, a2.card.alt]));
  await exDo({ op: 'names', mode: 'name' });
  await exDo({ op: 'search', q: 'local helper' });
  const a3 = await until(s => s.card !== null);
  check('A: the roster search finds it by "local helper"', !!a3);
  await exDo({ op: 'search', q: 'zzz-nothing' });
  check('A: ... and not by something else', (await until(s => s.card === null, 4000)) !== null);
  await exDo({ op: 'search', q: '' });
  await shot('gamify-A-roster.png');

  // B -----------------------------------------------------------------------------------------------------------------------
  await doIt({ op: 'type', text: 'Where is the lock released?' });
  await doIt({ op: 'submit' });
  const b1 = await until(s => s.card && s.card.state === 'working', 15000);
  check('B: asking: the card goes working', !!b1);
  const b2 = await until(s => s.card && s.card.detail === 'writing', 15000);
  check('B: ... with the writing badge ✏️ and "writing the explanation" under the name', !!b2 && b2.card.badge && b2.card.badge.icon === '✏️' && /writing the explanation/.test(b2.card.words), JSON.stringify(b2 && [b2.card.badge, b2.card.words]));
  check('B: the panel header wears the same state and badge', !!b2 && b2.header && b2.header.state === 'working' && b2.header.detail === 'writing' && b2.header.badge && b2.header.badge.icon === '✏️', JSON.stringify(b2 && b2.header));
  check('B: the working ring is drawn on the card and on the header portrait (a real box-shadow)', !!b2 && /rgb|#/.test(b2.card.ringShadow) && b2.card.ringShadow !== 'none' && b2.header.ringShadow !== 'none', JSON.stringify(b2 && [b2.card.ringShadow, b2.header.ringShadow]));
  check('B: a working explainer sorts with the working agents (before the sleeping ones)', !!b2 && b2.order.indexOf('ask-explainer') < b2.order.indexOf('zed'), JSON.stringify(b2 && b2.order));
  await shot('gamify-B-writing.png');
  const b3 = await until(s => s.card && s.card.state === 'sleeping' && /^1 question/.test(s.card.counts || ''), 20000);
  check('B: the answer lands: asleep again, "1 question · 0 places opened"', !!b3, JSON.stringify(b3 && [b3.card.state, b3.card.counts]));
  if (!b3) return;
  const a3s = await waitFor(async () => { const s = await st(); return s.view === 'answer' ? s : null; }, 8000, 200);
  check('B: the answer is on screen', !!a3s);
  if (!a3s) return;

  // C -----------------------------------------------------------------------------------------------------------------------
  await doIt({ op: 'click', act: 'open', text: 'lib/lock.js:6' });
  const c1 = await until(s => s.card && s.card.state === 'happy', 5000);
  check('C: opening a place it found makes it happy (card and header)', !!c1 && c1.header.state === 'happy', JSON.stringify(c1 && [c1.card.state, c1.header]));
  check('C: ... "1 place opened"', !!c1 && /1 place opened/.test(c1.card.counts || ''), c1 && c1.card.counts);
  await shot('gamify-C-happy.png');
  const c2 = await until(s => s.card && s.card.state === 'sleeping', 14000);
  check('C: 8 seconds later it sleeps again', !!c2);

  // D -----------------------------------------------------------------------------------------------------------------------
  await exDo({ op: 'cardMedal' });
  const d1 = await until(s => s.menu && s.menu.hidden === false, 4000);
  check('D: the card\'s 🏅 opens the give menu, titled with its name', !!d1 && /Give Ada a medal/.test(d1.menu.text), d1 && d1.menu.text.slice(0, 80));
  await exDo({ op: 'giveMedal', kind: 'fast', reason: 'Found the lock quickly' });
  const d2 = await until(s => /🏅 1/.test(s.card ? s.card.chip || '' : ''), 5000);
  check('D: a medal from the card: the chip counts it', !!d2 && d2.medalCount === 1, d2 && String(d2.card.chip));
  await exDo({ op: 'headerMedal' });
  const d3 = await until(s => s.menu && s.menu.hidden === false, 4000);
  check('D: the panel header\'s 🏅 opens the same menu, titled with its name', !!d3 && /Give Ada a medal/.test(d3.menu.text));
  await exDo({ op: 'giveMedal', kind: 'spot-on', reason: '' });
  const d4 = await until(s => /🏅 2/.test(s.card ? s.card.chip || '' : ''), 5000);
  check('D: a medal from the panel: two medals on the card', !!d4);
  await exDo({ op: 'rightClick' });
  const d5 = await until(s => s.menu && s.menu.hidden === false, 4000);
  check('D: a right-click on the card opens the menu too', !!d5);
  await sleep(100);
  await exDo({ op: 'clickCard' });
  const d6 = await until(s => s.log.open && s.log.agent === 'ask-explainer', 5000);
  check('D: a click on the card opens its page: the counts', !!d6 && /1\s*question/.test(d6.log.text) && /1\s*place/.test(d6.log.text), d6 && d6.log.text.slice(0, 160));
  check('D: ... and the medal shelf with the reason, under Ada\'s name', !!d6 && /Found the lock quickly/.test(d6.log.shelf || '') && /Great work|Fast/.test(d6.log.shelf || ''), d6 && String(d6.log.shelf).slice(0, 200));
  await shot('gamify-D-log.png');
  await exDo({ op: 'removeMedal' });
  await exDo({ op: 'removeMedal' });
  const d7 = await until(s => s.medalCount === 1, 5000);
  check('D: a medal comes off in two clicks', !!d7 && /🏅 1/.test(d7.card.chip || ''), d7 && String(d7.card.chip));
  await exDo({ op: 'closeLog' });
  check('D: the page closes', (await until(s => !s.log.open, 4000)) !== null);

  // E -----------------------------------------------------------------------------------------------------------------------
  await doIt({ op: 'settings', name: 'Grace' });
  const e1 = await until(s => s.card && s.card.name === 'Grace', 6000);
  check('E: a rename changes the card\'s name', !!e1);
  check('E: ... and keeps the medals and the counts', !!e1 && /🏅 1/.test(e1.card.chip || '') && e1.card.counts === '1 question · 1 place opened', e1 && JSON.stringify([e1.card.chip, e1.card.counts]));

  // F -----------------------------------------------------------------------------------------------------------------------
  await fake.close();
  await doIt({ op: 'type', text: 'Where is the toolbar rendered?' });
  await doIt({ op: 'submit' });
  const f1 = await until(s => s.card && s.card.state === 'stressed', 30000);
  check('F: with Ollama stopped it is stressed, with the ring', !!f1 && f1.card.ringShadow !== 'none', f1 && f1.card.ringShadow);
  check('F: ... the panel header wears the same', !!f1 && f1.header && f1.header.state === 'stressed', f1 && JSON.stringify(f1.header));
  check('F: a failed answer is not counted as a question answered', !!f1 && /^1 question/.test(f1.card.counts || ''), f1 && f1.card.counts);
  await shot('gamify-F-stressed.png');

  // G -----------------------------------------------------------------------------------------------------------------------
  await view(app, 'hide', { id: 'ask' });
  const g1 = await until(s => s.frame && s.frame.panels === 0 && s.card === null, 8000);
  check('G: with no Ask panel open, it leaves the Active tab', !!g1, JSON.stringify(g1 && g1.frame));
  await exDo({ op: 'tab', tab: 'inactive' });
  const g2 = await until(s => s.card !== null, 5000);
  check('G: ... and is on Inactive, with its counts and its medal', !!g2 && g2.card.state === 'inactive' && /1 question/.test(g2.card.counts || '') && /🏅 1/.test(g2.card.chip || ''), g2 && JSON.stringify([g2.card.state, g2.card.counts, g2.card.chip]));
  await shot('gamify-G-inactive.png');
  await exDo({ op: 'tab', tab: 'active' });
  await view(app, 'show', { id: 'ask' });
  const g3 = await until(s => s.frame && s.frame.panels === 1 && s.card !== null, 10000);
  check('G: shown again: back on Active', !!g3);

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
