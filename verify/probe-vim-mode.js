'use strict';
/* What does the CLI's input box look like in vim mode, INSERT vs NORMAL?
   FF12 types Ctrl-E, Ctrl-U, `/model x`, CR into the box when inputState()
   says 'ready'. In vim NORMAL mode those keys are motions and commands, not
   text (Dexter r2 N2), so the harness must be able to TELL the two apart from
   the screen alone. Measured on the REAL CLI, sending NO prompt.

     node verify/probe-vim-mode.js

   MEASURED 2026-09-26, v2.1.283: there is no /vim command ("Unknown
   command: /vim"); `editorMode: "vim"` in a --settings layer turns it on. In
   INSERT the footer line under the box starts `-- INSERT --`; in NORMAL that
   marker is simply ABSENT -- and absent is also how non-vim mode looks, so
   the screen alone can tell NORMAL apart only once INSERT has been seen.
   The `❯` box itself is identical in both modes. `i` in NORMAL is taken as
   a mode switch (not typed), and Ctrl-E, Ctrl-U in INSERT clear the draft
   exactly as in non-vim mode.

   Safety: ANTHROPIC_API_KEY and ELECTRON_RUN_AS_NODE are deleted from the
   child env. /vim toggles a persisted editor mode, so the probe toggles it
   back and reports what ~/.claude.json says afterwards; settings files are
   snapshotted and restored byte for byte, as in probe-top-bar-truth.js. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const COLS = 110;
const ROWS = 34;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPO = path.join(__dirname, '..');
const claudeJson = path.join(os.homedir(), '.claude.json');

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
    const same = before === null ? now === null : (now !== null && before.equals(now));
    if (same) continue;
    changed.push(f);
    if (before === null) fs.rmSync(f, { force: true });
    else fs.writeFileSync(f, before);
  }
  return changed;
}
const editorMode = () => {
  try { return JSON.parse(fs.readFileSync(claudeJson, 'utf8')).editorMode; } catch { return '(unreadable)'; }
};

const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
delete env.ELECTRON_RUN_AS_NODE;

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const shell = process.platform === 'win32' ? 'cmd.exe' : 'claude';
// v2.1.283 has no /vim command ("Unknown command: /vim"), so vim mode is
// switched on through a --settings layer: nothing persistent is touched.
const vimSettings = path.join(os.tmpdir(), `cc-probe-vim-${Date.now()}.json`);
fs.writeFileSync(vimSettings, JSON.stringify({ editorMode: 'vim' }));
const args = process.platform === 'win32' ? ['/c', 'claude', '--settings', vimSettings] : ['--settings', vimSettings];
const child = pty.spawn(shell, args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: REPO, env });
child.onData(d => term.write(d));

const screen = () => {
  const b = term.buffer.active;
  const out = [];
  for (let y = 0; y < ROWS; y++) {
    const l = b.getLine(b.viewportY + y);
    out.push(l ? l.translateToString(true).replace(/\s+$/, '') : '');
  }
  return out;
};
const show = (label) => {
  console.log(`\n--- SCREEN: ${label} ---`);
  for (const l of screen()) if (l) console.log('| ' + l);
};
const type = async (text, ms = 800) => { child.write(text); await sleep(ms); };
const enter = async (ms = 2500) => { child.write('\r'); await sleep(ms); };
async function waitFor(pred, ms) {
  for (let t = 0; t < ms; t += 250) { if (pred()) return true; await sleep(250); }
  return false;
}

(async () => {
  let failed = false;
  const modeBefore = editorMode();
  try {
    await waitFor(() => screen().some(l => /❯/.test(l)), 30000);
    await sleep(3000);
    show('boot, --settings editorMode=vim');

    await type('abc');
    show('INSERT mode with draft "abc"');

    await type('\x1b', 1200);          // ONE Esc: INSERT -> NORMAL
    show('NORMAL mode (after one Esc)');

    await type('i', 1000);             // back to INSERT
    show('INSERT again (after i)');

    await type('\x05', 300);
    await type('\x15', 800);           // clear the draft
    show('after Ctrl-E, Ctrl-U in INSERT');

    // Dexter #51 F2: with a slash command typed, is the INSERT marker still
    // under the box, or does the suggestion list push it away? FF12's
    // read-back needs it there before it sends the CR.
    await type('/model sonnet', 1500);
    show('INSERT with /model sonnet typed (not sent)');
    await type('\x05', 300);
    await type('\x15', 800);

    await type('\x1b', 1200);          // NORMAL, empty box
    show('NORMAL mode, empty box');
  } catch (err) {
    failed = true;
    console.error('probe error:', err);
  } finally {
    try { child.kill(); } catch {}
    await sleep(1500);
    const changed = restore();
    fs.rmSync(vimSettings, { force: true });
    console.log(`\neditorMode in ~/.claude.json: before=${JSON.stringify(modeBefore)} after=${JSON.stringify(editorMode())}`);
    console.log(`settings restored: ${changed.length ? changed.join(', ') : 'nothing had changed'}`);
    process.exit(failed ? 1 : 0);
  }
})();
