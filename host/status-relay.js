'use strict';
/**
 * The harness's statusLine command. Claude Code runs it with a JSON document
 * on stdin; this forwards that document to the host as a `Status` event, then
 * runs the USER's own statusLine command on the same stdin and passes its
 * output through as the status line.
 *
 *   node status-relay.js --pipe <bare pipe name> [--then <base64 command>]
 *                        [--quiet-when <chrome-global.json>]
 *
 * --quiet-when (BACKLOG #27): when that file says `statusInHeader: true`, the
 * user's command doesn't run and nothing is printed, so the CLI drops its
 * status row (MEASURED, verify/probe-footer-rows.js) and the tab header draws
 * the fields instead. The document is still forwarded either way.
 *
 * Hidden is the DEFAULT (BACKLOG #67), but not decided here: the relay is
 * re-read from disk on every fire while a running Electron main keeps its old
 * code, so the two must never disagree about a missing key. Main writes
 * `statusInHeader: true` into the file when none is chosen
 * (app/window-chrome-bridge.js ensureStatusDefault), and this stays strict.
 *
 * Why it exists: the document carries model.id and effort.level and re-fires
 * ~1s after /model and /effort with no turn (verify/probe-top-bar-truth.js),
 * the truth FF12's top bar resolves a switch against. `--settings` replaces
 * the user's statusLine wholesale, so without the chain their status line
 * would vanish. See host/settings-writer.js.
 *
 * Written to fail QUIETLY in both directions: no host listening must not
 * stall or blank the user's status line, and a user command that fails must
 * not stop the host hearing the truth. The two run concurrently.
 */
const fs = require('fs');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const FORWARD_TIMEOUT_MS = 300;
// How long the user's own statusLine command may run (Dexter r2 N6). Without
// a bound a hung command (a network call, say) was awaited forever, and each
// re-fire left one more of it behind.
const USER_TIMEOUT_MS = 5000;

// The whole tree on Windows: with shell:true the user's command runs UNDER
// cmd.exe, and killing only cmd.exe leaves the command itself running. On
// POSIX the child stays in the relay's own process group (Dexter #51 F7), so
// a CLI that kills the group still reaches it; `sh -c` execs a single command,
// so killing the child is killing the command.
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* already gone */ }
}

function parseArgs(argv) {
  const out = { pipe: null, then: null, quietWhen: null };
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--pipe') out.pipe = argv[i + 1];
    else if (argv[i] === '--then') out.then = argv[i + 1];
    else if (argv[i] === '--quiet-when') out.quietWhen = argv[i + 1];
  }
  return out;
}

// BACKLOG #27: the person moved the status line into the tab header. Read on
// EVERY fire, so the toggle needs no session restart. Only an exact `true`
// quiets the row: a missing, unreadable or corrupt file prints the row as
// before, because failing toward a duplicate row beats failing toward a
// missing one.
const choseHeader = (value) => !!value && value.statusInHeader === true;

function quiet(file) {
  if (!file) return false;
  try {
    return choseHeader(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return false;
  }
}

// The bare name, rebuilt into a pipe path here -- the same division of labour
// as the native hook helper, and for the same shell-escaping reason.
function pipePath(name) {
  if (/^\\\\/.test(name)) return name;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : name;
}

function forward(pipe, input) {
  return new Promise((resolve) => {
    let doc;
    try { doc = JSON.parse(input); } catch { resolve(); return; }
    if (!pipe) { resolve(); return; }
    const sock = net.connect(pipePath(pipe), () => {
      sock.end(JSON.stringify({ event: 'Status', payload: doc }) + '\n');
    });
    const done = () => { try { sock.destroy(); } catch {} resolve(); };
    sock.on('error', done);
    sock.on('close', done);
    setTimeout(done, FORWARD_TIMEOUT_MS).unref();
  });
}

function runUser(encoded, input, { timeoutMs = USER_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!encoded) { resolve(0); return; }
    let command;
    try { command = Buffer.from(encoded, 'base64').toString('utf8'); } catch { resolve(0); return; }
    if (!command) { resolve(0); return; }
    let child;
    try {
      child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    } catch {
      resolve(1);
      return;
    }
    const timer = setTimeout(() => { killTree(child); resolve(1); }, timeoutMs);
    timer.unref();
    child.on('error', () => { clearTimeout(timer); resolve(1); });
    child.on('close', (code) => { clearTimeout(timer); resolve(typeof code === 'number' ? code : 1); });
    child.stdin.on('error', () => { /* the user command may not read stdin */ });
    child.stdin.end(input);
  });
}

async function relay(argv, input) {
  const { pipe, then, quietWhen } = parseArgs(argv);
  const [, code] = await Promise.all([
    forward(pipe, input),
    quiet(quietWhen) ? Promise.resolve(0) : runUser(then, input),
  ]);
  return code;
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    // Exit explicitly: if killTree failed, the child would otherwise hold the
    // event loop and the relay would hang with it (Miguel #51 2).
    relay(process.argv.slice(2), input).then((code) => { process.exit(code); });
  });
}

module.exports = { parseArgs, relay, forward, runUser, quiet, USER_TIMEOUT_MS };
