'use strict';
/**
 * PROBE: edit mode in the code reader (#50) in a REAL window with a REAL host.  (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-reader-edit.js     (exit 0 = every check held)
 *   READER_EDIT_SHOTS=<dir>                                          also keep the screenshots there
 *
 * The unit tests pin the reader's logic against stubs (test/repo-reader-edit.test.js), the host's save
 * (test/repo-write.test.js) and its answers (test/repo-service.test.js). They cannot see the page: renderer
 * scripts share one global scope, CodeMirror's editing keymap and undo history only exist in a real renderer, and
 * the watcher only means something against a real filesystem. This checks, with a real host answering `repo`
 * frames for a throwaway repo:
 *
 *   1  Edit makes the file editable (Done label, Save shown); typing shows the dot; Ctrl+S writes the file
 *      atomically (the bytes on disk are the typed text, no temp file left beside it) and clears the dot
 *   2  CRLF is kept: a CRLF file saved from the editor is still CRLF on disk; a file with mixed line endings shows
 *      Edit disabled with the reason
 *   3  THE WATCHER: an outside change to an open file is seen, and how long that took is MEASURED (clean file:
 *      the Reload bar; unsaved edits: the conflict banner, "Claude changed this file while you were editing.")
 *   4  the three banner actions: Compare (rows line by line, Back), Reload (disk text, edits dropped, still
 *      editing), Keep mine (the next save replaces the disk version)
 *   5  NEVER A SILENT OVERWRITE: a save pressed right after an outside change, and a change after Keep mine, both
 *      leave the OUTSIDE text on disk and raise the banner
 *   6  the guards: opening another file, closing the panel, Esc and Done ask first with unsaved text (the probe
 *      answers the question: no keeps everything, yes discards), and say nothing when clean
 *   7  main knows about the unsaved file (the tab-close question reads it) and forgets it once saved
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and every
 * CLAUDE_CUSTOM_* variable is stripped from the window under test, then only the probe's own are set; the repo,
 * registry, portraits, uploads and user data are temp folders. Only PIDs this probe started are killed.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-edit-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const projectsDir = path.join(tmp, 'projects');
const userData = path.join(tmp, 'user-data');
const shots = process.env.READER_EDIT_SHOTS || path.join(tmp, 'shots');
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

const LAYOUT_BACKUP = `${LAYOUT_FILE}.edit-probe-backup`;
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
    CLAUDE_CUSTOM_GIT_PROJECTS_DIR: projectsDir,
  };
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${path.join(userData, String(port))}`], { cwd: ROOT, env }, { keepEnv: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_GIT_PROJECTS_DIR', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN', 'CLAUDE_CUSTOM_UPLOADS'] });
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
const rd = (app, what, args = {}) => rp(app, `reader.${what}`, args);

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
  }, 150000);
}

// ---- the fixture ----

const APP = path.join(dev, 'src', 'app.js');
const APP_TEXT = "'use strict';\nconst greeting = 'hello';\nfunction add(a, b) {\n  return a + b;\n}\nmodule.exports = { add, greeting };\n";

function makeRepo() {
  fs.mkdirSync(path.join(dev, 'src'), { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dev, 'README.md'), '# probe repo\n');
  fs.writeFileSync(APP, APP_TEXT);
  fs.writeFileSync(path.join(dev, 'src', 'crlf.txt'), 'one\r\ntwo\r\n');
  fs.writeFileSync(path.join(dev, 'src', 'mixed.txt'), 'one\r\ntwo\nthree\r\n');
  fs.writeFileSync(path.join(dev, 'src', 'other.js'), 'exports.other = 1;\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'init');
}

const ms = (a) => a.slice().sort((x, y) => x - y);
const shoot = (app, name) => command(app, { cmd: 'screenshot', file: path.join(shots, `${name}.png`) });
const st = (app) => rd(app, 'state');
const disk = () => fs.readFileSync(APP, 'utf8');
const tempsBeside = () => fs.readdirSync(path.dirname(APP)).filter(f => f.endsWith('.tmp'));

// open a file in the reader and wait until it is showing
async function openIn(app, rel, startsWith) {
  await rd(app, 'open', { path: rel });
  return waitFor(async () => { const s = await st(app); return s.open && s.path === rel && !s.noteShown && s.text.startsWith(startsWith) ? s : null; }, 15000);
}
async function startEdit(app) {
  await rd(app, 'edit');
  return waitFor(async () => { const s = await st(app); return s.editing ? s : null; }, 5000);
}

async function main() {
  makeRepo();
  setAsideLayout();
  const app = await launchApp(container);
  const ready = await viewReady(app);
  check('the window came up with a session and the probe hook', !!ready, ready ? '' : `${app.out.slice(-800)} | exited: ${app.exited}`);
  if (!ready) return;
  await view(app, 'move', { id: 'fog', target: 'left' });
  await waitFor(async () => { const s = await rp(app, 'state'); return s && s.ok && s.rows && s.rows.some(r => r.path === 'README.md') ? s : null; }, 20000);

  // 1 ------------------------------------------------------------------------------
  const first = await openIn(app, 'src/app.js', "'use strict';");
  check('1: src/app.js opens read-only with an Edit button (enabled, no Save, no dot)', !!first && first.editShown && !first.editDisabled && first.editLabel === 'Edit' && !first.saveShown && !first.dotShown && !first.editing,
    JSON.stringify(first && { editShown: first.editShown, editDisabled: first.editDisabled, editLabel: first.editLabel, saveShown: first.saveShown, dotShown: first.dotShown }));
  const editing = await startEdit(app);
  check('1: Edit makes it editable: the button reads Done, Save is shown (disabled: nothing changed), no dot yet', !!editing && editing.editLabel === 'Done' && editing.saveShown && editing.saveDisabled && !editing.dotShown, JSON.stringify(editing && { editLabel: editing.editLabel, saveShown: editing.saveShown, saveDisabled: editing.saveDisabled }));
  const typed1 = APP_TEXT.replace("'hello'", "'hello, world'");
  await rd(app, 'type', { text: typed1 });
  const dirty = await waitFor(async () => { const s = await st(app); return s.dirty && s.dotShown ? s : null; }, 5000);
  check('1: typing shows the unsaved dot and enables Save', !!dirty && !dirty.saveDisabled, JSON.stringify(dirty && { dirty: dirty.dirty, dot: dirty.dotShown, saveDisabled: dirty.saveDisabled }));
  const mainSees = await waitFor(async () => { const s = await command(app, { cmd: 'state' }); return s.readerUnsaved === 'src/app.js' ? s : null; }, 5000);
  check('7: main was told which file has unsaved edits (the tab-close question reads it)', !!mainSees);
  await shoot(app, '1-edit-dirty');
  await rd(app, 'ctrlS');
  const saved = await waitFor(async () => { const s = await st(app); return !s.dirty && !s.dotShown && /saved/.test(s.meta) ? s : null; }, 8000);
  check('1: Ctrl+S saves: the dot goes and the meta line says saved', !!saved, JSON.stringify(saved && saved.meta));
  check('1: ...the bytes on disk are the typed text, and no temp file is left beside it', disk() === typed1 && tempsBeside().length === 0, `${JSON.stringify(disk().slice(0, 60))} temps=${tempsBeside().join(',')}`);
  check('7: ...and main forgot the unsaved file', (await command(app, { cmd: 'state' })).readerUnsaved === null);
  check('1: the editor is still editable after a save (Done is still the label)', !!saved && saved.editing && saved.editLabel === 'Done');
  await shoot(app, '2-edit-saved');

  // our own write must not look like an outside change
  await sleep(1500);
  const quiet = await st(app);
  check('1: the watcher reports our own save and NO banner rises over it', !quiet.barShown && !quiet.conflictShown, JSON.stringify({ bar: quiet.barText, conflict: quiet.conflictShown }));

  // 2 ------------------------------------------------------------------------------
  await rd(app, 'edit');                                            // Done (clean: no question)
  await waitFor(async () => { const s = await st(app); return !s.editing ? s : null; }, 5000);
  const crlf = await openIn(app, 'src/crlf.txt', 'one');
  check('2: a CRLF file opens editable', !!crlf && crlf.editShown && !crlf.editDisabled);
  await startEdit(app);
  await rd(app, 'type', { text: 'one\ntwo\nthree\n' });
  await rd(app, 'ctrlS');
  await waitFor(async () => { const s = await st(app); return !s.dirty ? s : null; }, 8000);
  const crlfBytes = fs.readFileSync(path.join(dev, 'src', 'crlf.txt')).toString('latin1');
  check('2: saved from the editor, the file is still CRLF on disk (every line)', crlfBytes === 'one\r\ntwo\r\nthree\r\n', JSON.stringify(crlfBytes));
  await rd(app, 'edit');
  const mixed = await openIn(app, 'src/mixed.txt', 'one');
  check('2: a file with mixed line endings shows Edit DISABLED, with the reason as its tooltip', !!mixed && mixed.editShown && mixed.editDisabled && /mixes line endings/.test(mixed.editTitle), JSON.stringify(mixed && { d: mixed.editDisabled, t: mixed.editTitle }));
  await shoot(app, '3-mixed-disabled');

  // 3 ------------------------------------------------------------------------------
  // the watcher, clean file in edit mode: the ordinary Reload bar. Three samples, each timed from the write.
  await openIn(app, 'src/app.js', "'use strict';");
  const lat = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    fs.writeFileSync(APP, `${disk()}// outside ${i}\n`);
    const bar = await waitFor(async () => { const s = await st(app); return s.barShown && s.reloadShown ? s : null; }, 15000, 25);
    lat.push(bar ? Date.now() - t0 : NaN);
    if (!bar) break;
    await rd(app, 'reload');
    await waitFor(async () => { const s = await st(app); return !s.barShown && s.text.includes(`outside ${i}`) ? s : null; }, 8000);
  }
  console.log(`      WATCHER LATENCY (outside write -> Reload bar shown), clean file, ms: ${lat.join(', ')}  (the host waits 300 ms of quiet before it reports; the poll adds up to ~25 ms)`);
  check('3: an outside change to an open clean file raises the Reload bar promptly (all three under 3 s)', lat.length === 3 && lat.every(x => x < 3000), lat.join(', '));

  // unsaved edits: the conflict banner
  const base = disk();
  await startEdit(app);
  const mine = base.replace("'hello, world'", "'hello from me'");
  await rd(app, 'type', { text: mine });
  await waitFor(async () => { const s = await st(app); return s.dirty ? s : null; }, 5000);
  const claudeText = base.replace("return a + b;", "return a + b; // claude");
  const t1 = Date.now();
  fs.writeFileSync(APP, claudeText);
  const banner = await waitFor(async () => { const s = await st(app); return s.conflictShown ? s : null; }, 15000, 25);
  const conflictMs = banner ? Date.now() - t1 : NaN;
  console.log(`      WATCHER LATENCY (outside write -> conflict banner), unsaved edits, ms: ${conflictMs}  (includes the host's read of the disk version)`);
  check('3: with unsaved edits the same outside change raises the conflict banner with the exact words, NOT the plain bar',
    !!banner && banner.conflictText === 'Claude changed this file while you were editing.' && !banner.barShown, JSON.stringify(banner && { text: banner.conflictText, bar: banner.barShown }));
  check('3: ...your text is untouched and the disk still holds the outside text', !!banner && banner.text.includes('hello from me') && disk() === claudeText);
  await shoot(app, '4-conflict-banner');

  // 4 ------------------------------------------------------------------------------
  await rd(app, 'conflictCompare');
  const cmp = await waitFor(async () => { const s = await st(app); return s.compareShown ? s : null; }, 5000);
  const kinds = (cmp && cmp.compareRows || []).map(r => r.split('|')[0].replace('cmp-row ', ''));
  check('4: Compare shows the two versions line by line: lines only the disk has as del, only yours as add, shared ones as same',
    !!cmp && kinds.includes('del') && kinds.includes('add') && kinds.includes('same') && cmp.compareRows.some(r => /del\|.*claude/.test(r)) && cmp.compareRows.some(r => /add\|.*hello from me/.test(r)),
    JSON.stringify(cmp && cmp.compareRows));
  await shoot(app, '5-compare');
  await rd(app, 'compareBack');
  const back = await waitFor(async () => { const s = await st(app); return !s.compareShown && !s.bodyHidden ? s : null; }, 5000);
  check('4: Back to editing returns to the editor with your text intact, banner still up', !!back && back.conflictShown && back.text.includes('hello from me'));

  // Reload: edits dropped, disk text shown, still editing
  await rd(app, 'conflictReload');
  const reloaded = await waitFor(async () => { const s = await st(app); return !s.conflictShown && s.text.includes('// claude') ? s : null; }, 8000);
  check('4: Reload drops your edits, shows the disk version, clears the dot, and stays in edit mode', !!reloaded && !reloaded.dirty && !reloaded.dotShown && reloaded.editing, JSON.stringify(reloaded && { dirty: reloaded.dirty, editing: reloaded.editing }));
  await shoot(app, '6-after-reload');

  // Keep mine
  await rd(app, 'type', { text: base.replace("'hello, world'", "'kept mine'") });
  await waitFor(async () => { const s = await st(app); return s.dirty ? s : null; }, 5000);
  const claude2 = disk().replace('// claude', '// claude again');
  fs.writeFileSync(APP, claude2);
  const banner2 = await waitFor(async () => { const s = await st(app); return s.conflictShown ? s : null; }, 15000, 25);
  check('4: a second outside change raises the banner again', !!banner2);
  await rd(app, 'conflictKeep');
  const kept = await waitFor(async () => { const s = await st(app); return !s.conflictShown && s.dirty ? s : null; }, 5000);
  check('4: Keep mine hides the banner and your text is still unsaved', !!kept && kept.text.includes('kept mine'));
  check('4: ...and nothing was written by choosing it (the disk still holds the outside text)', disk() === claude2);
  await rd(app, 'ctrlS');
  const replaced = await waitFor(async () => { const s = await st(app); return !s.dirty && !s.conflictShown ? s : null; }, 8000);
  check('4: the next save replaces the disk version with yours', !!replaced && disk().includes('kept mine') && !disk().includes('claude again'), JSON.stringify(disk().slice(0, 90)));

  // 5 ------------------------------------------------------------------------------
  // a save pressed right after an outside change, and a change after Keep mine: the OUTSIDE text must survive both
  const mineB = disk().replace('kept mine', 'save race');
  await rd(app, 'type', { text: mineB });
  await waitFor(async () => { const s = await st(app); return s.dirty ? s : null; }, 5000);
  const outsideB = `${disk()}// outside before the save\n`;
  fs.writeFileSync(APP, outsideB);
  await rd(app, 'ctrlS');                           // immediately: the watcher may or may not have spoken yet
  const raced = await waitFor(async () => { const s = await st(app); return s.conflictShown ? s : null; }, 15000, 25);
  check('5: a save pressed right after an outside change did NOT overwrite it: the banner is up and the disk holds the outside text', !!raced && disk() === outsideB, JSON.stringify({ banner: !!raced, outsideKept: disk() === outsideB }));
  await rd(app, 'conflictKeep');
  await waitFor(async () => { const s = await st(app); return !s.conflictShown ? s : null; }, 5000);
  const outsideC = `${outsideB}// outside after Keep mine\n`;
  fs.writeFileSync(APP, outsideC);
  await rd(app, 'save');
  const again = await waitFor(async () => { const s = await st(app); return s.conflictShown ? s : null; }, 15000, 25);
  check('5: Keep mine is not a blank cheque: a further change before the save raises the banner again and is not overwritten', !!again && disk() === outsideC, JSON.stringify({ banner: !!again, outsideKept: disk() === outsideC }));
  await rd(app, 'conflictReload');
  // (the banner goes the moment Reload is pressed; wait for the read to land and edit mode to come back)
  const resumed = await waitFor(async () => { const s = await st(app); return !s.conflictShown && !s.dirty && s.editing && s.lines > 8 ? s : null; }, 8000);
  check('5: Reload lands back in edit mode on the outside text', !!resumed);

  // 5b: the file DELETED while editing: Keep mine, then Ctrl+S, recreates it (PR #155 Dexter 1 / Miguel B2)
  const mineGone = 'recreated by Keep mine\n';
  await rd(app, 'type', { text: mineGone });
  await waitFor(async () => { const s = await st(app); return s.dirty ? s : null; }, 5000);
  fs.unlinkSync(APP);
  const goneBanner = await waitFor(async () => { const s = await st(app); return s.conflictShown && /deleted/.test(s.conflictText) ? s : null; }, 15000, 25);
  check('5: a file deleted while you have unsaved edits raises the "deleted" banner', !!goneBanner, JSON.stringify(goneBanner && goneBanner.conflictText));
  await rd(app, 'conflictKeep');
  await rd(app, 'ctrlS');
  const recreated = await waitFor(async () => { const s = await st(app); return !s.dirty && !s.conflictShown ? s : null; }, 8000);
  check('5: Keep mine then Ctrl+S RECREATES the file with your text', !!recreated && fs.existsSync(APP) && disk() === mineGone, JSON.stringify(fs.existsSync(APP) && disk()));
  await rd(app, 'type', { text: APP_TEXT });
  await rd(app, 'ctrlS');
  await waitFor(async () => { const s = await st(app); return !s.dirty ? s : null; }, 8000);

  // 6 --------------------------------------------------------------------------------
  // the guards. The probe answers the native question for the person.
  await rd(app, 'confirmAnswer', { answer: false });
  await rd(app, 'type', { text: `${disk()}// unsaved\n` });
  await waitFor(async () => { const s = await st(app); return s.dirty ? s : null; }, 5000);
  await rd(app, 'open', { path: 'src/other.js' });
  let s6 = await st(app);
  let asked = (await rd(app, 'confirmAsked')).asked;
  check('6: opening another file with unsaved text ASKS (naming the file); "no" stays on the file with the text', s6.path === 'src/app.js' && s6.dirty && asked.length === 1 && /src\/app\.js/.test(asked[0]), JSON.stringify({ path: s6.path, asked }));
  await shoot(app, '7-guard-still-editing');
  await rd(app, 'close');
  s6 = await st(app);
  asked = (await rd(app, 'confirmAsked')).asked;
  check('6: closing the panel with unsaved text asks; "no" keeps it open', s6.open && s6.dirty && asked.length === 2, JSON.stringify({ open: s6.open, n: asked.length }));
  await rd(app, 'escape');
  await sleep(300);
  s6 = await st(app);
  asked = (await rd(app, 'confirmAsked')).asked;
  check('6: Esc asks too (same guard); "no" keeps it open', s6.open && s6.dirty && asked.length === 3, JSON.stringify({ open: s6.open, n: asked.length }));
  await rd(app, 'edit');
  s6 = await st(app);
  asked = (await rd(app, 'confirmAsked')).asked;
  check('6: Done with unsaved text asks; "no" keeps editing', s6.editing && s6.dirty && asked.length === 4, JSON.stringify({ editing: s6.editing, n: asked.length }));
  await rd(app, 'confirmAnswer', { answer: true });
  await rd(app, 'open', { path: 'src/other.js' });
  const moved = await waitFor(async () => { const s = await st(app); return s.path === 'src/other.js' && s.text.startsWith('exports.other') ? s : null; }, 10000);
  check('6: "yes" discards the text and opens the other file read-only; the dot is gone', !!moved && !moved.editing && !moved.dotShown && !moved.dirty);
  check('6: ...and the discarded text never reached the disk', !disk().includes('// unsaved'));
  check('7: ...and main forgot the unsaved file', (await command(app, { cmd: 'state' })).readerUnsaved === null);
  // clean: nothing is asked
  await rd(app, 'confirmAnswer', { answer: false });
  await startEdit(app);
  await rd(app, 'open', { path: 'src/app.js' });
  await waitFor(async () => { const s = await st(app); return s.path === 'src/app.js' && !s.editing ? s : null; }, 8000);
  await rd(app, 'close');
  const askedClean = (await rd(app, 'confirmAsked')).asked;
  check('6: with nothing unsaved, switching files and closing ask nothing', askedClean.length === 0 && !(await st(app)).open, JSON.stringify(askedClean));

  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 10000);
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    restoreLayout();
    if (process.env.READER_EDIT_SHOTS) console.log(`screenshots: ${shots}`);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
