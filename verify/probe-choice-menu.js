'use strict';
/* BACKLOG #11 (clickable choice menus). Drives a REAL `claude` through the real
   host and records what a choice menu looks like on the pty, so app/choice-click.js
   is written against measurement rather than memory.

   Questions, and where each answer is written up (RESULTS below):
     1. What marks the highlighted row, and are rows numbered?
     2. Does the CLI turn on mouse tracking (?1000/?1002/?1003/?1006h)? If it
        does, a click may already reach it as a mouse report and we must not
        double-act.
     3. Do Up/Down/Enter sent the way the app sends them (a {type:'input'}
        frame) move the highlight? If not, our layer is swallowing them.

   $0 by construction: no prompt is ever sent to the model. Menus used are the
   folder-trust dialog (fresh empty dir) and the /model picker. Every scenario
   ends with Escape; Enter is never sent.

   Run:  node verify/probe-choice-menu.js
   Env:  PROBE_TRUSTED_DIR  a directory claude already trusts (default: the repo
         this file lives in, then its parent -- the checkout Ricardo uses).

   RESULTS (2026-09-29, claude v2.1.284, 100x30, through host.js):
     - Highlight marker: U+276F "❯" in column 3 of the highlighted option row,
       one space before the number; other option rows carry spaces there.
     - Rows ARE numbered "N." (/model: "1.  Default (recommended)", /permissions:
       "1.   Add a new rule…"). Long lists are WINDOWED: a "↓" (or "↑") sits in the
       marker column of the last (first) visible row as a scroll cue, and a
       "… +6 models" row is not an option. The marker can scroll out of view.
     - Up/Down sent as a {type:'input'} frame (\x1b[B / \x1b[A) DO move the
       highlight (model: 2->3->4->3). Nothing in our layer swallows them.
     - The folder-trust dialog never appears here: the host runs claude in
       bypass-permissions mode, which skips it. Not measurable.
     - MOUSE TRACKING IS ON. Every screen enables ?1000h ?1002h ?1003h ?1006h
       (+ ?1004h focus). xterm.js therefore forwards clicks to the CLI as SGR
       reports, and renderer.js does nothing to stop that.
     - THE CLI ACTS ON THOSE CLICKS ITSELF. An SGR press+release on the "5. Haiku
       4.5" row of the /model picker selected it and SAVED it as the default
       ("Set model to Haiku 4.5 and saved as your default for new sessions",
       "model": "haiku" written to ~/.claude/settings.json). So on that menu a
       click already works with no help from us -- and a second, synthesised
       arrows+Enter would double-act.
     - Not measured: whether clicks work in permission prompts, /config, or the
       yes/no menus (no free way to raise a permission prompt).

   SIDE EFFECT OF THE 2026-09-29 MEASUREMENT: the click step WROTE
   "model": "haiku" INTO THE REAL ~/.claude/settings.json (it was "opus").
   Anyone who ran it then must restore their default with /model.

   CONSEQUENCE: BACKLOG #11 needs no code. Clicks already work; a synthesised
   arrows+Enter would double-act. test/renderer-mouse-passthrough.test.js pins
   that renderer.js never eats mouse events before xterm sees them.

   PROBE_MOUSE_COMMIT=1 re-runs the click step. It COMMITS a /model choice into
   the user's real settings, so it is opt-in; the default run is read-only. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

const COLS = 100, ROWS = 30;
const REPO = path.join(__dirname, '..');
const MOUSE_ON = /\x1b\[\?(100[0-6]|1015)h/g;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(name, { cwd, port, steps }) {
  const token = 'probe-choice-' + process.pid + '-' + port;
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-choice-reg-'));
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  const host = spawn(process.execPath, [path.join(REPO, 'host', 'host.js')], {
    env: {
      ...process.env,
      CLAUDE_CUSTOM_PORT: String(port),
      CLAUDE_CUSTOM_CWD: cwd,
      CLAUDE_CUSTOM_TOKEN: token,
      CLAUDE_CUSTOM_REGISTRY: registry,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stderr.on('data', (d) => process.stderr.write('[host!] ' + d));
  const raw = [];
  let ws;
  try {
    for (let i = 0; i < 40; i++) {
      ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`);
      const ok = await new Promise((r) => { ws.once('open', () => r(true)); ws.once('error', () => r(false)); });
      if (ok) break;
      await sleep(250);
    }
    // Only BINARY frames are pty bytes; text frames are JSON control messages
    // (renderer.js onmessage does the same split). Feeding both garbles the screen.
    ws.on('message', (d, isBinary) => {
      if (!isBinary) return;
      const s = d.toString('utf8'); raw.push(s); term.write(s);
    });
    ws.send(JSON.stringify({ type: 'resize', cols: COLS, rows: ROWS }));
    const send = (data) => ws.send(JSON.stringify({ type: 'input', data }));
    const rows = () => {
      const b = term.buffer.active, out = [];
      for (let y = 0; y < ROWS; y++) { const l = b.getLine(y); out.push(l ? l.translateToString(true).replace(/\s+$/, '') : ''); }
      return out;
    };
    const show = (label) => {
      console.log(`\n--- ${name}: ${label} ---`);
      rows().forEach((s, y) => { if (s) console.log(String(y).padStart(2) + ' | ' + s); });
    };
    await steps({ send, sleep, show, rows });
    const all = raw.join('');
    const seen = [...new Set(all.match(MOUSE_ON) || [])].map((s) => JSON.stringify(s));
    console.log(`\n[${name}] mouse-tracking enable sequences in the raw stream: ${seen.length ? seen.join(' ') : 'NONE'}`);
    console.log(`[${name}] headless term.modes.mouseTrackingMode: ${term.modes.mouseTrackingMode}`);
  } finally {
    try { ws.close(); } catch { /* not open */ }
    try { host.kill(); } catch { /* gone */ }
    await sleep(500);
    try { fs.rmSync(registry, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

(async () => {
  // 1. Folder trust: a fresh empty directory. Enter is NEVER sent -- accepting
  // would write a trust entry for a throwaway path.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-choice-fresh-'));
  try {
    await scenario('trust', {
      cwd: fresh, port: 7731,
      steps: async ({ send, show }) => {
        await sleep(9000);
        show('as first drawn');
        send('\x1b[B'); await sleep(900); show('after Down (\\x1b[B)');
        send('\x1b[A'); await sleep(900); show('after Up (\\x1b[A)');
        send('\x1b'); await sleep(500);
      },
    });
  } finally {
    try { fs.rmSync(fresh, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // 2. /model picker in a directory claude already trusts.
  const trusted = process.env.PROBE_TRUSTED_DIR || path.resolve(REPO, '..', '..', '..');
  await scenario('model', {
    cwd: trusted, port: 7732,
    steps: async ({ send, show }) => {
      await sleep(9000);
      send('/model'); await sleep(700);
      send('\r'); await sleep(1500); // opens the picker; /model is not a prompt to the model
      show('picker as first drawn');
      send('\x1b[B'); await sleep(900); show('after Down');
      send('\x1b[B'); await sleep(900); show('after Down again');
      send('\x1b[A'); await sleep(900); show('after Up');
      if (process.env.PROBE_MOUSE_COMMIT === '1') {
        // WRITES TO THE USER'S REAL ~/.claude/settings.json. A click in the
        // /model picker COMMITS: the first run of this step (2026-09-29) chose
        // Haiku 4.5 and saved "model": "haiku" as the default for new sessions.
        // Opt-in only, and afterwards restore the model with /model.
        //
        // What xterm sends for a left click on 0-based row 23 ("5. Haiku") now
        // that the CLI has asked for SGR mouse reporting: 1-based col;row,
        // press M then release m. Does the CLI act on it by itself?
        send('\x1b[<0;15;24M'); await sleep(150);
        send('\x1b[<0;15;24m'); await sleep(900);
        show('after an SGR mouse click on row 23 (0-based)');
      }
      send('\x1b'); await sleep(600);
      send('\x1b'); await sleep(400);
    },
  });
  // 3. /permissions: a tabbed dialog with a list. Looked at, arrowed, escaped.
  await scenario('permissions', {
    cwd: trusted, port: 7733,
    steps: async ({ send, show }) => {
      await sleep(9000);
      send('/permissions'); await sleep(700);
      send('\r'); await sleep(1500);
      show('permissions as first drawn');
      send('\x1b[B'); await sleep(900); show('after Down');
      send('\x1b'); await sleep(600);
      send('\x1b'); await sleep(400);
    },
  });
  process.exit(0);
})();
