'use strict';
/* BACKLOG #136: pasting a document sends what was typed before it. Real window, real `claude`.

     node verify/probe-paste-doc.js

   Types a draft ("DRAFT-BEFORE") into the prompt without Enter, pastes a document through the shipped Ctrl+V path,
   then reads the screen: did the draft stay in the prompt (good), or was it submitted (a "> DRAFT-BEFORE" turn
   above an empty prompt, or the spinner)? Cases: a short two-line paste and a long document, both with and
   without a draft. A submit is interrupted with Esc so it spends next to nothing.

   Same safety as probe-paste.js: the clipboard is snapshotted and restored, ELECTRON_RUN_AS_NODE is only set for
   the host child, only the PIDs this probe started are killed. */
const { spawn } = require('child_process');
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
const bail = setTimeout(() => { console.error(`TIMED OUT at ${at()}`); finish(2); }, 240000);

async function finish(code) {
  clearTimeout(bail);
  try { clipboard.clear(); if (saved.text) clipboard.writeText(saved.text); } catch {}
  try { if (host) host.kill(); } catch {}
  console.log('\n=== RESULTS ===\n' + JSON.stringify(results, null, 2));
  await sleep(1000);
  process.exitCode = code;
  app.quit();
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
      new Promise((_, reject) => setTimeout(() => reject(new Error(`page call hung: ${src.slice(0, 60)}`)), 10000)),
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
    async function pasteCase(name, draft, text, { direct = false } = {}) {
      await frames();
      if (draft) { await typeRaw(draft); await sleep(800); }
      clipboard.writeText(text);
      win.focus(); win.webContents.focus();
      await js(`term.focus(); true`);
      const bracketed = await js(`term.modes.bracketedPasteMode`);
      if (direct) {
        await typeRaw('\x1b[200~' + text.replace(/\r?\n/g, '\r') + '\x1b[201~');
      } else {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
      }
      for (const wait of [1000, 2000, 6000]) {
        await sleep(wait);
        const l = (await screen()).split('\n').filter(x => x.trim());
        console.log(`   [${name} +${wait}ms] ${JSON.stringify(l.slice(-6, -2))}`);
      }
      const f = await frames();
      const scr = await screen();
      const lines = scr.split('\n').filter(l => l.trim());
      // A submitted draft shows as a user turn ("> DRAFT-BEFORE") with the spinner/ a reply following it.
      const submitted = !!draft && lines.some(l => /^\s*>\s*DRAFT-BEFORE/.test(l)) && !/─{10,}\s*\n?\s*>\s*DRAFT-BEFORE/.test(scr);
      results[name] = { bracketedModeWas: bracketed, frameCount: f.length,
        frames: f.map(esc), submitted, tail: lines.slice(-14) };
      console.log(`[${at()}] ${name} bracketed=${bracketed} frames=${f.length} submitted=${submitted}`);
      await typeRaw('\x1b'); await sleep(600);          // interrupt, if a turn started
      await typeRaw('\x7f'.repeat(60)); await sleep(1500);   // clear the draft (a pasted block goes in one backspace)
      await frames();
    }

    await pasteCase('long-with-draft', 'DRAFT-BEFORE', doc(60));
    await pasteCase('long-direct', 'DRAFT-BEFORE', doc(60), { direct: true });
    await pasteCase('huge-with-draft', 'DRAFT-BEFORE', doc(1200));
    await finish(0);
  } catch (err) {
    console.error('probe failed:', err && err.stack);
    console.error('--- host log tail ---\n' + hostLog.split('\n').slice(-30).join('\n'));
    await finish(1);
  }
});
