'use strict';
/* Where does the REAL CLI echo a submitted prompt, relative to where its cursor is when UserPromptSubmit fires?
   (re-runnable, bills the plan: two haiku turns, about a minute)

   PR #99 Dexter F6. The terminal bar (app/terminal-bar.js) hides its prompt part while the prompt's line is on
   screen, and first anchored "the line" at `baseY + cursorY` at the moment the hook event reaches the page. Every
   check of that against cmd.exe's echo proved nothing about Claude Code's Ink UI, which keeps its cursor at the
   bottom of a dynamic region (input box + footer). This drives the REAL interactive CLI in a pty, feeds its output
   to a headless xterm of the same size the page would have, and measures:

     hook      the buffer line of the cursor (baseY + cursorY) when the UserPromptSubmit hook fires, and the
               viewport's top
     echo      the buffer line where the prompt's own text is found once the CLI has drawn it (searched in the last
               rows of the buffer, by the first words of the prompt)
     offset    hook cursor line minus echo line  (positive: the cursor is BELOW the echo)

   for a one-line prompt and a five-line prompt. The result is printed and decides how the page anchors
   (app/renderer.js applyBarPrompt). Same safety as verify/probe-bedtime-signal.js --capture: a temp folder, no
   permissions skipped, claude found through `npm root -g`, only the pty it started is killed, by PID.

     node verify/probe-prompt-anchor.js            */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- hook mode: append one payload and exit ---------------------------------
if (process.argv[2] === '--log') {
  const [, , , event, file] = process.argv;
  let body = '';
  process.stdin.on('data', d => { body += d; });
  process.stdin.on('end', () => {
    fs.appendFileSync(file, JSON.stringify({ event, at: Date.now() }) + '\n');
    process.exit(0);
  });
  return;
}

function findClaude() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim();
  for (const rel of [path.join('bin', exe), 'cli.js']) {
    const p = path.join(npmRoot, '@anthropic-ai', 'claude-code', rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function main() {
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const { killPidTree } = require(path.join(ROOT, 'host', 'kill-tree'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-anchor-'));
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  const logFile = path.join(base, 'hooks.jsonl').replace(/\\/g, '/');
  const self = __filename.replace(/\\/g, '/');
  const node = process.execPath.replace(/\\/g, '/');
  const settingsFile = path.join(base, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: {
    UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: `"${node}" "${self}" --log UserPromptSubmit "${logFile}"`, timeout: 10 }] }],
  } }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ANTHROPIC_API_KEY;

  const COLS = 120, ROWS = 40;
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 10000, allowProposedApi: true });
  const claudeBin = findClaude();
  if (!claudeBin) throw new Error('claude not found under npm root -g');
  const p = pty.spawn(claudeBin, ['--model', 'haiku', '--settings', settingsFile], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: work, env });
  p.onData(d => term.write(d));
  const killed = () => { try { killPidTree(p.pid); } catch { /* gone */ } };
  process.on('exit', killed);

  const flush = () => new Promise(r => term.write('', r));
  const hooks = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length : 0);
  const lines = () => {
    const b = term.buffer.active;
    const out = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true));
    return out;
  };
  const cursorLine = () => term.buffer.active.baseY + term.buffer.active.cursorY;
  const findEcho = (needle, from) => {
    const all = lines();
    for (let i = from; i < all.length; i++) if (all[i].includes(needle)) return i;
    return -1;
  };

  const results = [];
  async function trial(label, text, needle, newline) {
    const before = hooks();
    const bufBefore = term.buffer.active.length;
    const typed = text.split('\n');
    for (let i = 0; i < typed.length; i++) {
      p.write(typed[i]);
      await sleep(150);
      if (i < typed.length - 1) { p.write(newline); await sleep(150); }
    }
    await sleep(500);
    const boxLine = cursorLine();
    p.write('\r');
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000 && hooks() <= before) await sleep(50);
    await flush();
    const hookCursor = cursorLine();
    const hookViewport = term.buffer.active.viewportY;
    const hookLen = term.buffer.active.length;
    await sleep(8000);                         // the turn runs and the CLI draws the echo
    await flush();
    const echo = findEcho(needle, 0);
    results.push({ label, promptLines: typed.length, boxCursorBeforeSubmit: boxLine, hookCursor, hookViewport, hookBufferLength: hookLen,
      echoLine: echo, echoLastLine: findEcho("ANCHORLAST", 0), offsetCursorMinusEcho: echo < 0 ? null : hookCursor - echo, finalCursor: cursorLine() });
  }

  try {
    await sleep(9000);
    const screen = lines().join('\n');
    if (/trust/i.test(screen) && /folder|files/i.test(screen)) { p.write('\r'); await sleep(5000); }
    await trial('one line', 'Reply with exactly the single word OK ANCHORONE', 'ANCHORONE', '\x1b\r');
    await trial('five lines', 'ANCHORFIRST reply with exactly the single word OK\nline two\nline three\nline four\nANCHORLAST line five', 'ANCHORFIRST', '\x1b\r');
    if (process.argv.includes('--dump')) console.log(lines().map((l, i) => `${String(i).padStart(3)}| ${l}`).slice(-45).join('\n'));
  } finally {
    killed();
  }
  for (const r of results) console.log(JSON.stringify(r));
  const found = results.filter(r => r.echoLine >= 0);
  console.log(found.length === results.length
    ? 'RESULT: the echo was found by its text in every trial; offsets above (cursor line minus echo line).'
    : 'RESULT: the echo could NOT be found by its text in every trial.');
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temp */ }
}

main().then(() => process.exit(0), (e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
