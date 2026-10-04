'use strict';
/**
 * PROBE: tab marks (#40, documentation/PLAN_TAB_MARKS.md Task 6) in a REAL window with a REAL host.
 * (re-runnable)
 *
 *   node verify/probe-tab-marks.js            (exit 0 = every check held)
 *   TAB_MARKS_PROBE_SHOTS=<dir>                also keep screenshots there
 *
 * MEASURED 2026-10-02 (Electron 33, Windows 11): all 18 checks pass; the strip draws a colour ⏳
 * 16px wide before "develop" (screenshot 1-marked.strip.png).
 *
 * The unit tests pin the pieces; no unit test can see the strip page draw an emoji, or the window
 * read, prune and write dev\.claude-custom\tab-marks.json. This seeds that file in a temp project
 * and checks:
 *
 *   1  a saved mark is drawn before its tab's label, with its meaning on hover, and has width
 *   2  a mark on a branch git doesn't list is pruned from the file at launch; the live one stays
 *   3  setting a mark (the menu's own call, through the probe driver) writes the file and redraws
 *   4  a mark written by another window (the file, directly) shows within a poll
 *   5  an unreadable file draws no marks, and setting a mark never writes over it
 *   6  Clear removes the mark from the file and the strip
 *   7  the Mark menu, as Electron built it: checkbox rows (a radio group gets a default tick out of
 *      JS's sight: no delegate to ask, MEASURED), nothing ticked when unmarked, only its own when marked
 *
 * SAFE. The host's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills; ELECTRON_RUN_AS_NODE
 * is deleted; registry, portraits, uploads and user data are temp folders; the repo is a temp git
 * repo. Every host whose folder is inside the probe's temp folder is killed at the end.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));
const { MARKS } = require(path.join(ROOT, 'app', 'tab-marks'));

const hygiene = createHygieneRegistry();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-marks-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const MARKS_FILE = path.join(dev, '.claude-custom', 'tab-marks.json');
const userData = path.join(tmp, 'user-data');
const shots = process.env.TAB_MARKS_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });
const MARK = Object.fromEntries(MARKS.map(x => [x.id, x]));

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

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS'];

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
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
  }
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

const writeMarks = (marks) => {
  const t = `${MARKS_FILE}.probe-tmp`;
  fs.writeFileSync(t, JSON.stringify({ version: 1, marks }));
  fs.renameSync(t, MARKS_FILE);
};
const fileMarks = () => { try { return JSON.parse(fs.readFileSync(MARKS_FILE, 'utf8')).marks; } catch { return null; } };

async function devTab(app) {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.add(h.pid);
  return Array.isArray(st && st.stripDom) ? st.stripDom.find(t => t.label === 'develop') || null : null;
}
const markIs = (app, emoji) => waitFor(async () => {
  const t = await devTab(app);
  if (!t) return null;
  if (emoji === null) return t.mark === null ? t : null;
  return t.mark && t.mark.text === emoji ? t : null;
}, 10000);

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: dev, stdio: 'pipe', windowsHide: true });
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dev, stdio: 'pipe', windowsHide: true });
  fs.mkdirSync(path.dirname(MARKS_FILE), { recursive: true });
  writeMarks({ develop: 'waiting', 'feat/gone': 'bug' });

  const app = await launchApp(container);

  // 1 -----------------------------------------------------------------------------
  const first = await waitFor(async () => {
    const t = await devTab(app);
    return t && t.mark ? t : null;
  }, 45000);
  check('1: the saved mark is drawn on the develop tab', !!first && first.mark.text === MARK.waiting.emoji,
    first ? JSON.stringify(first.mark) : app.out.slice(-600));
  if (!first) return;
  check('1: ...its meaning on hover', first.mark.title === MARK.waiting.meaning, first.mark.title);
  check('1: ...just before the label, with width', first.mark.beforeLabel === true && first.mark.width > 0,
    JSON.stringify(first.mark));
  await sleep(500);
  await command(app, { cmd: 'screenshot', file: path.join(shots, '1-marked.png') });

  // 2 -----------------------------------------------------------------------------
  const pruned = await waitFor(() => {
    const m = fileMarks();
    return m && !('feat/gone' in m) ? m : null;
  }, 10000);
  check('2: the mark on a branch git doesn\'t list was pruned from the file', !!pruned, JSON.stringify(fileMarks()));
  check('2: ...and the live branch\'s mark stayed', !!pruned && pruned.develop === 'waiting', JSON.stringify(pruned));

  // 3 -----------------------------------------------------------------------------
  const set = await command(app, { cmd: 'mark', branch: 'develop', id: 'ship' });
  check('3: setting a mark through the menu\'s own call succeeds', set && set.ok === true, JSON.stringify(set));
  check('3: ...writes the file', (fileMarks() || {}).develop === 'ship', JSON.stringify(fileMarks()));
  check('3: ...and redraws the tab', !!(await markIs(app, MARK.ship.emoji)));

  // 4 -----------------------------------------------------------------------------
  writeMarks({ develop: 'star' });
  check('4: a mark another window wrote shows within a poll', !!(await markIs(app, MARK.star.emoji)));

  // 5 -----------------------------------------------------------------------------
  fs.writeFileSync(MARKS_FILE, '{ not json');
  check('5: an unreadable file draws no mark', !!(await markIs(app, null)));
  const refused = await command(app, { cmd: 'mark', branch: 'develop', id: 'bug' });
  check('5: ...setting a mark fails, and says the file is unreadable', refused && refused.ok === false && refused.state === 'unreadable', JSON.stringify(refused));
  check('5: ...and never writes over it', fs.readFileSync(MARKS_FILE, 'utf8') === '{ not json');

  // 7 (Dexter #87 F2) ---------------------------------------------------------------
  // Electron ticks the first item of a RADIO group with none ticked, in its menu-will-show
  // hook, out of JS's sight (no delegate to ask). So the rows are checkboxes, which have no
  // group and no default: asserted here on the menu Electron actually built.
  writeMarks({ develop: 'urgent' });
  const none = await command(app, { cmd: 'markMenu', branch: 'feat/unmarked' });
  const ticked = (r) => (r && r.items ? r.items.filter(i => i.checked).map(i => i.label) : null);
  const types = (r) => (r && r.items ? [...new Set(r.items.map(i => i.type))] : null);
  check('7: the Mark rows are checkboxes (no radio group, so no default tick)',
    none && none.ok && JSON.stringify(types(none)) === JSON.stringify(['checkbox', 'normal']), JSON.stringify(types(none)));
  check('7: ...an unmarked branch has nothing ticked', none && none.ok && ticked(none).length === 0, JSON.stringify(ticked(none)));
  const one = await command(app, { cmd: 'markMenu', branch: 'develop' });
  check('7: ...a marked one has exactly its own mark ticked',
    one && one.ok && JSON.stringify(ticked(one)) === JSON.stringify([`${MARK.urgent.emoji}  ${MARK.urgent.meaning}`]),
    JSON.stringify(ticked(one)));

  // 6 -----------------------------------------------------------------------------
  await markIs(app, MARK.urgent.emoji);
  const cleared = await command(app, { cmd: 'mark', branch: 'develop', id: null });
  check('6: Clear succeeds', cleared && cleared.ok === true, JSON.stringify(cleared));
  check('6: ...removes the mark from the file', JSON.stringify(fileMarks()) === '{}', JSON.stringify(fileMarks()));
  check('6: ...and from the strip', !!(await markIs(app, null)));

  await command(app, { cmd: 'quit' });
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    if (process.env.TAB_MARKS_PROBE_SHOTS) console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
