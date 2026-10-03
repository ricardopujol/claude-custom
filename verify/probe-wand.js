'use strict';
/**
 * PROBE: the wand (BACKLOG #51), favourite skills as emoji buttons, in a REAL window with a REAL host.
 * (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-wand.js        (exit 0 = every check held)
 *   WAND_PROBE_SHOTS=<dir>                                       where the screenshots go
 *
 * The unit tests pin what the panel SAYS (test/wand-display.test.js) and what the host DOES with a file
 * (test/wand-control.test.js). No unit test can see the page: every renderer script shares ONE global scope
 * (CLAUDE.md), so a module can load in a test and still abort in the window. This draws the real panel from
 * a real host, and checks:
 *
 *   1  the Wand module draws the default set from a real host (🌙 ✅ 🔀 💡), and a favourite whose skill
 *      isn't on disk (💡 /brainstorming here) is dimmed and says "skill not found"
 *   2  a click leaves EXACTLY `/checkpoint` in a stand-in CLI input box (verify/lib/fake-claude-box.js, which
 *      logs anything submitted) with nothing submitted, and the button flashes "typed, press Enter"
 *   3  a draft already in the box is cleared, not submitted with the command; a double click types it once
 *   4  clicking the dimmed favourite types nothing (a draft stays exactly as it was) and says why
 *   5  edit mode: ✕ and + appear and the buttons drag; changing an emoji persists to .harness/state/wand.json
 *      (the first edit writes the whole default set); a refusal ("rocket" is not an emoji) is shown, keeps the
 *      editor open and leaves the file's bytes alone
 *   6  adding a favourite from the PROJECT's own skills (the searchable list finds it), with an argument;
 *      drag-reorder persists, and a drag inside the panel never raises the page's file-drop overlay;
 *      delete persists
 *   7  out of edit mode, a click types the skill plus its pre-filled argument
 *   8  a wand file that goes corrupt shows "Wand unavailable" with no buttons at all (never an empty grid
 *      that reads as "no favourites"), edit controls disappear, the file is left alone; putting it back
 *      brings the buttons back (the other-host propagation path)
 *   9  a skill that appears on disk while the harness runs clears its favourite's dimming
 *  10  keyboard access (Miguel I3 / I4): Alt+Left / Alt+Right on a focused favourite reorders it by one place and
 *      focus stays on it; the pencil keeps focus across its rebuild; opening the editor focuses it; Enter in the
 *      skill SEARCH box saves nothing; the status text reaches a live region outside the rebuilt markup
 *  11  Reset wand (Miguel I2): a corrupt file shows its absolute path, and Reset moves it to wand.json.bad-<time>
 *      with its bytes intact (never deleting it), then the default set shows
 *
 * REFUSES to run while a live host is open on this checkout (Miguel S2): the probe corrupts and restores
 * .harness/state/wand.json on purpose, and a real window would see it.
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills and no prompt is ever sent;
 * ELECTRON_RUN_AS_NODE and every CLAUDE_CUSTOM_* variable of an enclosing tab are stripped; skills come from a
 * temp tree (the CLAUDE_CUSTOM_CLAUDE_HOME probe seam), the project is a temp git repo, registry, portraits,
 * uploads and user data are temp folders. Two files of THIS checkout are touched, because host.js
 * hardcodes its state dir: .harness/state/wand.json and layout-global.json. Both are snapshotted and put back
 * on every exit path, Ctrl+C included (verify/lib/file-snapshot.js, verify/lib/process-hygiene.js).
 * Only PIDs this probe started are killed.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.harness', 'state');
const WAND_FILE = path.join(STATE_DIR, 'wand.json');
const LAYOUT_FILE = path.join(STATE_DIR, 'layout-global.json');
// Dockable panels D1: the page's layout is the split tree, under its own key. Both go, so the launch is a first launch.
const TREE_FILE = path.join(STATE_DIR, 'layout-tree.json');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { snapshotFile } = require('./lib/file-snapshot');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-wand-'));
const dev = path.join(tmp, 'proj', 'dev');
const claudeHome = path.join(tmp, 'claude-home');
const userData = path.join(tmp, 'user-data');
const shots = process.env.WAND_PROBE_SHOTS || path.join(ROOT, '.harness', 'probe-wand');
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

// host.js hardcodes its state dir, so these two files are the checkout's own: snapshot, restore on every exit.
const wandSnap = snapshotFile(WAND_FILE);
const layoutSnap = snapshotFile(LAYOUT_FILE);
const treeSnap = snapshotFile(TREE_FILE);
// Reset sets bad files aside as wand.json.bad-*: the ones this run made are removed with it.
const badsBefore = new Set(fs.existsSync(STATE_DIR) ? fs.readdirSync(STATE_DIR).filter(f => f.startsWith('wand.json.bad-')) : []);
function removeOwnBads() {
  try {
    for (const f of fs.readdirSync(STATE_DIR)) if (f.startsWith('wand.json.bad-') && !badsBefore.has(f)) fs.rmSync(path.join(STATE_DIR, f), { force: true });
  } catch { /* none */ }
}
hygiene.addCleanup(() => { wandSnap.restore(); layoutSnap.restore(); treeSnap.restore(); removeOwnBads(); });
hygiene.install();

async function launchApp(cwd) {
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
    CLAUDE_CUSTOM_CLAUDE_HOME: claudeHome,
  };
  delete env.ELECTRON_RUN_AS_NODE;
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
// Every host of this run: any whose folder is inside the probe's temp folder (a host outlives its window by
// design, so one that registers late must still be found).
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
  for (const id of hostsOfThisRun()) seenPids.add(id.pid);
  for (const pid of seenPids) { try { require(path.join(ROOT, 'host', 'kill-tree')).killPidTree(pid); } catch { /* gone */ } }
}
hygiene.addCleanup(killEverything);

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

const skillMd = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
function makeWorld() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  // user skills: three of the four defaults. /brainstorming is deliberately absent: its favourite must dim.
  for (const [n, d] of [['bedtime', 'Overnight autonomous run.'], ['checkpoint', 'Wrap up a chunk of work cleanly.'], ['merged', 'After a merge: clean up.']]) {
    fs.mkdirSync(path.join(claudeHome, 'skills', n), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'skills', n, 'SKILL.md'), skillMd(n, d));
  }
  // a project skill, and a nameless one that discovery must skip
  fs.mkdirSync(path.join(dev, '.claude', 'skills', 'local-only'), { recursive: true });
  fs.writeFileSync(path.join(dev, '.claude', 'skills', 'local-only', 'SKILL.md'), skillMd('local-only', 'Only in this project.'));
  fs.mkdirSync(path.join(dev, '.claude', 'skills', 'nameless'), { recursive: true });
  fs.writeFileSync(path.join(dev, '.claude', 'skills', 'nameless', 'SKILL.md'), '---\ndescription: no name\n---\n');
}

// A live host on THIS checkout that is not one of ours: its window would see the probe's corrupt-file test and
// have its own edits overwritten by the restore (Miguel S2).
function liveForeignHost() {
  let files = [];
  try { files = fs.readdirSync(path.join(ROOT, '.harness', 'hosts')).filter(f => f.endsWith('.json')); } catch { return null; }
  for (const f of files) {
    const id = readIdentity({ dir: path.join(ROOT, '.harness'), port: Number(f.replace(/\.json$/, '')) });
    if (!id || !Number.isInteger(id.pid)) continue;
    let alive = false;
    try { process.kill(id.pid, 0); alive = true; } catch (err) { alive = !!err && err.code === 'EPERM'; }
    if (alive && !path.resolve(String(id.cwd || '')).toLowerCase().startsWith(path.resolve(tmp).toLowerCase() + path.sep)) return id;
  }
  return null;
}

let refused = false;

async function main() {
  const foreign = liveForeignHost();
  if (foreign) {
    refused = true;
    console.log(`REFUSED: a live host (pid ${foreign.pid}, ${foreign.cwd}) is open on this checkout. The probe rewrites .harness/state/wand.json on purpose; close that window, or run the probe from another checkout.`);
    return;
  }
  makeWorld();
  try { fs.unlinkSync(WAND_FILE); } catch { /* none */ }
  try { fs.unlinkSync(LAYOUT_FILE); } catch { /* none */ }
  try { fs.unlinkSync(TREE_FILE); } catch { /* none */ }

  const app = await launchApp(dev);
  const ready = await viewReady(app);
  check('the window came up with a session', !!ready, ready ? '' : app.out.slice(-600));
  if (!ready) return;

  const ws = () => view(app, 'wandState');
  const buttons = async () => ((await ws()).buttons || []);
  const disk = () => { try { return JSON.parse(fs.readFileSync(WAND_FILE, 'utf8')); } catch { return null; } };
  const boxCtl = path.join(tmp, 'box-ctl.json');
  const boxLog = path.join(tmp, 'box-submitted.log');
  const boxLine = () => { try { return JSON.parse(fs.readFileSync(`${boxLog}.line`, 'utf8')); } catch { return null; } };
  const submitted = () => { try { return fs.readFileSync(boxLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const click = (args) => view(app, 'wandClick', args);
  // the wand's own answer to a click that typed: "typed, press Enter", or why it did not
  const verdict = () => waitFor(async () => { const s = await ws(); return /typed, press Enter|didn't type/.test(s.status) ? s : null; }, 8000, 100);
  // The draft is staged in the fake box, then waited for in the PAGE's own terminal: the box writes its
  // file before the redraw has crossed the pty and the socket, and a click that lands mid-redraw would see
  // a half-drawn screen and (correctly) refuse to type.
  const setDraft = async (text) => {
    fs.writeFileSync(boxCtl, JSON.stringify({ draft: text }));
    await waitFor(() => boxLine() === text, 5000, 100);
    await waitFor(async () => {
      const r = await view(app, 'gitScreen');
      return r && (r.text || '').split('\n').some(l => l.replace(/\s+$/, '') === (text === '' ? '❯' : `❯ ${text}`)) ? r : null;
    }, 5000, 100);
  };

  // 1 -----------------------------------------------------------------------------
  // Dockable panels D1: the page reports groups of a split tree; the default layout has one, `right`.
  const home = (ready.groups || []).find(g => g.tabs.includes('wand'));
  const where = home ? home.id : null;
  check('1: the Wand module is in the dock (new modules land on the right)', where === 'right', String(where));
  await view(app, 'select', { id: 'wand' });
  const first = await waitFor(async () => { const s = await ws(); return s && s.ok && s.shown && s.buttons.length === 4 ? s : null; }, 20000);
  check('1: wand-display.js loaded in the shared plain-script scope, and the module shows', !!first && first.scope, JSON.stringify(first).slice(0, 300));
  if (!first) { console.log(app.out.slice(-800)); return; }
  check('1: the default set, in order: 🌙 ✅ 🔀 💡', first.buttons.map(b => b.emoji).join(' ') === '🌙 ✅ 🔀 💡', first.buttons.map(b => b.emoji).join(' '));
  check('1: only the favourite whose skill is not on disk is dimmed (💡 /brainstorming)',
    JSON.stringify(first.buttons.map(b => b.dim)) === '[false,false,false,true]', JSON.stringify(first.buttons.map(b => b.dim)));
  check('1: hover text names the skill and its description from the SKILL.md, and says "skill not found" for the dimmed one',
    /\/checkpoint .* Wrap up a chunk of work cleanly\./.test(first.buttons[1].title) && /skill not found/.test(first.buttons[3].title),
    JSON.stringify([first.buttons[1].title, first.buttons[3].title]));
  check('1: outside edit mode there is no ✕, no +, no drag handle', first.deletes === 0 && !first.add && first.buttons.every(b => !b.draggable));
  check('1: no wand.json yet: looking is not writing', disk() === null);
  await sleep(700);     // a capture straight after the tab switch can still hold the previous frame
  await command(app, { cmd: 'screenshot', file: path.join(shots, '1-default.png') });

  // the stand-in CLI box, in this tab's own cmd.exe
  await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && />\s*$/m.test(r.text || '') ? r : null; }, 15000, 300);
  await view(app, 'gitTermInput', { data: `node "${path.join(ROOT, 'verify', 'lib', 'fake-claude-box.js')}" "${boxCtl}" "${boxLog}"\r` });
  const boxUp = await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && /❯/.test(r.text) && /fake claude box/.test(r.text) ? r : null; }, 15000, 300);
  check('the stand-in CLI box is drawn in the tab', !!boxUp, JSON.stringify(await view(app, 'gitScreen')).slice(0, 300));
  if (!boxUp) return;

  // 2 -----------------------------------------------------------------------------
  await click({ act: 'press', id: 'f2' });
  const typed = await waitFor(() => boxLine() === '/checkpoint', 10000, 150);
  check('2: a click leaves exactly `/checkpoint` in the box', !!typed, JSON.stringify(boxLine()));
  const flashed = await waitFor(async () => { const s = await ws(); return /typed, press Enter/.test(s.status) && s.buttons[1].flash ? s : null; }, 5000, 150);
  const liveNow = await ws();
  check('2 (I3): the status reaches the live region OUTSIDE the rebuilt markup', liveNow.liveText === 'typed, press Enter', JSON.stringify(liveNow.liveText));
  check('2: the button flashes "typed, press Enter" (and says nothing about running it)', !!flashed && !/ran|sent|running/i.test(flashed.status), JSON.stringify(flashed && flashed.status));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '2-typed.png') });
  await sleep(1500);
  check('2: ...and NOTHING was submitted: the Enter is yours', submitted().length === 0 && boxLine() === '/checkpoint', JSON.stringify({ box: boxLine(), submitted: submitted() }));
  const cleared = await waitFor(async () => { const s = await ws(); return s.status === '' && !s.buttons[1].flash ? s : null; }, 6000, 300);
  check('2: the flash fades by itself', !!cleared);

  // 3 -----------------------------------------------------------------------------
  await setDraft('half a draft');
  await click({ act: 'press', id: 'f1' });
  const over = await waitFor(() => boxLine() === '/bedtime', 10000, 150);
  // the PAGE's own verdict first: it reads the box back ~600 ms after typing, and a probe that changes the box
  // before that reads as 'the input line changed' (a race in the probe, not in the wand)
  await verdict();
  check('3: a draft in the box is cleared and the box then holds /bedtime alone', !!over, JSON.stringify(boxLine()));
  check('3: ...and the draft was never submitted with it', submitted().length === 0, JSON.stringify(submitted()));
  await setDraft('');
  await click({ act: 'press', id: 'f2', times: 2 });
  await waitFor(() => boxLine() === '/checkpoint', 10000, 150);
  await verdict();
  await sleep(800);
  check('3: a double click types it once (never /checkpoint/checkpoint), still nothing submitted',
    boxLine() === '/checkpoint' && submitted().length === 0, JSON.stringify({ box: boxLine(), submitted: submitted(), status: (await ws()).status }));

  // 4 -----------------------------------------------------------------------------
  await setDraft('keep me');
  await click({ act: 'press', id: 'f4' });
  const said = await waitFor(async () => { const s = await ws(); return /skill not found/.test(s.status) ? s : null; }, 5000, 150);
  await sleep(800);
  check('4: clicking the dimmed favourite says "skill not found"', !!said, JSON.stringify(said && said.status));
  check('4: ...and typed nothing: the draft is exactly as it was, nothing submitted', boxLine() === 'keep me' && submitted().length === 0, JSON.stringify({ box: boxLine(), submitted: submitted() }));
  await setDraft('');

  // 5 -----------------------------------------------------------------------------
  await click({ act: 'toggle-edit' });
  const edit = await waitFor(async () => { const s = await ws(); return s.edit ? s : null; }, 5000);
  check('5: edit mode: a ✕ on every button, a +, and every button draggable',
    !!edit && edit.deletes === 4 && edit.add && edit.buttons.every(b => b.draggable), JSON.stringify(edit && { d: edit.deletes, a: edit.add }));
  await click({ act: 'press', id: 'f2' });
  const ed = await waitFor(async () => { const s = await ws(); return s.editor ? s : null; }, 5000);
  check('5: clicking a button in edit mode opens its editor (and types nothing)',
    !!ed && ed.editor.emoji === '✅' && /\/checkpoint/.test(ed.editor.picked) && submitted().length === 0 && boxLine() === '', JSON.stringify(ed && ed.editor));
  await view(app, 'wandSetField', { field: 'emoji', value: '🚀' });
  await click({ act: 'save' });
  const changed = await waitFor(async () => { const s = await ws(); return s.buttons[1] && s.buttons[1].emoji === '🚀' && !s.editor ? s : null; }, 8000);
  check('5: changing the emoji redraws the button and closes the editor', !!changed, JSON.stringify(await ws()).slice(0, 300));
  const d1 = disk();
  check('5: it persisted to .harness/state/wand.json, and the first edit wrote the WHOLE default set',
    !!d1 && d1.version === 1 && d1.favourites.length === 4 && d1.favourites[1].emoji === '🚀' && d1.favourites[1].skill === 'checkpoint'
      && d1.favourites[3].skill === 'brainstorming', JSON.stringify(d1));
  const before = fs.readFileSync(WAND_FILE, 'utf8');
  await click({ act: 'add' });
  await view(app, 'wandSetField', { field: 'emoji', value: 'rocket' });
  await click({ act: 'pick-skill', skill: 'merged' });
  await click({ act: 'save' });
  // Not named `refused`: that shadowed the module's flag, so main()'s own `refused = true` (a live host on this
  // checkout) threw "Cannot access 'refused' before initialization" instead of printing REFUSED.
  const refusal = await waitFor(async () => { const s = await ws(); return s.error && s.editor ? s : null; }, 8000);
  check('5: a refusal ("rocket" is not an emoji) is shown, the editor stays open, the file is untouched',
    !!refusal && /emoji/i.test(refusal.error) && fs.readFileSync(WAND_FILE, 'utf8') === before, JSON.stringify(refusal && refusal.error));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '5-editor-refusal.png') });

  // 6 -----------------------------------------------------------------------------
  await view(app, 'wandSetField', { field: 'emoji', value: '🧪' });
  await view(app, 'wandSetField', { field: 'query', value: 'local' });
  const found = await waitFor(async () => { const s = await ws(); return s.editor && s.editor.listed.length === 1 ? s : null; }, 5000);
  check('6: the searchable list finds the PROJECT\'s own skill (and the nameless one was skipped)', !!found && found.editor.listed[0] === 'local-only', JSON.stringify(found && found.editor.listed));
  check('6: ...with the editor field still holding what was typed (a redraw must not eat it)', !!found && found.editor.query === 'local' && found.editor.emoji === '🧪');
  await click({ act: 'pick-skill', skill: 'local-only' });
  await view(app, 'wandSetField', { field: 'args', value: 'now' });
  await click({ act: 'save' });
  const five = await waitFor(async () => { const s = await ws(); return s.buttons.length === 5 && !s.editor ? s : null; }, 8000);
  check('6: the new favourite is added at the end', !!five && five.buttons[4].emoji === '🧪', JSON.stringify(five && five.buttons.map(b => b.emoji)));
  const d2 = disk();
  check('6: persisted with its skill and argument, id unique',
    !!d2 && d2.favourites.length === 5 && d2.favourites[4].skill === 'local-only' && d2.favourites[4].args === 'now'
      && new Set(d2.favourites.map(f => f.id)).size === 5, JSON.stringify(d2 && d2.favourites[4]));
  const newId = d2 && d2.favourites[4].id;
  await command(app, { cmd: 'screenshot', file: path.join(shots, '6-edit-mode.png') });

  const drag = await view(app, 'wandDrag', { from: newId, to: 'f1' });
  const moved = await waitFor(async () => { const s = await ws(); return s.buttons[0] && s.buttons[0].id === newId ? s : null; }, 8000);
  check('6: dragging the new button onto the first slot reorders it', !!moved, JSON.stringify(moved && moved.buttons.map(b => b.emoji)));
  check('6: ...and the drag never raised the page\'s file-drop overlay', drag.ok && drag.fileDropOverlayShown === false, JSON.stringify(drag));
  const d3 = disk();
  check('6: the order persisted', !!d3 && d3.favourites[0].id === newId && d3.favourites.map(f => f.skill).join() === 'local-only,bedtime,checkpoint,merged,brainstorming',
    JSON.stringify(d3 && d3.favourites.map(f => f.skill)));
  await click({ act: 'delete', id: 'f1' });
  const four = await waitFor(async () => { const s = await ws(); return s.buttons.length === 4 ? s : null; }, 8000);
  check('6: ✕ deletes 🌙, and it persisted', !!four && !four.buttons.some(b => b.emoji === '🌙') && !!disk() && !disk().favourites.some(f => f.skill === 'bedtime'),
    JSON.stringify(disk() && disk().favourites.map(f => f.skill)));

  // 10 (6b) ----------------------------------------------------------------------------
  // edit mode is on; the order is local-only(f5) checkpoint(f2) merged(f3) brainstorming(f4)
  const order = async () => (await buttons()).map(b => b.id).join();
  await view(app, 'wandFocus', { act: 'press', id: 'f2' });
  const k1 = await view(app, 'wandKey', { act: 'press', id: 'f2', key: 'ArrowRight', alt: true });
  const right = await waitFor(async () => (await order()) === 'f5,f3,f2,f4' ? await ws() : null, 8000);
  check('10: Alt+Right on a focused favourite moves it one place (handled, so the page does not scroll)', !!right && k1.defaultPrevented === true, await order());
  check('10: ...and focus is still on that favourite after the rebuild', !!right && !!right.focus && right.focus.act === 'press' && right.focus.id === 'f2', JSON.stringify(right && right.focus));
  check('10: ...and it persisted', !!disk() && disk().favourites.map(f => f.skill).join() === 'local-only,merged,checkpoint,brainstorming', JSON.stringify(disk() && disk().favourites.map(f => f.skill)));
  await view(app, 'wandKey', { act: 'press', id: 'f2', key: 'ArrowLeft', alt: true });
  const left = await waitFor(async () => (await order()) === 'f5,f2,f3,f4' ? await ws() : null, 8000);
  check('10: Alt+Left moves it back', !!left);
  await view(app, 'wandKey', { act: 'press', id: 'f5', key: 'ArrowLeft', alt: true });
  await sleep(500);
  check('10: Alt+Left on the first favourite does nothing', (await order()) === 'f5,f2,f3,f4');
  await view(app, 'wandFocus', { act: 'toggle-edit' });
  await click({ act: 'toggle-edit' });
  const offEdit = await waitFor(async () => { const s = await ws(); return !s.edit ? s : null; }, 5000);
  check('10: the pencil keeps focus across the rebuild it causes', !!offEdit && !!offEdit.focus && offEdit.focus.act === 'toggle-edit', JSON.stringify(offEdit && offEdit.focus));
  await click({ act: 'toggle-edit' });
  await waitFor(async () => (await ws()).edit, 5000);
  await click({ act: 'add' });
  const opened = await waitFor(async () => { const s = await ws(); return s.editor && s.focus && s.focus.field === 'emoji' ? s : null; }, 5000);
  check('10: opening the editor puts focus in it (the emoji field)', !!opened, JSON.stringify((await ws()).focus));
  const beforeEnter = fs.readFileSync(WAND_FILE, 'utf8');
  await click({ act: 'pick-skill', skill: 'merged' });
  await view(app, 'wandSetField', { field: 'query', value: 'merg' });
  const enter = await view(app, 'wandKey', { field: 'query', key: 'Enter' });
  await sleep(700);
  const afterEnter = await ws();
  check('10 (I4): Enter in the skill search box saves nothing: the editor stays open, no error, the file is untouched',
    enter.defaultPrevented === true && !!afterEnter.editor && afterEnter.error === '' && fs.readFileSync(WAND_FILE, 'utf8') === beforeEnter && afterEnter.buttons.length === 4,
    JSON.stringify({ editor: !!afterEnter.editor, error: afterEnter.error, n: afterEnter.buttons.length }));
  check('10: ...and the search text is still there (the rebuild did not eat it)', !!afterEnter.editor && afterEnter.editor.query === 'merg');
  await view(app, 'wandKey', { field: 'emoji', key: 'Escape' });
  const closedEd = await waitFor(async () => { const s = await ws(); return !s.editor ? s : null; }, 5000);
  check('10: Escape in an editor field cancels it', !!closedEd);
  await click({ act: 'toggle-edit' });

  // 7 -----------------------------------------------------------------------------
  const normal = await waitFor(async () => { const s = await ws(); return !s.edit && s.deletes === 0 && !s.add ? s : null; }, 5000);
  check('7: leaving edit mode takes the ✕ and + away', !!normal);
  check('7: hover shows the pre-filled argument', !!normal && /pre-fills: now/.test(normal.buttons[0].title), JSON.stringify(normal && normal.buttons[0].title));
  await click({ act: 'press', id: newId });
  const withArgs = await waitFor(() => boxLine() === '/local-only now', 10000, 150);
  await verdict();
  check('7: a click types the skill plus its pre-filled argument, nothing submitted', !!withArgs && submitted().length === 0, JSON.stringify({ box: boxLine(), submitted: submitted() }));
  await setDraft('');

  // 8 -----------------------------------------------------------------------------
  const good = fs.readFileSync(WAND_FILE, 'utf8');
  fs.writeFileSync(WAND_FILE, '{ this is not json');
  const unavailable = await waitFor(async () => { const s = await ws(); return /Wand unavailable/.test(s.text) ? s : null; }, 10000, 250);
  check('8: a corrupt wand file shows "Wand unavailable" with the reason', !!unavailable && /not valid JSON/.test(unavailable.text), JSON.stringify(unavailable && unavailable.text).slice(0, 200));
  check('8: ...and NO buttons at all, no edit pencil, no +: never an empty grid that reads as "no favourites"',
    !!unavailable && unavailable.buttons.length === 0 && !unavailable.add && !/No favourites/.test(unavailable.text));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '8-unavailable.png') });
  check('8: the corrupt file is left exactly as it was (nothing wrote over it)', fs.readFileSync(WAND_FILE, 'utf8') === '{ this is not json');
  fs.writeFileSync(WAND_FILE, good);
  const back = await waitFor(async () => { const s = await ws(); return s.buttons.length === 4 ? s : null; }, 10000, 250);
  check('8: putting a valid file back brings the buttons back, with no restart (the other-host path)', !!back, JSON.stringify(await ws()).slice(0, 200));

  // 11 (Miguel I2) ----------------------------------------------------------------------
  fs.writeFileSync(WAND_FILE, '{ second corruption, the only copy');
  const bad2 = await waitFor(async () => { const s = await ws(); return /Wand unavailable/.test(s.text) ? s : null; }, 10000, 250);
  check('11: the unavailable panel shows the file\'s ABSOLUTE path', !!bad2 && bad2.text.includes(WAND_FILE), JSON.stringify(bad2 && bad2.text).slice(0, 260));
  const resetBtn = !!bad2 && /Reset wand/.test(bad2.text);
  check('11: ...and offers Reset wand', resetBtn);
  await click({ act: 'reset' });
  const afterReset = await waitFor(async () => { const s = await ws(); return s.buttons.length === 4 ? s : null; }, 10000, 250);
  check('11: Reset starts from the default set', !!afterReset && afterReset.buttons.map(b => b.emoji).join(' ') === '\u{1F319} \u2705 \u{1F500} \u{1F4A1}', JSON.stringify(afterReset && afterReset.buttons.map(b => b.emoji)));
  const bads = fs.readdirSync(STATE_DIR).filter(f => f.startsWith('wand.json.bad-') && !badsBefore.has(f));
  check('11: ...the bad file was MOVED ASIDE to wand.json.bad-<time>, bytes intact, never deleted',
    bads.length === 1 && fs.readFileSync(path.join(STATE_DIR, bads[0]), 'utf8') === '{ second corruption, the only copy', JSON.stringify(bads));
  check('11: ...and the answer says where it went', !!afterReset && /wand\.json\.bad-/.test(afterReset.status) && /default set/.test(afterReset.status), JSON.stringify(afterReset && afterReset.status));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '11-reset.png') });

  // 9 -----------------------------------------------------------------------------
  const brainstorm = back && back.buttons.find(b => /brainstorming/.test(b.label));
  check('9: before: the /brainstorming favourite is still dimmed', !!brainstorm && brainstorm.dim === true);
  fs.mkdirSync(path.join(claudeHome, 'skills', 'brainstorming'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'skills', 'brainstorming', 'SKILL.md'), skillMd('brainstorming', 'Ideas before design.'));
  const undimmed = await waitFor(async () => { const s = await ws(); const b = s.buttons.find(x => /brainstorming/.test(x.label)); return b && !b.dim ? b : null; }, 12000, 300);
  check('9: a skill that appears on disk while the harness runs clears its favourite\'s dimming', !!undimmed, JSON.stringify(await ws()).slice(0, 300));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '9-final.png') });

  const fin = await ws();
  check('the page raised no wand error line at rest', fin.error === '', JSON.stringify(fin.error));
  console.log(`screenshots: ${shots}`);
  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 10000);
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    wandSnap.restore();
    layoutSnap.restore();
    treeSnap.restore();
    removeOwnBads();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    if (refused) process.exit(2);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
