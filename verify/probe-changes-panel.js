'use strict';
/**
 * PROBE: the Changes panel (BACKLOG #119 A3) in a REAL window with a REAL host.  (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-changes-panel.js     (exit 0 = every check held)
 *   CHANGES_PROBE_SHOTS=<dir>                                          keep the screenshots there
 *
 * The unit tests pin what git's output PARSES to (test/changes-parse.test.js), what the service ANSWERS on a real repository
 * (test/changes-service.test.js) and what the panel and the reader DO with a stub document (test/changes-display.test.js,
 * test/changes-reader.test.js). None of them can see the page: renderer scripts share one global scope (CLAUDE.md), so a module
 * can load in a test and still abort in the window. This draws the real panel from a real host over a throwaway repository
 * that has a develop branch, a lane branch with a commit, and a dirty worktree, and checks:
 *
 *   1  the panel lists the dirty worktree: the same files and the same +/- counts as `git diff --numstat HEAD` (the oracle is
 *      git, run by this probe), an untracked file as an add with its line count, a deleted file as D, a binary file as `bin`
 *   2  the default scope is the working tree (the tree is dirty), the summary line adds up, the active scope button is lit
 *   3  `vs develop` lists the lane's commit as well as the dirty edits, and says so in its label
 *   4  a click on a file opens the reader's side-by-side Compare: the BASE line on the left, the NEW line on the right
 *   5  the keyboard: ArrowDown moves the selection, Enter opens it; `j` / `k` walk the hunks of the open file
 *   6  comment to prompt: a stand-in CLI box (verify/lib/fake-claude-box.js) holds exactly `In <path>:<line> - <comment>`
 *      after Enter in the comment field, and NOTHING is submitted; two queued comments are typed as one line
 *   7  a file added after the list was drawn appears after a refresh
 *   8  a deleted file is compared against nothing (every line removed); a new file is all additions
 *   9  a screenshot of the panel with the Compare open
 *
 * NOT done here: the hook-driven `changed` push (two seconds after an Edit / Write / Bash). The window under test has no real
 * Claude Code to fire hooks; test/changes-notifier.test.js pins the debounce and test/changes-wiring.test.js the wiring.
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_*
 * variable is stripped from the window under test, then only the probe's own are set; the repo, registry and user data are temp
 * folders. Only PIDs this probe started are killed. Electron is launched only through verify/lib/launch-electron.js (it takes
 * the machine-wide heavy lock).
 */

const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const LAYOUT_FILE = path.join(HARNESS_DIR, 'state', 'layout-global.json');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-changes-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const userData = path.join(tmp, 'user-data');
const shots = process.env.CHANGES_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false', ...args],
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

const LAYOUT_BACKUP = `${LAYOUT_FILE}.changes-probe-backup`;
let movedAside = false;
function setAsideLayout() {
  if (fs.existsSync(LAYOUT_FILE)) { fs.renameSync(LAYOUT_FILE, LAYOUT_BACKUP); movedAside = true; }
}
function restoreLayout() {
  try { fs.rmSync(LAYOUT_FILE, { force: true }); } catch { /* gone */ }
  if (movedAside) { try { fs.renameSync(LAYOUT_BACKUP, LAYOUT_FILE); } catch (e) { console.log(`(could not restore ${LAYOUT_FILE}: ${e.message})`); } }
}

async function launchApp(cwd) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  // Launched from inside a harness tab, this process inherits that tab's CLAUDE_CUSTOM_* identity and Claude Code's
  // ELECTRON_RUN_AS_NODE: none of it may reach the window under test.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CUSTOM_') && k !== 'ELECTRON_RUN_AS_NODE'));
  const env = {
    ...inherited,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
    CLAUDE_CUSTOM_GIT_PROJECTS_DIR: path.join(tmp, 'projects'),
  };
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${path.join(userData, String(port))}`], { cwd: ROOT, env },
    { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_GIT_PROJECTS_DIR', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
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
const rp = (app, what, args = {}) => view(app, 'repoProbe', { what, ...args });
const cp = (app, what, args = {}) => view(app, 'changesProbe', { what, ...args });

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
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
hygiene.addCleanup(restoreLayout);

async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? v : null;
    // 150s: a window on a busy machine can take half a minute to connect
  }, 150000);
}

// ---- the stand-in CLI box ----

const boxCtl = path.join(tmp, 'box-ctl.json');
const boxLog = path.join(tmp, 'box-submitted.log');
const boxLine = () => { try { return JSON.parse(fs.readFileSync(`${boxLog}.line`, 'utf8')); } catch { return null; } };
const submitted = () => { try { return fs.readFileSync(boxLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

// ---- the fixture ----

const APP_JS = ["'use strict';", "const greeting = 'hello';", 'function add(a, b) {', '  return a - b;', '}', 'function twice(n) {', '  return n * 2;', '}', 'module.exports = { add, twice, greeting };', ''].join('\n');
const DASH = String.fromCharCode(0x2014);

function makeRepo() {
  fs.mkdirSync(path.join(dev, 'src'), { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dev, 'README.md'), '# probe repo\n\nA fixture.\n');
  fs.writeFileSync(path.join(dev, 'src', 'app.js'), APP_JS);
  fs.writeFileSync(path.join(dev, 'src', 'old.txt'), 'going away\nsecond line\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'base');
  // the lane: one commit
  git(dev, 'checkout', '-q', '-b', 'feat/lane');
  fs.writeFileSync(path.join(dev, 'README.md'), '# probe repo\n\nA fixture, now with a lane.\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'lane: readme');
  // the dirty worktree: an edit in two places (two hunks), a deleted file, a new file, a binary file
  fs.writeFileSync(path.join(dev, 'src', 'app.js'), APP_JS.replace('return a - b;', 'return a + b;').replace('return n * 2;', 'return n * 3;\n  // tripled'));
  fs.rmSync(path.join(dev, 'src', 'old.txt'));
  fs.writeFileSync(path.join(dev, 'src', 'new.js'), 'exports.fresh = true;\nexports.second = 2;\nexports.third = 3;\n');
  fs.writeFileSync(path.join(dev, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00]));
}

// the oracle: git's own numbers for the dirty tree
function oracle() {
  const out = {};
  for (const line of git(dev, 'diff', '--numstat', 'HEAD').split('\n').filter(Boolean)) {
    const [a, d, p] = line.split('\t');
    out[p] = { add: a === '-' ? 'bin' : `+${a}`, del: d === '-' ? '' : `\u2212${d}` };
  }
  return out;
}

const rowOf = (s, p) => (s && s.rows || []).find(r => r.path === p) || null;

async function main() {
  makeRepo();
  setAsideLayout();
  const app = await launchApp(container);
  const ready = await viewReady(app);
  check('the window came up with a session and the probe hook', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;

  await view(app, 'move', { id: 'changes', target: 'left' });
  const docked = await view(app, 'state');
  check('the Changes module is in a dock group (moved to the left edge)', docked.groups.some(g => g.tabs.includes('changes')), JSON.stringify(docked.groups.map(g => g.tabs)));

  // 1 + 2 ----------------------------------------------------------------------------
  const first = await waitFor(async () => { const s = await cp(app, 'state'); return s && s.ok && s.rows.length >= 4 ? s : null; }, 25000);
  check('1: the panel lists the changed files', !!first, JSON.stringify(await cp(app, 'state')).slice(0, 500));
  if (!first) { console.log(`      window log tail: ${app.out.slice(-1200)}`); return; }
  const o = oracle();
  const tracked = Object.keys(o).filter(p => p !== 'logo.bin');
  check('1: every tracked file git reports is listed with git\'s own +/- counts',
    tracked.every(p => { const r = rowOf(first, p); return r && r.add === o[p].add && r.del === o[p].del; }),
    JSON.stringify(tracked.map(p => [p, o[p], rowOf(first, p) && [rowOf(first, p).add, rowOf(first, p).del]])));
  check('1: the untracked file is an add with its line count, the deleted file is D, the binary file says bin',
    (rowOf(first, 'src/new.js') || {}).status === 'A' && (rowOf(first, 'src/new.js') || {}).add === '+3'
    && (rowOf(first, 'src/old.txt') || {}).status === 'D' && (rowOf(first, 'logo.bin') || {}).add === 'bin',
    JSON.stringify(first.rows));
  check('2: the default scope is the working tree (the tree is dirty) and its button is the lit one', first.scope === 'working' && first.asked === 'auto', `${first.scope} / ${first.asked}`);
  check('2: the summary line adds the rows up', /^\d+ files? \u00b7 \+\d+ \u2212\d+/.test(first.summary) && Number(first.summary.split(' ')[0]) === first.rows.length, first.summary);

  // 3 --------------------------------------------------------------------------------
  await cp(app, 'clickScope', { scope: 'branch' });
  const branch = await waitFor(async () => { const s = await cp(app, 'state'); return s.scope === 'branch' && rowOf(s, 'README.md') ? s : null; }, 15000);
  check('3: `vs develop` also lists the lane\'s commit (README.md) next to the dirty edits', !!branch && !!rowOf(branch, 'src/app.js'), JSON.stringify(branch && branch.rows.map(r => r.path)));
  check('3: ...and names its base', branch && branch.base === 'develop', branch && branch.base);
  await cp(app, 'clickScope', { scope: 'working' });
  await waitFor(async () => { const s = await cp(app, 'state'); return s.scope === 'working' ? s : null; }, 15000);

  // 4 --------------------------------------------------------------------------------
  await cp(app, 'clickRow', { path: 'src/app.js' });
  const cmp = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.open && s.mode === 'changes' && s.compareShown && s.compareRows.length ? s : null; }, 15000);
  check('4: a click opens the reader in the Compare view', !!cmp, JSON.stringify(await rp(app, 'reader.state')).slice(0, 500));
  if (!cmp) return;
  const changeRow = cmp.compareRows.find(r => r.startsWith('sbs-row change|') && r.includes('a - b'));
  check('4: the changed line shows the BASE text (a - b) and the NEW text (a + b) in one row', !!changeRow && changeRow.includes('a + b'), JSON.stringify(cmp.compareRows));
  check('4: the head says what it is compared against', /HEAD vs now/.test(cmp.meta) && /HEAD against now/.test(cmp.compareTitle), `${cmp.meta} | ${cmp.compareTitle}`);

  // 5 --------------------------------------------------------------------------------
  const sel0 = (await cp(app, 'state')).selected;
  await cp(app, 'key', { key: 'ArrowDown' });
  const sel1 = await waitFor(async () => { const s = await cp(app, 'state'); return s.selected && s.selected !== sel0 ? s.selected : null; }, 5000);
  check('5: ArrowDown moves the selection to the next file', !!sel1, `${sel0} -> ${sel1}`);
  await cp(app, 'key', { key: 'Enter' });
  const opened = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === sel1 && s.mode === 'changes' ? s : null; }, 10000);
  check('5: Enter opens that file in the Compare', !!opened, sel1);
  await cp(app, 'clickRow', { path: 'src/app.js' });
  await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === 'src/app.js' && s.change && s.change.hunks >= 2 ? s : null; }, 10000);
  const h1 = await rp(app, 'reader.hunk', { dir: 'next' });
  const h2 = await rp(app, 'reader.hunk', { dir: 'next' });
  const h3 = await rp(app, 'reader.hunk', { dir: 'next' });
  check('5: `j` walks the hunks and wraps (the file has two)', Number.isInteger(h1.cur) && h2.cur > h1.cur && h3.cur === h1.cur, JSON.stringify([h1.cur, h2.cur, h3.cur]));

  // 6 --------------------------------------------------------------------------------
  await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && />\s*$/m.test(r.text || '') ? r : null; }, 15000, 300);
  await view(app, 'gitTermInput', { data: `node "${path.join(ROOT, 'verify', 'lib', 'fake-claude-box.js')}" "${boxCtl}" "${boxLog}"\r` });
  const boxUp = await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && /\u276f/.test(r.text) && /fake claude box/.test(r.text) ? r : null; }, 15000, 300);
  check('6: the stand-in CLI box is drawn in the tab', !!boxUp);
  await rp(app, 'reader.comment', { line: 4, text: 'is this meant to add?' });
  const want = `In src/app.js:4 ${DASH} is this meant to add?`;
  const typed = await waitFor(async () => (boxLine() === want ? true : null), 15000, 300);
  await sleep(1500);   // well past the read-back: an Enter would have landed by now
  check('6: Enter in the comment field leaves exactly `In src/app.js:4 \u2014 <comment>` in the box', !!typed && boxLine() === want, JSON.stringify(boxLine()));
  check("6: ...and NOTHING was submitted: the Enter is the person's", submitted().length === 0, JSON.stringify(submitted()));
  await rp(app, 'reader.comment', { line: 4, text: 'first', send: false });
  await rp(app, 'reader.comment', { line: 7, text: 'second', send: false });
  const queued = await rp(app, 'reader.state');
  check('6: Shift+Enter queues comments (two queued, nothing typed yet)', queued.pending.length === 2 && queued.queueShown && boxLine() === want, JSON.stringify({ pending: queued.pending, box: boxLine() }));
  await rp(app, 'reader.sendQueued');
  const stackWant = `In src/app.js:4 ${DASH} first; In src/app.js:7 ${DASH} second`;
  const stacked = await waitFor(async () => (boxLine() === stackWant ? true : null), 15000, 300);
  await sleep(1500);
  check('6: the queue is typed as ONE line, in order, and still not submitted', !!stacked && submitted().length === 0, JSON.stringify({ box: boxLine(), submitted: submitted() }));

  // 7 --------------------------------------------------------------------------------
  fs.writeFileSync(path.join(dev, 'src', 'later.js'), 'exports.later = 1;\n');
  await cp(app, 'refresh');
  const later = await waitFor(async () => { const s = await cp(app, 'state'); return rowOf(s, 'src/later.js') ? s : null; }, 15000);
  check('7: a file written after the list was drawn appears after a refresh', !!later && rowOf(later, 'src/later.js').status === 'A');

  // 8 --------------------------------------------------------------------------------
  await cp(app, 'clickRow', { path: 'src/old.txt' });
  const del = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === 'src/old.txt' && s.compareShown && s.compareRows.length ? s : null; }, 10000);
  check('8: a deleted file is compared against nothing: every row is a removed line', !!del && del.compareRows.every(r => r.startsWith('sbs-row del|')), JSON.stringify(del && del.compareRows));
  await cp(app, 'clickRow', { path: 'src/new.js' });
  const add = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === 'src/new.js' && s.compareShown && s.compareRows.length ? s : null; }, 10000);
  check('8: a new file is all additions', !!add && add.compareRows.every(r => r.startsWith('sbs-row add|')), JSON.stringify(add && add.compareRows));

  // 9 --------------------------------------------------------------------------------
  await cp(app, 'clickRow', { path: 'src/app.js' });
  await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === 'src/app.js' && s.compareRows.length ? s : null; }, 10000);
  await rp(app, 'reader.hunk', { dir: 'next' });
  await sleep(500);
  const shot = path.join(shots, 'changes-panel.png');
  const r = await command(app, { cmd: 'screenshot', file: shot });
  check('9: a screenshot of the panel with the Compare open', fs.existsSync(shot), `${shot} ${JSON.stringify(r).slice(0, 120)}`);

  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 10000);
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    restoreLayout();
    console.log(`screenshots: ${shots}`);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
