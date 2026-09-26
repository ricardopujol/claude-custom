'use strict';
/**
 * The harness's statusLine command. Claude Code runs it with a JSON document
 * on stdin; this forwards that document to the host as a `Status` event, then
 * runs the USER's own statusLine command on the same stdin and passes its
 * output through as the status line.
 *
 *   node status-relay.js --pipe <bare pipe name> [--then <base64 command>]
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
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const FORWARD_TIMEOUT_MS = 300;
// How long the user's own statusLine command may run (Dexter r2 N6). Without
// a bound a hung command (a network call, say) was awaited forever, and each
// re-fire left one more of it behind.
const USER_TIMEOUT_MS = 5000;

// The whole tree: with shell:true the user's command runs UNDER a shell, and
// killing only the shell leaves the command itself running.
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

function parseArgs(argv) {
  const out = { pipe: null, then: null };
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--pipe') out.pipe = argv[i + 1];
    else if (argv[i] === '--then') out.then = argv[i + 1];
  }
  return out;
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
      // detached on POSIX makes the shell a process-group leader, so killTree
      // can reach its children; on Windows taskkill /T walks the tree instead.
      child = spawn(command, {
        shell: true, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true,
        detached: process.platform !== 'win32',
      });
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
  const { pipe, then } = parseArgs(argv);
  const [, code] = await Promise.all([forward(pipe, input), runUser(then, input)]);
  return code;
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    relay(process.argv.slice(2), input).then((code) => { process.exitCode = code; });
  });
}

module.exports = { parseArgs, relay, forward, runUser, USER_TIMEOUT_MS };
