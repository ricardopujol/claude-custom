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
 * and, for backlog #46 (the living dial with a drawer):
 *
 *   6  the Settle swing: the dial's clock runs and its angle is 40 deg * sin(2 pi clock / 90 s); it eases
 *      to a stop under a pin (the angle is unchanged across samples) and under the pointer, and picks up
 *      again about 2.5 s after; under prefers-reduced-motion (a second launch) it never moves
 *   7  the drawer shows the pinned branch's facts: purpose, stats, people, and the latest review round per
 *      reviewer with its verdict line ("report, no verdict line" when there isn't one)
 *   8  every action's enabled / disabled state and its reason, for a merged, an open-PR and an unmerged
 *      branch; Open PR follows origin (disabled with no remote, enabled once one is added)
 *   9  live sparks only for MEASURED growth: a first measurement is quiet, a refresh that found new tokens
 *      streams sparks on that branch alone, and they stop
 *  10  Run /merged on an open PR whose session is at rest switches to that tab and its own page types
 *      `/merged` into its box and, once it reads back, presses Enter through the submit gate (BACKLOG #61;
 *      PR #93 R2-1 had left the Enter to the person). A stand-in CLI box
 *      (verify/lib/fake-claude-box.js) runs in feat-b's cmd.exe, and the CLI's hook events go down feat-b's
 *      host pipe, so nothing bills. PR #93 review cases: a main-session turn with no subagent disables it
 *      (Dexter F1); an open dialog still disables it after the tab is looked at (F2); a draft in the box is
 *      cleared and exactly `/merged` is submitted (F3, #61); a double click sends it once more (F4)
 *
 * The Open PR button itself is NOT clicked here: it would open a real browser. Its URL is built and
 * checked by test/pr-url.test.js, and the link gate by test/external-link.test.js.
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE
 * is deleted; registry, portraits, uploads and user data are temp folders; the repo is a temp git
 * repo. The install's global layout file is moved aside for the run and put back.
 */

const { spawn, execFileSync } = require('child_process');
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-git-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const featB = path.join(container, 'feat-b');
// probe seams (host/host.js): gh's answer, the transcripts and the review reports come from here, never ~/.claude
const projectsDir = path.join(tmp, 'projects');
const reviewsDir = path.join(tmp, 'reviews', 'proj');
const openPrsFile = path.join(tmp, 'open-prs.json');
const sessionDir = path.join(projectsDir, `${require(path.join(ROOT, 'host', 'project-dir')).projectDirName(container)}-dev`);
// A legal git branch name that is also markup (PR #85 Miguel Y4): it must be drawn as text, never as HTML.
const HOSTILE = 'feat/<b>x</b>&"q';
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
  // Windows can't hold `<`, `>` or `"` in a loose ref's FILE name, but a packed ref (what a clone or a
  // fetch writes) carries any name check-ref-format allows. So: commit on a plain branch, then
  // re-point that commit from packed-refs under the hostile name.
  git(dev, 'checkout', '-q', '-b', 'tmp-hostile');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'try: a <b>hostile</b> name');
  const sha = git(dev, 'rev-parse', 'HEAD').trim();
  git(dev, 'checkout', '-q', 'develop');
  git(dev, 'branch', '-q', '-D', 'tmp-hostile');
  git(dev, 'pack-refs', '--all');
  fs.appendFileSync(path.join(dev, '.git', 'packed-refs'), `${sha} refs/heads/${HOSTILE}\n`);
  git(dev, 'worktree', 'add', '-q', featB, '-b', 'feat/b');
  git(featB, 'commit', '-q', '--allow-empty', '-m', 'feat(b): the open lane');
  // gh's answer (host/host.js probe seam): feat/b has PR #91 open
  fs.writeFileSync(openPrsFile, JSON.stringify([{ number: 91, title: 'feat(b): the open lane', headRefName: 'feat/b' }]));
  fs.mkdirSync(projectsDir, { recursive: true });
}

async function main() {
  makeRepo();
  setAsideLayout();
  const app = await launchApp(container);
  const ready = await viewReady(app);
  check('the window came up with a session and the probe hook', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;

  // 1 -----------------------------------------------------------------------------
  // Dockable panels D1: the page reports the groups of a split tree; the default layout has one, `right`.
  const home = (ready.groups || []).find(g => g.tabs.includes('git'));
  const where = home ? home.id : null;
  check('1: the Git module is in the dock (new modules land on the right)', where === 'right', String(where));
  await view(app, 'select', { id: 'git' });
  const st = await waitFor(async () => {
    const s = await view(app, 'gitState');
    return s && s.ok && s.spokes.length === 4 ? s : null;
  }, 20000);
  check('1: the host answered and the panel drew one spoke per branch', !!st,
    st ? '' : JSON.stringify(await view(app, 'gitState')).slice(0, 400));
  if (!st) return;
  check('1: no status line is left (no error, no "reading")', st.status === '', JSON.stringify(st.status));
  check('1: the dial is visible in the panel', !!st.svg && st.svg.width > 100 && st.svg.height > 100, JSON.stringify(st.svg));

  // 2 -----------------------------------------------------------------------------
  const spoke = n => st.spokes.find(s => s.name === n) || {};
  check('2: feat/a is merged, feat/b has an open PR (gh answers from the fixture), spike/c is unmerged',
    / merged/.test(spoke('feat/a').cls) && / open/.test(spoke('feat/b').cls) && / unmerged/.test(spoke('spike/c').cls),
    st.spokes.map(s => `${s.name}: ${s.cls}`).join('; '));
  check('2: the open worktree has a square tip with a ring; the others a round tip, no ring',
    spoke('feat/b').ring && spoke('feat/b').square && !spoke('feat/a').ring && !spoke('spike/c').square,
    JSON.stringify(st.spokes));
  check('2: no transcripts for this repo: every spoke is dashed (unknown, not 0)', st.spokes.every(s => s.dashed));
  // gh answers from the fixture here, so the PR count is known. (The "PR status unknown, never 0 open" wording
  // for a gh that fails is pinned by test/git-rings-display.test.js; the host caches gh's answer for a minute,
  // so one window can't flip between the two.)
  check('2: the hub is develop; the footer counts 4 branches, no token record yet, 1 open PR',
    st.hub === 'develop' && /4 branches · no token record yet/.test(st.foot)
      && /1 merged · 1 open · 2 unmerged · 0 deleted/.test(st.foot),
    `${st.hub} / ${st.foot}`);
  // exactly the open PR and the open worktree: feat/b is both
  check('2: the labels are exactly the open-PR / open-worktree lanes', JSON.stringify([...st.labels].sort()) === JSON.stringify(['b #91']),
    JSON.stringify(st.labels));
  check('2 (Miguel Y4): a branch named like markup is drawn as text: its spoke carries the exact name, and no <b> was made',
    st.spokes.some(x => x.name === HOSTILE) && st.boldInPanel === 0, `bold elements: ${st.boldInPanel}`);
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
    if (!(s && s.ok && s.spokes.length === 4 && s.svg && s.svg.width > 300)) return null;
    // settled: the same svg box twice, 300 ms apart. The first frame wider than 300px can be mid-layout,
    // before the zone's height holds it (seen twice: "narrow true, scale 3.25", then 0.19 a moment later).
    await sleep(300);
    const t = await view(app, 'gitState');
    return t && t.svg && JSON.stringify(t.svg) === JSON.stringify(s.svg) ? t : null;
  }, 8000);
  const vs = await view(app, 'state');
  check('3b: moved to the bottom zone, the dial is redrawn there', !!wide, wide ? '' : JSON.stringify({ git: await view(app, 'gitState'), groups: vs.groups, shown: vs.shown }).slice(0, 700));
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
  await waitFor(async () => { const s = await view(app, 'gitState'); return s && s.spokes.length === 4 && s.narrow ? s : null; }, 8000);

  // 5 -----------------------------------------------------------------------------
  // PR #85 Dexter F1 / Miguel B1, Y1, Y2: the panel is redrawn every 30s; what the person is doing survives.
  await view(app, 'gitPin', { name: 'feat/a' });
  const p0 = await view(app, 'gitState');
  await view(app, 'gitRerender', { changed: false });
  const p1 = await view(app, 'gitState');
  check('5: the same answer again draws nothing: the pinned drawer stays', p1.renders === p0.renders && p1.drawerShown && p1.pinned === 'feat/a',
    `renders ${p0.renders} -> ${p1.renders}, pinned ${p1.pinned}`);
  await view(app, 'gitRerender', { changed: true });
  await view(app, 'gitRerender', { changed: true });
  const p2 = await view(app, 'gitState');
  check('5: a changed answer redraws, and the pinned drawer is put back', p2.renders === p0.renders + 2 && p2.drawerShown
    && p2.pinned === 'feat/a' && /feat\/a/.test(p2.drawerText), `renders ${p2.renders}, pinned ${p2.pinned}, drawer ${p2.drawerShown}`);
  check('5: however many redraws, the dial\'s listeners were attached once', p2.wired === 1, `wired ${p2.wired}`);
  await view(app, 'gitFocus', { name: 'feat/a' });
  await view(app, 'gitKey', { key: 'Escape' });
  const p3 = await view(app, 'gitState');
  check('5: Escape unpins and leaves the focus on the spoke', p3.pinned === null && !p3.drawerShown && p3.focused === 'feat/a',
    `pinned ${p3.pinned}, focused ${p3.focused}`);
  await view(app, 'gitFocus', { name: 'feat/b' });
  await view(app, 'gitKey', { key: 'Enter' });
  const p4 = await view(app, 'gitState');
  check('5: Enter on a spoke pins it and puts the focus on Jump, one key away', p4.pinned === 'feat/b' && p4.focused === 'jump',
    `pinned ${p4.pinned}, focused ${p4.focused}`);
  await view(app, 'gitRerender', { changed: true });
  const p5 = await view(app, 'gitState');
  check('5: a redraw keeps the focus on Jump', p5.pinned === 'feat/b' && p5.focused === 'jump', `pinned ${p5.pinned}, focused ${p5.focused}`);
  await view(app, 'gitKey', { key: 'Escape' });
  const p6 = await view(app, 'gitState');
  check('5: Escape from the Jump button unpins and goes back to its spoke', p6.pinned === null && p6.focused === 'feat/b',
    `pinned ${p6.pinned}, focused ${p6.focused}`);
  // Miguel I4: the 2 s tab-state poll redraws the panel; the hover card under the pointer must survive it
  await view(app, 'gitHover', { name: 'feat/a' });
  const hv0 = await view(app, 'gitState');
  await view(app, 'gitRerender', { changed: true });
  const hv1 = await view(app, 'gitState');
  check('5 (Miguel I4): a redraw keeps the hover card under the pointer', hv0.cardShown && /feat\/a/.test(hv0.cardText) && hv1.cardShown && /feat\/a/.test(hv1.cardText)
    && hv1.renders > hv0.renders, JSON.stringify({ before: hv0.cardText.slice(0, 40), after: hv1.cardShown, text: hv1.cardText.slice(0, 40) }));

  // 6 -----------------------------------------------------------------------------
  // The Settle swing (#46). Before the jump below: a tab that isn't selected has no visible page to animate.
  const gs = () => view(app, 'gitState');
  const mo = (args = {}) => view(app, 'gitMotion', args);
  const actOf = (s, id) => (s.acts || []).find(a => a.act === id) || {};
  // section 5's pins held the dial: it waits 2.5 s after the last one before it moves, then eases up
  await mo({ pointer: 'out' });
  await sleep(3800);
  const m0 = await mo();
  check('6: the dial is running: a clock, a loop, nothing holding it, motion allowed', m0.ok && m0.running && !m0.held && !m0.reduced, JSON.stringify(m0).slice(0, 300));
  await sleep(1500);
  const m1 = await mo();
  const adv = (m1.clock - m0.clock + 90) % 90;
  check('6: its own clock advances about as fast as real time', adv > 1.0 && adv < 2.2, `advanced ${adv.toFixed(2)} s in 1.5 s`);
  check('6: the angle is 40 deg * sin(2 pi * clock / 90 s), never past 40',
    Math.abs(m1.angle - 40 * Math.sin(2 * Math.PI * m1.clock / 90)) < 0.6 && Math.abs(m1.angle) <= 40.001, `angle ${m1.angle} at clock ${m1.clock}`);

  await view(app, 'gitPin', { name: 'feat/a' });
  await sleep(150);
  const easing = await mo();
  check('6: pinning a branch starts the dial easing (it does not run at full speed any more)', easing.held && easing.speed < 1, `speed ${easing.speed}`);
  await sleep(900);
  const h1 = await mo();
  await sleep(1300);
  const h2 = await mo();
  check('6: pinned, the dial has settled: the angle is unchanged across samples, the clock held',
    h1.held && h1.speed === 0 && h2.clock === h1.clock && h2.angle === h1.angle, `${h1.angle} / ${h2.angle}, clock ${h1.clock} / ${h2.clock}`);
  check('6 (Miguel S1): pinned, the spokes stop breathing too: no spoke changes length under a click',
    Object.keys(h1.parts).length > 0 && Object.keys(h1.parts).every(n => h2.parts[n] && h2.parts[n].f === h1.parts[n].f), JSON.stringify({ h1: h1.parts, h2: h2.parts }).slice(0, 400));
  await view(app, 'gitPin', { name: 'feat/a' });          // the same spoke again: unpinned
  await sleep(1000);
  const w1 = await mo();
  check('6: unpinned, it waits before it moves again (about 2.5 s)', !w1.held && w1.clock === h2.clock, `clock ${h2.clock} -> ${w1.clock}`);
  await sleep(2800);
  const w2 = await mo();
  check('6: ...and then it picks up again', w2.clock !== h2.clock && (w2.clock - h2.clock + 90) % 90 > 0.3, `clock ${h2.clock} -> ${w2.clock}`);
  await mo({ pointer: 'in' });
  await sleep(900);
  const o1 = await mo();
  await sleep(800);
  const o2 = await mo();
  check('6: under the pointer it holds still too', o1.held && o1.speed === 0 && o2.clock === o1.clock && o2.angle === o1.angle, `${o1.angle} / ${o2.angle}`);
  await mo({ pointer: 'out' });
  await command(app, { cmd: 'screenshot', file: path.join(shots, '6-swing.png') });

  // 7 -----------------------------------------------------------------------------
  // The drawer's facts. Transcripts and review reports come from the probe's own folders (host seams).
  const when = new Date().toISOString();
  const line = (id, input, output) => JSON.stringify({ type: 'assistant', gitBranch: 'feat/b', cwd: featB, timestamp: when,
    message: { id, usage: { input_tokens: input, output_tokens: output } } }) + '\n';
  fs.mkdirSync(path.join(sessionDir, 'sess1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'sess1.jsonl'), line('m1', 60, 40));
  fs.writeFileSync(path.join(sessionDir, 'sess1', 'subagents', 'agent-1.jsonl'), line('s1', 200, 300));
  fs.writeFileSync(path.join(sessionDir, 'sess1', 'subagents', 'agent-1.meta.json'), JSON.stringify({ agentType: 'dexter-pr91' }));
  fs.mkdirSync(reviewsDir, { recursive: true });
  const report = (name, text) => fs.writeFileSync(path.join(reviewsDir, name), text);
  report('2026-10-01-feat-b-dexter-r1.md', '## Verdict: **DEFECTIVE**\n');
  report('2026-10-02-feat-b-dexter-r2.md', '## Verdict: **CLEAN**\n');
  report('2026-10-02-feat-b-miguel.md', 'Findings only, no verdict line.\n');
  report('2026-10-02-feat-bb-miguel.md', '## Verdict: **A DIFFERENT BRANCH**\n');
  await view(app, 'gitRefresh');
  const measured = await waitFor(async () => {
    const s = await gs();
    const b = s.spokes && s.spokes.find(x => x.name === 'feat/b');
    return b && !b.dashed ? s : null;
  }, 20000);
  check('7: the host read the transcripts: feat/b now has a spend (its spoke is solid)', !!measured);
  const first = await mo();
  check('9: a FIRST measurement is not growth: no sparks, nothing live', first.grown.length === 0 && first.sparks.length === 0 && first.live.length === 0 && (await gs()).sparkEls === 0,
    JSON.stringify({ grown: first.grown, sparks: first.sparks, live: first.live }));

  await view(app, 'gitPin', { name: 'feat/b' });
  const d1 = await waitFor(async () => {
    const s = await gs();
    return s.drawerShown && s.reviews.length === 4 ? s : null;
  }, 10000) || await gs();
  check('7: the drawer shows the pinned branch: name, PR and state, purpose, commits',
    d1.drawerShown && /feat\/b/.test(d1.drawerText) && /#91 · PR open/.test(d1.drawerText) && /The open lane/.test(d1.drawerText) && /1 commit/.test(d1.drawerText),
    d1.drawerText.slice(0, 300));
  check('7: ...who worked on it (the subagent folded to Dexter)', d1.people.some(p => /^Dexter ×1$/.test(p)), JSON.stringify(d1.people));
  check('7: ...the latest round per reviewer, with the verdict line or "report, no verdict line"',
    JSON.stringify(d1.reviews) === JSON.stringify(['Dexter r2', 'CLEAN', 'Miguel r1', 'report, no verdict line']), JSON.stringify(d1.reviews));
  check('7: in the narrow right zone the drawer sits UNDER the dial', !d1.beside && d1.drawerRect && d1.svg && d1.drawerRect.top >= d1.svg.bottom - 2,
    JSON.stringify({ beside: d1.beside, drawer: d1.drawerRect, svg: d1.svg }));
  check('7: ...inside the panel', d1.drawerRect.left >= d1.panel.left - 1 && d1.drawerRect.right <= d1.panel.right + 1 && d1.drawerRect.bottom <= d1.panel.bottom + 1,
    JSON.stringify({ drawer: d1.drawerRect, panel: d1.panel }));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '7-drawer-below.png') });
  await view(app, 'gitPin', { name: 'spike/c' });
  const none = await gs();
  check('7: a branch with no reports says so', none.pinned === 'spike/c' && JSON.stringify(none.reviews) === JSON.stringify(['no review reports yet']), JSON.stringify(none.reviews));

  await view(app, 'move', { id: 'git', target: 'bottom' });
  const wideDrawer = await waitFor(async () => {
    const s = await gs();
    return s.beside && s.drawerShown && s.svg && s.svg.width > 300 ? s : null;
  }, 8000);
  const wideNow = wideDrawer || await gs();
  check('7: in a wide zone the drawer sits BESIDE the dial', !!wideDrawer && wideDrawer.drawerRect.left >= wideDrawer.svg.right - 2,
    JSON.stringify({ beside: wideNow.beside, shown: wideNow.drawerShown, pinned: wideNow.pinned, drawer: wideNow.drawerRect, svg: wideNow.svg, panel: wideNow.panel }));
  if (wideDrawer) await command(app, { cmd: 'screenshot', file: path.join(shots, '7-drawer-beside.png') });
  await view(app, 'move', { id: 'git', target: 'right' });
  await waitFor(async () => { const s = await gs(); return s.narrow && s.svg ? s : null; }, 8000);

  // the keyboard: the arrows walk the spokes in time order and the drawer follows; Enter goes into it
  await view(app, 'gitKey', { key: 'Escape' });
  await view(app, 'gitFocus', { name: 'feat/b' });
  await view(app, 'gitKey', { key: 'ArrowRight' });
  const k1 = await gs();
  check('7: an arrow key opens the drawer on the neighbouring spoke and the focus stays on the spokes',
    k1.drawerShown && k1.pinned !== null && k1.pinned !== 'feat/b' && k1.focused === k1.pinned, `pinned ${k1.pinned}, focused ${k1.focused}`);
  await view(app, 'gitKey', { key: 'ArrowLeft' });
  const k2 = await gs();
  check('7: ...and back', k2.pinned === 'feat/b' && k2.focused === 'feat/b', `pinned ${k2.pinned}, focused ${k2.focused}`);
  await view(app, 'gitKey', { key: 'Enter' });
  const k3 = await gs();
  check('7: Enter on the open spoke puts the keyboard on the drawer\'s first working action', k3.focused === 'jump' || (k3.focused || '').startsWith('act:'), `focused ${k3.focused}`);
  await view(app, 'gitKey', { key: 'Escape' });
  check('7: Escape closes the drawer and goes back to the spoke', (await gs()).focused === 'feat/b' && !(await gs()).drawerShown);

  // 8 -----------------------------------------------------------------------------
  // Each action's rule and its reason. No remote yet: Open PR can't work, and says so.
  await view(app, 'gitTabs');
  const pinOnly = async (name) => {
    const s0 = await gs();
    if (s0.pinned === name) return s0;
    await view(app, 'gitPin', { name });
    return waitFor(async () => { const s = await gs(); return s.pinned === name && s.acts.length ? s : null; }, 8000);
  };
  const shape = (s) => (s.acts || []).map(a => `${a.act}:${a.disabled ? 'off' : 'on'}`).join(' ');
  const bs = await pinOnly('feat/b');
  check('8 open PR: Open PR #91 is disabled with no remote, and says so; Jump works; Copy works',
    actOf(bs, 'open-pr').label === 'Open PR #91' && actOf(bs, 'open-pr').disabled && /remote/.test(actOf(bs, 'open-pr').why || '')
    && !actOf(bs, 'jump').disabled && !actOf(bs, 'copy').disabled, shape(bs));
  check('8 open PR: Type /merged is off until its tab has a session ("hasn\'t started"); Open a worktree says it is already open',
    actOf(bs, 'type-merged').disabled && /hasn't started/.test(actOf(bs, 'type-merged').why || '')
    && actOf(bs, 'open-worktree').disabled && /already open/.test(actOf(bs, 'open-worktree').why || ''), JSON.stringify(bs.acts));
  const ms = await pinOnly('feat/a');
  check('8 merged: Open PR #1 (no remote), no Jump (no open worktree), Open a worktree and Type /merged say it is merged',
    actOf(ms, 'open-pr').label === 'Open PR #1' && /remote/.test(actOf(ms, 'open-pr').why || '') && /no open worktree/.test(actOf(ms, 'jump').why || '')
    && /merged/.test(actOf(ms, 'open-worktree').why || '') && /already merged/.test(actOf(ms, 'type-merged').why || '') && !actOf(ms, 'copy').disabled, JSON.stringify(ms.acts));
  const us = await pinOnly('spike/c');
  check('8 unmerged: no PR to open, no tab to jump to, Open a worktree needs agent-creator, Type /merged needs an open PR',
    /no PR/.test(actOf(us, 'open-pr').why || '') && actOf(us, 'jump').disabled && actOf(us, 'open-worktree').why === 'needs agent-creator to attach an existing branch'
    && /no open PR/.test(actOf(us, 'type-merged').why || '') && !actOf(us, 'copy').disabled, JSON.stringify(us.acts));
  check('8: every disabled action says why: beside it, as its description, and not again as a title (Miguel S2)',
    [bs, ms, us].every(s => s.acts.filter(a => a.disabled).every(a => a.why && !a.title && a.described)), JSON.stringify(us.acts));
  const before8 = (await command(app, { cmd: 'state' })).selectedKey;
  await view(app, 'gitAct', { act: 'type-merged' });
  await sleep(500);
  const afterOff = await gs();
  check('8: a disabled action does nothing when it is clicked', afterOff.said === '' && (await command(app, { cmd: 'state' })).selectedKey === before8, `said "${afterOff.said}"`);
  // origin appears: Open PR follows it
  git(dev, 'remote', 'add', 'origin', 'https://github.com/probe/probe.git');
  await view(app, 'gitRefresh');
  const remoteOn = await waitFor(async () => {
    const s = await pinOnly('feat/b');
    return s && !actOf(s, 'open-pr').disabled ? s : null;
  }, 15000);
  check('8: once origin is a GitHub remote, Open PR #91 is enabled', !!remoteOn, JSON.stringify((await gs()).acts));
  const ms2 = await pinOnly('feat/a');
  check('8: ...and so is the merged branch\'s Open PR #1; a branch with no PR still is not', !actOf(ms2, 'open-pr').disabled
    && /no PR/.test(actOf(await pinOnly('spike/c'), 'open-pr').why || ''));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '8-actions.png') });

  // 9 -----------------------------------------------------------------------------
  // Sparks only for measured growth: a refresh that found new tokens on feat/b, and no other branch.
  fs.appendFileSync(path.join(sessionDir, 'sess1.jsonl'), line('m2', 300, 200));
  await view(app, 'gitRefresh');
  const grew = await waitFor(async () => { const m = await mo(); return m.grown.includes('feat/b') ? m : null; }, 20000);
  check('9: a refresh that found new tokens: feat/b is measured to have grown', !!grew, JSON.stringify(await mo()).slice(0, 300));
  if (grew) {
    const gst = await gs();
    check('9: sparks stream on feat/b ONLY; it is live; the other spokes have none', JSON.stringify(grew.sparks) === JSON.stringify(['feat/b'])
      && grew.live.includes('feat/b') && grew.parts['feat/b'].sparks && Object.entries(grew.parts).every(([n, p]) => n === 'feat/b' || !p.sparks)
      && gst.sparkEls === 4 && / live/.test(gst.spokes.find(x => x.name === 'feat/b').cls),
      JSON.stringify({ sparks: grew.sparks, live: grew.live, els: gst.sparkEls }));
    await command(app, { cmd: 'screenshot', file: path.join(shots, '9-sparks.png') });
    const ended = await waitFor(async () => { const m = await mo(); return m.sparks.length === 0 ? m : null; }, 25000, 500);
    const gst2 = await gs();
    check('9: the sparks stop, and the spoke is no longer live (a quiet branch is not decoration)',
      !!ended && !ended.live.includes('feat/b') && !ended.parts['feat/b'].sparks && !/ live/.test(gst2.spokes.find(x => x.name === 'feat/b').cls),
      JSON.stringify(ended && { sparks: ended.sparks, live: ended.live }));
  }

  // 4 -----------------------------------------------------------------------------
  const p = await view(app, 'gitPin', { name: 'feat/b' });
  check('4: pinning the open worktree\'s spoke opens the drawer, which offers Jump to its tab', p.ok && p.drawerShown && p.hidden && p.jump, JSON.stringify(p).slice(0, 300));
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

  // 10 ----------------------------------------------------------------------------
  // Type /merged (PR #93 review). feat-b's tab now has a session: cmd.exe. A stand-in CLI box
  // (verify/lib/fake-claude-box.js) runs inside it, so the target page has a `❯` box to judge, clear and read
  // back; the probe sends the CLI's hook events down feat-b's host pipe, as the native helper would.
  const boxCtl = path.join(tmp, 'box-ctl.json');
  const boxLog = path.join(tmp, 'box-submitted.log');
  const boxLine = () => { try { return JSON.parse(fs.readFileSync(`${boxLog}.line`, 'utf8')); } catch { return null; } };
  const submitted = () => { try { return fs.readFileSync(boxLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const stNow = await command(app, { cmd: 'state' });
  const bHost = ((stNow && stNow.hosts) || []).find(x => /feat-b$/i.test(x.key || ''));
  const bPid = bHost && Number.isInteger(bHost.pid) ? bHost.pid : null;
  check('10: feat-b\'s host is up (its hook pipe is named by its pid)', !!bPid, JSON.stringify(stNow && stNow.hosts));
  // still on feat-b's tab (the jump): start the box in its cmd.exe
  await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && />\s*$/m.test(r.text || '') ? r : null; }, 15000, 300);
  await view(app, 'gitTermInput', { data: `node "${path.join(ROOT, 'verify', 'lib', 'fake-claude-box.js')}" "${boxCtl}" "${boxLog}"\r` });
  const boxUp = await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && /❯/.test(r.text) && /fake claude box/.test(r.text) ? r : null; }, 15000, 300);
  check('10: the stand-in CLI box is drawn in feat-b\'s tab', !!boxUp, JSON.stringify(await view(app, 'gitScreen')).slice(0, 400));
  const hook = (event, payload = {}) => fireHook(bPid, event, payload);
  check('10: a hook line reached feat-b\'s host', await hook('SessionStart', { source: 'startup', session_id: 'probe-b' }));
  await command(app, { cmd: 'select', label: 'develop' });
  const tabOfB = async () => { const t = await view(app, 'gitTabs'); return t && t.tabs ? t.tabs.find(x => /feat-b$/i.test(x.folder)) : null; };
  const runWhy = async () => {
    await view(app, 'gitTabs');
    const s0 = await gs();
    if (s0.pinned !== 'feat/b') await view(app, 'gitPin', { name: 'feat/b' });
    const a = actOf(await gs(), 'type-merged');
    return a.disabled ? (a.why || 'disabled') : 'enabled';
  };
  const runIs = (re) => waitFor(async () => { const w = await runWhy(); return re.test(w) ? w : null; }, 15000, 400);
  const restB = await waitFor(async () => { const b = await tabOfB(); return b && b.known && b.turn === 'idle' && b.lock ? b : null; }, 20000, 500);
  check('10: the dev tab sees feat-b\'s tab open and started, and its host says the session is at rest', !!restB, JSON.stringify(await tabOfB()));
  check('10: an open PR whose session is at rest: Type /merged is enabled', !!(await runIs(/^enabled$/)), await runWhy());
  const tm = actOf(await gs(), 'type-merged');
  check('10 (#61): it is named "Run /merged" and leaves nothing to the person (no Enter hint)', tm.label === 'Run /merged' && !tm.why && !tm.described, JSON.stringify(tm));

  // Dexter F1: a main-session turn that calls no agent
  await hook('UserPromptSubmit', { prompt: 'address the findings' });
  const f1 = await runIs(/working/);
  const b1 = await tabOfB();
  check('10 (Dexter F1): a main-session turn with no subagent at all disables it ("working"); the roster says nothing works',
    !!f1 && b1 && b1.turn === 'turn' && b1.working === false, JSON.stringify({ why: await runWhy(), tab: b1 }));
  await hook('Stop', {});
  check('10 (Dexter F1): ...and the turn ending enables it again', !!(await runIs(/^enabled$/)), await runWhy());

  // Dexter F2: a dialog open, and the tab then looked at
  await hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  check('10 (Dexter F2): a permission prompt open disables it ("waiting for you")', !!(await runIs(/waiting for you/)), await runWhy());
  await command(app, { cmd: 'select', label: 'feat/b' });
  await command(app, { cmd: 'windowFocus' });
  await sleep(800);
  await command(app, { cmd: 'select', label: 'develop' });
  const b2 = await waitFor(async () => { const b = await tabOfB(); return b && b.needsInput === false ? b : null; }, 8000, 300);
  const why2 = await runWhy();
  check('10 (Dexter F2): looked at ("needs you" cleared), the open dialog still disables it',
    !!b2 && b2.turn === 'prompt' && /waiting for you/.test(why2), JSON.stringify({ tab: b2 || await tabOfB(), why: why2 }));
  await hook('Stop', {});
  check('10 (Dexter F2): ...and the session moving on enables it again', !!(await runIs(/^enabled$/)), await runWhy());

  // Dexter F3 + #61: a half-typed draft in the box. The action TYPES /merged and, the tab being at rest, the page's
  // submit gate presses Enter: what the CLI receives is "/merged" alone, never "also bump the version/merged".
  fs.writeFileSync(boxCtl, JSON.stringify({ draft: 'also bump the version' }));
  await waitFor(async () => (boxLine() === 'also bump the version' ? true : null), 5000, 200);
  await view(app, 'gitAct', { act: 'type-merged' });
  await waitFor(async () => (submitted().length >= 1 ? true : null), 15000, 300);
  await sleep(1500);     // well past the read-back: a second line would have landed by now
  check('10 (Dexter F3 + #61): the draft was cleared and exactly "/merged" was submitted, never "also bump the version/merged"',
    JSON.stringify(submitted()) === JSON.stringify(['/merged']) && boxLine() === '', JSON.stringify({ submitted: submitted(), box: boxLine() }));
  const sw = (await command(app, { cmd: 'state' })).selectedKey;
  check('10: it switched to that branch\'s tab to type', /feat-b$/i.test(sw || ''), String(sw));
  await command(app, { cmd: 'select', label: 'develop' });
  const said = await waitFor(async () => { const s = await gs(); return /Sent \/merged to feat\/b's session\./.test(s.said) ? s : null; }, 8000);
  check('10 (#61): the drawer says it SENT /merged, and that a box that wasn\'t empty was cleared (Ctrl+Y)',
    !!said && /Ctrl\+Y/.test(said.said) && !/Typed/.test(said.said), String((await gs()).said));
  check('10 (Miguel S2): one status node in the panel, however often the drawer was rebuilt', !!said && said.saidNodes === 1, String(said && said.saidNodes));

  // Dexter F4 / Miguel I1: a double click, on an empty box
  fs.writeFileSync(boxCtl, JSON.stringify({ draft: '' }));
  await waitFor(async () => (boxLine() === '' ? true : null), 5000, 200);
  await runIs(/^enabled$/);
  await view(app, 'gitAct', { act: 'type-merged', times: 2 });
  await waitFor(async () => (submitted().length >= 2 ? true : null), 15000, 300);
  await sleep(2500);
  check('10 (Dexter F4 + #61): a double click sends /merged once more (never /merged/merged): two lines in all, both "/merged"',
    JSON.stringify(submitted()) === JSON.stringify(['/merged', '/merged']) && boxLine() === '', JSON.stringify({ box: boxLine(), submitted: submitted() }));
  await command(app, { cmd: 'select', label: 'develop' });

  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 10000);

  // 6 (reduced motion) ------------------------------------------------------------
  // A second launch with the OS preference forced: the dial is still.
  const calm = await launchApp(container, ['--force-prefers-reduced-motion']);
  const calmReady = await viewReady(calm);
  check('6: the window came up again with reduced motion forced', !!calmReady, calmReady ? '' : calm.out.slice(-600));
  if (calmReady) {
    if (!calmReady.shown.includes('git')) await view(calm, 'select', { id: 'git' });
    const drawn = await waitFor(async () => { const s = await view(calm, 'gitState'); return s && s.ok && s.spokes.length === 4 ? s : null; }, 20000);
    check('6: the dial is drawn again', !!drawn);
    if (drawn) {
      const r1 = await view(calm, 'gitMotion', { pointer: 'out' });
      await sleep(1500);
      const r2 = await view(calm, 'gitMotion');
      check('6: under prefers-reduced-motion the dial is still: angle 0, the clock never moves',
        r1.reduced && r2.reduced && r1.angle === 0 && r2.angle === 0 && r1.clock === r2.clock, JSON.stringify({ r1: r1.angle, r2: r2.angle, c1: r1.clock, c2: r2.clock }));
      check('6: ...and the spokes do not breathe: every length factor is exactly 1', Object.values(r2.parts).every(p => p.f === 1) && Object.keys(r2.parts).length === 4,
        JSON.stringify(r2.parts));
      await command(calm, { cmd: 'screenshot', file: path.join(shots, '6-reduced.png') });
    }
  }
  await command(calm, { cmd: 'quit' });
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
