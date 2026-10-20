'use strict';
/**
 * Takes the README's two screenshots in a REAL window with a REAL host and the REAL `claude` CLI. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/screenshots-readme.js        (exit 0 = both files written, each under 400 KB)
 *
 *   docs/screenshots/terminal-roster.png    the terminal with the Agents roster docked beside it
 *   docs/screenshots/resources-history.png  the Resources chip's one-hour CPU and memory history, open over the terminal
 *
 * The project is a throwaway git repo called `my-app` in a fresh `demo-xxxx` folder under the home folder, so no real project name is in the picture. The roster is filled by
 * firing hook events through the real hook helper into the host's own pipe (the way verify/probe-gui.js does), so it shows
 * what the hooks show. The CLI starts and sits at its prompt: nothing is typed and no model is called.
 *
 * SAFE: ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* variable of an enclosing tab are stripped by verify/lib/launch-electron.js,
 * which also takes the machine-wide heavy lock and stops only the process tree it started, by PID. Registry, portraits,
 * uploads and user data are temp folders. Two files of THIS checkout are touched because host.js hardcodes its state dir
 * (.harness/state/layout-global.json and layout-tree.json): both are snapshotted and put back on every exit path.
 * One residue: answering the CLI's trust prompt makes the CLI itself record that throwaway folder (in ~/.claude.json), one orphan entry per run.
 * The keys are timed with sleeps, and the exit code only measures the PNG sizes, not that the prompt was passed: look at the pictures.
 * WINDOWS ONLY. Never `offscreen: true`: it hangs capturePage here (CLAUDE.md).
 */
const { spawnSync, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');
const { readIdentity } = require('../host/host-identity');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.harness', 'state');
const HOST_LOG = path.join(ROOT, '.harness', 'host.log');
const HELPER = path.join(ROOT, '.harness', 'hook-helper.exe');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const MAX_BYTES = 400 * 1024;

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Under the home folder, not the temp one: the CLI prints the folder it runs in (`~\demo-xxxx\my-app\dev`), and a temp path with the
// user's name in it doesn't belong in a README picture. mkdtemp makes a fresh folder, so removing it below can't touch anything else.
const tmp = fs.mkdtempSync(path.join(os.homedir(), 'demo-'));
const dev = path.join(tmp, 'my-app', 'dev');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

const snaps = ['layout-global.json', 'layout-tree.json', 'resource-chip.json'].map(f => snapshotFile(path.join(STATE_DIR, f)));
hygiene.addCleanup(() => snaps.forEach(s => s.restore()));
hygiene.install();

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
function command(app, cmd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: app.port });
    let buf = '';
    const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done({ ok: false, error: `no reply to ${cmd.cmd}` }), timeoutMs);
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

// pid -> start time, so a pid Windows has reused since is never killed (verify/lib/seen-pids.js)
const seenPids = require('./lib/seen-pids').createSeenPids();
function killHosts() {
  // Hosts this run started: identity files whose cwd is inside our temp folder. Killed by PID, with the tree (the pty's claude).
  try {
    const dir = path.join(ROOT, '.harness', 'hosts');
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      const id = readIdentity({ dir: path.join(ROOT, '.harness'), port: Number(f.replace(/\.json$/, '')) });
      if (id && typeof id.cwd === 'string' && path.resolve(id.cwd).toLowerCase().startsWith(path.resolve(tmp).toLowerCase() + path.sep)) seenPids.add(id.pid, id.processStartedAt);
    }
  } catch { /* none */ }
  seenPids.endAll();   // a dead or reused pid is left alone
}
hygiene.addCleanup(killHosts);

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const f of ['layout-global.json', 'layout-tree.json', 'resource-chip.json']) { try { fs.unlinkSync(path.join(STATE_DIR, f)); } catch { /* none */ } }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const logFrom = fs.existsSync(HOST_LOG) ? fs.statSync(HOST_LOG).size : 0;

  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_CWD: dev,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, `--user-data-dir=${path.join(tmp, 'user-data')}`],
    { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN'] });
  hygiene.registerChild(child);
  const app = { port, token, child, out: '', exited: false };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; });

  const ready = await waitFor(async () => {
    const st = await command(app, { cmd: 'state' });
    const sel = st && st.hosts && st.hosts.find(x => x.key === st.selectedKey);
    if (!sel || !sel.started) return null;
    if (Number.isInteger(sel.pid)) seenPids.see(sel.pid);
    const v = await view(app, 'state');
    return v && v.ok && v.sent ? v : null;
  }, 60000);
  if (!ready) throw new Error('the window never came up with a session:\n' + app.out.slice(-800));
  console.log('window is up');

  // The CLI asks whether to trust a folder it has never seen: answer "Yes, I trust this folder" the way a person would (Down, Enter).
  // The CLI itself then records that one temp folder; nothing of its state is edited from here.
  await sleep(6000);
  await command(app, { cmd: 'key', key: 'Down' });
  await sleep(500);
  await command(app, { cmd: 'key', key: 'Return' });
  await sleep(8000);

  const dbg = process.env.SHOTS_DEBUG_DIR;
  if (dbg) await command(app, { cmd: 'screenshot', file: path.join(dbg, 'a-after-trust.png') });

  // Fill the roster through the real hook helper, into this host's pipe (the last one the host log names since we started).
  const log = fs.readFileSync(HOST_LOG, 'utf8').slice(logFrom);
  const pipes = [...log.matchAll(/hook bridge listening on (\S+)/g)].map(m => m[1]);
  const pipe = pipes[pipes.length - 1];
  if (!pipe) throw new Error('no hook bridge in host.log since the launch');
  const fire = (event, payload) => spawnSync(HELPER, ['--pipe', pipe, '--event', event], { input: JSON.stringify(payload), windowsHide: true });
  const task = agent => ({ tool_name: 'Agent', tool_input: { subagent_type: agent } });
  fire('PreToolUse', task('code-reviewer'));
  fire('PreToolUse', task('test-automator'));
  fire('PreToolUse', task('refactoring-specialist'));
  fire('PreToolUse', task('docs-writer'));
  fire('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } });
  fire('SubagentStop', {});
  if (dbg) { await sleep(1000); await command(app, { cmd: 'screenshot', file: path.join(dbg, 'b-after-hooks.png') }); }
  await view(app, 'dock', { id: 'agents', target: { edge: 'right' } });
  await sleep(6000);
  if (dbg) { await sleep(25000); await command(app, { cmd: 'screenshot', file: path.join(dbg, 'c-later.png') }); }   // the CLI's own screen finishes drawing; the roster settles
  const a = await command(app, { cmd: 'screenshot', file: path.join(OUT_DIR, 'terminal-roster.png') });
  console.log('terminal-roster:', JSON.stringify(a));

  // The Resources chip's one-hour history: real CPU and memory graphs, once a few samples are in (the panel's own list is mostly the
  // machine's leftovers, which is a poor picture and says more about this machine than about the panel).
  const sampled = await waitFor(async () => {
    const st = await view(app, 'resourcesState');
    return st && st.hist && st.hist.points >= 3 && st.payloadHasModel ? st : null;
  }, 120000, 1000);
  if (!sampled) throw new Error('the Resources history never got three samples');
  await view(app, 'resourcesClick', { chip: true });
  const popped = await waitFor(async () => { const st = await view(app, 'resourcesState'); return st && st.hist && st.hist.open && st.hist.graphs.length >= 2 ? st : null; }, 10000, 200);
  if (!popped) throw new Error('the Resources popover never opened');
  await sleep(1500);
  const b = await command(app, { cmd: 'screenshot', file: path.join(OUT_DIR, 'resources-history.png') });
  console.log('resources-history:', JSON.stringify(b));

  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 10000);
}

let failed = false;
main()
  .catch((err) => { console.error('FAIL: ' + (err && err.stack)); failed = true; })
  .finally(() => {
    killHosts();
    snaps.forEach(s => s.restore());
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    for (const f of ['terminal-roster.png', 'resources-history.png']) {
      const p = path.join(OUT_DIR, f);
      const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
      console.log(`${size > 0 && size < MAX_BYTES ? 'ok  ' : 'BAD '} ${p} ${size} bytes`);
      if (!(size > 0 && size < MAX_BYTES)) failed = true;
    }
    process.exit(failed ? 1 : 0);
  });
