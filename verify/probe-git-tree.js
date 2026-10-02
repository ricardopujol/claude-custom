'use strict';
/**
 * PROBE: the Git panel (layout pass L3, documentation/PLAN_GIT_TREE.md Task 11) in a REAL window
 * with a REAL host.  (re-runnable)
 *
 *   node verify/probe-git-tree.js        (exit 0 = every check held)
 *   GIT_PROBE_SHOTS=<dir>                also keep screenshots there
 *
 * The unit tests pin what the dial and its card SAY (test/git-rings*.test.js); no unit test can see
 * the page. Renderer scripts share one global scope (CLAUDE.md), so a module can load in a test and
 * still abort in the window. This draws the real panel from a real host answering `git-tree` for a
 * throwaway repo, and checks:
 *
 *   1  the Git module opens and the host's answer becomes a dial: one spoke per branch
 *   2  colors and tips: merged / unmerged, a square with a ring for the open worktree, dashed for
 *      no token record (this repo has no transcripts), the hub and the footer
 *   3  hovering a spoke shows its card: name, PR and state, what it was for, inside the panel
 *   4  pinning the open worktree's spoke offers Jump to its tab, and the jump selects that tab
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE
 * is deleted; registry, portraits, uploads and user data are temp folders; the repo is a temp git
 * repo. The install's global layout file is moved aside for the run and put back.
 */

const { spawn, execFileSync } = require('child_process');
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-git-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featB = path.join(container, 'feat-b');
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

const LAYOUT_BACKUP = `${LAYOUT_FILE}.git-probe-backup`;
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
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDE_CUSTOM_PORT;
  delete env.CLAUDE_CUSTOM_TOKEN;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawn(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env });
  hygiene.registerSpawnedTree(child.pid);
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

const seenPids = new Set();
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
  for (const id of hostsOfThisRun()) seenPids.add(id.pid);
  for (const pid of seenPids) { try { require(path.join(ROOT, 'host', 'kill-tree')).killPidTree(pid); } catch { /* gone */ } }
}
hygiene.addCleanup(killEverything);
hygiene.addCleanup(restoreLayout);

async function viewReady(app) {
  return waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.add(h.pid);
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started) return null;
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? v : null;
  }, 45000);
}

// A repo with one of each: feat/a merged by a PR merge commit (its title in the body), feat/b an
// open worktree one commit ahead, spike/c ahead with no worktree.
function makeRepo() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'checkout', '-q', '-b', 'feat/a');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'feat(a): the first lane');
  git(dev, 'checkout', '-q', 'develop');
  git(dev, 'merge', '-q', '--no-ff', 'feat/a', '-m', 'Merge pull request #1 from probe/feat/a', '-m', 'feat(a): the first lane');
  git(dev, 'branch', '-q', 'spike/c');
  git(dev, 'checkout', '-q', 'spike/c');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'spike: measure a thing');
  git(dev, 'checkout', '-q', 'develop');
  git(dev, 'worktree', 'add', '-q', featB, '-b', 'feat/b');
  git(featB, 'commit', '-q', '--allow-empty', '-m', 'feat(b): the open lane');
}

async function main() {
  makeRepo();
  setAsideLayout();
  const app = await launchApp(container);
  const ready = await viewReady(app);
  check('the window came up with a session and the probe hook', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;

  // 1 -----------------------------------------------------------------------------
  const where = Object.keys(ready.zones).find(z => ready.zones[z].tabs.includes('git'));
  check('1: the Git module is in the dock (new modules land on the right)', where === 'right', String(where));
  await view(app, 'select', { id: 'git' });
  const st = await waitFor(async () => {
    const s = await view(app, 'gitState');
    return s && s.ok && s.spokes.length === 3 ? s : null;
  }, 20000);
  check('1: the host answered and the panel drew one spoke per branch', !!st,
    st ? '' : JSON.stringify(await view(app, 'gitState')).slice(0, 400));
  if (!st) return;
  check('1: no status line is left (no error, no "reading")', st.status === '', JSON.stringify(st.status));
  check('1: the dial is visible in the panel', !!st.svg && st.svg.width > 100 && st.svg.height > 100, JSON.stringify(st.svg));

  // 2 -----------------------------------------------------------------------------
  const spoke = n => st.spokes.find(s => s.name === n) || {};
  check('2: feat/a is merged, feat/b and spike/c are unmerged',
    / merged/.test(spoke('feat/a').cls) && / unmerged/.test(spoke('feat/b').cls) && / unmerged/.test(spoke('spike/c').cls),
    st.spokes.map(s => `${s.name}: ${s.cls}`).join('; '));
  check('2: the open worktree has a square tip with a ring; the others a round tip, no ring',
    spoke('feat/b').ring && spoke('feat/b').square && !spoke('feat/a').ring && !spoke('spike/c').square,
    JSON.stringify(st.spokes));
  check('2: no transcripts for this repo: every spoke is dashed (unknown, not 0)', st.spokes.every(s => s.dashed));
  check('2: the hub is develop; the footer counts 3 branches with no token record yet',
    st.hub === 'develop' && /3 branches · no token record yet/.test(st.foot) && /1 merged · 0 open · 2 unmerged · 0 deleted/.test(st.foot),
    `${st.hub} / ${st.foot}`);
  check('2: the open worktree is labelled', st.labels.some(l => l.includes('b')), JSON.stringify(st.labels));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '2-dial.png') });

  // 3 -----------------------------------------------------------------------------
  const h = await view(app, 'gitHover', { name: 'feat/a' });
  check('3: hovering feat/a shows its card', h.ok && !h.hidden, JSON.stringify(h).slice(0, 300));
  check('3: ...with its PR and state, what it was for, and no token record',
    /feat\/a/.test(h.text) && /#1 · merged/.test(h.text) && /The first lane/.test(h.text) && /no token record/.test(h.text), h.text);
  check('3: ...inside the panel', h.card.left >= h.panel.left - 1 && h.card.right <= h.panel.right + 1
    && h.card.top >= h.panel.top - 1 && h.card.bottom <= h.panel.bottom + 1, `${JSON.stringify(h.card)} in ${JSON.stringify(h.panel)}`);
  check('3: a hover card offers no jump (it can\'t be clicked)', !h.jump);

  // 3b ----------------------------------------------------------------------------
  // The default right zone is 180px: the dial is drawn at ~45% and its own text would be ~4px.
  // There, the dial's text is hidden (the card and footer talk); in a big zone it shows.
  const scaleOf = s => Math.min(s.svg.width / 360, s.svg.height / 430);
  check('3b: in the narrow right zone the dial hides its own text', st.narrow && !st.hubTextShown && scaleOf(st) < 0.75,
    `narrow ${st.narrow}, scale ${scaleOf(st).toFixed(2)}`);
  // a move shows the module; selecting it again would collapse the zone (L1's rule)
  await view(app, 'move', { id: 'git', target: 'bottom' });
  const wide = await waitFor(async () => {
    const s = await view(app, 'gitState');
    return s && s.ok && s.spokes.length === 3 && s.svg && s.svg.width > 300 ? s : null;
  }, 8000);
  const vs = await view(app, 'state');
  check('3b: moved to the bottom zone, the dial is redrawn there', !!wide, wide ? '' : JSON.stringify({ git: await view(app, 'gitState'), bottom: vs.zones && vs.zones.bottom, shown: vs.shown }).slice(0, 700));
  if (wide) {
    check('3b: ...and its text follows its size (shown at 75% or more, hidden below)',
      wide.narrow === (scaleOf(wide) < 0.75) && wide.hubTextShown === !wide.narrow,
      `narrow ${wide.narrow}, scale ${scaleOf(wide).toFixed(2)}`);
    const hw = await view(app, 'gitHover', { name: 'feat/a' });
    check('3b: ...and the card still sits inside the panel', hw.ok && !hw.hidden && hw.card.left >= hw.panel.left - 1
      && hw.card.right <= hw.panel.right + 1 && hw.card.bottom <= hw.panel.bottom + 1, `${JSON.stringify(hw.card)} in ${JSON.stringify(hw.panel)}`);
    await command(app, { cmd: 'screenshot', file: path.join(shots, '3b-bottom.png') });
  }
  await view(app, 'move', { id: 'git', target: 'right' });
  await waitFor(async () => { const s = await view(app, 'gitState'); return s && s.spokes.length === 3 && s.narrow ? s : null; }, 8000);

  // 4 -----------------------------------------------------------------------------
  const p = await view(app, 'gitPin', { name: 'feat/b' });
  check('4: pinning the open worktree\'s spoke offers Jump to its tab', p.ok && !p.hidden && p.jump, JSON.stringify(p).slice(0, 300));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '4-pinned.png') });
  const before = (await command(app, { cmd: 'state' })).selectedKey;
  await view(app, 'gitJump');
  const after = await waitFor(async () => {
    const s = await command(app, { cmd: 'state' });
    return s && s.selectedKey && s.selectedKey !== before ? s.selectedKey : null;
  }, 8000);
  check('4: the jump selects the feat-b tab', !!after && /feat-b$/i.test(after), `${before} -> ${after}`);
  // Selecting it started its host: wait for it, so the cleanup knows its pid.
  await waitFor(async () => {
    const s = await command(app, { cmd: 'state' });
    const h = s && s.hosts && s.hosts.find(x => x.key === s.selectedKey);
    if (h && Number.isInteger(h.pid)) { seenPids.add(h.pid); return true; }
    return null;
  }, 15000);

  await command(app, { cmd: 'quit' });
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
