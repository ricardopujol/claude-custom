'use strict';
/**
 * The roster's two names, Role/Name toggle and search, RENDERED (BACKLOG #76).
 *
 * WHY A PROBE. The unit tests prove the decisions (app/roster-search-display.js, host/roster-index.js). They cannot
 * prove that the real renderer, loaded as plain <script> tags in one shared scope, draws both names on the Active and
 * Inactive cards, switches them with the toggle, filters by a query, and says so when nothing matches. CLAUDE.md:
 * "No unit test can see this. Render it in a real window."
 *
 * SAFE TO RUN. No host and no `claude`: the page is handed a fixed roster through its own globals, so nothing starts and
 * nothing is billed. The toggle's store and Electron's userData are throwaway temp folders. Screenshots go to the folder
 * named by SHOTS (default: a temp folder, printed at the end).
 *
 * HEAVY: take ~/.claude/scripts/heavy-lock.ps1 before running it.
 *
 *   node verify/probe-roster-search.js        (exit 0 = every check passed)
 */
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createHygieneRegistry } = require('./lib/process-hygiene');

const ROOT = path.join(__dirname, '..');
const hygiene = createHygieneRegistry();
hygiene.install();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-roster-search-probe-'));
const shots = process.env.SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };

const mainSource = () => `
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path'); const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const { registerAvatarHandlers } = require(path.join(ROOT, 'app', 'avatar-bridge'));
const { createStore } = require(path.join(ROOT, 'host', 'store'));
app.setPath('userData', ${JSON.stringify(path.join(tmp, 'userData'))});
const SHOTS = ${JSON.stringify(shots)};
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log('[check]', ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 760, show: true, webPreferences: {
    contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'app', 'preload.js') } });
  registerAvatarHandlers({ ipcMain, store: createStore({ dir: ${JSON.stringify(path.join(tmp, 'state'))} }), win, dialog });
  win.loadFile(path.join(ROOT, 'app', 'renderer.html'), { query: { port: '1', cwd: ${JSON.stringify(tmp)}, project: 'probe', token: 'probe-token' } });
  win.webContents.on('console-message', (_e, level, message, line, src) => { if (level >= 2) console.log('[page]', message, src + ':' + line); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await js(code); if (v) return v; } catch (e) { /* page not ready */ } await sleep(150); }
    return null;
  };
  const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(SHOTS, name + '.png'), img.toPNG()); };
  const names = () => js('[...document.querySelectorAll("#agents .agent")].map(a => ({ big: (a.querySelector(".name").childNodes[0] || {}).textContent, alt: (a.querySelector(".name-alt") || {}).textContent || null, fn: (a.querySelector(".agent-fn") || {}).textContent || null, fnTitle: (a.querySelector(".agent-fn") || {}).title || null }))');
  const text = () => js('document.getElementById("agents").textContent');

  try {
    check('the renderer script loaded', await until('typeof renderRoster === "function" && !!window.rosterSearchDisplay'));
    await js('document.querySelector("[data-panel=agents]") && document.getElementById("panel-store")');
    // A fixed roster: two active agents (one with no persona), three inactive.
    await js(\`(() => {
      const mk = (agent, persona, fn, tokens) => ({ agent, persona, fn, tokens, portrait: null, resolved: true, unreadable: false });
      rosterIndexPayload = { ok: true, complete: true, unreadable: 0, agents: [
        mk('code-reviewer', 'Miguel', 'Elite code reviewer specializing in code quality, security vulnerabilities, performance, and best practices across a very long line that must clamp.', 5e6),
        mk('general-purpose', null, null, 2e6),
        mk('dead-code-sweeper', 'Murray Bones', 'Read-only dead-code sweeper.', 4e5),
        mk('qa-expert', 'Naomi', 'Senior QA Automation Engineer and UX Researcher.', 3e5),
        mk('fullstack-developer', 'Guillaume', 'Build complete features spanning database, API, and frontend layers together as a cohesive unit.', null),
      ] };
      roster.set('code-reviewer', { agent: 'code-reviewer', state: 'working', portrait: null });
      roster.set('general-purpose', { agent: 'general-purpose', state: 'sleeping', portrait: null });
      renderRoster();
    })()\`);
    await sleep(600);

    // ---- Active tab, role mode ------------------------------------------------
    let n = await names();
    check('Active: two cards', n.length === 2, n);
    const cr = n.find(x => x.big === 'code-reviewer');
    check('Active, role mode: the role is big and the persona small beside it', cr && cr.alt === 'Miguel', cr);
    const gp = n.find(x => x.big === 'general-purpose');
    check('Active: an agent with no persona shows the role only (no second name, no function)', gp && gp.alt === null && gp.fn === null, gp);
    check('Active: the function line is drawn with the full text in its title', cr && cr.fn && cr.fnTitle === cr.fn, cr);
    const clamp = await js('(() => { const f = document.querySelector("#agents .agent-fn"); const cs = getComputedStyle(f); return { clamp: cs.webkitLineClamp, h: f.getBoundingClientRect().height, lh: parseFloat(cs.lineHeight) }; })()');
    check('the function line is clamped to two lines', clamp.clamp === '2' && clamp.h <= clamp.lh * 2 + 1, clamp);
    await shot('1-active-role');

    // ---- the toggle -------------------------------------------------------------
    await js('document.querySelector("#roster-names-toggle [data-roster-names=name]").click()');
    check('the Name toggle reaches main and comes back', await until('rosterNamesMode === "name"'));
    n = await names();
    check('Active, name mode: the persona is big and the role small', n.some(x => x.big === 'Miguel' && x.alt === 'code-reviewer'), n);
    check('Active, name mode: no persona, role only', n.some(x => x.big === 'general-purpose' && x.alt === null), n);
    check('main stores the mode', (await js('window.harness.avatar.getRosterNames()')) === 'name');
    await shot('2-active-name');

    // ---- Inactive ---------------------------------------------------------------
    await js('setRosterTab("inactive")');
    await sleep(400);
    n = await names();
    check('Inactive, name mode: three cards, personas big', n.length === 3 && n.every(x => x.alt !== null), n);
    check('Inactive: Murray Bones (two words) is one name', n.some(x => x.big === 'Murray Bones' && x.alt === 'dead-code-sweeper'), n);
    await shot('3-inactive-name');
    await js('document.querySelector("#roster-names-toggle [data-roster-names=role]").click()');
    check('back to role mode', await until('rosterNamesMode === "role"'));
    n = await names();
    check('Inactive, role mode: roles big', n.some(x => x.big === 'qa-expert' && x.alt === 'Naomi'), n);
    await shot('4-inactive-role');

    // ---- search -----------------------------------------------------------------
    check('the search field starts closed', await js('document.getElementById("roster-search-row").hidden === true'));
    await js('document.getElementById("roster-search-btn").click()');
    check('the search button opens the field and focuses it', await until('!document.getElementById("roster-search-row").hidden && document.activeElement === document.getElementById("roster-search")'));
    const setQ = (q) => js('(() => { const i = document.getElementById("roster-search"); i.value = ' + JSON.stringify(q) + '; i.dispatchEvent(new Event("input", { bubbles: true })); })()');
    await setQ('NAOMI');
    await sleep(300);
    n = await names();
    check('Inactive search "NAOMI" (persona, any case): one card', n.length === 1 && n[0].alt === 'Naomi', n);
    await shot('5-inactive-search-hit');
    await setQ('sweeper');
    await sleep(200);
    n = await names();
    check('search matches the role too ("sweeper")', n.length === 1 && n[0].big === 'dead-code-sweeper', n);
    await setQ('database');
    await sleep(200);
    n = await names();
    check('search matches the function text ("database")', n.length === 1 && n[0].big === 'fullstack-developer', n);
    await setQ('zzzz');
    await sleep(200);
    const empty = await text();
    check('empty result names the tab, the query and the other tab', empty.trim() === 'No inactive agent matches “zzzz”. Try the active tab.', empty);
    await shot('6-inactive-search-empty');
    await js('setRosterTab("active")');
    await sleep(300);
    const emptyA = await text();
    check('the same query on the Active tab filters that tab', emptyA.trim() === 'No active agent matches “zzzz”. Try the inactive tab.', emptyA);
    await setQ('miguel');
    await sleep(200);
    n = await names();
    check('Active search "miguel" finds the reviewer', n.length === 1 && n[0].big === 'code-reviewer', n);
    await shot('7-active-search-hit');
    await js('document.getElementById("roster-search").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await sleep(300);
    check('Esc closes the field', await js('document.getElementById("roster-search-row").hidden === true'));
    check('Esc clears the query and the full tab is back', (await js('document.getElementById("roster-search").value === "" && rosterQuery === ""')) && (await names()).length === 2);
  } catch (err) {
    check('probe ran to completion', false, String(err && err.stack || err));
  }
  console.log('[result]', JSON.stringify({ failed: results.filter(r => !r.ok).length, total: results.length }));
  app.exit(results.every(r => r.ok) ? 0 : 1);
});
`;

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const mainFile = path.join(tmp, 'probe-main.js');
  fs.writeFileSync(mainFile, mainSource());
  const electron = spawnElectron(require('electron'), [mainFile], { cwd: ROOT, env }, { keepEnv: [] });
  hygiene.registerChild(electron);
  electron.stdout.on('data', d => { process.stdout.write(d); });
  electron.stderr.on('data', d => { if (/probe|Error/.test(String(d))) process.stderr.write(d); });
  const killer = setTimeout(() => { console.log('FAIL: probe timed out after 90s'); hygiene._emergencyCleanup('timeout'); }, 90000);
  const code = await new Promise((resolve) => electron.on('exit', resolve));
  clearTimeout(killer);
  hygiene._emergencyCleanup('done');
  console.log('screenshots:', shots);
  if (!process.env.SHOTS) cleanup();
  console.log(code === 0 ? 'PASS: the roster search renders as designed' : `FAIL: exit ${code}`);
  process.exit(code === 0 ? 0 : 1);
})().catch((err) => {
  console.log('FAIL: probe could not start:', err && err.message);
  hygiene._emergencyCleanup('startup-failed');
  cleanup();
  process.exit(1);
});
