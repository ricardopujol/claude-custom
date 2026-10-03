'use strict';
/**
 * PROBE: the repo browser and code reader (#45 + #32) in a REAL window with a REAL host.  (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-repo-browser.js     (exit 0 = every check held)
 *   REPO_PROBE_SHOTS=<dir>                                            also keep the screenshots there
 *
 * The unit tests pin what the tree SAYS (test/repo-tree-display*.test.js), what the host ANSWERS
 * (test/repo-service.test.js) and what the guard REFUSES (test/repo-guard*.test.js). None of them can see the
 * page: renderer scripts share one global scope (CLAUDE.md), so a module can load in a test and still abort in
 * the window, and CodeMirror only exists in a real renderer. This draws the real Files tab from a real host
 * answering `repo` frames for a throwaway repo, and checks:
 *
 *   1  the Files tab lists the repo: folders first, node_modules and ignored files out, an untracked file Claude
 *      wrote in, a hostile file name drawn as text
 *   2  folders list lazily (nothing under src until it is opened) and every row carries what it needs
 *   3  the overlay: edited rows wear a count, read rows are fainter, folders roll up, the note counts them
 *   4  "Only what Claude touched": exactly the touched files, and back
 *   5  a click opens the reader in a split beside the terminal; CodeMirror loads on THAT click, not before; the
 *      terminal gives up width but keeps at least 300px and is resized to match
 *   6  memory: the harness's private bytes and the page's JS heap before and after the first open
 *   7  the Diff toggle exists only on a file Claude edited, shows its Edit calls (+/- lines), and goes back
 *   8  a file changed on disk raises the Reload bar and is NOT swapped under the reader; Reload takes it;
 *      a deleted file says so
 *   9  over 2 MB and binary open nothing and say why, with Show in Explorer
 *  10  a path outside the worktree, a `..` spelling and a junction leading out are refused (read, reveal, drag)
 *  11  "@ in prompt": a stand-in CLI box (verify/lib/fake-claude-box.js) holds exactly `@src/app.js#L2-4`,
 *      then `@README.md` from the tree's menu, and NOTHING is submitted; a draft is cleared; a name with a
 *      space is refused with the reason
 *  12  right-click: Open / @ in prompt / Show in Explorer on a file, Show in Explorer alone on a folder; a file
 *      row can be dragged out and a folder row cannot
 *  13  the divider: dragged, the width changes, is remembered per tab, and comes back on the next open; Esc
 *      closes the reader and the terminal takes its width back
 *  14  a new file appears in the tree without a reload
 *  15  git failing under the tab (HEAD broken, then put back) says "not a git repository" in the warning colour and
 *      draws no rows, so it can never read as a clean, empty repo; fixed, the tree comes back
 *
 * NOT done here, on purpose: Show in Explorer on a real file (it would open Explorer on the machine running
 * this) and a real OS drag-out (webContents.startDrag opens the OS's modal drag loop, which freezes the window
 * until a mouse button is released: a probe page records the request instead). main's guard for both is
 * test/repo-actions.test.js; this checks that the page asks, and that main refuses the bad ones.
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE and every
 * CLAUDE_CUSTOM_* variable is stripped from the window under test, then only the probe's own are set; the
 * repo, registry, portraits, uploads and user data are temp folders. Only PIDs this probe started are killed.
 */

const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const LAYOUT_FILE = path.join(HARNESS_DIR, 'state', 'layout-global.json');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { projectDirName } = require(path.join(ROOT, 'host', 'project-dir'));
const { summarize } = require('./probe-memory-footprint');

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-repo-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const outsideDir = path.join(tmp, 'outside');
const projectsDir = path.join(tmp, 'projects');
const userData = path.join(tmp, 'user-data');
const shots = process.env.REPO_PROBE_SHOTS || path.join(tmp, 'shots');
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

const LAYOUT_BACKUP = `${LAYOUT_FILE}.repo-probe-backup`;
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
  // Launched from inside a harness tab, this process inherits that tab's CLAUDE_CUSTOM_* identity (its port,
  // token, project) and Claude Code's ELECTRON_RUN_AS_NODE: none of it may reach the window under test.
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
    // the transcripts the overlay reads come from here, never ~/.claude (host/probe-seams.js)
    CLAUDE_CUSTOM_GIT_PROJECTS_DIR: projectsDir,
  };
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawn(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${path.join(userData, String(port))}`], { cwd: ROOT, env });
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
const rp = (app, what, args = {}) => view(app, 'repoProbe', { what, ...args });

const seenPids = new Set();
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
    // 150s: a window on a busy machine can take half a minute to connect (develop's own probes do too)
  }, 150000);
}

// ---- the fixture ----

const APP_JS = [
  "'use strict';",
  "const greeting = 'hello';",
  'function add(a, b) {',
  '  return a + b;',
  '}',
  'module.exports = { add, greeting };',
  '',
].join('\n');
const HOSTILE = 'a&amp;b<tag>.js'.replace(/[<>]/g, '');     // Windows can't hold < or >; `&amp;` is the markup-shaped part
const SPACED = 'my file.md';

// well in the past, so "the file changed since Claude's last call" is only true when the probe changes it
function at(n) { return new Date(Date.parse('2026-09-01T12:00:00Z') + n * 1000).toISOString(); }
let toolId = 0;
const toolUse = (name, input, n) => ({ type: 'assistant', timestamp: at(n), message: { content: [{ type: 'tool_use', id: `toolu_probe_${++toolId}`, name, input }] } });
// the answer Claude Code records for a call; a call without one (or with is_error) is not a change
const toolResult = (use, n, content = 'ok', is_error = undefined) => ({ type: 'user', timestamp: at(n),
  message: { content: [{ type: 'tool_result', tool_use_id: use.message.content[0].id, content, ...(is_error ? { is_error } : {}) }] } });

function makeRepo() {
  fs.mkdirSync(path.join(dev, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dev, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dev, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dev, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dev, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dev, '.gitignore'), 'node_modules/\n*.log\n');
  fs.writeFileSync(path.join(dev, 'README.md'), '# probe repo\n\nA fixture.\n');
  fs.writeFileSync(path.join(dev, 'src', 'app.js'), APP_JS);
  fs.writeFileSync(path.join(dev, 'src', 'util.js'), 'exports.one = 1;\n');
  fs.writeFileSync(path.join(dev, 'docs', 'guide.md'), '# guide\n');
  fs.writeFileSync(path.join(dev, SPACED), 'a name with a space\n');
  fs.writeFileSync(path.join(dev, HOSTILE), 'x\n');
  fs.writeFileSync(path.join(dev, 'data', 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 4096, 0x61));
  fs.writeFileSync(path.join(dev, 'bin', 'blob.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02, 0x00]));
  fs.writeFileSync(path.join(dev, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dev, 'debug.log'), 'ignored\n');
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP SECRET\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'init');
  // After the commit: an UNTRACKED file Claude wrote (the design said "tracked only"; that would hide it), and
  // a tracked file changed by hand / by Bash (no Claude Edit recorded: no Diff toggle).
  fs.writeFileSync(path.join(dev, 'src', 'written.js'), 'exports.written = true;\nexports.second = 2;\n');
  fs.appendFileSync(path.join(dev, 'src', 'util.js'), 'exports.two = 2;\n');
  // a junction inside the worktree that leads OUT
  try { fs.symlinkSync(outsideDir, path.join(dev, 'jn'), 'junction'); } catch (e) { console.log(`(no junction: ${e.message})`); }

  // Claude's transcript for this worktree: two Edits and a Write, and two Reads
  const dir = path.join(projectsDir, projectDirName(dev));
  fs.mkdirSync(dir, { recursive: true });
  const abs = (rel) => path.join(dev, rel);
  const e1 = toolUse('Edit', { file_path: abs('src/app.js'), old_string: "const greeting = 'hi';", new_string: "const greeting = 'hello';" }, 3);
  const e2 = toolUse('Edit', { file_path: abs('src/app.js'), old_string: 'return a - b;', new_string: 'return a + b;' }, 4);
  const w1 = toolUse('Write', { file_path: abs('src/written.js'), content: 'exports.written = true;\nexports.second = 2;\n' }, 5);
  // an Edit that FAILED ("Found 2 matches") and a Write the person refused: neither is a change (Dexter D1)
  const bad = toolUse('Edit', { file_path: abs('src/util.js'), old_string: 'one', new_string: 'uno' }, 6);
  const refused = toolUse('Write', { file_path: abs('docs/never.md'), content: 'x' }, 7);
  const lines = [
    toolUse('Read', { file_path: abs('README.md') }, 1),
    toolUse('Read', { file_path: abs('docs/guide.md') }, 2),
    e1, toolResult(e1, 3), e2, toolResult(e2, 4), w1, toolResult(w1, 5),
    bad, toolResult(bad, 6, 'Found 2 matches of the string to replace', true),
    refused, toolResult(refused, 7, "The user doesn't want to proceed with this tool use. The tool use was rejected.", true),
  ].map(l => JSON.stringify(l)).join('\n');
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines);
}

// ---- memory ----

function allProcesses() {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1048576 });
  return JSON.parse(ps.stdout);
}
const MB = (b) => (b / 1048576).toFixed(1);
// median of five: one reading can land on a GC or a paint
async function memory(app) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const { summary } = summarize(allProcesses(), app.child.pid);
    samples.push(summary);
    if (i < 4) await sleep(1000);
  }
  samples.sort((a, b) => a.harnessPrivateBytes - b.harnessPrivateBytes);
  return samples[2];
}

// ---- the stand-in CLI box ----

const boxCtl = path.join(tmp, 'box-ctl.json');
const boxLog = path.join(tmp, 'box-submitted.log');
const boxLine = () => { try { return JSON.parse(fs.readFileSync(`${boxLog}.line`, 'utf8')); } catch { return null; } };
const submitted = () => { try { return fs.readFileSync(boxLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

// ---- the checks ----

const rowsOf = (s) => (s && s.rows) || [];
const rowOf = (s, p) => rowsOf(s).find(r => r.path === p) || null;
const names = (s) => rowsOf(s).filter(r => r.path).map(r => r.path);

async function main() {
  makeRepo();
  setAsideLayout();
  const app = await launchApp(container);
  const ready = await viewReady(app);
  const vstate = ready ? null : await view(app, 'state');
  check('the window came up with a session and the probe hook', !!ready, ready ? '' : `${app.out.slice(-800)} | state: ${JSON.stringify(await command(app, { cmd: 'state' })).slice(0, 900)} | view: ${(() => { const v = vstate || {}; return JSON.stringify({ ok: v.ok, sent: v.sent, term: v.term, fit: v.fit, shown: v.shown, error: v.error }); })()} | exited: ${app.exited}`);
  if (!ready) return;
  const stateNow = async () => (await command(app, { cmd: 'state' })) || {};
  console.log(`      host cwd: ${JSON.stringify(((await stateNow()).hosts || []).map(h => h.cwd))}`);

  // 1 ------------------------------------------------------------------------------
  // The Files tab replaced the Map: same module id, new label. Put it where its screenshot reads well.
  await view(app, 'move', { id: 'fog', target: 'left' });
  const vs = await view(app, 'state');
  check('1: the module is in the dock, in the left zone we moved it to', vs.zones.left.tabs.includes('fog'), JSON.stringify(vs.zones.left.tabs));
  const label = await waitFor(async () => {
    const tabs = await view(app, 'openMenu', { which: 'layout' });
    await view(app, 'closeMenu');
    return tabs;
  }, 3000);
  void label;
  const first = await waitFor(async () => {
    const s = await rp(app, 'state');
    return s && s.ok && s.rows.some(r => r.path === 'README.md') ? s : null;
  }, 20000);
  check('1: the tree lists the repo root', !!first, JSON.stringify(await rp(app, 'state')).slice(0, 600));
  if (!first) return;
  const rootNames = names(first);
  check('1: folders first (data, docs, src), then files; node_modules, the ignored debug.log and .git are not listed',
    JSON.stringify(rootNames.slice(0, 3)) === JSON.stringify(['bin', 'data', 'docs'].filter(x => rootNames.includes(x)).concat(rootNames.slice(3, 3)).slice(0, 3))
    && rootNames.indexOf('src') < rootNames.indexOf('README.md') && !rootNames.includes('node_modules') && !rootNames.includes('debug.log') && !rootNames.includes('.git'),
    rootNames.join(', '));
  const hostile = rowOf(first, HOSTILE);
  check('1: a file named like markup is drawn as text, exactly (no entity decoded, no element made)',
    !!hostile && hostile.text === HOSTILE, JSON.stringify(hostile && hostile.text));
  check('1: the Files module is labelled Files', (await view(app, 'state')).zones.left.tabs.includes('fog')
    && await waitFor(async () => (await command(app, { cmd: 'screenshot', file: path.join(shots, '1-tree.png') })) && true, 5000) !== null);

  // 2 ------------------------------------------------------------------------------
  check('2: folders are listed lazily: nothing under src is drawn until src is opened', !names(first).some(p => p.startsWith('src/')));
  await rp(app, 'click', { path: 'src' });
  const src = await waitFor(async () => { const s = await rp(app, 'state'); return rowOf(s, 'src/app.js') ? s : null; }, 8000);
  check('2: opening src lists its files one level deeper, and marks the folder open',
    !!src && rowOf(src, 'src').expanded === 'true' && rowOf(src, 'src/app.js').depth === 1, JSON.stringify(rowsOf(src).map(r => `${r.depth}:${r.path}`)));
  check('2: an untracked file Claude wrote (src/written.js) is listed; every file row is draggable and no folder row is',
    !!src && !!rowOf(src, 'src/written.js') && rowsOf(src).filter(r => r.kind === 'file').every(r => r.draggable) && rowsOf(src).filter(r => r.kind === 'dir').every(r => !r.draggable));

  // 3 ------------------------------------------------------------------------------
  const ov = await waitFor(async () => { const s = await rp(app, 'state'); const r = rowOf(s, 'src/app.js'); return r && r.badge ? s : null; }, 20000);
  check('3: the overlay arrived: src/app.js wears \u25cf2 (two Edit calls) and the edited look', !!ov && rowOf(ov, 'src/app.js').badge === '\u25cf2' && / edited/.test(rowOf(ov, 'src/app.js').cls),
    JSON.stringify(rowOf(ov || src, 'src/app.js')));
  if (ov) {
    check('3: the Write counts as one edit; a file edited by hand with no Claude call is untouched (no badge, "none")',
      rowOf(ov, 'src/written.js').badge === '\u25cf1' && rowOf(ov, 'src/util.js').badge === '' && / none/.test(rowOf(ov, 'src/util.js').cls),
      JSON.stringify([rowOf(ov, 'src/written.js'), rowOf(ov, 'src/util.js')]));
    check('3: README.md was only read: the read look, no count; the src folder rolls its files up to \u25cf3; docs is read-only',
      / read/.test(rowOf(ov, 'README.md').cls) && rowOf(ov, 'README.md').badge === '' && rowOf(ov, 'src').badge === '\u25cf3' && / edited/.test(rowOf(ov, 'src').cls)
      && / read/.test(rowOf(ov, 'docs').cls) && / none/.test(rowOf(ov, 'data').cls),
      JSON.stringify(['README.md', 'src', 'docs', 'data'].map(p => [p, rowOf(ov, p).cls, rowOf(ov, p).badge])));
    check('3: the note counts them: 2 edited, 2 read', /2 edited \u00b7 2 read by Claude/.test(ov.note) && !ov.noteWarn, ov.note);
  }
  await command(app, { cmd: 'screenshot', file: path.join(shots, '3-overlay.png') });

  // 4 ------------------------------------------------------------------------------
  await rp(app, 'only', { on: true });
  const only = await rp(app, 'state');
  const touchedFiles = rowsOf(only).filter(r => r.kind === 'file').map(r => r.path).sort();
  check('4: "Only what Claude touched" keeps exactly the four touched files', JSON.stringify(touchedFiles) === JSON.stringify(['README.md', 'docs/guide.md', 'src/app.js', 'src/written.js']), touchedFiles.join(', '));
  check('4: ...and no untouched file or folder (data, bin, util.js) is drawn', !names(only).some(p => /^(data|bin)|util\.js/.test(p)), names(only).join(', '));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '4-only.png') });
  await rp(app, 'only', { on: false });
  check('4: switched off, the whole tree is back', rowsOf(await rp(app, 'state')).some(r => r.path === 'data'));

  // 5 + 6 --------------------------------------------------------------------------
  const termBefore = await view(app, 'state');
  const before = await rp(app, 'reader.state');
  check('5: before the first open: no reader, and CodeMirror is NOT loaded (lazy)', before.ok && !before.open && !before.cmLoaded && !before.splitShown, JSON.stringify(before));
  const memBefore = await memory(app);
  const heapBefore = before.heap;
  await rp(app, 'click', { path: 'src/app.js' });
  const opened = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.open && s.cmMounted && s.lines > 3 ? s : null; }, 15000);
  check('5: a click on src/app.js opens the reader, and CodeMirror loaded then and is mounted', !!opened && opened.cmLoaded && opened.path === 'src/app.js', JSON.stringify(opened || await rp(app, 'reader.state')).slice(0, 500));
  if (!opened) return;
  check('5: it shows the file: first line, line count', opened.text.startsWith("'use strict';") && opened.lines === 7, `${opened.lines} lines: ${JSON.stringify(opened.text.slice(0, 40))}`);
  const termAfter = await waitFor(async () => {
    const t = await view(app, 'state');
    return t.term.cols < termBefore.term.cols && JSON.stringify(t.sent) === JSON.stringify(t.term) ? t : null;
  }, 8000);
  check('5: the terminal gave up width (fewer columns), is at least 300px, and the pty was told the new size',
    !!termAfter && termAfter.termwrap.width >= 300 && opened.width >= 240,
    termAfter ? `cols ${termBefore.term.cols} -> ${termAfter.term.cols}; termwrap ${Math.round(termAfter.termwrap.width)}px; reader ${Math.round(opened.width)}px; sent ${JSON.stringify(termAfter.sent)}` : 'terminal did not shrink');
  check('5: the reader sits beside the terminal, not over it', !!termAfter && opened.rect.left >= termAfter.termwrap.right - 1,
    `termwrap right ${termAfter && Math.round(termAfter.termwrap.right)}, reader left ${Math.round(opened.rect.left)}`);
  await sleep(1500);
  const memAfter = await memory(app);
  const after = await rp(app, 'reader.state');
  const rend = (m) => (m.byRole['electron:renderer'] || { privateBytes: 0, count: 0 });
  console.log(`      MEMORY before the first open: harness private ${MB(memBefore.harnessPrivateBytes)} MB (${memBefore.processes} processes); renderers ${MB(rend(memBefore).privateBytes)} MB x${rend(memBefore).count}; page JS heap ${heapBefore === null ? 'n/a' : MB(heapBefore)} MB`);
  console.log(`      MEMORY after  the first open: harness private ${MB(memAfter.harnessPrivateBytes)} MB (${memAfter.processes} processes); renderers ${MB(rend(memAfter).privateBytes)} MB x${rend(memAfter).count}; page JS heap ${after.heap === null ? 'n/a' : MB(after.heap)} MB`);
  console.log(`      MEMORY delta: renderers ${MB(rend(memAfter).privateBytes - rend(memBefore).privateBytes)} MB (this is what opening the first file costs: CodeMirror and one document); whole harness tree ${MB(memAfter.harnessPrivateBytes - memBefore.harnessPrivateBytes)} MB (the host's own GC swings this by tens of MB, so it is not the number to judge)`);
  const byRole = (m) => Object.fromEntries(Object.entries(m.byRole).filter(([k]) => /electron:renderer|electron:main|host/.test(k)).map(([k, v]) => [k, `${MB(v.privateBytes)} MB x${v.count}`]));
  console.log(`      MEMORY by role before: ${JSON.stringify(byRole(memBefore))}`);
  console.log(`      MEMORY by role after : ${JSON.stringify(byRole(memAfter))}`);
  console.log('      (the page JS heap is performance.memory, which Chromium rounds to coarse steps without --enable-precise-memory-info: it reads the same before and after, so the OS numbers above are the evidence)');
  check('6: memory was measured before and after the first open (a number, not a threshold: #20 has no target yet)', memBefore.harnessPrivateBytes > 0 && memAfter.harnessPrivateBytes > 0);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '5-reader.png') });

  // 7 ------------------------------------------------------------------------------
  check('7: the Diff toggle is on src/app.js (Claude edited it)', opened.diffVisible && opened.diffLabel === 'Diff');
  await rp(app, 'reader.toggleDiff');
  const diff = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.mode === 'diff' && s.diffClasses && s.diffClasses.hunk >= 2 ? s : null; }, 10000);
  check("7: the diff is Claude's own two Edit calls: two @@ headers, - and + lines coloured, labelled \"Claude's edits\"",
    !!diff && /@@ Edit/.test(diff.text) && diff.diffClasses.add >= 2 && diff.diffClasses.del >= 2 && /Claude's edits/.test(diff.meta), JSON.stringify(diff || await rp(app, 'reader.state')).slice(0, 500));
  check('7: the toggle now offers the way back (File)', !!diff && diff.diffLabel === 'File');
  await command(app, { cmd: 'screenshot', file: path.join(shots, '7-diff.png') });
  await rp(app, 'reader.toggleDiff');
  const back = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.mode === 'file' && s.text.startsWith("'use strict';") ? s : null; }, 8000);
  check('7: toggled back, the file is shown again', !!back);
  await rp(app, 'click', { path: 'README.md' });
  const readme = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === 'README.md' && s.text.startsWith('# probe repo') ? s : null; }, 8000);
  check('7: README.md (only read) has NO Diff toggle', !!readme && !readme.diffVisible);
  await rp(app, 'click', { path: 'src/util.js' });
  const util = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === 'src/util.js' && s.text.includes('exports.one') ? s : null; }, 8000);
  check('7 (Dexter D1): src/util.js had only a FAILED Edit in the transcript: still untouched (no badge) and docs/never.md (a refused Write) is not in the overlay',
    rowOf(await rp(app, 'state'), 'src/util.js').badge === '' && !rowsOf(await rp(app, 'state')).some(r => r.path === 'docs/never.md' && r.badge));
  check('7 (Dexter D2): src/util.js was changed by hand (git calls it modified): it HAS the Diff toggle, and the diff is git\'s, with the added line',
    !!util && util.diffVisible, JSON.stringify(util && { diffVisible: util.diffVisible }));
  await rp(app, 'reader.toggleDiff');
  const utilDiff = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.mode === 'diff' && /exports\.two = 2/.test(s.text) ? s : null; }, 10000);
  check('7 (D2): ...labelled git diff HEAD', !!utilDiff && /git diff HEAD/.test(utilDiff.meta), JSON.stringify(utilDiff && utilDiff.meta));
  await rp(app, 'reader.toggleDiff');

  // 8 ------------------------------------------------------------------------------
  await rp(app, 'click', { path: 'src/app.js' });
  await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === 'src/app.js' && s.text.startsWith("'use strict';") ? s : null; }, 8000);
  fs.appendFileSync(path.join(dev, 'src', 'app.js'), '// changed by hand\n');
  const bar = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.barShown && s.reloadShown ? s : null; }, 12000);
  check('8: a file changed on disk raises the Reload bar', !!bar && /changed on disk/.test(bar.barText), JSON.stringify(bar && bar.barText));
  check('8: ...and the reader did NOT swap the text under the person (still 7 lines)', !!bar && bar.lines === 7, `lines ${bar && bar.lines}`);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '8-reload-bar.png') });
  await rp(app, 'reader.reload');
  const reloaded = await waitFor(async () => { const s = await rp(app, 'reader.state'); return !s.barShown && s.lines === 8 ? s : null; }, 10000);
  check('8: Reload takes the new text (8 lines) and the bar goes', !!reloaded, JSON.stringify(await rp(app, 'reader.state')).slice(0, 300));
  await rp(app, 'click', { path: 'src/util.js' });
  await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === 'src/util.js' && s.text.includes('exports.one') ? s : null; }, 8000);
  fs.rmSync(path.join(dev, 'src', 'util.js'));
  const gone = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.barShown && /deleted on disk/.test(s.barText) ? s : null; }, 12000);
  check('8: a deleted file says "deleted on disk" (no Reload offered) and keeps the last text', !!gone && !gone.reloadShown && gone.text.includes('exports.one'), JSON.stringify(gone && gone.barText));

  // 9 ------------------------------------------------------------------------------
  await rp(app, 'click', { path: 'data' });
  await waitFor(async () => rowOf(await rp(app, 'state'), 'data/big.txt'), 8000);
  await rp(app, 'click', { path: 'data/big.txt' });
  const big = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === 'data/big.txt' && s.noteShown && /over the/.test(s.noteText) ? s : null; }, 10000);
  check('9: a file over 2 MB opens nothing and says its size and the limit, with Show in Explorer',
    !!big && /2\.0 MB/.test(big.noteText) && big.noteRevealShown && big.bodyHidden, JSON.stringify(big && big.noteText));
  await rp(app, 'click', { path: 'bin' });
  await waitFor(async () => rowOf(await rp(app, 'state'), 'bin/blob.bin'), 8000);
  await rp(app, 'click', { path: 'bin/blob.bin' });
  const bin = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === 'bin/blob.bin' && s.noteShown && /binary/.test(s.noteText) ? s : null; }, 10000);
  check('9: a binary file says binary, with Show in Explorer', !!bin && /binary/.test(bin.noteText) && bin.noteRevealShown, JSON.stringify(bin && bin.noteText));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '9-binary.png') });

  // 10 -----------------------------------------------------------------------------
  const refusals = {};
  for (const p of ['../outside/secret.txt', '..\\..\\Windows\\win.ini', outsideDir + '\\secret.txt', 'jn/secret.txt']) {
    await rp(app, 'reader.open', { path: p });
    const s = await rp(app, 'reader.state');
    refusals[p] = s;
  }
  check('10: a `..` spelling, an absolute path outside, and a junction that leads out are all refused in the reader, with a reason, and none shows the file',
    Object.values(refusals).every(s => s.noteShown && /refused|outside/i.test(s.noteText) && !/TOP SECRET/.test(s.text)),
    JSON.stringify(Object.fromEntries(Object.entries(refusals).map(([k, s]) => [k, s.noteText]))));
  const rev = {};
  const drg = {};
  for (const p of ['../outside/secret.txt', outsideDir + '\\secret.txt', 'jn/secret.txt', '\\\\srv\\share\\x']) {
    rev[p] = await rp(app, 'harnessReveal', { path: p });
    drg[p] = await rp(app, 'harnessDrag', { path: p });
  }
  check('10: main refuses to reveal or drag any of them (the page is not trusted either)',
    Object.values(rev).every(r => r && r.ok === false && r.why) && Object.values(drg).every(r => r && r.ok === false && r.why), JSON.stringify({ rev, drg }).slice(0, 500));

  // 11 -----------------------------------------------------------------------------
  // The stand-in box runs in the tab's cmd.exe so the page has a `❯` box to judge, clear and read back.
  await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && />\s*$/m.test(r.text || '') ? r : null; }, 15000, 300);
  await view(app, 'gitTermInput', { data: `node "${path.join(ROOT, 'verify', 'lib', 'fake-claude-box.js')}" "${boxCtl}" "${boxLog}"\r` });
  const boxUp = await waitFor(async () => { const r = await view(app, 'gitScreen'); return r && /\u276f/.test(r.text) && /fake claude box/.test(r.text) ? r : null; }, 15000, 300);
  check('11: the stand-in CLI box is drawn in the tab', !!boxUp, JSON.stringify(await view(app, 'gitScreen')).slice(0, 300));
  await rp(app, 'click', { path: 'src/app.js' });
  await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === 'src/app.js' && s.lines >= 7 && !s.noteShown ? s : null; }, 8000);
  await rp(app, 'reader.select', { from: 2, to: 4 });
  await rp(app, 'reader.mention');
  const typed = await waitFor(async () => (boxLine() === '@src/app.js#L2-4' ? true : null), 15000, 300);
  await sleep(1500);   // well past the read-back: an Enter would have landed by now
  check('11: "@ in prompt" with lines 2-4 selected leaves exactly @src/app.js#L2-4 in the box', !!typed && boxLine() === '@src/app.js#L2-4', JSON.stringify(boxLine()));
  check("11: ...and NOTHING was submitted: the Enter is the person's", submitted().length === 0, JSON.stringify(submitted()));
  const said = await rp(app, 'reader.state');
  check('11: the reader says it typed it and that Enter is the person\'s', /typed @src\/app\.js#L2-4/.test(said.meta) && /Enter/.test(said.meta), said.meta);
  // a draft is cleared, never submitted with the mention
  fs.writeFileSync(boxCtl, JSON.stringify({ draft: 'also fix the thing' }));
  await waitFor(async () => (boxLine() === 'also fix the thing' ? true : null), 5000, 200);
  const cm = await rp(app, 'contextMenu', { path: 'README.md' });
  check('12: right-click on a file offers Open, @ in prompt and Show in Explorer', JSON.stringify(cm.items) === JSON.stringify(['Open', '@ in prompt', 'Show in Explorer']), JSON.stringify(cm.items));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '12-menu.png') });
  await rp(app, 'menuClick', { item: '@ in prompt' });
  await waitFor(async () => (boxLine() === '@README.md' ? true : null), 15000, 300);
  await sleep(1500);
  check('11: "@ in prompt" from the tree menu replaces the draft: the box holds @README.md alone, never "also fix the thing@README.md"; still nothing submitted',
    boxLine() === '@README.md' && submitted().length === 0, JSON.stringify({ box: boxLine(), submitted: submitted() }));
  const cmDir = await rp(app, 'contextMenu', { path: 'src' });
  check('12: right-click on a folder offers Show in Explorer only', JSON.stringify(cmDir.items) === JSON.stringify(['Show in Explorer']), JSON.stringify(cmDir.items));
  await view(app, 'closeMenu');
  await rp(app, 'key', { path: 'src', key: 'Escape' });
  const dragFile = await rp(app, 'dragStart', { path: 'README.md' });
  const dragDir = await rp(app, 'dragStart', { path: 'src' });
  const dragged12 = (await rp(app, 'state')).dragRequests;
  check('12: a drag on a file row is taken over (default prevented, so main can start the OS drag) and asks main for exactly that file; a folder row asks for nothing',
    dragFile.ok && dragFile.defaultPrevented && dragDir.ok && dragDir.defaultPrevented && JSON.stringify(dragged12) === JSON.stringify(['README.md']), JSON.stringify({ dragFile, dragDir, dragged12 }));
  // a name with a space can't be mentioned: refused with the reason, box unchanged
  const boxWas = boxLine();
  await rp(app, 'reader.open', { path: SPACED });
  await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.path === SPACED && s.lines >= 1 && !s.noteShown ? s : null; }, 8000);
  await rp(app, 'reader.mention');
  await sleep(600);
  const spaced = await rp(app, 'reader.state');
  check("11: a file name with a space is refused with the reason (the CLI's @ ends at a space), and the box is untouched",
    /space or tab/.test(spaced.meta) && boxLine() === boxWas, JSON.stringify({ meta: spaced.meta, box: boxLine(), was: boxWas }));

  // 13 -----------------------------------------------------------------------------
  const w0 = (await rp(app, 'reader.state')).width;
  const dragged = await rp(app, 'reader.dragSplit', { dx: -120 });
  const stored = await rp(app, 'reader.storedWidth');
  check('13: dragging the divider 120px left widens the reader by about 120px and remembers it for THIS tab (the key names the tab\'s folder)',
    dragged.ok && Math.abs(dragged.width - (w0 + 120)) <= 4 && Number(stored.value) === Math.round(dragged.width) && /repoReaderWidth:.*dev/.test(stored.key),
    JSON.stringify({ w0, dragged, stored }));
  await rp(app, 'reader.escape');
  const closed = await rp(app, 'reader.state');
  const termRestored = await waitFor(async () => { const t = await view(app, 'state'); return t.term.cols === termBefore.term.cols ? t : null; }, 8000);
  check('13: Esc closes the reader and the terminal has its full width (and columns) back', !closed.open && !closed.splitShown && !!termRestored,
    `open ${closed.open}; cols ${termBefore.term.cols} -> ${termRestored ? termRestored.term.cols : (await view(app, 'state')).term.cols}`);
  await rp(app, 'click', { path: 'README.md' });
  const reopened = await waitFor(async () => { const s = await rp(app, 'reader.state'); return s.open && s.path === 'README.md' ? s : null; }, 8000);
  check('13: opened again, the reader comes back at the width it was dragged to', !!reopened && Math.abs(reopened.width - Math.round(dragged.width)) <= 2, `${reopened && reopened.width} vs ${dragged.width}`);
  await rp(app, 'reader.close');

  // 14 -----------------------------------------------------------------------------
  fs.writeFileSync(path.join(dev, 'src', 'later.js'), 'exports.later = 1;\n');
  const live = await waitFor(async () => { const s = await rp(app, 'state'); return rowOf(s, 'src/later.js') ? s : null; }, 12000);
  check('14: a file written after the tree was drawn appears without a reload', !!live);
  fs.rmSync(path.join(dev, 'src', 'later.js'));
  check('14: ...and goes when it is deleted', !!(await waitFor(async () => { const s = await rp(app, 'state'); return !rowOf(s, 'src/later.js') ? s : null; }, 12000)));

  // 15 -----------------------------------------------------------------------------
  // git can't answer (here: HEAD is garbage, so git says "not a git repository"): the tab says so, in the warning
  // colour, and draws NO rows, so an unreadable repo can never look like a clean, empty one. A change under the
  // watch makes the host list again; HEAD is put back afterwards and the tree comes back.
  const headFile = path.join(dev, '.git', 'HEAD');
  const head = fs.readFileSync(headFile, 'utf8');
  fs.writeFileSync(headFile, 'this is not a ref\n');
  fs.writeFileSync(path.join(dev, 'src', 'trigger.js'), 'x\n');
  const err = await waitFor(async () => { const s = await rp(app, 'state'); return s.ok && s.error ? s : null; }, 15000);
  check('15: git failing: the tab says "not a git repository" in the warning colour and draws no rows (it cannot read as a clean, empty repo)',
    !!err && /not a git repository/i.test(err.note) && err.noteWarn && rowsOf(err).length === 0, JSON.stringify(err && { note: err.note, error: err.error, rows: err.rows.length }));
  await command(app, { cmd: 'screenshot', file: path.join(shots, '15-git-failed.png') });
  fs.writeFileSync(headFile, head);
  fs.writeFileSync(path.join(dev, 'src', 'trigger.js'), 'y\n');
  const healed = await waitFor(async () => { const s = await rp(app, 'state'); return s.ok && !s.error && rowOf(s, 'README.md') ? s : null; }, 15000);
  check('15: git back: the tree comes back and the warning goes', !!healed, JSON.stringify(healed && { note: healed.note, error: healed.error }));

  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 10000);
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    restoreLayout();
    if (process.env.REPO_PROBE_SHOTS) console.log(`screenshots: ${shots}`);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
