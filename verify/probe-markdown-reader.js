'use strict';
/**
 * PROBE: the code reader shows Markdown as a page (BACKLOG #119 A9) in a REAL window.  (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-markdown-reader.js     (exit 0 = every check held)
 *   MARKDOWN_SHOTS=<dir>                                                 keep the screenshots (and the temp repo) there
 *
 * The unit tests pin the reader's wiring against stubs (test/repo-reader-markdown.test.js) and the link rule
 * (test/markdown-links.test.js). They cannot see the page: marked, DOMPurify and Mermaid only run in a real renderer
 * under the real Content-Security-Policy (no inline script, no eval), and "no inline script ever reaches the DOM" is a
 * claim about that DOM. This opens a fixture guide with headings, a table, task boxes, relative / http / hostile links,
 * two Mermaid fences (one good, one not a diagram), a Mermaid fence trying to lower its own security level and raw
 * HTML carrying a script, an event handler, an iframe, a style and an id that would shadow the app's own #reader, and
 * checks the DOM that came out, what the clicks do, the Rendered | Source segment and that Edit forces Source.
 *
 * SAFE. Same as probe-reader-edit.js: the host's `claude` is cmd.exe, nothing bills, CLAUDE_CUSTOM_* and
 * ELECTRON_RUN_AS_NODE are stripped, the repo and user data are temp folders, only PIDs this probe started are killed,
 * and the Electron goes through verify/lib/launch-electron.js (which takes the machine's heavy lock).
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-md-'));
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const projectsDir = path.join(tmp, 'projects');
const userData = path.join(tmp, 'user-data');
const shots = process.env.MARKDOWN_SHOTS || path.join(tmp, 'shots');
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

const LAYOUT_BACKUP = `${LAYOUT_FILE}.md-probe-backup`;
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

const GUIDE_LINES = [
  '# Guide Title',
  '',
  'Intro with **bold**, `code` and links: [sibling](other.md), [parent](../README.md), [js file](../src/app.js), [web](https://example.com/page),',
  '[mail](mailto:a@b.c), [js](javascript:window.__mdPwned=1), [escape](../../outside.md), [anchor](#second-section).',
  '',
  '## Second Section',
  '',
  '| Name | Value |',
  '|------|-------|',
  '| a | 1 |',
  '| b | 2 |',
  '',
  '- [x] done',
  '- [ ] todo',
  '',
  '```mermaid',
  'graph TD',
  '  A[Start] --> B{Choice}',
  '  B -->|yes| C[Done]',
  '  B -->|no| A',
  '```',
  '',
  '```mermaid',
  'this is not a diagram at all',
  '```',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '<script>window.__mdPwned = "script"</script>',
  '<img src="x" onerror="window.__mdPwned=\'img\'">',
  '<iframe src="https://example.com"></iframe>',
  '<div style="position:fixed;inset:0" id="reader" onclick="window.__mdPwned=\'click\'">raw html div</div>',
  '<a href="javascript:window.__mdPwned=\'a\'">js link html</a>',
  '',
  '![alt text](pic.png)',
  '',
  '```mermaid',
  '%%{init: {"securityLevel": "loose"}}%%',
  'graph LR',
  '  A --> B',
  '  click A "javascript:window.__mdPwned=\'mermaid\'" "tip"',
  '```',
  '',
  'Last paragraph.',
  '',
];

function makeRepo() {
  fs.mkdirSync(path.join(dev, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dev, 'docs'), { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dev, 'README.md'), '# probe repo\n\nThe readme.\n');
  fs.writeFileSync(path.join(dev, 'src', 'app.js'), "'use strict';\nmodule.exports = 1;\n");
  fs.writeFileSync(path.join(dev, 'docs', 'guide.md'), GUIDE_LINES.join('\n'));
  fs.writeFileSync(path.join(dev, 'docs', 'other.md'), '# Other\n\nThe second page.\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'init');
}

const shoot = (app, name) => command(app, { cmd: 'screenshot', file: path.join(shots, `${name}.png`) });
const st = (app) => rd(app, 'state');
const dom = (app) => rd(app, 'mdDom');

async function openMd(app, rel) {
  await rd(app, 'open', { path: rel });
  return waitFor(async () => { const s = await st(app); if (!(s.open && s.path === rel && s.mdShown)) return null; const d = await dom(app); return d.page ? { s, d } : null; }, 90000, 150);
}
async function openOther(app, rel, startsWith) {
  await rd(app, 'open', { path: rel });
  return waitFor(async () => { const s = await st(app); return s.open && s.path === rel && !s.noteShown && s.text.startsWith(startsWith) ? s : null; }, 20000);
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

  // 1 lazy: a code file does not load the Markdown bundle, and shows no segment
  const code = await openOther(app, 'src/app.js', "'use strict';");
  check('1: a code file shows no Rendered | Source segment, and the Markdown bundle is NOT loaded yet', !!code && !code.mdSegmentShown && !code.mdLoaded && !code.mdShown && code.cmMounted, JSON.stringify(code && { seg: code.mdSegmentShown, loaded: code.mdLoaded }));

  // 2 the page
  const t0 = Date.now();
  const first = await openMd(app, 'docs/guide.md');
  const firstMs = Date.now() - t0;
  check('2: docs/guide.md opens RENDERED by default, with the segment showing Rendered pressed', !!first && first.s.mdSegmentShown && first.s.mdView === 'rendered' && first.s.mdPressed.rendered === 'true' && first.s.mdPressed.source === 'false' && first.s.mdLoaded, JSON.stringify(first && first.s.mdPressed));
  console.log(`      FIRST RENDER (open -> page on screen, includes loading the bundle and drawing the diagrams), ms: ${firstMs}`);
  if (!first) {
    const s = await st(app);
    console.log(`      WHERE IT STOPPED: ${JSON.stringify({ open: s.open, path: s.path, meta: s.meta, mdLoaded: s.mdLoaded, mdShown: s.mdShown, mdRenderedOn: s.mdRenderedOn, bodyHidden: s.bodyHidden, noteText: s.noteText })}`);
    console.log(`      APP OUTPUT (tail): ${app.out.slice(-1500)}`);
    return;
  }
  const d = first.d;
  await sleep(1500);                                                            // anything that was going to run, has
  const d2 = await dom(app);
  const h = d2.headings;
  check('2: headings are real, each with an accent rule on the left and an anchor', h.length >= 2 && h[0].text === 'Guide Title' && h[0].tag === 'H1' && h.every(x => x.ruleLeft === '2px' && x.anchor) && h[1].anchor === 'second-section', JSON.stringify(h));
  check('2: the table is wrapped in its own horizontally scrolling container', d2.tables === 1 && d2.tableWrapped[0] === true);
  check('2: task-list checkboxes render, read-only, the first checked', d2.checkboxes.length === 2 && d2.checkboxes.every(c => c.type === 'checkbox' && c.disabled) && d2.checkboxes[0].checked && !d2.checkboxes[1].checked, JSON.stringify(d2.checkboxes));
  check('2: both drawable Mermaid fences (the plain one and the one asking for securityLevel loose) became SVGs, with their labels', d2.svgs >= 2 && ['Start', 'Choice', 'Done'].every(w => d2.mermaidTexts.some(t => t.includes(w))), JSON.stringify(d2.mermaidTexts));
  check('2: the bad Mermaid fence stays as its source block with "diagram didn\'t render: <reason>" under it, no throw', d2.diagramErrors.length >= 1 && d2.diagramErrors.every(e => /^diagram didn.t render: .{3,}/.test(e)) && d2.fenceBlocks >= 2, JSON.stringify(d2.diagramErrors));
  const kinds = Object.fromEntries(d2.links.map(l => [l.text, `${l.kind}:${l.target}`]));
  check('2: link kinds: files resolve against docs/, http stays http, the rest is inert, the anchor is an anchor',
    kinds.sibling === 'file:docs/other.md' && kinds.parent === 'file:README.md' && kinds['js file'] === 'file:src/app.js' && kinds.web === 'http:https://example.com/page'
    && kinds.mail === 'inert:null' && kinds.js === 'inert:null' && kinds.escape === 'inert:null' && kinds.anchor === 'anchor:second-section' && kinds['js link html'] === 'inert:null', JSON.stringify(kinds));
  check('2: no link carries an href (nothing can navigate natively)', d2.links.every(l => !l.hasHref) && d2.danger.hrefAny === 0);
  const dz = d2.danger;
  check('2: SECURITY: script, iframe, img, style, on* attributes, style attributes, ids and javascript: URLs from the raw HTML are all gone', dz.script === 0 && dz.iframe === 0 && dz.img === 0 && dz.style === 0 && dz.onAttr === 0 && dz.styleAttr === 0 && dz.ids === 0 && dz.jsUrls === 0 && dz.foreign === 0, JSON.stringify(dz));
  check('2: SECURITY: the SVG carries no script, no on* attribute and no link; a diagram cannot lower its own security level', d2.svgDanger.script === 0 && d2.svgDanger.on === 0 && d2.svgDanger.hrefs.length === 0, JSON.stringify(d2.svgDanger));
  check('2: SECURITY: nothing ran (window.__mdPwned unset) and the app\'s own #reader is still the reader, not the page\'s id=reader div', d2.globals.pwned === null && d2.globals.readerStillThere, JSON.stringify(d2.globals));
  check('2: the image became its alt text (nothing fetched)', d2.textLength > 200);
  await shoot(app, '1-rendered');
  await rd(app, 'mdReveal', { index: 0 });
  await sleep(300);
  await shoot(app, '1b-diagram');

  // 3 links
  await rd(app, 'externalProbe', { on: true });
  await rd(app, 'mdLink', { text: 'web' });
  for (const t of ['mail', 'js', 'escape', 'js link html']) await rd(app, 'mdLink', { text: t });
  await sleep(300);
  const opened = (await rd(app, 'externalOpened')).urls;
  check('3: clicking the http link hands exactly that URL to the browser path; mailto, javascript:, a path out of the worktree and the rest do nothing', JSON.stringify(opened) === JSON.stringify(['https://example.com/page']), JSON.stringify(opened));
  const stillThere = await st(app);
  check('3: ...and they did not move the reader off the guide', stillThere.path === 'docs/guide.md' && stillThere.mdShown);
  await rd(app, 'mdLink', { text: 'anchor' });
  await sleep(500);
  const sc = await rd(app, 'mdScroll');
  check('3: the anchor link scrolls the page to that heading', sc.top > 20, JSON.stringify(sc));
  await rd(app, 'externalProbe', { on: false });
  await rd(app, 'mdLink', { text: 'sibling' });
  const other = await waitFor(async () => { const s = await st(app); if (!(s.path === 'docs/other.md' && s.mdShown)) return null; const x = await dom(app); return x.page && x.headings[0] && x.headings[0].text === 'Other' ? x : null; }, 20000);
  check('3: the relative file link opens that file in the reader, rendered', !!other);
  await shoot(app, '2-linked-page');

  // 4 the segment
  await openMd(app, 'docs/guide.md');
  await rd(app, 'setView', { view: 'source' });
  const src = await waitFor(async () => { const s = await st(app); return !s.mdShown && s.mdView === 'source' && s.text.startsWith('# Guide Title') && s.cmMounted && !s.bodyHidden ? s : null; }, 10000);
  check('4: Source shows the code view of the same file (the Markdown text), Source pressed', !!src && src.mdPressed.source === 'true' && src.mdPressed.rendered === 'false');
  await shoot(app, '3-source');
  await openOther(app, 'README.md', '# probe repo');
  const stay = await st(app);
  check('4: the choice sticks for the next Markdown file (README.md opens as Source)', !stay.mdShown && stay.mdView === 'source' && stay.mdSegmentShown);
  await rd(app, 'setView', { view: 'rendered' });
  const back = await waitFor(async () => { const s = await st(app); return s.mdShown && s.mdView === 'rendered' ? s : null; }, 20000);
  check('4: back to Rendered shows the page again', !!back);

  // 5 Edit forces Source
  await openMd(app, 'docs/other.md');
  await rd(app, 'edit');
  const ed = await waitFor(async () => { const s = await st(app); return s.editing ? s : null; }, 8000);
  check('5: Edit forces Source: the page is gone, the editor shows, the segment is hidden', !!ed && !ed.mdShown && !ed.mdSegmentShown && !ed.bodyHidden && ed.text.startsWith('# Other'));
  await rd(app, 'edit');                                                       // Done, clean: no question
  const done = await waitFor(async () => { const s = await st(app); return !s.editing && s.mdShown && s.mdSegmentShown ? s : null; }, 20000);
  check('5: Done brings the rendered page back', !!done);

  // 6 a non-Markdown file again
  const code2 = await openOther(app, 'src/app.js', "'use strict';");
  check('6: a code file again: no segment, no page, the code view', !!code2 && !code2.mdSegmentShown && !code2.mdShown && !code2.bodyHidden);

  console.log(`screenshots: ${shots}`);
  await command(app, { cmd: 'quit' });
  await waitFor(() => app.exited, 10000);
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    killEverything();
    restoreLayout();
    if (!process.env.MARKDOWN_SHOTS) console.log('(screenshots are deleted with the temp folder; set MARKDOWN_SHOTS=<dir> to keep them)');
    try { if (!process.env.MARKDOWN_SHOTS) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
