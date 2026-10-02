'use strict';
/* Backlog #27 (L2): can the CLI's footer rows leave the terminal? Measured on
   the REAL CLI, sending NO prompt, so it spends no tokens.

   (a) The status line is the statusLine command's output. If that command
       prints NOTHING, does the CLI drop the row, or keep a blank one?
   (b) Which fields does the statusLine stdin document carry (cost, duration,
       context), and with what values before any turn? A field that's absent
       must never be drawn as 0 (the Number(null) trap).
   (c) The permission-mode footer ("accept edits on (shift+tab to cycle)") is
       the CLI's own. Does it move or vanish when the status line is empty?

   Six boots: {statusLine prints text, prints nothing, no statusLine at all}
   x {default mode, acceptEdits}. Every row under the input box is printed
   for each.

     node verify/probe-footer-rows.js [--only text|empty|none] [--repeat N] [--rows N]

   MEASURED 2026-10-02, v2.1.287:
   (a) An EMPTY statusLine output DROPS the status row: footer 2 rows instead
       of 3, on a full 16-row screen in 4 of 4 boots, and it stays dropped
       after a keystroke redraw and after a resize. (One first boot on a
       30-row screen showed a blank row once; not reproduced on a full
       screen, which is what a real session is.) No statusLine at all: the
       same 2 rows, and "? for shortcuts" joins the mode row.
   (b) stdin carries cost.{total_cost_usd, total_duration_ms,
       total_api_duration_ms, total_lines_added, total_lines_removed},
       context_window.{total_input_tokens, total_output_tokens,
       context_window_size, current_usage, used_percentage,
       remaining_percentage} -- used/remaining/current_usage are NULL before
       the first turn (unknown, never 0) -- plus exceeds_200k_tokens,
       rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}, model,
       effort, thinking, fast_mode, workspace.git_worktree, workspace.repo.
   (c) The mode row ("⏸ manual mode on", "⏵⏵ accept edits on (shift+tab to
       cycle)") is the CLI's and stays. No setting hides it: the settings
       schema's only footer switch is statusLine.hideVimModeIndicator. The
       CLI also puts right-aligned notes on that row ("◐ medium · /effort",
       "You've used 82% of your weekly limit ..."), so it isn't dead space.
   So #27 reclaims ONE row: the status line's.

   Safety: ANTHROPIC_API_KEY and ELECTRON_RUN_AS_NODE are deleted from the
   child env. No command is typed, so no settings file is written. */
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- statusLine mode: log one stdin document, print text or nothing --------
if (process.argv[2] === '--status') {
  let buf = '';
  process.stdin.on('data', d => { buf += d; });
  process.stdin.on('end', () => {
    fs.appendFileSync(process.argv[3], JSON.stringify({ at: Date.now(), raw: buf }) + '\n');
    if (process.argv[4] === 'text') process.stdout.write('probe-status-row');
  });
  return;
}

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const COLS = 110;
// --rows N: a short terminal is always full, the way a real long session is.
const ROWS = (() => {
  const i = process.argv.indexOf('--rows');
  return i > 0 ? Math.max(10, parseInt(process.argv[i + 1], 10) || 30) : 30;
})();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPO = path.join(__dirname, '..');
const node = process.execPath.replace(/\\/g, '/');
const self = __filename.replace(/\\/g, '/');

const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
delete env.ELECTRON_RUN_AS_NODE;

async function boot({ output, mode }) {
  const stamp = `${Date.now()}-${output}-${mode}`;
  const statusLog = path.join(os.tmpdir(), `cc-probe-footer-${stamp}.jsonl`);
  const settingsFile = path.join(os.tmpdir(), `cc-probe-footer-${stamp}.json`);
  fs.writeFileSync(settingsFile, JSON.stringify({
    statusLine: {
      type: 'command',
      command: `"${node}" "${self}" --status "${statusLog.replace(/\\/g, '/')}" ${output}`,
      padding: 0,
    },
  }));
  // 'none': no statusLine anywhere. User settings (where Ricardo's lives) are
  // left out, and the worktree has no project settings.
  const cliArgs = output === 'none'
    ? ['--setting-sources', 'project,local', '--permission-mode', mode]
    : ['--settings', settingsFile, '--permission-mode', mode];
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const child = process.platform === 'win32'
    ? pty.spawn('cmd.exe', ['/c', 'claude', ...cliArgs], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: REPO, env })
    : pty.spawn('claude', cliArgs, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: REPO, env });
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
  const statuses = () => (fs.existsSync(statusLog) ? fs.readFileSync(statusLog, 'utf8') : '')
    .split('\n').filter(Boolean).map(l => JSON.parse(l))
    .map(s => { try { return JSON.parse(s.raw); } catch { return null; } });

  try {
    for (let t = 0; t < 30000; t += 250) {
      if (screen().some(l => /[❯>] /.test(l) || /[❯>]$/.test(l))) break;
      await sleep(250);
    }
    // The input box is the last ─── border pair; everything after its closing
    // border is footer. Print from the opening border down, row numbers shown.
    const report = (label) => {
      const rows = screen();
      const borders = rows.map((l, i) => (/^\s*[─━]{10,}/.test(l) ? i : -1)).filter(i => i >= 0);
      const from = borders.length >= 2 ? borders[borders.length - 2] : Math.max(0, ROWS - 8);
      console.log(`\n=== statusLine=${output}  mode=${mode}  rows=${ROWS}  [${label}] ===`);
      const lastText = rows.reduce((acc, l, i) => (l.trim() ? i : acc), -1);
      for (let i = from; i <= lastText; i++) console.log(`${String(i).padStart(2)}| ${rows[i]}`);
      const closing = borders.length ? borders[borders.length - 1] : -1;
      const blanks = closing >= 0 ? rows.slice(closing + 1, lastText).filter(l => !l.trim()).length : '?';
      console.log(`   footer rows used: ${closing >= 0 ? lastText - closing : '?'}  `
        + `(blank rows inside the footer: ${blanks})`);
    };
    await sleep(8000); // let the statusLine fire and the footer settle
    report('settled');
    // A redraw: one keystroke, then Ctrl-U to clear it (never submitted).
    child.write('x'); await sleep(800); child.write('\x15'); await sleep(2000);
    report('after a keystroke');
    // A resize redraws everything Ink owns.
    child.resize(COLS - 10, ROWS); term.resize(COLS - 10, ROWS); await sleep(3000);
    report('after a resize');
    const docs = statuses().filter(Boolean);
    console.log(`   statusLine fired ${docs.length}x`);
    return docs[docs.length - 1] || null;
  } finally {
    try { child.kill(); } catch {}
    await sleep(1500);
    fs.rmSync(settingsFile, { force: true });
  }
}

(async () => {
  let doc = null;
  try {
    // --only <text|empty|none>  --repeat N : re-measure one variant N times.
    const arg = (name, dflt) => {
      const i = process.argv.indexOf(name);
      return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
    };
    const outputs = arg('--only', null) ? [arg('--only')] : ['text', 'empty', 'none'];
    const repeat = Math.max(1, parseInt(arg('--repeat', '1'), 10) || 1);
    for (let r = 0; r < repeat; r++) {
      for (const mode of ['default', 'acceptEdits']) {
        for (const output of outputs) {
          const d = await boot({ output, mode });
          if (d && !doc) doc = d;
        }
      }
    }
    console.log('\n=== statusLine stdin document (first boot) ===');
    console.log(doc ? JSON.stringify(doc, null, 1) : '(never fired)');
  } catch (err) {
    console.error('probe error:', err);
    process.exit(1);
  }
  process.exit(0);
})();
