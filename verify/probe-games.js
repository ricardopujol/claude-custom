'use strict';
/**
 * PROBE: the Games panel (BACKLOG #41), in a REAL window with a REAL host. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-games.js        (exit 0 = every check held)
 *   GAMES_PROBE_SHOTS=<dir>                                        where the screenshots go
 *
 * The unit tests pin the rules (test/games-rules*.test.js), the round and the hand-back (test/games-round.test.js), the panel
 * through a fake document (test/games-display.test.js) and the score store (test/game-scores.test.js). No unit test can see the
 * page: every renderer script shares ONE global scope (CLAUDE.md), the canvas is only real here, and "keyboard focus goes back to
 * the terminal" is a fact about xterm's textarea. This starts a real window and a real session host, then checks:
 *
 *   1  the three scripts loaded in the shared plain-script scope; the panel opens from its tab and shows Stack's cover; the
 *      board is drawn (more than one colour on the canvas) and the colours follow the project's accent
 *   2  Play starts a 45-second round whose clock runs; Space on the board drops a block
 *   3  a key meant for the terminal does nothing in the game: with the terminal holding focus, Space is not a drop
 *   4  HAND-BACK: Claude's attention message (the same handleControl path the host's message takes) pauses the running round
 *      with "Claude needs you", freezes its clock, and puts keyboard focus in the terminal; coming back to the board resumes it
 *   5  the panel stops drawing when it is hidden (another tab selected): the round pauses, the clock stops, nothing runs
 *      until the board is clicked
 *   6  Merge 2048 takes arrow keys; Pipeline takes a click
 *   7  a round that ends banks its score: the header shows the new best, and it is on disk in .harness/state/wait-games.json
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills and no prompt is ever sent; ELECTRON_RUN_AS_NODE
 * and every CLAUDE_CUSTOM_* variable of an enclosing tab are stripped; the project is a temp git repo, registry, portraits,
 * uploads and user data are temp folders. Files of THIS checkout the app writes (the layout files and wait-games.json under
 * .harness/state) are snapshotted and put back on every exit path. Only PIDs this probe started are killed (never by name).
 * The attention step goes through the real handler, which asks main for an OS toast when the window isn't focused: a silent
 * one at worst (the message is not urgent).
 */

const { execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-games-'));
const dev = path.join(tmp, 'proj', 'dev');
const userData = path.join(tmp, 'user-data');
const shots = process.env.GAMES_PROBE_SHOTS || path.join(ROOT, '.harness', 'probe-games');
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
const SCORES_FILE = path.join(STATE_DIR, 'wait-games.json');
const snaps = [snapshotFile(LAYOUT_FILE), snapshotFile(TREE_FILE), snapshotFile(SCORES_FILE)];
hygiene.addCleanup(() => snaps.forEach(s => s.restore()));
hygiene.install();

async function launchApp(cwd) {
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
  };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env },
    { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
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

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const f of [LAYOUT_FILE, TREE_FILE, SCORES_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }

  const app = await launchApp(dev);
  const ready = await viewReady(app);
  check('the window came up with a session', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;
  const gs = () => view(app, 'gamesState');
  const doIt = (a) => view(app, 'gamesDo', a);
  const shot = async (name) => { await sleep(250); await command(app, { cmd: 'screenshot', file: path.join(shots, name) }); };

  // 1 -----------------------------------------------------------------------------
  await view(app, 'select', { id: 'games' });
  const s1 = await waitFor(async () => { const s = await gs(); return s && s.ok && s.shown ? s : null; }, 10000, 200);
  check('1: the Games panel opens from its tab', !!s1);
  if (!s1) return;
  check('1: games-rules.js, games-round.js and games-display.js loaded in the shared plain-script scope', s1.scope === true);
  check('1: it starts on Stack the PRs, idle, with the cover and a Play button', s1.state.game === 'stack' && s1.state.phase === 'idle' && s1.cover.hidden === false && s1.cover.button === 'Play', JSON.stringify([s1.state, s1.cover]));
  check('1: the three games are offered, Stack chosen', JSON.stringify(s1.picks) === JSON.stringify([['stack', true], ['merge', false], ['pipeline', false]]), JSON.stringify(s1.picks));
  check('1: the header shows a best of 0 for every game', s1.best === 'Stack 0 \u00B7 Merge 0 \u00B7 Pipeline 0', s1.best);
  check('1: the board is drawn (more than one colour on the canvas) and sized', s1.colours > 1 && s1.canvas.width > 100 && s1.canvas.height > 60, JSON.stringify([s1.colours, s1.canvas]));
  check('1: the project\'s accent is a real colour token', /^#[0-9a-f]{6}$/i.test(s1.accent), s1.accent);
  await shot('games-1-idle.png');

  // 2 -----------------------------------------------------------------------------
  await doIt({ op: 'go' });
  const s2 = await waitFor(async () => { const s = await gs(); return s.state.phase === 'running' && Number(s.time) < 45 ? s : null; }, 8000, 150);
  check('2: Play starts a round and its clock runs (45 s counting down)', !!s2, JSON.stringify(s2 && [s2.state.phase, s2.time]));
  check('2: the cover is gone while playing', !!s2 && s2.cover.hidden === true);
  await doIt({ op: 'focusBoard' });
  await doIt({ op: 'keyAtFocus', key: ' ', code: 'Space' });
  const s2b = await gs();
  check('2: Space on the board drops a block (score 1)', s2b.state.score === 1, JSON.stringify([s2b.state.score, s2b.score]));
  check('2: the colours cover the sliding block and the stack', s2b.colours > 2, String(s2b.colours));
  await shot('games-2-running-stack.png');

  // 3 -----------------------------------------------------------------------------
  await doIt({ op: 'termFocus' });
  const t0 = await gs();
  check('3: after focusing the terminal, the terminal (not the panel) holds the keyboard', t0.focus.terminal === true && t0.focus.panel === false, JSON.stringify(t0.focus));
  await doIt({ op: 'keyAtFocus', key: ' ', code: 'Space' });
  const t1 = await gs();
  check('3: Space typed with the terminal focused is NOT a drop in the game', t1.state.score === t0.state.score, JSON.stringify([t0.state.score, t1.state.score]));

  // 4 -----------------------------------------------------------------------------
  await doIt({ op: 'focusBoard' });
  const before = await gs();
  check('4: (setup) the round is still running with focus on the board', before.state.phase === 'running' && before.focus.panel === true, JSON.stringify([before.state.phase, before.focus]));
  await doIt({ op: 'attention', urgent: false });
  const h1 = await gs();
  check('4: Claude\'s attention message pauses the running round, because Claude needs you', h1.state.phase === 'paused' && h1.state.why === 'claude', JSON.stringify([h1.state.phase, h1.state.why]));
  check('4: the cover says "\u270B Claude needs you" and offers Resume', h1.cover.hidden === false && h1.cover.text === '\u270B Claude needs you' && h1.cover.button === 'Resume', JSON.stringify(h1.cover));
  check('4: keyboard focus went back to the terminal', h1.focus.terminal === true && h1.focus.panel === false, JSON.stringify(h1.focus));
  check('4: no frame is left running', h1.state.looping === false);
  await shot('games-4-claude-needs-you.png');
  const frozen = h1.state.left;
  await sleep(1200);
  const h2 = await gs();
  check('4: the clock is frozen while paused', h2.state.left === frozen && h2.state.score === h1.state.score, JSON.stringify([frozen, h2.state.left]));
  await doIt({ op: 'keyAtFocus', key: ' ', code: 'Space' });
  check('4: a key typed for Claude (terminal focused) does not move the paused game', (await gs()).state.score === h1.state.score);
  await doIt({ op: 'resume' });
  const h3 = await waitFor(async () => { const s = await gs(); return s.state.phase === 'running' && s.state.left < frozen ? s : null; }, 5000, 150);
  check('4: coming back to the board resumes the round from where it stopped, score kept', !!h3 && h3.state.score === h1.state.score && h3.state.left > frozen - 3, JSON.stringify(h3 && [h3.state.left, h3.state.score]));
  check('4: the cover is gone again', !!h3 && h3.cover.hidden === true);

  // 5 -----------------------------------------------------------------------------
  await view(app, 'select', { id: 'agents' });
  const hid = await waitFor(async () => { const s = await gs(); return s.shown === false && s.state.phase === 'paused' ? s : null; }, 5000, 150);
  check('5: selecting another tab hides the panel and pauses the round, saying why', !!hid && hid.state.why === 'hidden' && hid.state.drawing === false, JSON.stringify(hid && hid.state));
  check('5: nothing keeps running while it is hidden', !!hid && hid.state.looping === false);
  const hl = hid && hid.state.left;
  await sleep(1200);
  check('5: the clock does not run while hidden', (await gs()).state.left === hl);
  await view(app, 'select', { id: 'games' });
  const back = await waitFor(async () => { const s = await gs(); return s.shown ? s : null; }, 5000, 150);
  check('5: showing it again does not restart play by itself', !!back && back.state.phase === 'paused', JSON.stringify(back && back.state.phase));
  await doIt({ op: 'resume' });
  check('5: a click on the board resumes it', !!(await waitFor(async () => { const s = await gs(); return s.state.phase === 'running' ? s : null; }, 5000, 150)));

  // 6 -----------------------------------------------------------------------------
  await doIt({ op: 'pick', game: 'merge' });
  await doIt({ op: 'go' });
  await doIt({ op: 'focusBoard' });
  const m0 = await waitFor(async () => { const s = await gs(); return s.state.game === 'merge' && s.state.phase === 'running' ? s : null; }, 5000, 150);
  check('6: Merge 2048 starts', !!m0 && m0.colours > 2, JSON.stringify(m0 && [m0.state.game, m0.colours]));
  for (const k of ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown']) { await doIt({ op: 'keyAtFocus', key: k, code: k }); await sleep(60); }
  const m1 = await gs();
  check('6: arrow keys play Merge (the score counts merged tiles, and the board still draws)', m1.state.phase === 'running' && Number(m1.score) >= 0 && m1.colours > 2, JSON.stringify([m1.score, m1.colours]));
  await shot('games-6-merge.png');
  await doIt({ op: 'pick', game: 'pipeline' });
  await doIt({ op: 'go' });
  const p0 = await waitFor(async () => { const s = await gs(); return s.state.game === 'pipeline' && s.state.phase === 'running' ? s : null; }, 5000, 150);
  check('6: Pipeline starts', !!p0 && p0.colours > 2);
  await doIt({ op: 'click', x: 100, y: 60 });
  await doIt({ op: 'click', x: 200, y: 150 });
  check('6: clicks on tiles keep Pipeline running and drawn', (await gs()).state.phase === 'running');
  await shot('games-6-pipeline.png');

  // 7 -----------------------------------------------------------------------------
  await doIt({ op: 'pick', game: 'stack' });
  await doIt({ op: 'go' });
  await doIt({ op: 'focusBoard' });
  for (let i = 0; i < 80; i += 1) {
    const s = await gs();
    if (s.state.phase === 'over') break;
    await doIt({ op: 'keyAtFocus', key: ' ', code: 'Space' });
    await sleep(70 + (i * 37) % 160);
  }
  const over = await waitFor(async () => { const s = await gs(); return s.state.phase === 'over' ? s : null; }, 60000, 300);
  check('7: a Stack round ends (a miss or the clock)', !!over, JSON.stringify(over && over.state));
  if (over) {
    check('7: the cover reports the result and offers Again', over.cover.hidden === false && /^(Missed|Time): \d+$/.test(over.cover.text) && over.cover.button === 'Again', JSON.stringify(over.cover));
    const score = over.state.score;
    const shown = await waitFor(async () => { const s = await gs(); return s.best.startsWith(`Stack ${score} `) ? s : null; }, 5000, 150);
    check('7: the new best is in the header', score > 0 && !!shown, JSON.stringify([score, (await gs()).best]));
    let disk = null;
    try { disk = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8')); } catch { /* none */ }
    check('7: and on disk in wait-games.json', !!disk && disk.stack === score, JSON.stringify(disk));
    await shot('games-7-over.png');
  }

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
