'use strict';
/* What can FF12's top bar trust, and how can it type safely? Measured on the
   REAL CLI, sending NO prompt -- /model and /effort are local commands, so
   this spends no tokens.

   (a) The statusLine command gets a JSON document on stdin. Does it carry
       model.id, and effort? Does it re-fire right after /model and /effort,
       with no turn in between? If so it is a truth source that is causally
       downstream of the switch -- which #34's transcript-derived
       session.model is not (Dexter #2), nor is effort off the NEXT hook
       payload (Dexter #6).
   (b) What clears a half-typed input line without submitting it (Dexter #4)?
       And what does the screen look like while a dialog is open, so the
       harness can refuse to type into one? Esc Esc opens the rewind menu, so
       keys are measured one at a time, never guessed.

     node verify/probe-top-bar-truth.js

   Safety: ANTHROPIC_API_KEY is deleted from the child env (so it uses the Max
   login, and nothing can bill the key), and ELECTRON_RUN_AS_NODE with it.
   /model may persist the choice to settings; every settings file it could
   touch is snapshotted first and restored after. (It does: see below.)
   Run from a Claude Code session, the child inherits CLAUDE_CODE_CHILD_SESSION
   and says "Transcript saving is off" -- left on purpose: no transcript.

   MEASURED 2026-09-26, v2.1.283:
   (a) statusLine stdin carries model.id AND effort.level, and re-fires ~1s
       after /model and after /effort, with no turn. /model sonnet also moved
       effort medium -> high (the model's own default), reported the same way.
       BOTH commands print "saved as your default for new sessions" and DO
       write ~/.claude/settings.json.
   (b) Ctrl-U (\x15) clears a draft without submitting ("Ctrl+Y to paste
       deleted text"). Bare /model opens a picker: the `❯` input box is gone
       and "Esc to cancel" shows; one Esc closes it ("Kept model as ..."). */
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- statusLine mode: append one stdin document and print a status line ----
if (process.argv[2] === '--status') {
  let buf = '';
  process.stdin.on('data', d => { buf += d; });
  process.stdin.on('end', () => {
    fs.appendFileSync(process.argv[3], JSON.stringify({ at: Date.now(), raw: buf }) + '\n');
    process.stdout.write('probe-status');
  });
  return;
}

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const COLS = 110;
const ROWS = 34;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPO = path.join(__dirname, '..');
const stamp = Date.now();
const statusLog = path.join(os.tmpdir(), `cc-probe-status-${stamp}.jsonl`);
const settingsFile = path.join(os.tmpdir(), `cc-probe-settings-${stamp}.json`);
const node = process.execPath.replace(/\\/g, '/');
const self = __filename.replace(/\\/g, '/');
fs.writeFileSync(settingsFile, JSON.stringify({
  statusLine: { type: 'command', command: `"${node}" "${self}" --status "${statusLog.replace(/\\/g, '/')}"`, padding: 0 },
}));

// Everything /model could write to, restored byte for byte afterwards.
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

const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
delete env.ELECTRON_RUN_AS_NODE;

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const shell = process.platform === 'win32' ? 'cmd.exe' : 'claude';
const args = process.platform === 'win32'
  ? ['/c', 'claude', '--settings', settingsFile]
  : ['--settings', settingsFile];
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
const statuses = () => (fs.existsSync(statusLog) ? fs.readFileSync(statusLog, 'utf8') : '')
  .split('\n').filter(Boolean).map(l => JSON.parse(l))
  .map(s => { try { return { at: s.at, doc: JSON.parse(s.raw) }; } catch { return { at: s.at, doc: null, raw: s.raw }; } });
const summarise = s => s.doc
  ? `model.id=${s.doc.model && s.doc.model.id} display=${s.doc.model && s.doc.model.display_name} `
    + `effort=${JSON.stringify(s.doc.effort)} keys=[${Object.keys(s.doc).join(',')}]`
  : `unparsed: ${String(s.raw).slice(0, 120)}`;
const type = async (text, ms = 600) => { child.write(text); await sleep(ms); };
// Sent on its own: a longer chunk ending in CR is treated as a paste and the
// CR is swallowed (see verify/probe-payloads.js).
const enter = async (ms = 3000) => { child.write('\r'); await sleep(ms); };

async function waitFor(pred, ms) {
  for (let t = 0; t < ms; t += 250) { if (pred()) return true; await sleep(250); }
  return false;
}

(async () => {
  let failed = false;
  try {
    const booted = await waitFor(() => screen().some(l => /[❯>]\s*$|[❯>] /.test(l)), 30000);
    await sleep(3000);
    show(`boot (prompt seen: ${booted})`);
    const s0 = statuses();
    console.log(`\n(a) statusLine fired ${s0.length}x before any command`);
    if (s0.length) console.log('    first :', summarise(s0[0]), '\n    last  :', summarise(s0[s0.length - 1]));
    if (s0.length) console.log('    full doc:', JSON.stringify(s0[s0.length - 1].doc, null, 1).slice(0, 1500));

    // (b) clearing a draft. Ctrl-U first (kill to start of line).
    await type('draft words here');
    show('after typing a draft');
    await type('\x15', 800);
    show('after Ctrl-U');

    // (a) /model with an argument: does statusLine re-fire, and with what?
    const beforeModel = statuses().length;
    const tModel = Date.now();
    await type('/model sonnet');
    await enter(4000);
    show('after /model sonnet');
    const afterModel = statuses().slice(beforeModel);
    console.log(`\n(a) after /model sonnet: ${afterModel.length} statusLine run(s)`);
    for (const s of afterModel) console.log(`    +${s.at - tModel}ms`, summarise(s));

    const beforeEffort = statuses().length;
    const tEffort = Date.now();
    await type('/effort high');
    await enter(4000);
    show('after /effort high');
    const afterEffort = statuses().slice(beforeEffort);
    console.log(`\n(a) after /effort high: ${afterEffort.length} statusLine run(s)`);
    for (const s of afterEffort) console.log(`    +${s.at - tEffort}ms`, summarise(s));

    // (b) a dialog: bare /model opens the picker. What marks it on screen?
    await type('/model');
    await enter(3000);
    show('bare /model (a dialog is open)');
    await type('\x1b', 1500); // ONE Esc: closes the dialog. Never two.
    show('after one Esc');
  } catch (err) {
    failed = true;
    console.error('probe error:', err);
  } finally {
    try { child.kill(); } catch {}
    await sleep(1500);
    const changed = restore();
    console.log(`\nsettings restored: ${changed.length ? changed.join(', ') : 'nothing had changed'}`);
    console.log(`status log kept at ${statusLog}`);
    fs.rmSync(settingsFile, { force: true });
    process.exit(failed ? 1 : 0);
  }
})();
