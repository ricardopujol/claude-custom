'use strict';
/**
 * claude-custom :: session host  (SPIKE — step 0 walking skeleton)
 *
 * Owns the pty running the real `claude` binary and exposes it over a local
 * WebSocket so the Electron GUI can attach as a pure view.
 *
 * Deliberately runs under plain Node, NOT inside Electron: node-pty is a native
 * module and would otherwise need an ABI rebuild against Electron's headers
 * (Visual Studio build tools on Windows). This also mirrors the target
 * architecture, where the host outlives any attached GUI.
 *
 * Spike scope: no detach/reattach, no replay buffer, no hook bridge, no mood
 * state. Those arrive in step 1+. This exists to answer one question — does
 * xterm.js host the Ink TUI faithfully?
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { writeHarnessSettings, buildClaudeArgs } = require('./settings-writer');

const PORT = Number(process.env.CLAUDE_CUSTOM_PORT) || 7681;

// --- locate the real claude binary -----------------------------------------
// npm installs a native claude.exe; spawning it directly avoids a cmd.exe shim
// layer that would otherwise sit between the pty and the TUI.
function resolveClaude() {
  if (process.env.CLAUDE_CUSTOM_BIN) return process.env.CLAUDE_CUSTOM_BIN;

  const candidates = [
    path.join(
      process.env.APPDATA || '',
      'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    ),
    path.join(os.homedir(), '.local/bin/claude.exe'),
    path.join(os.homedir(), '.local/bin/claude'),
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // Fall back to PATH resolution and let the pty fail loudly if absent.
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

const CLAUDE_BIN = resolveClaude();
const CWD = process.env.CLAUDE_CUSTOM_CWD || process.cwd();

// The generated settings file contributes ONLY the harness's own hook matchers.
// It does not union the user's hooks: those accumulate across settings layers
// on their own, so copying them in would run every one of them twice. See
// verify/probe-hook-layers.js and the design doc's verification section.
const SESSION_ID = process.env.CLAUDE_CUSTOM_SESSION_ID || String(process.pid);
const PIPE_NAME = `\\\\.\\pipe\\claude-custom-${SESSION_ID}`;
const HARNESS_DIR = path.join(__dirname, '..', '.harness');
const HELPER_PATH =
  process.env.CLAUDE_CUSTOM_HELPER || path.join(HARNESS_DIR, 'hook-helper.exe');

const settingsFile = writeHarnessSettings(HARNESS_DIR, {
  helperPath: HELPER_PATH,
  pipeName: PIPE_NAME,
});

// Attached only once the native helper exists (step 2). Wiring hooks to a
// missing binary would fire on every Task and Bash call and invoke nothing.
const helperExists = fs.existsSync(HELPER_PATH);
const ARGS = buildClaudeArgs({ settingsFile, helperExists });

if (!helperExists) {
  console.log('[host] hook helper absent — running without hooks:', HELPER_PATH);
}

console.log('[host] claude binary :', CLAUDE_BIN);
console.log('[host] cwd           :', CWD);

// Inherited CLAUDE_CODE_* markers must not leak into the hosted session.
// Measured: launching the host from inside an existing claude session passes
// CLAUDE_CODE_CHILD_SESSION down, and the child silently disables transcript
// saving — which would take `--resume` with it. The harness owns a top-level
// session, never a child one.
// Explicit denylist, NOT a CLAUDE_CODE_* wildcard: that namespace also carries
// legitimate user configuration (e.g. CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS),
// which the harness has no business dropping. Only session-identity markers go.
const INHERITED_SESSION_VARS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDECODE',
];

function cleanEnv() {
  const env = { ...process.env };
  for (const k of INHERITED_SESSION_VARS) delete env[k];
  return env;
}

const term = pty.spawn(CLAUDE_BIN, ARGS, {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: CWD,
  env: {
    ...cleanEnv(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // Marks this session as harness-hosted; the hook bridge keys off it later.
    CLAUDE_CUSTOM_SESSION: '1',
  },
});

console.log('[host] pty pid       :', term.pid);

// --- attach surface ---------------------------------------------------------
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
const clients = new Set();

term.onData((data) => {
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
});

term.onExit(({ exitCode, signal }) => {
  console.log(`[host] claude exited code=${exitCode} signal=${signal}`);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({ type: 'exit', exitCode, signal })
      );
    }
  }
  process.exit(exitCode ?? 0);
});

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[host] client attached (${clients.size} total)`);

  ws.on('message', (raw, isBinary) => {
    // Control frames arrive as JSON; everything else is raw keystrokes.
    if (!isBinary) {
      const text = raw.toString();
      if (text.startsWith('{')) {
        try {
          const msg = JSON.parse(text);
          if (msg.type === 'resize') {
            term.resize(msg.cols, msg.rows);
            return;
          }
          if (msg.type === 'input') {
            term.write(msg.data);
            return;
          }
        } catch {
          // Not control JSON — fall through and treat as literal input.
        }
      }
      term.write(text);
      return;
    }
    term.write(raw.toString('utf8'));
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[host] client detached (${clients.size} remain)`);
    // NOTE: the pty deliberately keeps running. This is the detachable-session
    // property the phone/Remote Control workflow depends on.
  });
});

console.log(`[host] listening on ws://127.0.0.1:${PORT}`);

process.on('SIGINT', () => {
  try { term.kill(); } catch {}
  process.exit(0);
});
