'use strict';
/**
 * claude-custom :: Electron main  (SPIKE — step 0 walking skeleton)
 *
 * Deliberately thin. The window is a pure view; all session state lives in the
 * host process. Main's only jobs are: make sure a host is listening, and open a
 * window pointed at it.
 */

const { app, BrowserWindow, Notification, clipboard, ipcMain, safeStorage, shell } = require('electron');
const { createVault } = require('./secret-vault');
const { createSecretService } = require('./secret-service');
const { registerClipboardHandlers } = require('./clipboard-bridge');
const { registerFavouriteHandlers } = require('./favourites-bridge');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { projectLabel } = require('../host/project-path');

const { resolvePort } = require('../host/port-for-project');
const { decideAttach } = require('../host/handshake');
const { readIdentity } = require('../host/host-identity');
const { readLook } = require('../host/style');
const { sanitizeDim } = require('../host/look');
const { createStore } = require('../host/store');

// Install-wide UI state that belongs to no one project: today only how dark an
// unfocused window gets. The same .harness/state the host's store uses, under
// its own key, so neither side can clobber the other's file.
const uiStore = createStore({ dir: path.join(__dirname, '..', '.harness', 'state') });
const UI_KEY = 'look-global';
const readDim = () => sanitizeDim((uiStore.read(UI_KEY, {}) || {}).unfocusedDim);

// Resolved in whenReady, because choosing it needs to probe. An explicit
// CLAUDE_CUSTOM_PORT is honoured exactly and never stepped: someone who names a
// port means that port, and quietly moving them to another one would be the
// same class of silent substitution this whole change removes.
// PARSED STRICTLY. Dexter F10: `Number(x) || null` turns CLAUDE_CUSTOM_PORT=7742x
// into NaN into null, and the port is then DERIVED with no message -- which is
// the silent substitution the comment above says this whole change removes.
// `=0` was swallowed the same way and `=0x1e1a` was accepted as 7706.
function explicitPort() {
  const raw = process.env.CLAUDE_CUSTOM_PORT;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`[main] CLAUDE_CUSTOM_PORT is not a port: ${JSON.stringify(raw)}`);
    console.error('[main] refusing to guess -- unset it to derive the port from the project');
    return { bad: raw };
  }
  return n;
}
const EXPLICIT_PORT = explicitPort();
let PORT = null;

// One secret, handed to both children. Main spawns the host AND owns the
// window, so it is the only place that can give them the same value without
// either having to go looking for it.
//
// A reattaching window (the host was already running) reads the token the host
// wrote, because that host generated its own.
const SESSION_TOKEN = process.env.CLAUDE_CUSTOM_TOKEN
  || require('crypto').randomBytes(24).toString('hex');

// The token of the host on THIS port, preferred over the shared file, which is
// last-writer-wins once a second project is open. Falling back to the shared
// one keeps a host started before this change reattachable.
function tokenForRunningHost() {
  try {
    return fs.readFileSync(
      path.join(__dirname, '..', '.harness', 'hosts', `${PORT}.token`), 'utf8').trim();
  } catch { /* fall through to the shared file */ }
  try {
    return fs.readFileSync(path.join(__dirname, '..', '.harness', 'session-token'), 'utf8').trim();
  } catch {
    return SESSION_TOKEN;
  }
}
const PROJECT_CWD = process.env.CLAUDE_CUSTOM_CWD || process.cwd();

function isHostListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (result) => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(400);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

const HARNESS_DIR = path.join(__dirname, '..', '.harness');

/**
 * Who, if anyone, is on this port?
 *
 *   null   nothing is listening
 *   {cwd}  our host, and it says which project it serves
 *   {}     something IS listening and could not be identified
 *
 * The third case is the one that matters and the reason the socket is probed at
 * all rather than trusting the identity file alone: a file can be stale while a
 * stranger holds the port, and "listening but unidentified" must stay
 * distinguishable from "free".
 */
async function occupantAt(port) {
  if (!(await isHostListening(port))) return null;
  return readIdentity({ dir: HARNESS_DIR, port }) || {};
}

// Returns { port, action } or null when the user named a port we must not take.
async function chooseHostPort() {
  if (EXPLICIT_PORT && EXPLICIT_PORT.bad !== undefined) return null;   // named and refused above
  if (EXPLICIT_PORT) {
    const decision = decideAttach({
      requestedCwd: PROJECT_CWD,
      occupant: await occupantAt(EXPLICIT_PORT),
    });
    if (decision.action === 'refuse') {
      console.error(`[main] refusing port ${EXPLICIT_PORT}: ${decision.reason}` +
        (decision.occupiedBy ? ` (serving ${decision.occupiedBy})` : ''));
      console.error('[main] unset CLAUDE_CUSTOM_PORT to let the port be derived from the project');
      return null;
    }
    return { port: EXPLICIT_PORT, action: decision.action };
  }
  return resolvePort({ cwd: PROJECT_CWD, occupantAt });
}

function spawnHost() {
  const hostPath = path.join(__dirname, '..', 'host', 'host.js');
  // detached:true is the point — the host must outlive this window so a session
  // driven from Remote Control survives the GUI being closed.
  // Log to a FILE, not to pipes. Pipes belong to this Electron process, so
  // when the window closes they close with it -- and the next time the detached
  // host writes to stdout it takes EPIPE and dies. The host logs on every hook
  // event, so "detached" sessions were dying almost immediately, which is
  // exactly the detach property this spawn exists to provide.
  const logPath = path.join(__dirname, '..', '.harness', 'host.log');
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn(process.execPath, [hostPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_CUSTOM_PORT: String(PORT),
      CLAUDE_CUSTOM_CWD: PROJECT_CWD,
      CLAUDE_CUSTOM_TOKEN: SESSION_TOKEN,
    },
  });
  console.log('[main] host log:', logPath);
  child.unref();
  return child;
}

async function waitForHost(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHostListening(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function createWindow(spawnedHost) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // The project's own app colour when it has one, so a window does not
    // flash the default blue before the page paints its look.
    backgroundColor: readLook(PROJECT_CWD).appColor || '#11131a',
    title: projectLabel(PROJECT_CWD),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'renderer.html'), {
    query: { port: String(PORT), cwd: PROJECT_CWD,
             // FF21: the header's project name, painted before the host even
             // answers -- same source of truth as the OS window title above.
             project: projectLabel(PROJECT_CWD),
             // The token the host will demand. Read back from disk when we
             // reattached to a host that was already running and therefore
             // generated its own.
             token: spawnedHost ? SESSION_TOKEN : tokenForRunningHost(),
             tab: process.env.CLAUDE_CUSTOM_SIDE_TAB || '',
             demosecret: process.env.CLAUDE_CUSTOM_DEMO_SECRET || '',
             flourish: process.env.CLAUDE_CUSTOM_FLOURISH || '' },
  });

  // Attention raised from main, not from the page. The renderer's own
  // Notification is subject to page permission and can neither flash the
  // taskbar nor focus the window when clicked; this can do all three.
  // FF4: a cue that survives until the window is LOOKED AT. The taskbar flash
  // below stops at the OS's discretion and is invisible in alt-tab, which
  // shows a title and a thumbnail and nothing else. A border is part of the
  // thumbnail, so it is legible exactly where you decide which window to
  // return to.
  //
  // DECLARED ABOVE ITS CALLER. Miguel, PR #33, A7: it used to sit 23 lines
  // below the handler that calls it, safe only because that handler runs
  // asynchronously -- one synchronous call away from a TDZ ReferenceError, and
  // a reader had to prove the asynchrony to themselves to know it was fine.
  //
  // The state is kept here, not only in the page. A5: `webContents.send`
  // before the renderer has registered its listener is dropped on the floor,
  // and a reload while the cue is up would clear it permanently -- a cue that
  // silently stops meaning anything is worse than no cue, because the next
  // real one says nothing either.
  let cueOn = false;

  // FOCUS IS TRACKED, NOT ASKED FOR. Naomi, PR #33, measured in a real window:
  // `win.isFocused()` returns TRUE while the window is minimized, so the cue
  // and the taskbar flash were both skipped and nothing logged -- a dropped
  // cue is indistinguishable from no task having finished. 2 of 13 trials,
  // and it still failed 5 seconds after minimizing, so it is not a race that
  // settles.
  //
  // The EVENTS fired reliably in every one of her runs; it is the
  // point-in-time query that lies. So the events are the source of truth.
  let focused = win.isFocused();
  // The page darkens itself while unfocused, so the window you are typing
  // into is the one that is not dimmed. The dim level is read FRESH on every
  // send: it is install-wide, so a slider moved in another project's window
  // takes effect here the next time this one loses focus, with no watcher.
  const sendFocus = () => {
    if (!win.isDestroyed()) win.webContents.send('window-focus', { focused, dim: readDim() });
  };
  win.on('focus', () => { focused = true; sendFocus(); });
  win.on('blur', () => { focused = false; sendFocus(); });
  win.on('minimize', () => { focused = false; });
  win.on('restore', () => { focused = win.isFocused(); sendFocus(); });
  win.webContents.on('did-finish-load', sendFocus);
  const setCue = (on) => {
    cueOn = !!on;
    if (!win.isDestroyed()) win.webContents.send('attention-cue', cueOn);
  };
  win.webContents.on('did-finish-load', () => {
    if (cueOn && !win.isDestroyed()) win.webContents.send('attention-cue', true);
  });

  ipcMain.on('attention', (event, surfaces) => {
    if (event.sender !== win.webContents || !surfaces) return;
    // Logged even when nothing is shown. "Suppressed because you are looking at
    // it" and "never arrived" are the same silence otherwise, and telling those
    // two apart is what took two wrong diagnoses to learn.
    if (!surfaces.toast) console.log(`[main] attention: suppressed (focused=${focused})`);
    if (surfaces.toast && Notification.isSupported()) {
      const n = new Notification({
        title: String(surfaces.toast.title || 'claude-custom'),
        body: String(surfaces.toast.body || ''),
        silent: !!surfaces.toast.silent,
      });
      n.on('click', () => {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      });
      n.show();
    }
    // Survives the toast: on Windows the taskbar button keeps flashing until
    // the window is looked at, which is the whole point for a blocked session.
    if (surfaces.flashTaskbar && !focused) win.flashFrame(true);
    // Raised for ANY unfocused attention, not only urgent ones: "a task
    // finished while you were elsewhere" is precisely the case this is for,
    // and it costs nothing when you are already looking at the window.
    if (!focused) setCue(true);
    if (surfaces.toast) {
      console.log(`[main] attention: ${surfaces.toast.title}` +
        ` (silent=${surfaces.toast.silent}, flash=${!!surfaces.flashTaskbar})`);
    }
    if (surfaces.toast) console.log(`[main] attention body: ${surfaces.toast.body}`);
  });

  // FF3: the page sets its own <title>, and a page title WINS over the one
  // given to BrowserWindow. Without this the window silently reverts to
  // whatever renderer.html says the moment it loads, which is how it kept
  // announcing a spike branch long after that branch was gone.
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(projectLabel(PROJECT_CWD));
  });

  win.on('focus', () => {
    win.flashFrame(false);
    setCue(false);            // looked at: the cue has done its job
  });

  // The secret store lives HERE, in main. Not in the host: the host owns the
  // pty, so keeping secrets out of it means no wiring mistake can put one into
  // the session. Not in the renderer: the window would then hold the file and
  // every value in it.
  const secrets = createSecretService({
    // The window's project. Secrets are scoped to it unless explicitly shared;
    // the vault file itself is per-INSTALL, which is why the scope has to be
    // enforced rather than implied by where the file lives.
    project: PROJECT_CWD,
    // DELIBERATELY NOT WRAPPED IN try/catch, and that rests on an invariant:
    // `createVault` CONSTRUCTS FOR ANY BYTES ON DISK, reporting the vault as
    // healthy or damaged rather than throwing.
    //
    // Miguel asked for this line, and the history is why. When `load()` threw on
    // a malformed lock record, this call took the whole window down with it --
    // no panel, no damage message, no melt button (Dexter G3). Wrapping it here
    // would have been worse: a window whose vault panel is silently dead is the
    // class this repo has already paid for four times (careerDisplay,
    // quotaDisplay, isPanelToggle, `.vault-row`). So the throw was removed
    // instead of the crash being caught.
    //
    // The invariant is pinned as a RULE, not by example, in
    // test/vault-damaged-path.test.js -- eighteen adversarial byte shapes
    // including a UTF-8 BOM. If you add a throw to `load()`, that test fails and
    // this comment is what it means.
    vault: createVault({
      file: path.join(__dirname, '..', '.harness', 'secrets.enc'),
      crypto: safeStorage,
    }),
    clipboard: {
      writeText: (t) => clipboard.writeText(t),
      readText: () => clipboard.readText(),
      clear: () => clipboard.writeText(''),
    },
  });

  const fromWindow = (event) => event.sender === win.webContents;
  ipcMain.handle('secrets:available', (e) => fromWindow(e) && secrets.available());
  ipcMain.handle('secrets:list', (e, query) => (fromWindow(e) ? secrets.list({ query }) : []));
  ipcMain.handle('secrets:add', (e, entry) => (fromWindow(e) ? secrets.add(entry || {}) : { ok: false }));
  ipcMain.handle('secrets:remove', (e, id) => (fromWindow(e) ? secrets.remove(id) : { ok: false }));
  ipcMain.handle('secrets:reveal', (e, id) => (fromWindow(e) ? secrets.reveal(id) : { ok: false }));
  ipcMain.handle('secrets:copy', (e, id) => (fromWindow(e) ? secrets.copy(id) : { ok: false }));

  // The lock. Same `fromWindow` gate as everything above it: a handler that
  // answers anyone is not a boundary.
  // `hasKey: true` as well as `locked: true`, and `count: null`. An unauthorized
  // sender must get the shape that draws as LOCKED and reveals nothing --
  // `hasKey: false` with `locked: true` was already safe, but it says "locked
  // vault with no key", which is not a state that exists. Now this default and
  // the service's (secret-service.js, Dexter F6 / Miguel A2) are the same object.
  ipcMain.handle('secrets:lockState', (e) =>
    (fromWindow(e) ? secrets.lockState() : { hasKey: true, locked: true, count: null }));
  ipcMain.handle('secrets:setKey', (e, key) =>
    (fromWindow(e) ? secrets.setKey(key) : { ok: false }));
  ipcMain.handle('secrets:unlock', (e, key) =>
    (fromWindow(e) ? secrets.unlock(key) : { ok: false }));
  ipcMain.handle('secrets:lock', (e) => (fromWindow(e) ? secrets.lock() : { ok: false }));
  ipcMain.handle('secrets:removeKey', (e) => (fromWindow(e) ? secrets.removeKey() : { ok: false }));
  ipcMain.handle('secrets:melt', (e) => (fromWindow(e) ? secrets.melt() : { ok: false }));

  // Ctrl+V (BACKLOG #12, #8): the page asks, main reads the clipboard.
  registerClipboardHandlers({ ipcMain, clipboard, win });

  // Model favourites (BACKLOG E #5, #3): a star on an OpenRouter row or a
  // Claude choice, persisted GLOBALLY next to look-global -- see
  // favourites-bridge.js's header for why main owns this store directly.
  registerFavouriteHandlers({ ipcMain, store: uiStore, win });

  // The install-wide unfocused-window dim: the one Style-tab setting that is
  // not project-scoped, so it lives here rather than going to the host.
  ipcMain.handle('look:getDim', (e) => (fromWindow(e) ? readDim() : null));
  ipcMain.handle('look:setDim', (e, value) => {
    if (!fromWindow(e)) return null;
    const dim = sanitizeDim(value);
    try {
      uiStore.update(UI_KEY, {}, (prev) => ({ ...(prev && typeof prev === 'object' ? prev : {}), unfocusedDim: dim }));
    } catch (err) {
      console.error('[main] could not save the unfocused dim:', err && err.message);
      return null;
    }
    return dim;
  });

  // Headless verification of the secret store. The unit tests inject a fake
  // cipher, so they say nothing about whether DPAPI actually works here; this
  // exercises the real safeStorage and the real OS clipboard. It prints only
  // BOOLEANS -- never the secret, which would defeat the thing being tested.
  if (process.env.CLAUDE_CUSTOM_VAULT_PROBE) {
    const value = process.env.CLAUDE_CUSTOM_VAULT_PROBE;
    setTimeout(() => {
      console.log('[vault-probe] available:', secrets.available());
      const added = secrets.add({ label: 'probe entry', secret: value });
      console.log('[vault-probe] stored:', added.ok, added.error || '');
      const listed = secrets.list();
      console.log('[vault-probe] listed:', listed.length);
      console.log('[vault-probe] list-leaks:', JSON.stringify(listed).includes(value));
      if (added.ok) {
        const shown = secrets.reveal(added.entry.id);
        console.log('[vault-probe] revealed-matches:', shown.ok && shown.secret === value);
        secrets.copy(added.entry.id);
        console.log('[vault-probe] clipboard-matches:', clipboard.readText() === value);
        // Deliberately NOT removed. The probe's strongest assertion is that the
        // file holds no plaintext, and deleting the entry first made that
        // assertion pass against an empty 25-byte vault -- vacuously true.
        console.log('[vault-probe] left-on-disk: true');
      }
    }, 2500);
  }

  // Any external link opens in the real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

app.whenReady().then(async () => {
  console.log('[main] project       :', PROJECT_CWD);

  let chosen;
  try {
    chosen = await chooseHostPort();
  } catch (err) {
    // The derived range is full. Nothing sensible is left to do, and opening a
    // window anyway would show a terminal wired to nothing.
    console.error('[main]', err.message);
    app.exit(1);
    return;
  }
  if (!chosen) { app.exit(1); return; }

  PORT = chosen.port;
  let spawnedHost = false;
  if (chosen.action === 'spawn') {
    console.log('[main] no host for this project on', PORT, '— spawning one');
    spawnHost();
    spawnedHost = true;
    const up = await waitForHost(PORT);
    if (!up) console.error('[main] host did not come up in time');
  } else {
    // Verified as THIS project's host, not merely "something is listening".
    // That check is the whole point: before it, opening project B while
    // project A's detached host was alive silently attached the window to A.
    console.log('[main] reattaching to this project\'s host on', PORT);
  }

  const win = createWindow(spawnedHost);

  // Headless verification path. CLAUDE_CUSTOM_SCREENSHOT=<file> renders the
  // real window, waits for the TUI to draw, writes a PNG and exits. The GUI is
  // the one surface the headless probes cannot reach, so this is how it gets
  // checked at all rather than assumed to look right.
  if (process.env.CLAUDE_CUSTOM_SCREENSHOT) {
    const outFile = process.env.CLAUDE_CUSTOM_SCREENSHOT;
    const waitMs = Number(process.env.CLAUDE_CUSTOM_SCREENSHOT_DELAY) || 12000;

    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['verbose', 'info', 'warn', 'error'][level] || level;
      console.log(`[renderer:${tag}] ${message} (${String(sourceId).split('/').pop()}:${line})`);
    });
    win.webContents.on('render-process-gone', (_e, d) => console.error('[main] renderer gone:', d.reason));
    win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[main] load failed:', code, desc));

    // Optional keystroke drive. The renderer's custom key handler -- above all
    // the hardcoded Shift+Enter -- is the one piece of the input path that the
    // headless probes cannot reach, because it lives in xterm's browser-side
    // event handling rather than on the wire.
    if (process.env.CLAUDE_CUSTOM_INPUT_TEST) {
      const type = text => {
        for (const ch of text) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      };
      const key = (keyCode, modifiers = []) => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      };
      setTimeout(() => {
        win.focus();
        type('LINE-ONE');
        // If Shift+Enter is mishandled this SUBMITS instead of inserting a
        // newline, which the screenshot shows unmistakably.
        key('Enter', ['shift']);
        type('LINE-TWO');
      }, Math.max(1000, waitMs - 3000));
    }

    setTimeout(async () => {
      try {
        const fsMod = require('fs');
        // RETRIED. capturePage intermittently returns an empty image -- observed
        // several times in a row while the host, the hooks and the renderer all
        // reported healthy, so it is the capture and not the page. Reporting it
        // as a probe failure sent me looking for a product bug that was not
        // there, more than once.
        let png = null;
        for (let attempt = 1; attempt <= 4 && !(png && png.length); attempt++) {
          if (attempt > 1) {
            console.log(`[main] capturePage came back empty, retry ${attempt - 1}`);
            await new Promise(r => setTimeout(r, 700));
          }
          try {
            png = (await win.webContents.capturePage()).toPNG();
          } catch (err) {
            console.log('[main] capturePage threw:', err.message);
          }
        }
        if (!png || png.length === 0) throw new Error('capturePage returned an empty image 4 times');
        fsMod.writeFileSync(outFile, png);
        // Verify before exiting. app.exit() is a hard exit that has been
        // observed truncating the file to zero bytes even after a synchronous
        // write, and a 0-byte PNG reads as "the GUI rendered nothing" rather
        // than as the write race it actually is.
        const onDisk = fsMod.statSync(outFile).size;
        if (onDisk !== png.length) throw new Error(`wrote ${png.length}B but file is ${onDisk}B`);
        console.log(`[main] screenshot written: ${outFile} (${onDisk} bytes)`);
      } catch (err) {
        console.error('[main] screenshot failed:', err.message);
      }
      // Let the filesystem settle before the hard exit.
      setTimeout(() => app.exit(0), 400);
    }, waitMs);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(false);
  });
});

// Closing the window detaches; it does not end the session.
app.on('window-all-closed', () => {
  app.quit();
});
