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
 *
 * Two more ctl switches (BACKLOG #61, verify/probe-wand.js):
 *   { "queue": true }   every Enter then leaves the CLI's own queued-messages line in the box row
 *                       ("❯ Press up to edit queued messages", measured: verify/probe-queued-skill.js) until
 *                       { "queue": false }; the wand reads it off the screen to say "queued"
 *   { "dialog": true }  the box is replaced by a permission-style dialog (no input box, no rules) until
 *                       { "dialog": false }: what a page must refuse to type into
 */
const fs = require('fs');

const [ctl, log] = process.argv.slice(2);
// As wide as the terminal (the CLI's rules fill the row): a fixed 60 wrapped into two rows once the code
// reader narrowed the terminal, and the page then judged the box a dialog (verify/probe-repo-browser.js).
const rule = () => '─'.repeat(Math.max(10, (process.stdout.columns || 61) - 1));
let line = '';
let lastCtl = '';
let queueMode = false;
let queued = false;
let dialog = false;
const history = [];

function draw() {
  const rows = dialog
    ? [...history.slice(-6), 'Do you want to run this command?', '❯ 1. Yes', '  2. No']
    : [...history.slice(-6), rule(), `❯ ${line || (queued ? 'Press up to edit queued messages' : '')}`, rule(), '  fake claude box'];
  process.stdout.write(`\x1b[2J\x1b[H${rows.join('\r\n')}`);
  if (log) fs.writeFileSync(`${log}.line`, JSON.stringify(line));
}

// Pastes, as the REAL CLI treats them (verify/probe-chat-send-real.js --measure, 2026-11-03): it turns bracketed-paste mode on; a bracketed
// paste of 4 or more lines shows as "[Pasted text #N +K lines]", a plain write of more than 1,000 characters in one read as "[Pasted text #N]",
// and Enter submits the REAL text. Shorter pastes show as typed, their line ends as spaces.
const PASTE_LINES = 4;
const BIG_WRITE = 1000;
const pasted = {};
let pasteCount = 0;
let inPaste = false;
let pasteBuf = '';
const placeholder = (text, lines) => {
  pasted[++pasteCount] = text;
  return lines > 1 ? `[Pasted text #${pasteCount} +${lines - 1} lines]` : `[Pasted text #${pasteCount}]`;
};
const real = (s) => s.replace(/\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g, (m, n) => (pasted[n] !== undefined ? pasted[n] : m));

if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdout.write('\x1b[?2004h');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (!inPaste && !chunk.includes('\x1b[200~') && chunk.length > BIG_WRITE) { line += placeholder(chunk, 1); draw(); return; }
  let rest = chunk;
  while (rest.length) {
    if (inPaste) {
      const end = rest.indexOf('\x1b[201~');
      if (end < 0) { pasteBuf += rest; rest = ''; break; }
      pasteBuf += rest.slice(0, end);
      rest = rest.slice(end + 6);
      inPaste = false;
      const text = pasteBuf.replace(/\r\n?/g, '\n');
      const rows = text.split('\n').length;
      line += rows >= PASTE_LINES ? placeholder(text, rows) : text.replace(/\n/g, ' ');
      pasteBuf = '';
      continue;
    }
    const start = rest.indexOf('\x1b[200~');
    const plain = start < 0 ? rest : rest.slice(0, start);
    for (const ch of plain) {
      if (ch === '\r' || ch === '\n') {
        const sent = real(line);
        if (log) fs.appendFileSync(log, `${JSON.stringify(sent)}\n`);
        history.push(`> ${sent.replace(/\n/g, ' ').slice(0, 100)}`);       // one short row: a 2,000-character echo would push the box off the screen
        line = '';
        if (queueMode) queued = true;
      } else if (ch === '\x15') {
        line = '';
      } else if (ch === '\x03') {
        process.exit(0);
      } else if (ch >= ' ' && ch !== '\x7f') {
        line += ch;
      }
    }
    if (start < 0) break;
    rest = rest.slice(start + 6);
    inPaste = true;
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
    if (typeof c.queue === 'boolean') { queueMode = c.queue; if (!c.queue) queued = false; draw(); }
    if (typeof c.dialog === 'boolean') { dialog = c.dialog; draw(); }
  } catch { /* half-written: the next read gets it */ }
}, 100);

if (process.stdout.on) process.stdout.on('resize', draw);
draw();
