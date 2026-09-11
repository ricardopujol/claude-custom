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
const { createHookBridge } = require('./hook-bridge');
const { createTerminalState } = require('./terminal-state');
const { createMoodMachine } = require('./mood-machine');
const { resolveTheme } = require('./themes');
const { portraitFor } = require('./portraits');
const { readUsage } = require('./usage');
const { backgroundFor } = require('./background');
const { createProcessTracker } = require('./processes');

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

// The bridge must be listening BEFORE claude starts, otherwise every matched
// tool call pays the helper's full connect timeout waiting for a listener that
// never appears -- strictly worse than not hooking at all.
const REGISTRY_DIR = process.env.CLAUDE_CUSTOM_REGISTRY || path.join(__dirname, '..', 'registry');
// Portraits live with the agents, in the agent-creator repo, not here: they are
// a property of the agent roster, which more than one project consumes. The
// forge writes there and the harness reads from there.
const PORTRAITS_DIR =
  process.env.CLAUDE_CUSTOM_PORTRAITS ||
  'C:\\Users\\ricar\\VibeCode\\agent-creator\\portraits';
const theme = resolveTheme(CWD, { registryDir: REGISTRY_DIR });
console.log('[host] theme          :', theme.name);

const mood = createMoodMachine();
const processes = createProcessTracker();
const describe = (agent, state) => ({ agent, state, portrait: portraitFor(agent, state, { portraitsDir: PORTRAITS_DIR }) });

// Generated once per project folder and reused by every context window on it.
const BACKGROUNDS_DIR = process.env.CLAUDE_CUSTOM_BACKGROUNDS || path.join(__dirname, '..', 'backgrounds');
const background = backgroundFor(CWD, { dir: BACKGROUNDS_DIR });
console.log('[host] background     :', path.basename(background.path), background.created ? '(new)' : '(existing)');

// The session id arrives on the SessionStart hook. Until it does, only the
// project total is knowable -- readUsage handles that rather than blocking.
let sessionId = null;
let lastUsage = null;
function currentUsage() {
  lastUsage = readUsage({ cwd: CWD, sessionId });
  return lastUsage;
}

let hookBridge = null;
if (helperExists) {
  hookBridge = createHookBridge({ pipeName: PIPE_NAME });
  hookBridge.on('event', (ev) => {
    if (ev.event === 'SessionStart' && ev.payload && ev.payload.session_id) {
      sessionId = ev.payload.session_id;
      console.log('[host] session id     :', sessionId);
    }
    mood.handle(ev);
    processes.handle(ev);
    broadcastControl({ type: 'processes', running: processes.list() });
  });
  hookBridge.on('parse-error', e => console.log('[hook!] unparseable line:', e.line.slice(0, 80)));
  hookBridge.on('error', e => console.log('[hook!] bridge error:', e.message));
  hookBridge.listening
    .then(() => console.log('[host] hook bridge listening on', PIPE_NAME))
    .catch(e => console.log('[host] hook bridge FAILED to bind:', e.message));
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

// Authoritative screen, so a GUI attaching later gets the CURRENT state rather
// than nothing until the TUI happens to repaint.
const termState = createTerminalState({ cols: 120, rows: 30 });

// Protocol: BINARY frames are raw pty bytes, TEXT frames are control JSON.
// Distinguishing by content would be wrong -- terminal output can contain
// anything, including a leading '{'.
const sendControl = (ws, msg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};
const broadcastControl = msg => { for (const ws of clients) sendControl(ws, msg); };

term.onData((data) => {
  termState.write(data);
  const frame = Buffer.from(data, 'utf8');
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
  }
});

// The machine is deliberately passive: it schedules nothing itself, so the host
// owns the clock and the transitions stay reproducible in tests.
mood.on('change', ({ agent, state }) => broadcastControl({ type: 'mood', ...describe(agent, state) }));
const moodTimer = setInterval(() => {
  mood.tick();
  processes.sweep();
  // Re-broadcast so elapsed times tick up in the GUI without the view having to
  // own a clock of its own.
  if (processes.list().length) broadcastControl({ type: 'processes', running: processes.list() });
}, 1000);
moodTimer.unref();

// Usage is re-read from the transcripts on a timer rather than tracked here:
// the transcripts are authoritative, and they already account for spend this
// harness never saw. Polled rather than watched because the file is appended to
// constantly and only the total is displayed.
const usageTimer = setInterval(() => {
  const before = lastUsage && lastUsage.session.total;
  const usage = currentUsage();
  if (usage.session.total !== before) broadcastControl({ type: 'usage', usage });
}, 5000);
usageTimer.unref();

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

  // Attach handshake: everything the view needs to draw itself, then the
  // current screen. The view holds no session state of its own, so this is the
  // only place it learns the theme, the roster or what is on the terminal.
  sendControl(ws, {
    type: 'hello',
    cwd: CWD,
    theme,
    hooks: helperExists,
    background: background.path,
    usage: currentUsage(),
    roster: mood.roster().map(r => describe(r.agent, r.state)),
    running: processes.list(),
  });
  const replay = termState.serialize();
  if (replay) ws.send(Buffer.from(replay, 'utf8'), { binary: true });

  ws.on('message', (raw, isBinary) => {
    // Control frames arrive as JSON; everything else is raw keystrokes.
    if (!isBinary) {
      const text = raw.toString();
      if (text.startsWith('{')) {
        try {
          const msg = JSON.parse(text);
          if (msg.type === 'resize') {
            term.resize(msg.cols, msg.rows);
            termState.resize(msg.cols, msg.rows);
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
  if (hookBridge) { hookBridge.close().catch(() => {}); }
  process.exit(0);
});
