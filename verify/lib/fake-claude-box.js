'use strict';
/**
 * A stand-in for the claude CLI's input box, for verify/probe-git-tree.js (Type /merged, PR #93). Nothing
 * bills: it is a plain Node script started inside a tab's cmd.exe.
 *
 *   node fake-claude-box.js <ctl.json> <submitted.log>
 *
 * It draws exactly what app/top-bar-display.js inputState() reads as the live box: a `❯` line between the
 * last two full-width `─` rules, a footer under it. Keys, in raw mode:
 *   printable text   joins the line (the cursor is always at its end)
 *   Ctrl-E           nothing more to do: already at the end
 *   Ctrl-U           clears the line
 *   Enter            submits it: appended to <submitted.log> as one JSON string per line
 * The probe stages a half-typed draft by writing <ctl.json> as { "draft": "..." }, and reads what the box
 * holds now from <submitted.log>.line (a JSON string, rewritten on every draw).
 */
const fs = require('fs');

const [ctl, log] = process.argv.slice(2);
// As wide as the terminal (the CLI's rules fill the row): a fixed 60 wrapped into two rows once the code
// reader narrowed the terminal, and the page then judged the box a dialog (verify/probe-repo-browser.js).
const rule = () => '─'.repeat(Math.max(10, (process.stdout.columns || 61) - 1));
let line = '';
let lastCtl = '';
const history = [];

function draw() {
  const rows = [...history.slice(-6), rule(), `❯ ${line}`, rule(), '  fake claude box'];
  process.stdout.write(`\x1b[2J\x1b[H${rows.join('\r\n')}`);
  if (log) fs.writeFileSync(`${log}.line`, JSON.stringify(line));
}

if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') {
      if (log) fs.appendFileSync(log, `${JSON.stringify(line)}\n`);
      history.push(`> ${line}`);
      line = '';
    } else if (ch === '\x15') {
      line = '';
    } else if (ch === '\x03') {
      process.exit(0);
    } else if (ch >= ' ' && ch !== '\x7f') {
      line += ch;
    }
  }
  draw();
});

setInterval(() => {
  let text;
  try { text = fs.readFileSync(ctl, 'utf8'); } catch { return; }
  if (text === lastCtl) return;
  lastCtl = text;
  try {
    const c = JSON.parse(text);
    if (typeof c.draft === 'string') { line = c.draft; draw(); }
  } catch { /* half-written: the next read gets it */ }
}, 100);

if (process.stdout.on) process.stdout.on('resize', draw);
draw();
