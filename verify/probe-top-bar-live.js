'use strict';
/* FF12 end to end, in the REAL window, against a REAL `claude` -- no prompt
   is ever sent, so no tokens are spent (/model and /effort are local).

     node verify/probe-top-bar-live.js [outDir]

   Unit tests pin every decision; this is where they meet: the statusLine
   relay the host writes into its settings, the Status event, the liveModel
   broadcast, and renderer.js's requestSwitch in app/renderer.html's actual
   shared global scope (CLAUDE.md: no unit test can see that scope).

   Cases, each ASSERTED, not logged:
     boot      the chip shows the statusLine's model id, not "—"
     effort    a click on "low" over a single-line draft: the draft is
               cleared, not submitted, and the chip confirms "low"
     model     a click on "sonnet": the chip confirms a claude-sonnet-* id
               and the accent turns the sonnet colour
     dialog    with /model's picker open, a click is REFUSED with a notice
               and nothing is typed into the picker
     bad id    a free-typed id with an embedded CR is refused
     user line the user's own statusLine still renders (chained, not lost)

   FIRST RUN, 2026-09-26: 17/17 after two probe fixes. Found on the way:
   <input type=text> strips CR/LF from its value, so Miguel #1's pasted CR
   cannot come through the text box at all (validModelInput is the second
   wall, pinned via requestSwitch); and the full model id wrapped its pill
   into a three-line circle (fixed: .tb-chip white-space: nowrap).

   Safety: ANTHROPIC_API_KEY is deleted from the host's env (so claude uses
   the Max login). /model and /effort save to ~/.claude/settings.json, so every
   settings file they could touch is snapshotted and restored byte for byte.
   ELECTRON_RUN_AS_NODE is deleted for this process and set ONLY for the host
   child, exactly as app/main.js does. */
const { spawn } = require('child_process');
const path = require('path');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: true, env });
  child.on('exit', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const REPO = path.join(__dirname, '..');
const OUT_DIR = process.argv[2] || path.join(REPO, '.harness', 'top-bar-shots');
const PORT = 7841;
const TOKEN = crypto.randomBytes(16).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The native helper is a build artefact; a worktree may not have one. Without
// it the host writes no --settings at all, so there would be no statusLine.
const HELPER = [path.join(REPO, '.harness', 'hook-helper.exe'),
  path.join(REPO, '..', 'claude-custom', '.harness', 'hook-helper.exe')].find(p => fs.existsSync(p));

const guarded = [
  path.join(os.homedir(), '.claude', 'settings.json'),
  path.join(os.homedir(), '.claude', 'settings.local.json'),
  path.join(REPO, '.claude', 'settings.json'),
  path.join(REPO, '.claude', 'settings.local.json'),
];
const snapshot = new Map(guarded.map(f => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]));
function restore() {
  const changed = [];
  for (const [f, before] of snapshot) {
    const now = fs.existsSync(f) ? fs.readFileSync(f) : null;
    if (before === null ? now === null : (now !== null && before.equals(now))) continue;
    changed.push(f);
    if (before === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, before);
  }
  return changed;
}

let host = null;
let hostLog = '';
const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures.push(label);
};
const bail = setTimeout(() => { console.error('TIMED OUT'); finish(2); }, 180000);

async function finish(code) {
  clearTimeout(bail);
  try { if (host) host.kill(); } catch {}
  await sleep(1500);
  const changed = restore();
  console.log(`\nsettings restored: ${changed.length ? changed.join(', ') : 'nothing had changed'}`);
  process.exitCode = code;
  app.quit();
}

app.on('ready', async () => {
  try {
    if (!HELPER) throw new Error('no hook-helper.exe: the host would write no statusLine');
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CUSTOM_PORT: String(PORT),
      CLAUDE_CUSTOM_CWD: REPO, CLAUDE_CUSTOM_TOKEN: TOKEN, CLAUDE_CUSTOM_HELPER: HELPER };
    delete env.ANTHROPIC_API_KEY;
    host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout.on('data', d => { hostLog += d; });
    host.stderr.on('data', d => { hostLog += d; });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const win = new BrowserWindow({
      width: 1300, height: 760, show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(REPO, 'app', 'preload.js') },
    });
    await sleep(2500);
    // NOT awaited: the returned promise never settled here (the page keeps a
    // load in flight), and app/main.js does not await it either.
    win.loadFile(path.join(REPO, 'app', 'renderer.html'),
      { query: { port: String(PORT), token: TOKEN, cwd: REPO } }).catch(() => {});
    const js = src => win.webContents.executeJavaScript(src);
    for (let i = 0; i < 60; i++) {
      try { if (await js(`document.readyState !== 'loading' && typeof requestSwitch === 'function'`)) break; } catch {}
      await sleep(500);
    }
    const chip = id => js(`(() => { const e = document.getElementById('${id}');
      return { text: e.textContent, title: e.title, pending: e.classList.contains('pending'),
               notice: e.classList.contains('notice') }; })()`);
    const screen = () => js(`screenLines().join('\\n')`);
    const shot = async (name) => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), img.toPNG());
    };
    async function until(pred, ms, step = 250) {
      for (let t = 0; t < ms; t += step) { const v = await pred(); if (v) return v; await sleep(step); }
      return null;
    }
    const idle = () => until(async () => (await js(`inputState(screenLines())`)) === 'ready', 20000);

    // --- boot -----------------------------------------------------------------
    const booted = await until(async () => /claude-/.test((await chip('tb-model')).text), 45000, 500);
    check('boot: the model chip shows the statusLine model id', !!booted, (await chip('tb-model')).text);
    check('boot: the host received Status documents', /\[host\] live model/.test(hostLog));
    await idle();
    const startModel = (await chip('tb-model')).text;
    const startEffort = (await chip('tb-effort')).text;
    console.log(`      started on ${startModel} / ${startEffort}`);
    await shot('1-boot');

    // --- effort over a draft -----------------------------------------------------
    await js(`send(JSON.stringify({ type: 'input', data: 'draft words here' })); true`);
    await sleep(800);
    const target = startEffort === 'low' ? 'medium' : 'low';
    await js(`document.getElementById('tb-effort').click();
      document.querySelector('[data-effort="${target}"]').click(); true`);
    const pendingSeen = (await chip('tb-effort')).pending;
    const effortDone = await until(async () => { const c = await chip('tb-effort'); return !c.pending && c.text === target && c; }, 10000);
    check(`effort: a click on "${target}" is confirmed by the live truth`, !!effortDone,
      JSON.stringify(await chip('tb-effort')));
    check('effort: the chip showed PENDING first, never an optimistic flip', pendingSeen);
    const afterEffort = await screen();
    check('effort: the draft was cleared, not submitted as a prompt',
      !/draft words here/.test(afterEffort), afterEffort.split('\n').filter(l => /draft/.test(l)).join(' | '));
    await shot('2-effort');

    // --- model ----------------------------------------------------------------------
    await idle();
    const wantFamily = /sonnet/.test(startModel) ? 'haiku' : 'sonnet';
    await js(`document.getElementById('tb-model').click();
      document.querySelector('[data-model="${wantFamily}"]').click(); true`);
    const modelDone = await until(async () => {
      const c = await chip('tb-model'); return !c.pending && new RegExp(wantFamily).test(c.text) && c;
    }, 10000);
    check(`model: a click on "${wantFamily}" is confirmed with a claude-${wantFamily}-* id`, !!modelDone,
      JSON.stringify(await chip('tb-model')));
    const accent = await js(`getComputedStyle(document.documentElement).getPropertyValue('--model-accent').trim()`);
    const expected = { sonnet: '#4c8bf5', haiku: '#4caf6a' }[wantFamily];
    check(`model: the accent is the ${wantFamily} colour`, accent.toLowerCase() === expected, accent);
    await shot('3-model');

    // --- dialog -----------------------------------------------------------------------
    await idle();
    await js(`send(JSON.stringify({ type: 'input', data: '/model' })); true`);
    await sleep(300);
    await js(`send(JSON.stringify({ type: 'input', data: '\\r' })); true`);
    const dialogOpen = await until(async () => (await js(`inputState(screenLines())`)) === 'dialog', 8000);
    check('dialog: bare /model opens a picker the harness recognises', !!dialogOpen);
    const beforeClick = (await chip('tb-effort')).text;
    await js(`document.getElementById('tb-effort').click();
      document.querySelector('[data-effort="high"]').click(); true`);
    await sleep(1500);
    const refused = await chip('tb-effort');
    check('dialog: the click is refused with a notice, not typed into the picker',
      refused.notice && /dialog/.test(refused.title) && !refused.pending && refused.text === beforeClick,
      JSON.stringify(refused));
    const stillOpen = (await js(`inputState(screenLines())`)) === 'dialog';
    check('dialog: the picker is still open, untouched by the refused click', stillOpen);
    await shot('4-dialog-refused');
    await js(`send(JSON.stringify({ type: 'input', data: '\\x1b' })); true`);   // ONE Esc
    await idle();

    // --- the user's own status line (read while the box is idle) ----------------
    const lines = (await screen()).split('\n');
    const rules = lines.map((l, i) => (/^─{10,}$/.test(l.trim()) ? i : -1)).filter(i => i >= 0);
    check('user line: the input box is on screen to read under', rules.length >= 2);
    const below = rules.length >= 2 ? lines.slice(rules[rules.length - 1] + 1).filter(l => l.trim()) : [];
    console.log('      under the input box:\n' + below.map(l => '        | ' + l).join('\n'));
    check("user line: something renders under the box besides the mode line",
      below.some(l => !/⏵|permissions|shift\+tab|Transcript saving/i.test(l)));

    // --- bad free-text ids ----------------------------------------------------------
    // MEASURED on the first run: <input type=text> strips CR/LF from its value,
    // so 'sonnet\r/exit' typed there arrives as 'sonnet/exit' -- a legal-looking
    // id. The CR case is therefore driven through requestSwitch itself, and the
    // text box gets a character that DOES survive it (a space).
    const typed = async (value) => {
      await js(`document.getElementById('tb-model').click();
        document.getElementById('tb-model-custom').value = ${JSON.stringify(value)};
        document.getElementById('tb-model-custom-go').click(); true`);
      await sleep(500);
      return chip('tb-model');
    };
    const spaced = await typed('sonnet exit');
    check('bad id: a typed id with a space is refused', spaced.notice && /model id/.test(spaced.title), spaced.title);
    const cr = await js(`document.getElementById('tb-model-custom').value = 'a\\rb';
      document.getElementById('tb-model-custom').value`);
    check('bad id: the text box itself strips a CR (defence one)', !/\r/.test(cr), JSON.stringify(cr));
    await js(`requestSwitch('model', 'sonnet\\r/exit'); true`);
    await sleep(500);
    const direct = await chip('tb-model');
    check('bad id: requestSwitch refuses an embedded CR (defence two)',
      direct.notice && /model id/.test(direct.title) && !direct.pending, direct.title);
    await sleep(1500);
    check('bad id: the session is still alive (no /exit ran)', !/claude exited/i.test(hostLog));

    console.log(`\nshots: ${path.resolve(OUT_DIR)}`);
    await finish(failures.length ? 1 : 0);
    if (failures.length) console.log(`\n${failures.length} FAILED: ${failures.join('; ')}`);
  } catch (err) {
    console.error('probe failed:', err && err.stack);
    console.error('--- host log tail ---\n' + hostLog.split('\n').slice(-30).join('\n'));
    await finish(1);
  }
});
