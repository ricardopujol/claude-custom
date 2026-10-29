'use strict';
/**
 * PROBE: the chat view (BACKLOG #157 Hide tool lines, #149 Copy buttons; documentation/DESIGN_CHAT_VIEW.md) in a REAL window
 * with a REAL host. (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-chat-view.js        (exit 0 = every check held)
 *   CHAT_VIEW_PROBE_SHOTS=<dir>                                       also keep the screenshots there
 *
 * The unit tests pin the decisions and the DOM (jsdom). No unit test can see the chat laid over a real xterm without
 * resizing it, a real hook event travel native helper -> pipe -> host -> websocket -> page, the plain-<script> global
 * scope trap (three new files share one scope with the other ~90), the real clipboard bridge, or the type box's bytes
 * reach a real pty. This runs the whole chain over a temp git project: real hook events are delivered to the host's pipe
 * through the native helper, exactly what Claude Code's hooks do (UserPromptSubmit, PreToolUse/PostToolUse of a Bash
 * call, Notification of a permission prompt, Stop with last_assistant_message), and the terminal is a real cmd.exe session.
 *
 *   A  the scripts loaded in the real page (the three globals exist); nothing to chat about: the empty line
 *   B  a prompt, a Bash tool call and a Stop: the button swaps to the chat; it holds the You and Claude bubbles and NO tool
 *      line; the terminal underneath kept its size (no resize sent) and the chat covers exactly the terminal's rectangle
 *   C  Copy on a fenced block, on a command and Copy reply put exactly that text on the clipboard (the person's own
 *      clipboard text is put back; an image on it skips the check, never touched)
 *   D  the type box writes to the pty like typing: a command typed there runs in the terminal
 *   E  a permission prompt (Notification) flips the tab to the terminal with the one-line note; a main-session tool
 *      event (the answer) brings the chat back; a dialog still open when Ctrl+Shift+H is pressed keeps the terminal
 *   F  "Claude is working..." from a prompt to its Stop; a reply with hostile text shows as text, no element made of it
 *   G  Ctrl+Shift+H toggles; a re-attached window (hello) is handed the conversation; off shows the terminal again
 *
 * SAFE. The session's `claude` is cmd.exe (CLAUDE_CUSTOM_BIN), so nothing bills: this is NOT a real claude run, because that
 * needs a signed-in account and spends money; the hooks it fires are the payloads the CLI documents. ELECTRON_RUN_AS_NODE
 * and every CLAUDE_CUSTOM_* not passed on purpose are deleted; registry, portraits, uploads and user data are temp folders;
 * the project is a temp git repo. The only processes killed are hosts whose folder is inside the probe's temp folder and
 * the window it started, by PID: never by name. The OS clipboard is the person's: its text is read first and put back.
 */

const { spawnSync, execFileSync } = require('child_process');
const { spawnElectron } = require('./lib/launch-electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, '.harness');
const HELPER = path.join(HARNESS_DIR, 'hook-helper.exe');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { readIdentity } = require(path.join(ROOT, 'host', 'host-identity'));
const { tmpDir } = require(path.join(ROOT, 'test', 'tmp-dir'));

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmp = tmpDir('cc-probe-chat-');
const container = path.join(tmp, 'proj');
const dev = path.join(container, 'dev');
const userData = path.join(tmp, 'user-data');
const shots = process.env.CHAT_VIEW_PROBE_SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

async function waitFor(fn, ms = 20000, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const PASSED_ENV = ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_TABS_PROBE', 'CLAUDE_CUSTOM_TABS_PROBE_TOKEN',
  'CLAUDE_CUSTOM_REGISTRY', 'CLAUDE_CUSTOM_PORTRAITS', 'CLAUDE_CUSTOM_UPLOADS'];

async function launchApp(cwd) {
  const port = await freePort();
  const token = require('crypto').randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    CLAUDE_CUSTOM_BIN: 'C:\\Windows\\System32\\cmd.exe',
    CLAUDE_CUSTOM_CWD: cwd,
    CLAUDE_CUSTOM_TABS_PROBE: String(port),
    CLAUDE_CUSTOM_TABS_PROBE_TOKEN: token,
    CLAUDE_CUSTOM_REGISTRY: path.join(tmp, 'registry'),
    CLAUDE_CUSTOM_PORTRAITS: path.join(tmp, 'portraits'),
    CLAUDE_CUSTOM_UPLOADS: path.join(tmp, 'uploads'),
  };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CUSTOM_') && !PASSED_ENV.includes(k)) delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.CLAUDE_CUSTOM_REGISTRY, { recursive: true });
  const child = spawnElectron(require(path.join(ROOT, 'node_modules', 'electron')),
    [ROOT, `--user-data-dir=${userData}`], { cwd: ROOT, env }, { keepEnv: PASSED_ENV });
  hygiene.registerChild(child);
  const app = { port, token, child, out: '', exited: false };
  child.stdout.on('data', d => { app.out += d; });
  child.stderr.on('data', d => { app.out += d; });
  child.on('exit', () => { app.exited = true; hygiene.unregisterSpawnedTree(child.pid); });
  return app;
}

function command(app, cmd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: app.port });
    let buf = '';
    const done = (v) => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done({ ok: false, error: `no reply to ${cmd.cmd} in ${timeoutMs}ms` }), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ ...cmd, token: app.token }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done({ ok: false, error: 'unparseable reply' }); } }
    });
    sock.on('error', (e) => done({ ok: false, error: e.message }));
  });
}

const seenPids = require(path.join(ROOT, 'verify', 'lib', 'seen-pids')).createSeenPids();
function hostsOfThisRun() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HARNESS_DIR, 'hosts')).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
  const inside = path.resolve(tmp).toLowerCase() + path.sep;
  for (const f of files) {
    const id = readIdentity({ dir: HARNESS_DIR, port: Number(f.replace(/\.json$/, '')) });
    if (id && path.resolve(id.cwd).toLowerCase().startsWith(inside)) out.push(id);
  }
  return out;
}
function killEverything() {
  for (const id of hostsOfThisRun()) seenPids.add(id.pid, id.processStartedAt);
  seenPids.endAll();
}
hygiene.addCleanup(killEverything);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true });

// What Claude Code's hook does: the native helper writes one event to the host's pipe.
function hook(hostPid, event, payload) {
  const r = spawnSync(HELPER, ['--pipe', `\\\\.\\pipe\\claude-custom-${hostPid}`, '--event', event],
    { input: JSON.stringify({ session_id: 'probe', ...payload }), windowsHide: true });
  return r.status === 0;
}

const stateOf = async (app) => {
  const st = await command(app, { cmd: 'state' });
  for (const h of (st && st.hosts) || []) if (Number.isInteger(h.pid)) seenPids.see(h.pid);
  return st;
};
const view = (app, action, args = {}) => command(app, { cmd: 'view', action, args });
const chat = async (app) => { const r = await view(app, 'chatState'); return r && r.ok ? r : null; };
const doChat = (app, what, args = {}) => view(app, 'chatDo', { what, ...args });
const screenOf = async (app) => { const r = await view(app, 'gitScreen'); return r && r.ok ? String(r.text) : ''; };
const shoot = (app, name) => command(app, { cmd: 'screenshot', file: path.join(shots, `${name}.png`) });

const PROMPT = 'please run the tests and tell me what failed';
const TOOL_MARK = 'TOOLLINE-should-never-show';
const REPLY = [
  'Two tests failed. Run this to see them:',
  '',
  '```bash',
  'npm test -- --grep parser',
  '```',
  '',
  'Use `git status` first, and look at `src/parser.js`. A plain `word` is not a command.',
  '',
  'Reply to paste:',
  '',
  'Hi Sam, the parser tests are red. I will fix them today.',
  '',
  '> Quoted from the log: expected 3, got 4',
].join('\n');
const HOSTILE = 'Careful: <script>window.__pwned = 1</script> <img src=x onerror="window.__pwned = 2"> and [bad](javascript:window.__pwned=3)';

async function main() {
  fs.mkdirSync(dev, { recursive: true });
  git(dev, 'init', '-q', '-b', 'develop');
  git(dev, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (!fs.existsSync(HELPER)) { check('the native hook helper exists (.harness/hook-helper.exe)', false, HELPER); return; }

  const app = await launchApp(container);
  const devHost = await waitFor(async () => {
    const st = await stateOf(app);
    return ((st && st.hosts) || []).find(x => x.label === 'develop' && x.started && Number.isInteger(x.pid)) || null;
  }, 60000);
  check('0: the window is up and the dev host is running', !!devHost, devHost ? `pid ${devHost.pid}` : `exited=${app.exited} out=${app.out.slice(-600)}`);
  if (!devHost) return;
  await sleep(1500);                      // its hook bridge binds a moment after its identity is written
  const pid = devHost.pid;

  // A -----------------------------------------------------------------------------
  const first = await waitFor(() => chat(app), 15000);
  check('A: the page loaded the chat scripts in the shared global scope (a collision would have aborted renderer.js)', !!first);
  check('A: off at first: the terminal shows, the chat is hidden, the button is not pressed', !!first && first.wanted === false && first.rootHidden === true
    && first.btn.pressed === 'false' && first.btn.hidden === false, JSON.stringify(first && { w: first.wanted, h: first.rootHidden, b: first.btn }));
  hook(pid, 'SessionStart', { source: 'startup', transcript_path: path.join(tmp, 'none.jsonl') });

  // B -----------------------------------------------------------------------------
  hook(pid, 'UserPromptSubmit', { prompt: PROMPT });
  hook(pid, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: `echo ${TOOL_MARK}` } });
  hook(pid, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: `echo ${TOOL_MARK}` }, tool_response: { stdout: TOOL_MARK } });
  hook(pid, 'Stop', { last_assistant_message: REPLY });
  const before = await chat(app);
  const resizesBefore = before ? before.resizeSends : -1;
  const toggled = await doChat(app, 'toggle');
  const on = await waitFor(async () => {
    const c = await chat(app);
    return c && c.shown && c.bubbles.length >= 2 ? c : null;
  }, 15000);
  check('B: the button swaps the tab to the chat', !!toggled.ok && !!on && on.wanted === true && on.rootHidden === false && on.btn.pressed === 'true', JSON.stringify(on && { s: on.shown, b: on.bubbles.length }));
  if (on) {
    check('B: it holds the prompt as a You bubble and the reply as a Claude bubble', on.bubbles[0].cls.includes('chat-user') && on.bubbles[0].text.includes(PROMPT)
      && on.bubbles[1].cls.includes('chat-claude') && on.bubbles[1].text.includes('Two tests failed'), JSON.stringify(on.bubbles.map(b => b.cls)));
    check('B: ...and NO tool line: the Bash call and its output are not in the chat', !on.logText.includes(TOOL_MARK) && !/⏺|⎿|Ran \d+ shell/.test(on.logText));
    check('B: ...exactly two bubbles', on.bubbles.length === 2, String(on.bubbles.length));
    check('B: the terminal underneath kept its size and was sent no resize', on.term.cols === before.term.cols && on.term.rows === before.term.rows && on.resizeSends === resizesBefore,
      JSON.stringify({ before: before.term, now: on.term, sends: [resizesBefore, on.resizeSends] }));
    const r = on.rootRect, t = on.termRect;
    check('B: the chat covers the terminal\'s area', r.width >= t.width - 1 && r.height >= t.height - 1 && Math.abs(r.left - t.left) <= 12 && Math.abs(r.top - t.top) <= 12, JSON.stringify({ r, t }));
    check('B: Copy buttons exist for the code block, the command, the path, the draft, the quote, and the reply',
      ['code', 'command or path', 'draft', 'quote', 'whole reply'].every(w => on.copyButtons.some(b => (b.label || '').includes(w))) && on.copyButtons.filter(b => (b.label || '').includes('command or path')).length === 2,
      JSON.stringify(on.copyButtons.map(b => b.label)));
  }
  await sleep(300);
  await shoot(app, '1-chat');

  // C -----------------------------------------------------------------------------
  const code = await doChat(app, 'copy', { label: 'this code' });
  check('C: Copy on the fenced block puts exactly its text on the clipboard', code.ok && (code.skipped || code.copied === 'npm test -- --grep parser'), JSON.stringify(code));
  const cmd = await doChat(app, 'copy', { label: 'command or path', index: 0 });
  check('C: Copy on `git status` puts exactly the command on the clipboard', cmd.ok && (cmd.skipped || cmd.copied === 'git status'), JSON.stringify(cmd));
  const draft = await doChat(app, 'copy', { label: 'this draft' });
  check('C: Copy on the draft puts exactly the draft on the clipboard', draft.ok && (draft.skipped || draft.copied === 'Hi Sam, the parser tests are red. I will fix them today.'), JSON.stringify(draft));
  const reply = await doChat(app, 'copy', { label: 'whole reply' });
  check('C: Copy reply puts the whole reply, as written, on the clipboard', reply.ok && (reply.skipped || reply.copied === REPLY), JSON.stringify(reply && { ok: reply.ok, skipped: reply.skipped, len: reply.copied && reply.copied.length }));

  // D -----------------------------------------------------------------------------
  const typed = await doChat(app, 'type', { text: 'echo chat-typed-ok' });
  check('D: the type box accepted the message and cleared itself', !!typed.ok && typed.boxAfter === '', JSON.stringify(typed));
  const ran = await waitFor(async () => (await screenOf(app)).split('\n').some(l => l.trim() === 'chat-typed-ok') ? true : null, 15000);
  check('D: ...and it reached the pty like typing: the command RAN in the terminal underneath', !!ran);

  // F ------------------------------------------------------------------------------
  hook(pid, 'UserPromptSubmit', { prompt: 'second question' });
  const working = await waitFor(async () => { const c = await chat(app); return c && c.working ? c : null; }, 10000);
  check('F: "Claude is working..." shows while the turn is open', !!working);
  hook(pid, 'Stop', { last_assistant_message: HOSTILE });
  const done = await waitFor(async () => { const c = await chat(app); return c && !c.working && c.bubbles.length === 4 ? c : null; }, 10000);
  check('F: ...and goes at its Stop, the reply arriving as the fourth bubble', !!done, JSON.stringify(done && done.bubbles.length));
  check('F: hostile reply text shows as text', !!done && done.logText.includes('<script>window.__pwned = 1</script>') && done.logText.includes('onerror='));
  const hostile = await view(app, 'gitScreen');   // any op: the page must still answer
  check('F: ...and made no element and ran nothing (the page answers, no __pwned)', hostile.ok === true);
  await shoot(app, '2-working-and-hostile');

  // E ------------------------------------------------------------------------------
  hook(pid, 'UserPromptSubmit', { prompt: 'edit a file' });
  hook(pid, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Write' });
  const flipped = await waitFor(async () => { const c = await chat(app); return c && c.rootHidden && !c.flip.hidden ? c : null; }, 10000);
  check('E: a permission prompt flips the tab to the terminal with a one-line note', !!flipped && /needs you/i.test(flipped.flip.text) && !flipped.flip.text.includes('\n'), JSON.stringify(flipped && flipped.flip));
  check('E: ...the switch itself is still on (it is remembered; only the display stepped aside)', !!flipped && flipped.wanted === true && flipped.btn.pressed === 'true');
  await shoot(app, '3-flipped-to-terminal');
  await doChat(app, 'key');
  const off = await waitFor(async () => { const c = await chat(app); return c && c.wanted === false ? c : null; }, 5000);
  await doChat(app, 'key');
  const stillTerminal = await waitFor(async () => { const c = await chat(app); return c && c.wanted === true ? c : null; }, 5000);
  check('E: pressing the shortcut twice while the dialog is open toggles the switch but the terminal keeps showing', !!off && !!stillTerminal && stillTerminal.rootHidden === true);
  hook(pid, 'PostToolUse', { tool_name: 'Write', tool_use_id: 't2', tool_input: { file_path: 'x' }, tool_response: {} });
  const back = await waitFor(async () => { const c = await chat(app); return c && !c.rootHidden && c.flip.hidden ? c : null; }, 10000);
  check('E: the turn resuming (the answer: a main-session tool event) brings the chat back, the note gone', !!back);
  hook(pid, 'Stop', { last_assistant_message: 'Written.' });

  // G ------------------------------------------------------------------------------
  const count = (await chat(app)).bubbles.length;
  await view(app, 'reconnect', { blur: true });
  const again = await waitFor(async () => { const c = await chat(app); return c && c.bubbles.length === count && !c.rootHidden ? c : null; }, 20000);
  check('G: a re-attached window (hello) is handed the whole conversation and shows the chat', !!again, JSON.stringify(await chat(app).then(c => c && c.bubbles.length)));
  await doChat(app, 'toggle');
  const terminalBack = await waitFor(async () => { const c = await chat(app); return c && c.rootHidden && c.wanted === false && c.btn.pressed === 'false' ? c : null; }, 5000);
  check('G: the button again shows the terminal', !!terminalBack);
  check('G: ...which is the real terminal: the earlier typed command\'s output is still on its screen', (await screenOf(app)).includes('chat-typed-ok'));
  await shoot(app, '4-terminal-again');

  await command(app, { cmd: 'quit' });
}

main()
  .catch((err) => { console.log(`FAIL  probe crashed: ${err && err.stack}`); failures++; })
  .finally(() => {
    hygiene._emergencyCleanup('done');
    console.log(`screenshots: ${shots}`);
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });
