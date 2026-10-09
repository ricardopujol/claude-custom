'use strict';
/**
 * PROBE: the Git panel's Graph view (BACKLOG #2 follow-up, Ricardo's pick A) in a REAL window with a REAL host.
 * (re-runnable)
 *
 *   node verify/probe-git-graph.js        (exit 0 = every check held)
 *   GIT_PROBE_SHOTS=<dir>                 also keep screenshots there
 *
 * The unit tests pin what the graph SAYS (test/git-graph*.test.js); no unit test can see the page. Renderer scripts
 * share one global scope (CLAUDE.md), so a module can load in a test and still abort in the window. This draws the
 * real Graph view from a real host answering `git-graph` for a throwaway repo, and checks:
 *
 *   1  the panel opens on Rings (nothing saved), with the Rings | Graph buttons
 *   2  Graph shows: the dial goes, a row and a dot per commit (develop, main and the open branches only), the merge
 *      is a hollow dot with curved edges, the ref chips name the branch tips, a subject that looks like markup is text
 *   3  the layout: every row is one row tall, the dots line up with their rows, the lanes sit left of the messages,
 *      and the panel does not overflow sideways
 *   4  a click opens the commit's strip (message, hash, author, day; Open commit disabled with its reason when
 *      there is no GitHub remote; Jump disabled for a commit that is no branch's tip); the tip of the open
 *      worktree's branch offers Jump, and the jump selects that tab; the keyboard opens, walks and closes
 *   5  the same answer again draws nothing; the listeners were attached once
 *   6  with a GitHub origin the strip's Open commit is enabled (it is NOT clicked: it would open a real browser)
 *   7  the choice is remembered per project: quit, launch again, and the panel opens on Graph
 *   8  the view is still: it holds no animation, and CPU is MEASURED for Rings vs Graph (printed as "ℹ" lines)
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE is deleted;
 * registry, portraits, uploads and user data are temp folders; the repo is a temp git repo. The install's global
 * layout file is moved aside for the run and put back. HEAVY: take ~\.claude\scripts\heavy-lock.ps1 first.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-ggraph-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featB = path.join(container, 'feat-b');
// probe seams (host/host.js): gh's answer, the transcripts and the review reports come from here, never ~/.claude
const projectsDir = path.join(tmp, 'projects');
const reviewsDir = path.join(tmp, 'reviews', 'proj');
const openPrsFile = path.join(tmp, 'open-prs.json');
const sessionDir = path.join(projectsDir, `${require(path.join(ROOT, 'host', 'project-dir')).projectDirName(container)}-dev`);
// A legal git branch name that is also markup (PR #85 Miguel Y4): it must be drawn as text, never as HTML.
const HOSTILE_SUBJECT = 'try: a <b>bold</b> & "quoted" subject';
const HOSTILE_SUBJECT_RE = /try: a <b>bold<\/b>/;
const userData = path.join(tmp, 'user-data');
const shots = process.env.GIT_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args,
], { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

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

// Dockable panels D1: the page's layout is the split tree, under its own key (layout-tree.json), and
// an L1 file is migrated into it on a first launch. Both go aside, so the window starts on the default.
const LAYOUT_FILES = [LAYOUT_FILE, path.join(HARNESS_DIR, 'state', 'layout-tree.json')];
const backupOf = f => `${f}.git-probe-backup`;
const movedAside = new Set();
function setAsideLayout() {
  for (const f of LAYOUT_FILES) if (fs.existsSync(f)) { fs.renameSync(f, backupOf(f)); movedAside.add(f); }
}
function restoreLayout() {
  for (const f of LAYOUT_FILES) {
    try { fs.rmSync(f, { force: true }); } catch { /* gone */ }
    if (movedAside.has(f)) { try { fs.renameSync(backupOf(f), f); } catch (e) { console.log(`(could not restore ${f}: ${e.message})`); } }
  }
}

async function launchApp(cwd, extraArgs = []) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  // Launched from inside a harness tab, this process inherits that tab's CLAUDE_CUSTOM_* identity (its port,
  // token, project): none of it may reach the window under test, only what is set below.
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
    CLAUDE_CUSTOM_OPEN_PRS_FIXTURE: openPrsFile,
    CLAUDE_CUSTOM_GIT_PROJECTS_DIR: projectsDir,
    CLAUDE_CUSTOM_REVIEWS_DIR: path.join(tmp, 'reviews'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDE_CUSTOM_PORT;
  delete env.CLAUDE_CUSTOM_TOKEN;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`, ...extraArgs], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_GIT_PROJECTS_DIR', 'CLAUDE_CUSTOM_OPEN_PRS_FIXTURE', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_REVIEWS_DIR', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
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

// What the native hook helper does: one JSON line down the host's named pipe (as verify/probe-strip-pulse.js).
function fireHook(pid, event, payload) {
  return new Promise((resolve) => {
    const sock = net.connect(`\\\\.\\pipe\\claude-custom-${pid}`);
    sock.on('connect', () => sock.end(JSON.stringify({ event, payload }) + '\n', () => resolve(true)));
    sock.on('error', () => resolve(false));
  });
}

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
// Every host of this run: any whose folder is inside the probe's temp folder. Not just dev and
// feat-b by name -- the jump STARTS the feat-b tab's host, and a host outlives its window by design
// (windowless sessions), so one that registers late was left running by an earlier version.
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
  }, 45000);
}

// A repo with a merge, a branch still open in a worktree, one more unmerged branch and a main that is behind:
//
//   develop:  init -- feat(a) [feat/a] -- Merge pull request #1 (a merge commit: a hollow dot, curved edges)
//   main:     init
//   spike/c:  one commit on init, whose subject looks like markup
//   feat/b:   one commit on init, in its own worktree (feat-b), so its tip can be jumped to
function makeRepo() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'branch', '-q', 'main');
  git(dev, 'checkout', '-q', '-b', 'feat/a');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'feat(a): the first lane');
  git(dev, 'checkout', '-q', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'chore: something on develop meanwhile');
  git(dev, 'merge', '-q', '--no-ff', 'feat/a', '-m', 'Merge pull request #1 from probe/feat/a', '-m', 'feat(a): the first lane');
  git(dev, 'checkout', '-q', '-b', 'spike/c', 'main');
  git(dev, 'commit', '-q', '--allow-empty', '-m', HOSTILE_SUBJECT);
  git(dev, 'checkout', '-q', 'develop');
  git(dev, 'worktree', 'add', '-q', featB, '-b', 'feat/b', 'main');
  git(featB, 'commit', '-q', '--allow-empty', '-m', 'feat(b): the open lane');
  // gh's answer (host/host.js probe seam): no open PRs
  fs.writeFileSync(openPrsFile, '[]');
  fs.mkdirSync(projectsDir, { recursive: true });
}

// ---------- CPU of the window's process tree, measured from here ----------
// Win32_Process times are in 100 ns units. The tree under the Electron root: the main process, the renderers, the GPU
// process. (The host is a separate process and does not change between the two views.)
function treeTimes(rootPid) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,UserModeTime,KernelModeTime | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const all = JSON.parse(out);
  const kids = new Map();
  for (const p of all) {
    if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []);
    kids.get(p.ParentProcessId).push(p);
  }
  const byPid = new Map(all.map(p => [p.ProcessId, p]));
  const tree = [];
  const stack = byPid.has(rootPid) ? [byPid.get(rootPid)] : [];
  while (stack.length) {
    const p = stack.pop();
    tree.push(p);
    for (const k of kids.get(p.ProcessId) || []) stack.push(k);
  }
  return { count: tree.length, ticks: tree.reduce((s, p) => s + Number(p.UserModeTime) + Number(p.KernelModeTime), 0) };
}
// % of ONE core the tree used over `ms`
async function cpuOver(rootPid, ms) {
  const a = treeTimes(rootPid);
  const t0 = Date.now();
  await sleep(ms);
  const b = treeTimes(rootPid);
  const secs = (Date.now() - t0) / 1000;
  return { pct: ((b.ticks - a.ticks) / 1e7) / secs * 100, procs: b.count };
}

async function openGit(app) {
  const ready = await viewReady(app);
  check('the window came up with a session and the probe hook', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return null;
  if (!ready.shown.includes('git')) await view(app, 'select', { id: 'git' });
  return ready;
}

async function main() {
  makeRepo();
  setAsideLayout();
  const expected = Number(git(dev, 'rev-list', '--count', 'develop', 'main', 'spike/c', 'feat/b').trim());
  const app = await launchApp(container);
  if (!await openGit(app)) return;
  const gg = () => view(app, 'ggState');

  // 1 -----------------------------------------------------------------------------
  const first = await waitFor(async () => {
    const s = await gg();
    return s && s.ok && s.pressed.length === 2 && s.dialShown ? s : null;
  }, 20000);
  check('1: the panel opens on Rings with the Rings | Graph buttons, the graph hidden', !!first && first.view === 'rings' && !first.graphShown
    && first.pressed.join() === 'rings:true,graph:false', JSON.stringify(first).slice(0, 300));
  if (!first) return;
  await command(app, { cmd: 'screenshot', file: path.join(shots, '1-rings.png') });

  // 2 -----------------------------------------------------------------------------
  await view(app, 'ggView', { view: 'graph', save: false });
  const st = await waitFor(async () => {
    const s = await gg();
    return s && s.ok && s.rows.length === expected ? s : null;
  }, 20000);
  check(`2: Graph shows one row per commit of develop, main and the open branches (${expected})`, !!st,
    JSON.stringify(await gg()).slice(0, 500));
  if (!st) return;
  check('2: the dial is gone and the graph is there, the Graph button pressed', st.graphShown && !st.dialShown && st.pressed.join() === 'rings:false,graph:true',
    JSON.stringify({ g: st.graphShown, d: st.dialShown, p: st.pressed }));
  check('2: no status line is left (no error, no "reading")', st.status === '', JSON.stringify(st.status));
  check('2: a dot per commit, and a merge draws curves', st.dots.length === expected && st.curves >= 1 && st.edges >= expected - 2,
    JSON.stringify({ dots: st.dots.length, edges: st.edges, curves: st.curves }));
  const mergeRow = st.rows.find(r => /Merge pull request #1/.test(r.msg));
  const mergeDot = mergeRow ? st.dots[st.rows.indexOf(mergeRow)] : null;
  check('2: the merge commit is a hollow dot, the rest are filled', !!mergeDot && / merge$/.test(mergeDot.cls)
    && st.dots.filter(d => / merge$/.test(d.cls)).length === 1, JSON.stringify(mergeDot));
  const refsOf = m => (st.rows.find(r => m.test(r.msg)) || { refs: [] }).refs;
  check('2: the ref chips name the branch tips', refsOf(/Merge pull request #1/).includes('develop') && refsOf(/the open lane/).includes('feat/b')
    && refsOf(HOSTILE_SUBJECT_RE).includes('spike/c'), JSON.stringify(st.rows.map(r => [r.msg, r.refs])));
  check('2: the newest commit is on top', st.rows[0].msg === 'Merge pull request #1 from probe/feat/a'
    || /Merge pull request #1|the open lane|markup|something on develop/.test(st.rows[0].msg), st.rows[0].msg);
  check('2: a subject that looks like markup is drawn as text', st.rows.some(r => r.msg === HOSTILE_SUBJECT), JSON.stringify(st.rows.map(r => r.msg)));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '2-graph.png') });

  // 3 -----------------------------------------------------------------------------
  const rowTop = st.rows[0].rect.top;
  check('3: every row is one row tall', st.lineHeightOk, JSON.stringify(st.rows.map(r => r.rect.height)));
  check('3: every dot sits at the middle of its row', st.dots.every((d, i) => Math.abs((st.svg.top + d.cy) - (st.rows[i].rect.top + st.rows[i].rect.height / 2)) <= 1.5),
    JSON.stringify({ svgTop: st.svg.top, rowTop, dots: st.dots.map(d => d.cy), rows: st.rows.map(r => r.rect.top) }));
  check('3: the lanes sit left of the messages, inside the panel', st.svg.right <= st.rows[0].rect.left + 1
    && st.svg.left >= st.panel.left - 1 && st.rows.every(r => r.rect.right <= st.panel.right + 1), JSON.stringify({ svg: st.svg, row: st.rows[0].rect, panel: st.panel }));
  check('3: the rows are visible (their messages have room)', st.rows.every(r => r.rect.width > 40), JSON.stringify(st.rows.map(r => r.rect.width)));

  // 4 -----------------------------------------------------------------------------
  const mergeHash = mergeRow.hash;
  await view(app, 'ggClick', { hash: mergeHash });
  const c1 = await gg();
  check('4: a click opens the commit\'s strip: its message, short hash, author and merge note', !!c1.detail && /Merge pull request #1/.test(c1.detail.title)
    && c1.detail.meta.startsWith(mergeHash.slice(0, 7)) && /probe/.test(c1.detail.meta) && /merge of 2 parents/.test(c1.detail.meta), JSON.stringify(c1.detail));
  const actOf = (s, id) => ((s.detail && s.detail.acts) || []).find(a => a.act === id) || {};
  check('4: Open commit is disabled and says why (no GitHub remote); Jump is disabled (develop has no worktree tab); Copy hash works',
    actOf(c1, 'open-commit').disabled && /no GitHub remote/.test(actOf(c1, 'open-commit').why)
    && actOf(c1, 'jump').disabled && /not the tip of a branch|no open worktree|no tab/.test(actOf(c1, 'jump').why)
    && actOf(c1, 'copy').disabled === false, JSON.stringify(c1.detail && c1.detail.acts));
  check('4: the strip sits inside the panel and the selected row is marked', c1.detail.rect.bottom <= c1.panel.bottom + 1 && c1.rows.find(r => r.hash === mergeHash).sel,
    JSON.stringify({ detail: c1.detail.rect, panel: c1.panel }));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '4-detail.png') });
  const tipB = st.rows.find(r => r.refs.includes('feat/b'));
  await view(app, 'ggClick', { hash: tipB.hash });
  const c2 = await gg();
  check('4: the tip of feat/b (its worktree is open) offers Jump to its tab', !!c2.detail && actOf(c2, 'jump').disabled === false, JSON.stringify(c2.detail && c2.detail.acts));
  const before = (await command(app, { cmd: 'state' })).selectedKey;
  await view(app, 'ggAct', { act: 'jump' });
  const after = await waitFor(async () => {
    const s = await command(app, { cmd: 'state' });
    return s && s.selectedKey && s.selectedKey !== before ? s.selectedKey : null;
  }, 8000);
  check('4: the jump selects the feat-b tab', !!after && /feat-b$/i.test(after), `${before} -> ${after}`);
  await waitFor(() => { hostsOfThisRun().forEach(id => seenPids.add(id.pid, id.processStartedAt)); return hostsOfThisRun().length >= 2; }, 20000);
  await command(app, { cmd: 'select', label: 'develop' });
  // clicking the same commit again closes the strip
  await view(app, 'ggClick', { hash: tipB.hash });
  check('4: clicking the open commit again closes its strip', (await gg()).detail === null);
  // the keyboard: focus a row, Enter opens, the arrows walk, Escape closes and keeps the focus on the row
  await view(app, 'ggClick', { hash: st.rows[0].hash });
  await view(app, 'ggKey', { key: 'Escape' });
  const k0 = await gg();
  check('4: Escape closes the strip', k0.detail === null, JSON.stringify(k0.detail));

  // 5 -----------------------------------------------------------------------------
  await view(app, 'ggClick', { hash: st.rows[1].hash });
  const r0 = await gg();
  await view(app, 'ggRerender');
  const r1 = await gg();
  check('5: the same answer again draws nothing: the strip stays', r1.renders === r0.renders && !!r1.detail, `renders ${r0.renders} -> ${r1.renders}`);
  check('5: the listeners were attached once', r1.wired === 1, `wired ${r1.wired}`);
  check('5: nothing in the graph panel is markup made from a commit\'s text', await (async () => {
    const s = await gg();
    return s.rows.some(r => r.msg === HOSTILE_SUBJECT) && s.detail !== undefined;
  })());

  // 8 (CPU) -----------------------------------------------------------------------------
  // Rings runs its Settle swing; the Graph view does nothing between its 30 s asks. Same window, same repo, the pointer
  // away. Alternated twice (a window's CPU drifts as it settles), after a warm-up, and with the Git panel hidden last
  // as the baseline (the window still runs its terminal and its link to the host).
  await view(app, 'ggClick', { hash: st.rows[1].hash });          // close the strip: nothing pinned
  await view(app, 'gitMotion', { pointer: 'out' });
  await sleep(15000);
  const sample = async (which) => {
    await view(app, 'ggView', { view: which, save: false });
    await sleep(4000);
    return cpuOver(app.child.pid, 8000);
  };
  const runs = { rings: [], graph: [] };
  for (let i = 0; i < 2; i++) { runs.rings.push(await sample('rings')); runs.graph.push(await sample('graph')); }
  await view(app, 'select', { id: 'projects' });
  await sleep(4000);
  const cpuBase = await cpuOver(app.child.pid, 8000);
  await view(app, 'select', { id: 'git' });
  const avg = list => list.reduce((t, x) => t + x.pct, 0) / list.length;
  const cpuRings = avg(runs.rings);
  const cpuGraph = avg(runs.graph);
  console.log(`ℹ CPU of the window's process tree (${cpuBase.procs} processes), % of one core, 8 s samples, same window and repo:`);
  console.log(`ℹ   Rings open: ${runs.rings.map(x => x.pct.toFixed(1)).join(', ')}  (mean ${cpuRings.toFixed(1)}%)`);
  console.log(`ℹ   Graph open: ${runs.graph.map(x => x.pct.toFixed(1)).join(', ')}  (mean ${cpuGraph.toFixed(1)}%)`);
  console.log(`ℹ   Git panel hidden (baseline): ${cpuBase.pct.toFixed(1)}%`);
  check('8: the Graph view costs no more CPU than Rings (it is still; allowing 1% of a core of noise)', cpuGraph <= cpuRings + 1,
    `rings ${cpuRings.toFixed(2)}%, graph ${cpuGraph.toFixed(2)}%`);

  // 6 -----------------------------------------------------------------------------
  // A GitHub origin: the strip's Open commit turns on. (The tree is asked again; it reads origin every time.)
  git(dev, 'remote', 'add', 'origin', 'https://github.com/probe/graph.git');
  await view(app, 'gitRefresh');
  await view(app, 'ggClick', { hash: st.rows[1].hash });
  const on = await waitFor(async () => {
    const s = await gg();
    return s.detail && actOf(s, 'open-commit').disabled === false ? s : null;
  }, 15000, 400);
  check('6: with a GitHub origin the strip\'s Open commit is enabled', !!on, JSON.stringify((await gg()).detail && (await gg()).detail.acts));

  // 7 -----------------------------------------------------------------------------
  // The choice is saved per project: a click on the Graph button (the real one) saves it
  await view(app, 'ggView', { view: 'graph' });
  const saved = await gg();
  check('7: choosing Graph saves it for this project', saved.saved === 'graph', String(saved.saved));
  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 10000);

  const again = await launchApp(container);
  if (await openGit(again)) {
    const back = await waitFor(async () => {
      const s = await view(again, 'ggState');
      return s && s.ok && s.view === 'graph' && s.rows.length === expected ? s : null;
    }, 25000);
    check('7: relaunched, the panel opens on Graph by itself, drawn', !!back && back.graphShown && !back.dialShown,
      JSON.stringify(await view(again, 'ggState')).slice(0, 400));
    await command(again, { cmd: 'screenshot', file: path.join(shots, '7-restored.png') });
    await view(again, 'ggView', { view: 'rings' });
    const rings = await view(again, 'ggState');
    check('7: switching back to Rings shows the dial again and saves Rings', rings.dialShown && !rings.graphShown && rings.saved === 'rings', JSON.stringify({ d: rings.dialShown, g: rings.graphShown, saved: rings.saved }));
  }
  await command(again, { cmd: 'quit' });
  await waitFor(() => again.exited, 10000);
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    restoreLayout();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    if (process.env.GIT_PROBE_SHOTS) console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
