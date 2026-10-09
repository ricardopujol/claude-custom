'use strict';
/**
 * Worktree tabs PR 3, in a REAL window with REAL hosts.  (re-runnable)
 *
 *   node verify/probe-worktree-ops.js        (exit 0 = every check held)
 *
 * The unit tests pin the decisions (test/tab-shell.test.js, tab-lifecycle,
 * worktree-ops, tab-strip). This drives the whole thing: app/main.js, the strip
 * page with its + and branch form, the tab views, real hosts, real git, and
 * STAND-INS for agent-creator's scripts (CLAUDE_CUSTOM_WORKTREE_SCRIPTS):
 *
 *   criterion 2   + -> feat/demo gives a tab on a new folder; `demo` shows the
 *                 script's refusal word for word and makes nothing
 *   criterion 10  setup runs before the session: its progress shows and no host
 *                 serves the folder until it ends; a failing setup still starts it
 *   criterion 3   a merged marker, then the session ends (`exit` typed into its
 *                 cmd.exe) -> the tab closes, the folder and the worktree are gone
 *   criterion 4   the same with an uncommitted file -> the tab stays with the
 *                 remover's error, and the folder stays
 *   exit 2        the same with the remover keeping it on purpose -> "kept", not
 *                 an error
 *   reopen        a hand-closed tab is offered back, and Ctrl+Shift+T reopens it
 *   (render)      the strip painted the + and the badges
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing runs
 * that bills; ELECTRON_RUN_AS_NODE is deleted before the window launches; the
 * registry, portraits and uploads point at temp folders. The stand-ins only
 * touch the temp repo. Side effect, as in probe-worktree-tabs.js: hosts
 * allocate port blocks in ~\.claude-custom\worktree-ports.json for temp
 * folders that are then deleted. WINDOWS ONLY (cmd.exe, PowerShell, taskkill).
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
const { resolveWorktreeGitDir } = require(path.join(ROOT, 'host', 'git-branch'));
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));

if (process.platform !== 'win32') {
  console.log('SKIP: this probe drives cmd.exe, PowerShell and taskkill; Windows only');
  process.exit(0);
}

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-ops-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const scripts = path.join(tmp, 'scripts');
const userData = path.join(tmp, 'user-data');
const wtPath = (branch) => path.join(container, branch.replace(/\//g, '-'));
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

// --- the stand-ins for agent-creator's scripts (Contracts A, C, E) ----------------
// Same parameters, exit codes and output shapes as the real ones. No backslash
// appears in them: paths are built with Join-Path.
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
    '$gitDir = (Get-Content -Raw (Join-Path $Path ".git")).Trim().Substring(7).Trim()',
    '$log = Join-Path $gitDir "claude-setup.log"',
    'foreach ($i in 1..4) { Add-Content -Path $log -Value "setup step $i of 4"; Start-Sleep -Milliseconds 1200 }',
    '$branch = (& git -C $Path branch --show-current)',
    'if ($branch -eq "feat/setup-fails") {',
    `  [Console]::Error.WriteLine("run: 'npm ci' exited with 1 (output in $log).")`,
    '  exit 1',
    '}',
    '[Console]::Out.WriteLine((@{ path = $Path; manifest = $true; copied = @(); kept = @(); ran = @("npm ci"); log = $log } | ConvertTo-Json -Compress))',
    'exit 0',
  ],
  'remove-worktree.ps1': [
    'param([Parameter(Mandatory)][string]$Path)',
    '$gitDir = (Get-Content -Raw (Join-Path $Path ".git")).Trim().Substring(7).Trim()',
    'if (Test-Path (Join-Path $gitDir "KEEP")) { [Console]::Error.WriteLine("the branch still has a handoff brief, so it was kept."); exit 2 }',
    '$dirty = & git -C $Path status --porcelain',
    'if ($dirty) { [Console]::Error.WriteLine("$Path has uncommitted changes. Nothing was removed."); exit 1 }',
    '$branch = (& git -C $Path branch --show-current)',
    '$dev = Join-Path (Split-Path $Path -Parent) "dev"',
    'for ($i = 0; $i -lt 10; $i++) {',
    '  & git -C $dev worktree remove $Path 2>$null',
    '  if ($LASTEXITCODE -eq 0) { break }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    'if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("git worktree remove failed for $Path"); exit 1 }',
    '& git -C $dev branch -d $branch | Out-Null',
    '[Console]::Out.WriteLine("removed: $Path")',
    'exit 0',
  ],
};

function makeRepo() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'worktree', 'add', '-q', wtPath('feat/a'), '-b', 'feat/a');
  fs.mkdirSync(scripts, { recursive: true });
  for (const [name, lines] of Object.entries(STAND_INS)) fs.writeFileSync(path.join(scripts, name), lines.join('\r\n') + '\r\n');
}

const gitDirOf = (wt) => resolveWorktreeGitDir(path.join(wt, '.git'));
const listed = () => git(dev, 'worktree', 'list', '--porcelain').split(/\r?\n/)
  .filter(l => l.startsWith('worktree ')).map(l => path.resolve(l.slice(9)).toLowerCase());

// --- the app -------------------------------------------------------------------------
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
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDE_CUSTOM_PORT;
  delete env.CLAUDE_CUSTOM_TOKEN;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_WORKTREE_SCRIPTS'] });
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
const tabOf = (s, label) => (s && s.tabs ? s.tabs.find(t => t.label === label) : null);
const hostOf = (s, label) => (s && s.hosts ? s.hosts.find(h => h.label === label) : null);
const labelsOf = (s) => (s && s.tabs ? s.tabs.map(t => t.label) : []);

function hostsUnder(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase() === path.resolve(dir).toLowerCase()) out.push(id);
  }
  return out;
}

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
const remember = (s) => { for (const h of (s && s.hosts) || []) if (Number.isInteger(h.pid)) seenPids.add(h.pid); };

// What a person does to end a session: type `exit` into its terminal. The
// host exits with its claude (here cmd.exe), so the tab's port refuses.
function typeInto(port, text) {
  return new Promise((resolve) => {
    let token = null;
    try { token = fs.readFileSync(path.join(HARNESS_DIR, 'hosts', `${port}.token`), 'utf8').trim(); } catch { return resolve(false); }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    const t = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } resolve(false); }, 10000);
    ws.on('open', () => {
      ws.send(Buffer.from(text, 'utf8'), { binary: true }, () => {
        setTimeout(() => { clearTimeout(t); try { ws.close(); } catch { /* gone */ } resolve(true); }, 300);
      });
    });
    ws.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function writeMarker(branch) {
  const gd = gitDirOf(wtPath(branch));
  fs.writeFileSync(path.join(gd, 'claude-merged.json'),
    JSON.stringify({ branch, pr: 1, mergedAt: new Date().toISOString() }));
}

async function startedTab(app, label, ms = 40000) {
  return waitFor(async () => {
    const x = await state(app);
    const h = hostOf(x, label);
    return tabOf(x, label) && tabOf(x, label).started && h && Number.isInteger(h.port) ? x : null;
  }, ms);
}

function killEverything() {
  for (const dir of [dev, ...['feat/a', 'feat/demo', 'feat/setup-fails', 'feat/dirty', 'feat/keep'].map(wtPath)]) {
    for (const id of hostsUnder(dir)) seenPids.add(id.pid, id.processStartedAt);
  }
  seenPids.killAll();
}
hygiene.addCleanup(killEverything);

function removeTemp() {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {
    console.log(`(could not remove ${tmp}: ${e.message})`);
  }
}

// --- the probe -------------------------------------------------------------------------
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
  check('the strip painted the +', !!s.stripChrome && s.stripChrome.plus === true, JSON.stringify(s.stripChrome));

  // ===== criterion 2: a refusal, word for word, and nothing made =====
  await command(app, { cmd: 'create', branch: 'demo' });
  s = await waitFor(async () => { const x = await state(app); return x.create && x.create.phase === 'failed' ? x : null; }, 30000);
  const refusal = 'demo has no prefix: use feat/, fix/, spike/, chore/, docs/, refactor/ or test/.';
  check("`demo` shows the script's refusal word for word (criterion 2)",
    !!s && s.create.error === refusal && s.stripChrome && s.stripChrome.alert === refusal, s && JSON.stringify(s.create));
  check('and makes no folder and no tab', !fs.existsSync(wtPath('demo')) && !labelsOf(s).includes('demo'));
  await command(app, { cmd: 'cancelCreate' });

  // ===== criteria 2 + 10: a new branch, set up before its session =====
  await command(app, { cmd: 'create', branch: 'feat/demo' });
  let during = null;
  let hostDuring = null;
  s = await waitFor(async () => {
    const x = await state(app);
    const t = tabOf(x, 'feat/demo');
    if (t && t.setup && t.setup.running && t.setup.line) {
      during = x;
      hostDuring = hostsUnder(wtPath('feat/demo')).length;
      return x;
    }
    return null;
  }, 30000, 200);
  check('feat/demo gets a tab on a new folder (criterion 2)', !!s && fs.existsSync(wtPath('feat/demo')), labelsOf(s).join(', '));
  check('its setup runs with its progress on the tab (criterion 10)',
    !!during && /setup step/.test(tabOf(during, 'feat/demo').setup.line) && !!during.stripChrome && /Setting up feat\/demo/.test(during.stripChrome.pane || ''),
    during && JSON.stringify({ setup: tabOf(during, 'feat/demo').setup, pane: during.stripChrome && during.stripChrome.pane }));
  check('and no host serves the folder while it does', hostDuring === 0, `hosts: ${hostDuring}`);
  s = await startedTab(app, 'feat/demo');
  remember(s);
  check('the session starts once setup ends, on the selected new tab',
    !!s && s.selectedKey === tabOf(s, 'feat/demo').key && tabOf(s, 'feat/demo').setup === null,
    s && `selected ${s.selectedKey}`);

  // ===== criterion 10: a failing setup still starts the session =====
  await command(app, { cmd: 'create', branch: 'feat/setup-fails' });
  s = await startedTab(app, 'feat/setup-fails', 60000);
  remember(s);
  const failText = s && s.stripChrome ? s.stripChrome.alert || '' : '';
  check('a failing setup still starts the session, and says why (criterion 10)',
    !!s && /^Setup failed: run: 'npm ci' exited with 1/.test(failText), failText);

  // ===== criterion 3: merged, the session ends, the folder goes =====
  const demoHost = hostOf(s, 'feat/demo');
  writeMarker('feat/demo');
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, 'feat/demo') && tabOf(x, 'feat/demo').phase === 'finishing' ? x : null; }, 15000);
  const badge = s && Array.isArray(s.stripDom) ? (s.stripDom.find(t => t.label === 'feat/demo') || {}).badge : null;
  check('the marker labels the tab merged, and it keeps running', !!s && badge === 'merged' && fs.existsSync(wtPath('feat/demo')),
    `badge ${badge}`);
  const typed = demoHost ? await typeInto(demoHost.port, 'exit\r') : false;
  const gone = await waitFor(async () => {
    const x = await state(app);
    return !tabOf(x, 'feat/demo') && !fs.existsSync(wtPath('feat/demo')) ? x : null;
  }, 30000, 300);
  check('its session ends -> the tab closes and the folder is removed (criterion 3)', typed && !!gone,
    `typed ${typed}, folder ${fs.existsSync(wtPath('feat/demo'))}`);
  check('and git no longer lists the worktree', !listed().includes(path.resolve(wtPath('feat/demo')).toLowerCase()));

  // ===== criterion 4: uncommitted changes -> kept, with the error shown =====
  await command(app, { cmd: 'create', branch: 'feat/dirty' });
  s = await startedTab(app, 'feat/dirty', 60000);
  remember(s);
  fs.writeFileSync(path.join(wtPath('feat/dirty'), 'scratch.txt'), 'not committed');
  writeMarker('feat/dirty');
  await waitFor(async () => { const x = await state(app); return tabOf(x, 'feat/dirty') && tabOf(x, 'feat/dirty').phase === 'finishing'; }, 15000);
  await typeInto(hostOf(s, 'feat/dirty').port, 'exit\r');
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, 'feat/dirty') && tabOf(x, 'feat/dirty').phase === 'remove-failed' ? x : null; }, 30000, 300);
  const dirtyAlert = s && s.stripChrome ? s.stripChrome.alert || '' : '';
  check('a remove that fails keeps the tab and shows the error (criterion 4)',
    !!s && /has uncommitted changes/.test(dirtyAlert), dirtyAlert);
  check('and the folder stays', fs.existsSync(path.join(wtPath('feat/dirty'), 'scratch.txt')));

  // ===== exit 2: kept on purpose, not an error =====
  await command(app, { cmd: 'create', branch: 'feat/keep' });
  s = await startedTab(app, 'feat/keep', 60000);
  remember(s);
  fs.writeFileSync(path.join(gitDirOf(wtPath('feat/keep')), 'KEEP'), '');
  writeMarker('feat/keep');
  await waitFor(async () => { const x = await state(app); return tabOf(x, 'feat/keep') && tabOf(x, 'feat/keep').phase === 'finishing'; }, 15000);
  await typeInto(hostOf(s, 'feat/keep').port, 'exit\r');
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, 'feat/keep') && tabOf(x, 'feat/keep').phase === 'kept' ? x : null; }, 30000, 300);
  const keptAlert = s && s.stripChrome ? s.stripChrome.alert || '' : '';
  const keptBadge = s && Array.isArray(s.stripDom) ? (s.stripDom.find(t => t.label === 'feat/keep') || {}).badge : null;
  check('a remover that keeps the folder on purpose (exit 2) leaves a "kept" tab, not an error',
    !!s && /^Merged, and kept: the branch still has a handoff brief/.test(keptAlert) && keptBadge === 'merged' && fs.existsSync(wtPath('feat/keep')),
    `${keptAlert} / badge ${keptBadge}`);

  // ===== reopen: the + menu and Ctrl+Shift+T =====
  await command(app, { cmd: 'select', label: 'feat/a' });
  s = await startedTab(app, 'feat/a');
  remember(s);
  const closed = await command(app, { cmd: 'close', label: 'feat/a' });
  s = await waitFor(async () => { const x = await state(app); return !tabOf(x, 'feat/a') ? x : null; }, 15000);
  check('a hand-closed tab is offered back by the + menu', closed.ok === true && !!s &&
    Array.isArray(s.reopenable) && s.reopenable.some(r => r.label === 'feat/a'), s && JSON.stringify(s.reopenable));
  await command(app, { cmd: 'reopen' });
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, 'feat/a') && x.selectedKey === tabOf(x, 'feat/a').key ? x : null; }, 15000);
  check('Reopen brings it back, selected', !!s);
  await startedTab(app, 'feat/a');
  await command(app, { cmd: 'close', label: 'feat/a' });
  await waitFor(async () => !tabOf(await state(app), 'feat/a'), 15000);
  await command(app, { cmd: 'select', label: 'develop' });
  await sleep(500);
  await command(app, { cmd: 'key', key: 'T', modifiers: ['control', 'shift'] });
  s = await waitFor(async () => { const x = await state(app); return tabOf(x, 'feat/a') ? x : null; }, 15000);
  check('Ctrl+Shift+T reopens the last closed tab', !!s);

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
    hygiene._emergencyCleanup('done');
    await sleep(800);
    removeTemp();
  }
  if (skipped) {
    console.log(`\n${failures} FAILED -- the app did not come up, so the rest was never measured`);
    process.exit(1);
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
