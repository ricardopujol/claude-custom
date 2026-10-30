'use strict';
/* BACKLOG #136: pasting a document sends what was typed before it. Real window, real `claude`.

     node verify/probe-paste-doc.js [long] [midturn] [menu] [file] [drop] [grant] [redraw]     (no argument = all)

   Types a draft ("DRAFT-BEFORE") into the prompt without Enter, pastes or drops a document, then reads the screen:
   did the draft stay in the prompt (good), or was it submitted (a "> DRAFT-BEFORE" turn above an empty prompt, or the
   spinner)? Exits 1 and prints FAILED: <cases> if any case submitted the draft, sent a raw-CR paste, or (grant cases)
   never reached the CLI's "Add directory" dialog. A submit is interrupted with Esc so it spends next to nothing.
   `grant` is the #136 regression: a drop from outside the project onto a short, 3-row, 6-row, taller-than-the-box,
   hard-newline and cursor-mid-draft draft (PR #223, host/grant-sequence.js).

   Same safety as probe-paste.js: the clipboard is snapshotted and restored, ELECTRON_RUN_AS_NODE is only set for
   the host child, only the PIDs this probe started are killed. */
const { spawn, execFileSync } = require('child_process');
const { spawnElectron, noteChild } = require('./lib/launch-electron');
const path = require('path');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const userData = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'probe-paste-doc-'));
  const child = spawnElectron(require('electron'), [__filename, `--user-data-dir=${userData}`, ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: true, env }, { keepEnv: ['CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_HELPER', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_TOKEN'] });
  child.on('exit', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow, clipboard } = require('electron');
const crypto = require('crypto');
const fs = require('fs');

const REPO = path.join(__dirname, '..');
const PORT = 7853;
const TOKEN = crypto.randomBytes(16).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const at = () => `${Math.round((Date.now() - T0) / 1000)}s`;
const HELPER = [path.join(REPO, '.harness', 'hook-helper.exe'),
  path.join(REPO, '..', '..', '..', '.harness', 'hook-helper.exe')].find(p => fs.existsSync(p));

const saved = { text: clipboard.readText() };
let host = null;
let hostLog = '';
const results = {};
const failures = [];
const bail = setTimeout(() => { console.error(`TIMED OUT at ${at()}`); finish(2); }, 900000);

async function finish(code) {
  clearTimeout(bail);
  try { clipboard.clear(); if (saved.text) clipboard.writeText(saved.text); } catch {}
  try { if (host) host.kill(); } catch {}
  console.log('--- host grant/drop lines ---\n' + hostLog.split('\n').filter(l => /\[host\] (grant|drop)/.test(l)).join('\n'));
  console.log('\n=== RESULTS ===\n' + JSON.stringify(results, null, 2));
  await sleep(1000);
  app.exit(code);   // app.quit() ends with 0 whatever process.exitCode says; a probe with a verdict must exit with it
}

const doc = n => Array.from({ length: n }, (_, i) => `DOC-LINE-${i + 1} lorem ipsum dolor sit amet consectetur`).join('\n');

app.on('ready', async () => {
  try {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CUSTOM_PORT: String(PORT),
      CLAUDE_CUSTOM_CWD: REPO, CLAUDE_CUSTOM_TOKEN: TOKEN };
    if (HELPER) env.CLAUDE_CUSTOM_HELPER = HELPER;
    delete env.ANTHROPIC_API_KEY;
    host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    noteChild(host);
    host.stdout.on('data', d => { hostLog += d; });
    host.stderr.on('data', d => { hostLog += d; });

    const win = new BrowserWindow({
      width: 1200, height: 760, show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
        preload: path.join(REPO, 'app', 'preload.js') },
    });
    require(path.join(REPO, 'app', 'clipboard-bridge.js')).registerClipboardHandlers({ ipcMain: require('electron').ipcMain, clipboard, win });
    // The renderer asks main synchronously at startup; with no answer the page blocks for good.
    require('electron').ipcMain.on('resources:chipOn', (e) => { e.returnValue = false; });
    await sleep(2500);
    win.loadFile(path.join(REPO, 'app', 'renderer.html'), { query: { port: String(PORT), token: TOKEN, cwd: REPO } }).catch(() => {});

    const js = src => Promise.race([
      win.webContents.executeJavaScript(src),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`page call hung: ${src.slice(0, 60)}`)), 45000)),
    ]);
    async function until(pred, ms, step = 250) {
      for (let t = 0; t < ms; t += step) { const v = await pred(); if (v) return v; await sleep(step); }
      return null;
    }
    win.webContents.on('console-message', (e, level, message) => {
      if (level >= 2) console.log(`      [page ${level === 3 ? 'error' : 'warn'}] ${String(message).slice(0, 300)}`);
    });
    win.webContents.on('did-fail-load', (e, code, desc) => console.log(`      [load failed] ${code} ${desc}`));
    const up = await until(async () => { try { return await js(`typeof screenLines === 'function'`); } catch { return false; } }, 30000, 500);
    console.log(`[${at()}] page ${up ? 'is up' : 'DID NOT LOAD'}\n${hostLog.split('\n').slice(-8).join('\n')}`);
    await js(`window.__frames = [];
      const __send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { window.__frames.push(String(d)); return __send.call(this, d); };
      true`);
    const frames = async () => js(`window.__frames.splice(0)`);
    const screen = async () => (await js(`screenLines().join('\\n')`));
    const typeRaw = d => js(`send(${JSON.stringify(d)}); true`);
    const esc = s => JSON.stringify(s).replace(/\\u001b/g, '\\x1b').slice(0, 200);

    const ready = await until(async () => /─{10,}/.test(await screen()), 60000, 500);
    console.log(`[${at()}] claude ${ready ? 'is up' : 'DID NOT COME UP'}`);
    if (!ready) throw new Error('claude never drew its input box');
    await sleep(3000);

    // `direct` skips Ctrl+V and types the same bracketed bytes straight to the pty: if the CLI behaves the same,
    // the paste path is not ours. `watch` logs the prompt box at 1, 3 and 9 s after the paste.
    async function pasteCase(name, draft, text, { file = null, dropFile = null, direct = false, draftFirst = false, pre = null, after = null, settle = 0, typeDraft = null, expect = null } = {}) {
      await frames();
      const putDraft = async () => { if (typeDraft) await typeDraft(); else await typeRaw(draft); await sleep(800); };
      if (draft && draftFirst) await putDraft();
      if (pre) await pre();
      if (draft && !draftFirst) await putDraft();
      if (settle) await sleep(settle);
      if (file) {
        // A real file on the clipboard, as Explorer's Copy leaves it (CF_HDROP): no text, no bitmap.
        execFileSync('powershell.exe', ['-NoProfile', '-Command', `Set-Clipboard -Path '${file}'`], { windowsHide: true });
        console.log(`   [${name}] clipboard text="${clipboard.readText()}" formats=${JSON.stringify(clipboard.availableFormats())}`);
      } else clipboard.writeText(text);
      win.focus(); win.webContents.focus();
      await js(`term.focus(); true`);
      const bracketed = await js(`term.modes.bracketedPasteMode`);
      if (dropFile) {
        // The renderer's drop handler ends in exactly this frame (userInput of {type:'drop', entries}); a native
        // drag cannot be driven from here, so this drives the host half, which is where the pty bytes are decided.
        await typeRaw(JSON.stringify({ type: 'drop', entries: [{ path: dropFile, isDirectory: false }] }));
        // The host clears the box key by key and reads the screen back before the Enter (host/grant-sequence.js): up to ~15 s for a tall draft.
        for (let t = 0; t < 25000; t += 500) { await sleep(500); if (/Add directory to workspace/.test(await screen())) break; }
      } else if (direct) {
        await typeRaw('\x1b[200~' + text.replace(/\r?\n/g, '\r') + '\x1b[201~');
      } else {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
      }
      for (const wait of [1000, 2000, 5000]) {
        await sleep(wait);
        const l = (await screen()).split('\n').filter(x => x.trim());
        console.log(`   [${name} +${wait}ms] ${JSON.stringify(l.slice(-6, -2))}`);
      }
      const f = await frames();
      const scr = await screen();
      const lines = scr.split('\n').filter(l => l.trim());
      // A submitted draft shows as a user turn ("> DRAFT-BEFORE") with the spinner/ a reply following it.
      // The prompt box is what follows the last-but-one rule line; a draft above it was sent (or is queued).
      const rules = lines.map((l, i) => /^─{10,}/.test(l) ? i : -1).filter(i => i >= 0);
      const box = rules.length >= 2 ? lines.slice(rules[rules.length - 2], rules[rules.length - 1]) : lines.slice(-6);
      const draftInBox = box.some(l => l.includes('DRAFT-BEFORE'));
      const draftOnScreen = lines.some(l => l.includes('DRAFT-BEFORE'));
      const submitted = !!draft && draftOnScreen && !draftInBox;
      // A frame that carries text with a CR but no bracket start is the raw path: an Enter per line.
      const rawCr = f.some(x => { try { const d = JSON.parse(x).data; return /\r/.test(d) && !d.startsWith('\x1b[200~'); } catch { return false; } });
      // A verdict, not just a printout: nothing the person typed may have reached the model, and a grant must have got as far as the
      // CLI's own "Add directory" dialog (the Enter went out on a read-back that matched).
      const dialogSeen = /Add directory to workspace/.test(scr);
      const ok = !submitted && !rawCr && (expect !== 'dialog' || dialogSeen);
      if (!ok) failures.push(name);
      results[name] = { ok, bracketedModeWas: bracketed, frameCount: f.length, rawCr, draftInBox, dialogSeen,
        frames: f.map(esc), submitted, tail: lines.slice(-14) };
      console.log(`[${at()}] ${ok ? 'PASS' : 'FAIL'} ${name} bracketed=${bracketed} frames=${f.length} rawCr=${rawCr} draftInBox=${draftInBox} dialog=${dialogSeen} submitted=${submitted}`);
      if (after) await after();
      // A drop's own dialog is answered by this Esc; the host then types the dropped path (its chain waits for the prompt), so give it
      // the time, or that text lands in the NEXT case's draft.
      await typeRaw('\x1b'); await sleep(dropFile ? 4000 : 600);          // interrupt, if a turn started
      await typeRaw('\x1b'); await sleep(600);          // and leave a menu
      await typeRaw('\x7f'.repeat(400)); await sleep(1500);   // clear the draft (a pasted block goes in one backspace)
      await frames();
    }

    const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const want = n => !only.length || only.includes(n);
    if (want('long')) {
      await pasteCase('long-with-draft', 'DRAFT-BEFORE', doc(60));
      await pasteCase('long-direct', 'DRAFT-BEFORE', doc(60), { direct: true });
      await pasteCase('huge-with-draft', 'DRAFT-BEFORE', doc(1200));
    }
    // Where bracketed mode might be off at paste time (BACKLOG #136): mid-turn, on a menu, right after a redraw.
    if (want('midturn')) {
      await pasteCase('mid-turn', 'DRAFT-BEFORE', doc(5), { settle: 500,
        pre: async () => { await typeRaw('Count from 1 to 300, one number per line, no other words.'); await sleep(500); await typeRaw('\r'); await sleep(3500); } });
    }
    if (want('menu')) {
      await pasteCase('menu-model', '', doc(5), { settle: 500,
        pre: async () => { await typeRaw('/model'); await sleep(600); await typeRaw('\r'); await sleep(2500); } });
      await pasteCase('menu-config', '', doc(5), { settle: 500,
        pre: async () => { await typeRaw('/config'); await sleep(600); await typeRaw('\r'); await sleep(2500); } });
    }
    // A document from outside the project (Explorer copy / drag-drop), onto a tab with a draft: BACKLOG #136.
    if (want('file') || want('drop')) {
      const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'paste-doc-'));
      const docFile = path.join(dir, 'notes.md');
      fs.writeFileSync(docFile, '# Notes\n\nA document.\n');
      const longDraft = 'DRAFT-BEFORE ' + 'word '.repeat(70);   // wraps onto three rows
      const busy = async () => { await typeRaw('Count from 1 to 300, one number per line, no other words.'); await sleep(500); await typeRaw('\r'); await sleep(3500); };
      if (want('file')) {
        await pasteCase('file-idle', 'DRAFT-BEFORE', '', { file: docFile });
        await pasteCase('file-midturn', 'DRAFT-BEFORE', '', { file: docFile, pre: busy, settle: 500 });
      }
      if (want('drop')) {
        await pasteCase('drop-idle-short-draft', 'DRAFT-BEFORE', '', { dropFile: docFile });
        await pasteCase('drop-idle-wrapped-draft', longDraft, '', { dropFile: docFile });
        await pasteCase('drop-midturn', 'DRAFT-BEFORE', '', { dropFile: docFile, pre: busy, settle: 500 });
      }
    }
    // A drop from a folder OUTSIDE the project that needs a grant: the host clears the prompt, types `/add-dir <dir>` and presses Enter
    // only when the screen reads back as exactly that line (BACKLOG #136, PR #223). The scratch dir above lives under AppData, which
    // the drop guard refuses, so these drop the main checkout's CLAUDE.md, a sibling of this worktree. Each case: nothing the person
    // typed may reach the model, and the CLI's "Add directory" dialog must open.
    const gwant = n => want('grant') || only.includes(n);
    if (want('grant') || only.some(a => a.startsWith('grant-'))) {
      // One DIFFERENT outside folder per case: the host remembers a folder it already asked for (grantedDirs), so a second drop from
      // the same folder types only the path and never grants again.
      const outsideFiles = ['CLAUDE.md', 'host/drop.js', 'app/main.js', 'test/drop.test.js', 'verify/README.md', 'scripts/usage-report.js']
        .map(f => path.resolve(path.join(REPO, '..', 'dev', f)));
      for (const f of outsideFiles) if (!fs.existsSync(f)) throw new Error(`no ${f} to drop`);
      const outsideOf = n => outsideFiles[['grant-short-draft', 'grant-3-rows', 'grant-6-rows', 'grant-taller-than-box', 'grant-newline-draft', 'grant-cursor-mid-draft'].indexOf(n)];
      const cols = await js('term.cols');
      const termRows = await js('term.rows');
      const cap = Math.max(1, Math.floor(termRows / 2) - 5);
      const rowsOf = n => 'DRAFT-BEFORE ' + 'word '.repeat(Math.ceil(((n - 1) * cols + 20) / 5));
      console.log(`   [grant] cols=${cols} termRows=${termRows} box cap=${cap}`);
      if (gwant('grant-short-draft')) await pasteCase('grant-short-draft', 'DRAFT-BEFORE', '', { dropFile: outsideOf('grant-short-draft'), expect: 'dialog' });
      if (gwant('grant-3-rows')) await pasteCase('grant-3-rows', rowsOf(3), '', { dropFile: outsideOf('grant-3-rows'), expect: 'dialog' });
      if (gwant('grant-6-rows')) await pasteCase('grant-6-rows', rowsOf(6), '', { dropFile: outsideOf('grant-6-rows'), expect: 'dialog' });
      if (gwant('grant-taller-than-box')) await pasteCase('grant-taller-than-box', rowsOf(cap + 10), '', { dropFile: outsideOf('grant-taller-than-box'), expect: 'dialog' });
      // A real newline in the draft (backslash + Enter), which Ctrl-U does not cross as a wrapped row.
      if (gwant('grant-newline-draft')) await pasteCase('grant-newline-draft', 'DRAFT-BEFORE', '', { dropFile: outsideOf('grant-newline-draft'), expect: 'dialog',
        typeDraft: async () => { await typeRaw('DRAFT-BEFORE first line'); await sleep(300); await typeRaw('\\'); await sleep(200); await typeRaw('\r'); await sleep(300); await typeRaw('second line'); } });
      // The cursor moved back into the draft before the drop.
      if (gwant('grant-cursor-mid-draft')) await pasteCase('grant-cursor-mid-draft', 'DRAFT-BEFORE', '', { dropFile: outsideOf('grant-cursor-mid-draft'), expect: 'dialog',
        typeDraft: async () => { await typeRaw('DRAFT-BEFORE the rest of a sentence'); await sleep(300); await typeRaw('\x1b[D'.repeat(12)); } });
    }
    if (want('redraw')) {
      await pasteCase('after-resize', 'DRAFT-BEFORE', doc(5), { draftFirst: true,
        after: async () => { win.setSize(1200, 760); await sleep(500); },
        pre: async () => { win.setSize(900, 600); await sleep(250); } });
    }
    console.log(failures.length ? 'FAILED: ' + failures.join(', ') : 'ALL CASES PASSED');
    await finish(failures.length ? 1 : 0);
  } catch (err) {
    console.error('probe failed:', err && err.stack);
    console.error('--- host log tail ---\n' + hostLog.split('\n').slice(-30).join('\n'));
    await finish(1);
  }
});
