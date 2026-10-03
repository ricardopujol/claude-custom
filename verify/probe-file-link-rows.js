'use strict';
/* Backlog #37: how does a long file path land in the terminal buffer? Measured
   on the REAL CLI in a pty, through a headless xterm (the same buffer code the
   window uses), before any row-joining code is written.

     node verify/probe-file-link-rows.js [--no-model]

   Questions (PLAN_TERMINAL_FILE_LINKS.md, Task 1):
   (a) Does `isWrapped` ever become true on Claude Code's output, or does Ink
       break long lines itself with real line breaks?
   (b) When a path with no spaces passes the edge, where is it broken, and at
       which column is the last character of the full row?
   (c) What indent do continuation rows get?
   (d) Does a path with a space break AT the space, and is the space dropped?
   (e) How are `inline code` and [text](C:\path) rendered: are the backticks
       and the link target still on screen?

   Two outputs: a bash-mode `! echo` and, unless --no-model, ONE short Haiku
   reply that repeats three paths. Both cost a little: in v2.1.288 a bash-mode
   command is followed by a model turn too (a few hundred Haiku tokens each).

     --all  print every buffer row, not only the rows naming a path

   Safety: ANTHROPIC_API_KEY and ELECTRON_RUN_AS_NODE are deleted from the child
   env; user settings are left out (--setting-sources project,local), so no
   user hook fires. Only the pty this probe spawned is killed.

   MEASURED 2026-10-02, v2.1.288, 100 columns:
   (a) isWrapped is NOT a usable signal. Ink writes every row itself; xterm
       sets isWrapped only where Ink's write happened to fill the last column
       first, so it's true on some continuation rows, false on others, and
       true on a row that STARTS a new block ("  ⎿  Wrote ..." right after the
       "! echo" lines). Row joining can't use it either way.
   (b) A word longer than the room left is broken mid-word at the edge: the
       full row's last character is at column 98 or 99 (cols-2 or cols-1).
       So a row is "full" when its last non-blank column >= cols - 2.
   (c) A continuation row is indented to where its block's TEXT starts: 2
       after "● " and "❯ " and "! ", 5 after "  ⎿  ". Each row's text start =
       indent + any marker ("●", "⎿", "❯", "!", list "-") + the spaces after it.
   (d) Word wrap breaks AT a space and drops it ("...file.txt and then" /
       "C:\Users\ricar\Reaper Projects..."). A row can also be full AND end at
       a dropped space ("is the second one," / "ok"), so a full row is
       ambiguous; it's joined with nothing between, and the join is a break.
   (e) Markdown is rendered: `inline code` loses its backticks (the path shows
       bare), and [mocks](C:\...\git-tree-mocks.html) shows only "mocks" -- the
       target isn't on screen, so it can't become a file link from the text. */
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const path = require('path');

const COLS = 100, ROWS = 50;
const REPO = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
delete env.ELECTRON_RUN_AS_NODE;

const LONG = 'C:\\Users\\ricar\\VibeCode\\claude-custom\\feat-terminal-file-links\\documentation\\'
  + 'a-deliberately-long-folder-name\\and-another-folder-to-cross-the-edge\\file.txt';
const SPACED = 'C:\\Users\\ricar\\Reaper Projects\\Pinshot\\Pinshot\\Pinshot_Recording_Script.xlsx';
const MARKS = ['a-deliberately', 'cross-the-edge', 'file.txt', 'Reaper', 'Projects', 'Pinshot', 'mocks', 'renderer.js'];

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 });
const args = ['--setting-sources', 'project,local', '--model', 'haiku'];
const child = pty.spawn('cmd.exe', ['/c', 'claude', ...args],
  { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: REPO, env });
child.onData(d => term.write(d));

function rows() {
  const b = term.buffer.active, out = [];
  for (let y = 0; y < b.length; y++) {
    const l = b.getLine(y);
    if (!l) continue;
    const full = l.translateToString(false);
    const text = full.replace(/\s+$/, '');
    out.push({ y, isWrapped: l.isWrapped, text, lastCol: text.length - 1,
      indent: (text.match(/^\s*/) || [''])[0].length });
  }
  return out;
}
function dump(label, from) {
  const all = rows().filter(r => r.y >= from);
  console.log(`\n=== ${label} (cols ${COLS}) ===`);
  for (const r of all) {
    if (!process.argv.includes('--all') && !MARKS.some(m => r.text.includes(m))) continue;
    console.log(`y=${String(r.y).padStart(3)} wrapped=${r.isWrapped ? 'Y' : 'n'} last=${String(r.lastCol).padStart(3)} `
      + `indent=${r.indent} |${r.text}|`);
  }
  return all;
}
const screenText = () => rows().map(r => r.text).join('\n');
async function until(pred, ms) {
  for (let t = 0; t < ms; t += 250) { if (pred()) return true; await sleep(250); }
  return false;
}
async function type(s) { for (const ch of s) { child.write(ch); await sleep(4); } }

(async () => {
  let code = 0;
  try {
    const up = await until(() => /❯/.test(screenText()), 40000);
    console.log(`claude ${up ? 'is up' : 'DID NOT COME UP'}`);
    console.log(`buffer: ${term.buffer.active.type}, length ${term.buffer.active.length}`);
    if (!up) { console.log(screenText()); throw new Error("no prompt"); }
    await sleep(2000);

    // (1) bash mode: no model call.
    let from = term.buffer.active.length;
    child.write('!'); await sleep(600);
    await type(`echo 'Wrote ${LONG} and then ${SPACED} is the second one, ok'`);
    child.write('\r');
    await until(() => screenText().includes('second one, ok'), 15000);
    await sleep(2500);
    dump("bash-mode echo", 0);

    if (!process.argv.includes('--no-model')) {
      from = term.buffer.active.length;
      await type('Reply with exactly the next three lines and nothing else, keeping all markdown as is. '
        + `Line 1: Saved it to ${LONG} as asked. `
        + `Line 2: The script is \`${SPACED}\` and the code is at \`app/renderer.js:594\`. `
        + 'Line 3: Open the [mocks](C:\\Users\\ricar\\AppData\\Local\\Temp\\git-tree-mocks.html) now.');
      child.write('\r');
      // The prompt itself shows "Open the" once; the reply is the second one.
      await until(() => screenText().split('Open the').length - 1 >= 2, 90000);
      await sleep(4000);
      dump("assistant reply", 0);
    }
  } catch (err) {
    console.error('probe error:', err.message);
    code = 1;
  } finally {
    try { child.kill(); } catch {}
    await sleep(1000);
    process.exit(code);
  }
})();
