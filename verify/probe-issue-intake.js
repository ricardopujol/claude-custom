'use strict';
/**
 * Start a lane from a GitHub issue, in a REAL window with REAL hosts.  (re-runnable)
 *
 *   node verify/probe-issue-intake.js        (exit 0 = every check held)
 *
 * The unit tests pin the decisions (test/issues.test.js, issue-lane, tab-shell-issues, tab-strip-issues, the wiring
 * tests). Nothing else runs app/main.js, the strip page and the tab views together, and that wiring is where the traps
 * live: a `<script>` that declares a name another one already took aborts SILENTLY in the shared global scope, a tab's
 * page is a native view that covers whatever the strip page draws under it, and an IPC gate compared to the wrong
 * webContents answers nobody.
 *
 * Against a throwaway container repo  <tmp>\proj\dev  (with a documentation\ folder, so the REAL sync-docs
 * brief-path.ps1 finds where a brief goes), stand-ins for agent-creator's worktree scripts, and a FAKE gh: a tiny
 * Node script (CLAUDE_CUSTOM_GH, host/probe-seams.js) that prints fixture JSON for `issue list` / `issue view`.
 *
 *   the row         opening the branch form reads the issues once; the row says "From an issue"
 *   the list        opening it hides the selected tab's page and draws one row per issue, each with the
 *                   branch picking it would fill in (fix/ for a bug label); the filter narrows by title
 *   the pick        fills the branch field, closes the list, and the page comes back
 *   Create          the real form submit makes the worktree AND writes the brief, at the path brief-path.ps1 gave,
 *                   from the issue (Source line with its URL, its body quoted, the branch and worktree)
 *   the tab         remembers its issue: the model, and the hover line in the painted strip
 *   no overwrite    a brief that is already there is left exactly as it was
 *   no gh           the row is one dim line and the typed branch still creates a worktree, with no brief
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing runs that bills; the launcher strips
 * ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* it was not told to keep; the registry, portraits and uploads point at
 * temp folders; the fake gh never touches the network. The brief is written in the TEMP project only. Side effect, as
 * in probe-worktree-ops.js: hosts allocate port blocks in ~\.claude-custom\worktree-ports.json for temp folders that
 * are then deleted. WINDOWS ONLY (cmd.exe, PowerShell, taskkill).
 */
const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));

if (process.platform !== 'win32') {
  console.log('SKIP: this probe drives cmd.exe, PowerShell and taskkill; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-issues-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const scripts = path.join(tmp, 'scripts');
const fakeGh = path.join(tmp, 'fake-gh.js');
const ghLog = path.join(tmp, 'gh-calls.log');
const ghMode = path.join(tmp, 'gh-mode');
const handoffs = path.join(dev, 'documentation', 'handoffs');
const userData = path.join(tmp, 'user-data');
const wtPath = (branch) => path.join(container, branch.replace(/\//g, '-'));
const briefOf = (branch) => path.join(handoffs, `CURRENT-${branch.replace(/\//g, '-')}.md`);
const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args,
], { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

let failures = 0;
let skipped = false;
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

// --- the stand-ins ---------------------------------------------------------------------------------
// agent-creator's worktree scripts: same parameters, exit codes and output shapes as the real ones (see
// verify/probe-worktree-ops.js). The sync-docs brief-path.ps1 is the REAL one.
const STAND_INS = {
  'new-worktree.ps1': [
    'param([Parameter(Mandatory)][string]$Project, [Parameter(Mandatory)][string]$Branch, [string]$Base = "develop")',
    'if ($Branch -notmatch "^(feat|fix|spike|chore|docs|refactor|test)/.+") {',
    '  [Console]::Error.WriteLine("$Branch has no prefix: use feat/, fix/, spike/, chore/, docs/, refactor/ or test/.")',
    '  exit 1',
    '}',
    '$dir = Join-Path $Project ($Branch -replace "/", "-")',
    '$dev = Join-Path $Project "dev"',
    '& git -C $dev worktree add -q $dir -b $Branch develop',
    'if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("git worktree add failed for $Branch"); exit 1 }',
    '[Console]::Out.WriteLine((@{ path = $dir; branch = $Branch } | ConvertTo-Json -Compress))',
    'exit 0',
  ],
  'setup-worktree.ps1': [
    'param([Parameter(Mandatory)][string]$Path, [int]$CommandTimeoutSeconds = 1800)',
    '[Console]::Out.WriteLine((@{ path = $Path; manifest = $true; copied = @(); kept = @(); ran = @(); log = $null } | ConvertTo-Json -Compress))',
    'exit 0',
  ],
  'remove-worktree.ps1': [
    'param([Parameter(Mandatory)][string]$Path)',
    '[Console]::Out.WriteLine("removed: $Path")',
    'exit 0',
  ],
};

// The fake gh. `issue list` and `issue view <n>` print fixtures; a `fail` in gh-mode makes every call fail the way a
// signed-out gh does. Every call is logged, one JSON array of argv per line.
const FAKE_GH = `'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'gh-calls.log'), JSON.stringify(args) + '\\n');
let mode = '';
try { mode = fs.readFileSync(path.join(__dirname, 'gh-mode'), 'utf8').trim(); } catch (e) { /* normal */ }
if (mode === 'fail') {
  process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n');
  process.exit(4);
}
const ISSUES = [
  { number: 12, title: 'Crash on start', labels: [{ name: 'bug' }], assignees: [], updatedAt: '2026-10-18T10:00:00Z', url: 'https://github.com/o/r/issues/12',
    body: 'Steps:\\n1. Start the app\\n2. It crashes\\n\\n## What to build\\nnot a heading, a quote' },
  { number: 7, title: 'Add the widget', labels: [{ name: 'enhancement' }, { name: 'ui' }], assignees: [], updatedAt: '2026-10-17T10:00:00Z', url: 'https://github.com/o/r/issues/7',
    body: 'A widget, please.' },
  { number: 3, title: 'Docs: update the README!', labels: [], assignees: [], updatedAt: '2026-10-01T10:00:00Z', url: 'https://github.com/o/r/issues/3', body: '' },
];
if (args[0] === 'issue' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(ISSUES.map(({ body, ...rest }) => rest)));
} else if (args[0] === 'issue' && args[1] === 'view') {
  const i = ISSUES.find(x => String(x.number) === args[2]);
  if (!i) { process.stderr.write('issue not found\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(i));
} else {
  process.stderr.write('fake gh: unexpected ' + JSON.stringify(args) + '\\n');
  process.exit(2);
}
`;

function makeRepo() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.mkdirSync(handoffs, { recursive: true });       // so the real brief-path.ps1 answers inside the temp project
  fs.mkdirSync(scripts, { recursive: true });
  for (const [name, lines] of Object.entries(STAND_INS)) fs.writeFileSync(path.join(scripts, name), lines.join('\r\n') + '\r\n');
  fs.writeFileSync(fakeGh, FAKE_GH);
}

const ghCalls = () => {
  try { return fs.readFileSync(ghLog, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
};

// --- the app ---------------------------------------------------------------------------------------
async function launchApp(cwd) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_WORKTREE_SCRIPTS: scripts,
    CLAUDE_CUSTOM_GH: fakeGh,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDE_CUSTOM_PORT;
  delete env.CLAUDE_CUSTOM_TOKEN;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env },
    { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE',
      'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_WORKTREE_SCRIPTS', 'CLAUDE_CUSTOM_GH'] });
  hygiene.registerChild(child);
  const app = { port, token, child, out: '', exited: false, exitCode: null };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', (code) => { app.exited = true; app.exitCode = code; hygiene.unregisterSpawnedTree(child.pid); });
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

const state = (app) => command(app, { cmd: 'state' });
const strip = (app, action, extra = {}) => command(app, { cmd: 'stripIssues', action, ...extra });
const view = async (app) => ((await strip(app, 'read')) || {}).view || null;
const tabOf = (s, label) => (s && s.tabs ? s.tabs.find(t => t.label === label) : null);
const hostOf = (s, label) => (s && s.hosts ? s.hosts.find(h => h.label === label) : null);
const labelsOf = (s) => (s && s.tabs ? s.tabs.map(t => t.label) : []);

function hostsUnder(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(path.resolve(dir).toLowerCase())) out.push(id);
  }
  return out;
}

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
const remember = (s) => { for (const h of (s && s.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid); };

function killEverything() {
  for (const id of hostsUnder(container)) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}
hygiene.addCleanup(killEverything);

function removeTemp() {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {
    console.log(`(could not remove ${tmp}: ${e.message})`);
  }
}

// --- the probe -------------------------------------------------------------------------------------
async function main() {
  console.log('temp repo:', tmp);
  makeRepo();

  const app = await launchApp(container);
  let s = await waitFor(async () => {
    if (app.exited) throw new Error('the app exited');
    const x = await state(app);
    return x && x.ok && tabOf(x, 'develop') && tabOf(x, 'develop').started ? x : null;
  }, 60000, 500);
  if (!s) {
    check('the window came up with dev started', false, `\n${app.out.split('\n').slice(-25).join('\n')}`);
    skipped = true;
    return;
  }
  remember(s);
  check('the window came up with dev started', true, labelsOf(s).join(', '));
  check('the strip page has the issue row and list (the page loaded to the end)',
    !!(await view(app)), 'stripIssues read answered from the page');

  // ===== the row: opening the form reads the issues =====
  fs.writeFileSync(ghLog, '');
  await command(app, { cmd: 'openCreate' });
  // The row reads "From an issue" from the first paint; its title says how many are open once the read has answered.
  const row = await waitFor(async () => {
    const v = await view(app);
    return v && v.row.text === 'From an issue \u25be' && v.row.title === '3 open issues' ? v : null;
  }, 15000, 300);
  check('opening the branch form reads the issues, and the row says "From an issue"', !!row, JSON.stringify(row ? row.row : await view(app)));
  check('the row is enabled and says how many are open', !!row && row.row.disabled === false && row.row.title === '3 open issues', row && row.row.title);
  check('and gh was asked for the open issues (an argv array, nothing from a title)',
    ghCalls().some(a => a[0] === 'issue' && a[1] === 'list' && a.includes('--state') && a.includes('open')), JSON.stringify(ghCalls()[0]));
  check('the list panel starts hidden', !!row && row.panelHidden === true);

  // ===== the list: the tab's page steps aside, one row per issue =====
  await strip(app, 'open');
  const opened = await waitFor(async () => {
    const x = await state(app);
    const v = await view(app);
    return x.create && x.create.picker === true && v && v.panelHidden === false && v.rows.length === 3 ? { x, v } : null;
  }, 15000, 300);
  check('opening the list shows the panel with one row per issue', !!opened, opened ? '' : JSON.stringify(await view(app)));
  if (opened) {
    const r = opened.v.rows;
    check('each row names the number, the title, its labels and the branch picking it would fill in',
      r[0].num === '#12' && r[0].title === 'Crash on start' && r[0].branch === 'fix/12-crash-on-start' && r[0].labels.join(',') === 'bug'
        && r[1].num === '#7' && r[1].branch === 'feat/7-add-the-widget' && r[1].labels.join(',') === 'enhancement,ui'
        && r[2].branch === 'feat/3-docs-update-the-readme', JSON.stringify(r.map(x => x.branch)));
    check("a bug label makes the prefix fix/, anything else feat/", r[0].branch.startsWith('fix/') && r[1].branch.startsWith('feat/'));
    check("the selected tab's page steps aside while the list is open (a native view would cover it)",
      opened.x.selectedViewVisible === false || opened.x.selectedViewVisible === null,
      `selectedViewVisible=${opened.x.selectedViewVisible}${opened.x.selectedViewVisible === null ? ' (not readable on this Electron)' : ''}`);
  }

  // ===== the filter =====
  await strip(app, 'filter', { text: 'widget' });
  const filtered = await waitFor(async () => { const v = await view(app); return v && v.rows.length === 1 ? v : null; }, 10000, 250);
  check('typing in the filter narrows the rows by title', !!filtered && filtered.rows[0].num === '#7', filtered && JSON.stringify(filtered.rows.map(x => x.num)));
  await strip(app, 'filter', { text: 'zzzz' });
  const none = await waitFor(async () => { const v = await view(app); return v && v.rows.length === 0 ? v : null; }, 10000, 250);
  check('a query nothing matches says so', !!none && none.note === 'No issue matches.', none && none.note);
  await strip(app, 'filter', { text: '#12' });
  const byNumber = await waitFor(async () => { const v = await view(app); return v && v.rows.length === 1 ? v : null; }, 10000, 250);
  check('and "#12" finds the issue by its number', !!byNumber && byNumber.rows[0].num === '#12');

  // ===== the pick =====
  await strip(app, 'pick', { index: 0 });
  const picked = await waitFor(async () => {
    const x = await state(app);
    const v = await view(app);
    return x.create && !x.create.picker && v && v.panelHidden === true && v.branchValue === 'fix/12-crash-on-start' ? { x, v } : null;
  }, 10000, 250);
  check('picking a row fills the branch field and closes the list', !!picked, JSON.stringify(await view(app)));
  check("and the tab's page comes back", !!picked && picked.x.selectedViewVisible !== false, `selectedViewVisible=${picked && picked.x.selectedViewVisible}`);

  // ===== Create: the real form submit =====
  await strip(app, 'submit');
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, 'fix/12-crash-on-start') ? x : null; }, 30000);
  remember(s);
  check('Create makes the worktree and its tab', !!s && fs.existsSync(wtPath('fix/12-crash-on-start')), labelsOf(s).join(', '));
  const briefFile = briefOf('fix/12-crash-on-start');
  const wrote = await waitFor(() => fs.existsSync(briefFile), 20000, 250);
  check('and writes the lane\'s brief where brief-path.ps1 says, inside the temp project', !!wrote, briefFile);
  const text = wrote ? fs.readFileSync(briefFile, 'utf8') : '';
  check('the brief names the issue, its URL and the builder',
    /\*\*Source:\*\* GitHub issue #12 https:\/\/github\.com\/o\/r\/issues\/12\r?\n/.test(text) && /\*\*Builder:\*\* unassigned/.test(text), text.split('\n').slice(0, 7).join(' | '));
  check('with the branch and the worktree of this lane',
    text.includes('**Branch:** `fix/12-crash-on-start`') && text.includes(`**Worktree:** \`${wtPath('fix/12-crash-on-start')}\``));
  check('the issue body is quoted, and a line like "## What to build" cannot open a section of its own',
    text.includes('> 2. It crashes') && text.includes('> ## What to build') && text.split(/\r?\n/).filter(l => l === '## What to build').length === 1);
  check('the standard sections are there', ['## The issue', '## What to build', '## Rules', '## Read first', '## Verify with', '## Open questions'].every(h => text.includes(h)));
  check('gh was asked for that one issue by number', ghCalls().some(a => a[0] === 'issue' && a[1] === 'view' && a[2] === '12'));
  check('the brief is in the TEMP project, never under this repo', briefFile.toLowerCase().startsWith(tmp.toLowerCase()));

  // ===== the tab remembers its issue =====
  const withIssue = await waitFor(async () => { const x = await state(app); const t = tabOf(x, 'fix/12-crash-on-start'); return t && t.issue ? x : null; }, 10000, 250);
  const issue = withIssue ? tabOf(withIssue, 'fix/12-crash-on-start').issue : null;
  check('the tab keeps its issue: number, title and link',
    !!issue && issue.number === 12 && issue.title === 'Crash on start' && issue.url === 'https://github.com/o/r/issues/12', JSON.stringify(issue));
  const dom = withIssue && Array.isArray(withIssue.stripDom) ? withIssue.stripDom.find(d => d.label === 'fix/12-crash-on-start') : null;
  check('and the painted strip shows "#12 Crash on start" on hover', !!dom && /(^|\n)#12 Crash on start$/.test(dom.title), dom && JSON.stringify(dom.title));
  check('a tab made another way has no issue', !!withIssue && tabOf(withIssue, 'develop').issue === null);
  check('the form closed itself when the creation started', !!withIssue && withIssue.create === null, JSON.stringify(withIssue && withIssue.create));

  // ===== an existing brief is never overwritten =====
  fs.writeFileSync(briefOf('feat/7-add-the-widget'), 'MY OWN BRIEF, written first\n');
  await command(app, { cmd: 'openCreate' });
  await waitFor(async () => { const v = await view(app); return v && v.row.text === 'From an issue \u25be' ? v : null; }, 10000, 250);
  await strip(app, 'open');
  await waitFor(async () => { const v = await view(app); return v && v.rows.length === 3 ? v : null; }, 10000, 250);
  await strip(app, 'pick', { index: 1 });
  await waitFor(async () => { const v = await view(app); return v && v.branchValue === 'feat/7-add-the-widget' ? v : null; }, 10000, 250);
  await strip(app, 'submit');
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, 'feat/7-add-the-widget') ? x : null; }, 30000);
  remember(s);
  await sleep(2500);
  check('a brief that is already there is left exactly as it was', fs.readFileSync(briefOf('feat/7-add-the-widget'), 'utf8') === 'MY OWN BRIEF, written first\n');
  const t7 = tabOf(await state(app), 'feat/7-add-the-widget');
  check('and its tab still remembers the issue', !!t7 && !!t7.issue && t7.issue.number === 7, JSON.stringify(t7 && t7.issue));

  // ===== no gh: one dim line, the typed path still works =====
  fs.writeFileSync(ghMode, 'fail');
  await command(app, { cmd: 'openCreate' });
  const dim = await waitFor(async () => { const v = await view(app); return v && v.row.dim ? v : null; }, 15000, 300);
  check('with gh signed out the row is one dim line', !!dim && dim.row.text === 'Sign in to gh to pick an issue' && dim.row.disabled === true, dim && JSON.stringify(dim.row));
  await strip(app, 'open');                       // the (disabled) row's click does nothing, but ask main anyway
  await sleep(500);
  const noDialog = await state(app);
  check('and it never raised a dialog or an alert', !(noDialog.confirms || []).length && (noDialog.stripChrome || {}).alert === null, JSON.stringify(noDialog.stripChrome && noDialog.stripChrome.alert));
  await command(app, { cmd: 'cancelCreate' });
  await command(app, { cmd: 'create', branch: 'feat/typed-by-hand' });
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, 'feat/typed-by-hand') ? x : null; }, 30000);
  // Its host has to be up (identity file complete) before the cleanup can prove it is ours to stop.
  s = await waitFor(async () => {
    const x = await state(app);
    const h = hostOf(x, 'feat/typed-by-hand');
    return tabOf(x, 'feat/typed-by-hand') && tabOf(x, 'feat/typed-by-hand').started && h && Number.isInteger(h.pid) ? x : null;
  }, 40000) || s;
  remember(s);
  check('the typed branch still makes a worktree and a tab', !!s && fs.existsSync(wtPath('feat/typed-by-hand')));
  check('with no brief and no issue (nothing was picked)', !fs.existsSync(briefOf('feat/typed-by-hand')) && tabOf(await state(app), 'feat/typed-by-hand').issue === null);

  await command(app, { cmd: 'quit' }, 5000);
  await waitFor(() => app.exited, 15000, 200);
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.log(`FAIL  the probe threw: ${err && err.stack || err}`);
    failures++;
  } finally {
    hygiene._emergencyCleanup('done');     // kills the window and, via the cleanup, every host it started
    await sleep(800);
    removeTemp();
  }
  if (skipped) {
    console.log(`\n${failures} FAILED -- the app or dev's host did not start, so the rest was never measured`);
    process.exit(1);
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
