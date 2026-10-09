'use strict';
/**
 * PROBE: Ctrl+click closes a merged, safe tab with no confirm (backlog #77) in a REAL window. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-ctrl-click-close.js      (exit 0 = every check held)
 *   CTRL_CLOSE_PROBE_SHOTS=<dir>                                          also keep the screenshots there
 *
 * The unit tests pin the decision (test/close-safety.test.js) and the shell's close (test/tab-shell.test.js).
 * They cannot see the strip PAGE turn a real Ctrl+click into "close if safe", nor the git facts read from a real
 * repo. This sends a real mouse event with the control modifier to the strip, over a temp git project with an
 * origin:
 *
 *   feat/a  merged marker, clean, nothing unpushed   -> closes with NO confirm
 *   feat/b  merged marker, one untracked file        -> asks, reason "1 uncommitted file"
 *   feat/c  no marker                                -> asks, reason "not merged"
 *   dev     Ctrl+click only selects (it has no close)
 *   plain close of feat/c                            -> asks with no reason (the old single confirm)
 *
 * The probe driver answers a confirm with yes only when it carries no reason, so an unsafe Ctrl+click leaves the
 * tab open and the reason is read back from state.confirms.
 *
 * SAFE. Every host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN); CLAUDE_CUSTOM_WORKTREE_SCRIPTS points at an empty
 * folder so a merged marker can never remove a worktree; the project and its origin are temp folders; the only
 * processes stopped are the window it started and hosts whose folder is inside the temp folder, by PID.
 */

const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { killPidTree } = require(path.join(ROOT, 'host', 'kill-tree'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-ctrlclose-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const origin = path.join(tmp, 'origin.git');
const userData = path.join(tmp, 'user-data');
const scripts = path.join(tmp, 'no-scripts');
const shots = process.env.CTRL_CLOSE_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(scripts, { recursive: true });

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
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_WORKTREE_SCRIPTS'];

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
    CLAUDE_CUSTOM_WORKTREE_SCRIPTS: scripts,
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

const seenPids = new Set();
function killEverything() {
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => /^\d+\.json$/.test(f)); } catch { files = []; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) seenPids.add(id.pid);
  }
  for (const pid of seenPids) { try { killPidTree(pid); } catch { /* gone */ } }   // kill-ok: a host pid from an identity file or the app state, no handle held
}
hygiene.addCleanup(killEverything);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

const mark = (folder, branch) => {
  const gitDir = git(folder, 'rev-parse', '--absolute-git-dir').trim();
  fs.writeFileSync(path.join(gitDir, 'claude-merged.json'), JSON.stringify({ branch, pr: 77, mergedAt: new Date().toISOString() }));
};

const labelsOf = async (app) => {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.add(h.pid);
  return st;
};
const tabLabels = (st) => ((st && st.tabs) || []).map(t => t.label);
const shoot = (app, name) => command(app, { cmd: 'screenshot', file: path.join(shots, `${name}.png`) });

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(tmp, 'init', '-q', '--bare', '-b', 'develop', origin);
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dev, 'remote', 'add', 'origin', origin);
  git(dev, 'push', '-q', 'origin', 'develop');
  for (const [dir, branch] of [['feat-a', 'feat/a'], ['feat-b', 'feat/b'], ['feat-c', 'feat/c']]) {
    git(dev, 'worktree', 'add', '-q', path.join(container, dir), '-b', branch);
  }
  mark(path.join(container, 'feat-a'), 'feat/a');
  mark(path.join(container, 'feat-b'), 'feat/b');
  fs.writeFileSync(path.join(container, 'feat-b', 'notes.txt'), 'unsaved work\n');

  const app = await launchApp(container);
  const up = await waitFor(async () => {
    const st = await labelsOf(app);
    return st && tabLabels(st).length === 4 ? st : null;
  }, 60000);
  check('0: the window is up with develop, feat/a, feat/b and feat/c', !!up, up ? '' : `exited=${app.exited} out=${app.out.slice(-600)}`);
  if (!up) return;
  await sleep(1500);
  await shoot(app, '1-before');

  // dev: Ctrl+click only selects
  await command(app, { cmd: 'ctrlClick', label: 'develop' });
  await sleep(700);
  let st = await labelsOf(app);
  check('1: Ctrl+click on develop closes nothing and asks nothing', tabLabels(st).includes('develop') && st.confirms.length === 0, JSON.stringify(st.confirms));

  // feat/b: merged, but one file uncommitted
  await command(app, { cmd: 'ctrlClick', label: 'feat/b' });
  await waitFor(async () => (await labelsOf(app)).confirms.length >= 1, 15000);
  st = await labelsOf(app);
  check('2: a merged tab with an uncommitted file asks, and says why', st.confirms.length === 1 && st.confirms[0].label === 'feat/b'
    && st.confirms[0].reason === '1 uncommitted file', JSON.stringify(st.confirms));
  check('2: ...and stays open', tabLabels(st).includes('feat/b'));

  // feat/c: no marker
  await command(app, { cmd: 'ctrlClick', label: 'feat/c' });
  await waitFor(async () => (await labelsOf(app)).confirms.length >= 2, 15000);
  st = await labelsOf(app);
  check('3: an unmerged tab asks, and says "not merged"', st.confirms.length === 2 && st.confirms[1].label === 'feat/c'
    && st.confirms[1].reason === 'not merged', JSON.stringify(st.confirms));
  await shoot(app, '2-unsafe-asked');

  // feat/a: merged, clean, pushed -> closes with no confirm
  await command(app, { cmd: 'ctrlClick', label: 'feat/a' });
  const closed = await waitFor(async () => {
    const s = await labelsOf(app);
    return !tabLabels(s).includes('feat/a') ? s : null;
  }, 15000);
  check('4: a merged, clean, pushed tab closes on Ctrl+click', !!closed, JSON.stringify(tabLabels(await labelsOf(app))));
  st = await labelsOf(app);
  check('4: ...with NO confirm', st.confirms.length === 2, JSON.stringify(st.confirms));
  check('4: ...and the others stay', ['develop', 'feat/b', 'feat/c'].every(l => tabLabels(st).includes(l)), JSON.stringify(tabLabels(st)));
  check('4: ...the closed tab is offered back by the + menu', Array.isArray(st.reopenable) && st.reopenable.some(r => /feat\/a|feat-a/i.test(JSON.stringify(r))), JSON.stringify(st.reopenable));
  await sleep(500);
  await shoot(app, '3-after-safe-close');

  // a plain close still asks once, with no reason
  const r = await command(app, { cmd: 'close', label: 'feat/c' });
  st = await labelsOf(app);
  check('5: a plain close of feat/c asks once, with no reason', r.ok === true && st.confirms.length === 3 && st.confirms[2].reason === '', JSON.stringify(st.confirms));

  await command(app, { cmd: 'quit' });
}

main().catch((err) => { console.log(`FAIL  probe crashed: ${(err && err.stack) || err}`); failures++; })
  .finally(async () => {
    killEverything();
    await sleep(500);
    console.log(failures === 0 ? '\nALL CHECKS HELD' : `\n${failures} CHECK(S) FAILED`);
    console.log(`screenshots: ${shots}`);
    process.exit(failures === 0 ? 0 : 1);
  });
