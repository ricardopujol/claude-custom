'use strict';
/**
 * Builds the settings file the host hands to `claude --settings`.
 *
 * Two measured facts shape this file; both are counter-intuitive and both are
 * recorded in verify/ with runnable probes.
 *
 * 1. `--settings` merges with the other layers at the TOP LEVEL only. Any
 *    single-valued key it supplies replaces its counterpart WHOLESALE -- a
 *    partial `statusLine: {padding: 1}` destroyed the user's `statusLine.command`.
 *    So this file carries `hooks` and, deliberately, ONE more: `statusLine`,
 *    FF12's truth source (its stdin carries model.id and effort.level and
 *    re-fires ~1s after /model and /effort -- verify/probe-top-bar-truth.js).
 *    Because it replaces the user's, it is a RELAY (host/status-relay.js) that
 *    runs the user's own command and passes its output through, and it keeps
 *    every other field of theirs. Anything else the harness needs travels
 *    through the pty environment, never through settings.
 *
 * 2. `hooks`, unlike single-valued keys, ACCUMULATES across layers. The harness
 *    therefore contributes only its OWN matchers and never copies the user's in.
 *    Unioning them would run every user hook twice.
 */

const fs = require('fs');
const path = require('path');

// Hooks run synchronously in the critical path of tool execution, so the
// matchers stay deliberately narrow. A '*' matcher would tax every Read, Grep
// and edit; the mood engine's appetite for signal is paid for in agent speed.
//
// Agent AND Bash. "Agent" is what Claude Code actually names the subagent
// tool -- "Task" is kept for older versions. Agent alone was enough for the
// mood engine, but the process
// panel needs to see a Bash command START, not only finish -- a four-minute GPU
// job that only reports on completion is invisible for the whole time it
// matters. Bash already pays a PostToolUse hook, so this adds one more ~23ms
// call to Bash only, not to Read/Grep/Edit.
//
// SendMessage, on its RESULT only: a message to a finished agent resumes it,
// with no Agent call at all, and the result names the run it resumed or
// queued for (host/mood-machine.js message()). Not PreToolUse: a send that
// is denied or blocked never runs, so its intent opens nothing. And with no
// PreToolUse, a message never shows as a running process. SendMessage calls
// are rare, so the tax is negligible.
const PRE_TOOL_MATCHER = 'Agent|Task|Bash';
const POST_TOOL_MATCHER = 'Agent|Task|Bash|SendMessage';    // completion and error signals
const HOOK_TIMEOUT_SECONDS = 5;

const quote = s => `"${s}"`;

// Claude Code runs a hook command through a shell, and on Windows that shell
// may be a POSIX one. There, a backslash inside double quotes is an ESCAPE, so
// "\\.\pipe\NAME" reaches the helper as "\.\pipe\NAME" -- one backslash
// short, pointing at a pipe that does not exist. The helper then fails to
// connect, swallows the error and exits 0, so hooks stop arriving with nothing
// anywhere reporting a problem.
//
// So the argument carries NO backslashes at all: the bare pipe name, which no
// shell can corrupt. The helper rebuilds the \\.\pipe\ prefix itself, and has
// always accepted this form.
const bareName = pipeName => String(pipeName).replace(/^\\\\\.\\pipe\\/i, '');

// Forward slashes: node on Windows takes them, and no shell treats them as an
// escape (the backslash trap above, for paths).
const slashes = p => String(p).replace(/\\/g, '/');
const RELAY_MARK = 'status-relay.js';

/**
 * The statusLine entry: the relay, chained to the user's own command. The
 * user's command travels as base64 -- an alphabet with no quote, backslash,
 * `$` or backtick, so no shell between the CLI and the relay can alter it.
 * A user statusLine that is already this relay is not chained, or the relay
 * would run itself.
 */
function buildStatusLine({ nodePath, scriptPath, userStatusLine, quietWhen }, pipeName) {
  const user = userStatusLine && typeof userStatusLine === 'object' ? userStatusLine : null;
  const userCommand = user && user.type === 'command' && typeof user.command === 'string'
    && user.command && !user.command.includes(RELAY_MARK) ? user.command : null;
  let command = `${quote(slashes(nodePath))} ${quote(slashes(scriptPath))} --pipe ${quote(bareName(pipeName))}`;
  if (userCommand) command += ` --then ${Buffer.from(userCommand, 'utf8').toString('base64')}`;
  // BACKLOG #27: the file whose statusInHeader quiets the row (status-relay.js).
  if (quietWhen) command += ` --quiet-when ${quote(slashes(quietWhen))}`;
  return { padding: 0, ...(user || {}), type: 'command', command };
}

// The tool belt's hook (BACKLOG #17): rewrites an Agent spawn from the loadout.
// A SECOND PreToolUse entry, for the subagent tool ONLY. It is a Node script
// rather than the native helper because it has to read state and decide, and
// the helper is transport-only and must never block. Node's ~55 ms startup is
// therefore paid per subagent spawn, never per Read or Bash -- which is why
// this matcher must stay narrower than PRE_TOOL_MATCHER, not equal to it.
const LOADOUT_MATCHER = 'Agent|Task';
const LOADOUT_TIMEOUT_SECONDS = 5;

// Inside double quotes a POSIX shell still expands `$name` and backticks and
// ends the string at a bare `"`, so an install under `D:\$work` reaches node as
// `D://...` (PR #68, Dexter F7 / Miguel S5). Those three are backslash-escaped.
// A path without them is quoted exactly as before, so the common case is
// byte-identical; the escape assumes the POSIX shell this file already assumes
// for the backslash trap. (The two older entries still use plain `quote`.)
const quotePosixSafe = (s) => `"${String(s).replace(/(["$`])/g, '\\$1')}"`;

/** The tool belt entry, or null when it is not fully specified. */
function buildLoadoutEntry(loadoutHook) {
  const h = loadoutHook && typeof loadoutHook === 'object' ? loadoutHook : null;
  if (!h || !h.nodePath || !h.scriptPath || !h.stateDir) return null;
  const q = (p) => quotePosixSafe(slashes(p));
  const command = `${q(h.nodePath)} ${q(h.scriptPath)} --state ${q(h.stateDir)}`;
  return { matcher: LOADOUT_MATCHER, hooks: [{ type: 'command', command, timeout: LOADOUT_TIMEOUT_SECONDS }] };
}

function buildHarnessSettings({ helperPath, pipeName, statusRelay, loadoutHook } = {}) {
  if (!helperPath) throw new Error('buildHarnessSettings: helperPath is required');
  if (!pipeName) throw new Error('buildHarnessSettings: pipeName is required');

  // A native helper, not a script: Node costs 60-100ms of startup per
  // invocation and PowerShell ~200ms, paid on every matched tool call.
  const command = event =>
    `${quote(helperPath)} --pipe ${quote(bareName(pipeName))} --event ${event}`;

  const entry = (matcher, event) => ({
    matcher,
    hooks: [{ type: 'command', command: command(event), timeout: HOOK_TIMEOUT_SECONDS }],
  });

  const settings = {
    hooks: {
      PreToolUse: [entry(PRE_TOOL_MATCHER, 'PreToolUse')],
      PostToolUse: [entry(POST_TOOL_MATCHER, 'PostToolUse')],
      // A FAILED call fires this INSTEAD of PostToolUse -- never both. Without
      // it every non-zero Bash exit stayed "running" in the panel, and the mood
      // engine never saw the failure. Measured: verify/probe-failure-payloads.js.
      PostToolUseFailure: [entry(POST_TOOL_MATCHER, 'PostToolUseFailure')],
      SubagentStop: [entry('', 'SubagentStop')],
      // Once per session: the backstop that ends anything still shown running.
      SessionEnd: [entry('', 'SessionEnd')],
      // Fires once per session, not per tool call, so it adds nothing to the
      // critical path. It carries the session id, which is how the host finds
      // this session's transcript to read token spend from.
      SessionStart: [entry('', 'SessionStart')],
      // Attention: the session is blocked waiting for input. Once per prompt,
      // not per tool call.
      Notification: [entry('', 'Notification')],
      // Attention: the turn finished. Deliberately NOT SubagentStop, which
      // fires constantly mid-task.
      Stop: [entry('', 'Stop')],
      // A main-session turn opened (PR #93 Dexter F1): the subagent roster can't see a turn that calls
      // no agent, and the Git drawer's Run /merged must not type into one (host/turn-state.js). Once
      // per prompt. The helper prints nothing and always exits 0, so it never adds to or blocks a prompt.
      UserPromptSubmit: [entry('', 'UserPromptSubmit')],
    },
  };
  if (statusRelay) settings.statusLine = buildStatusLine(statusRelay, pipeName);
  const loadoutEntry = buildLoadoutEntry(loadoutHook);
  if (loadoutEntry) settings.hooks.PreToolUse.push(loadoutEntry);
  return settings;
}

/**
 * The statusLine the user would have had without the harness: the first
 * layer that defines one, in the CLI's own precedence (project-local, then
 * project, then user). Null when none is a runnable command. An unreadable
 * layer is skipped -- the CLI reports its own settings errors.
 */
function findUserStatusLine({ home, cwd } = {}) {
  const candidates = [];
  if (cwd) {
    candidates.push(path.join(cwd, '.claude', 'settings.local.json'));
    candidates.push(path.join(cwd, '.claude', 'settings.json'));
  }
  if (home) candidates.push(path.join(home, '.claude', 'settings.json'));
  for (const file of candidates) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || !('statusLine' in parsed)) continue;
    const sl = parsed.statusLine;
    const runnable = sl && typeof sl === 'object' && sl.type === 'command'
      && typeof sl.command === 'string' && sl.command;
    return runnable ? sl : null;
  }
  return null;
}

/**
 * Writes the harness's settings file and returns the path claude should be
 * given.
 *
 * `port` makes it PER-HOST, and that is a correctness fix rather than tidiness
 * (Miguel B1 / Dexter F2, found independently). This file's only content is
 * the hook matchers pointing at `pipeName`, which is derived per-pid -- so its
 * contents were per-host while its name was fixed. One host at a time used to
 * be the practical reality; this release makes two the advertised feature, and
 * the write happens ~550 lines of module init before the pty spawns. Two hosts
 * booting together therefore interleave, and project A's claude reads project
 * B's pipe name: A's tool events arrive at B's bridge, B's panels show A's
 * activity, A's show nothing, and the bind failure is logged and swallowed.
 *
 * ADDITIVE, for the same reason the per-port session token was: the shared
 * `harness-settings.json` is still written, first and unchanged, because
 * verify/probe-hook-shell.js reads it at that literal path and each probe runs
 * against a single host. Moving it would fix the window and break the probes.
 *
 * With no `port` the behaviour is exactly as before, so every existing caller
 * and every probe keeps working untouched.
 */
function writeHarnessSettings(dir, opts, port) {
  const settings = buildHarnessSettings(opts);
  const body = JSON.stringify(settings, null, 2);
  fs.mkdirSync(dir, { recursive: true });

  const shared = path.join(dir, 'harness-settings.json');
  fs.writeFileSync(shared, body);
  if (port == null) return shared;

  const own = path.join(dir, `harness-settings-${port}.json`);
  fs.writeFileSync(own, body);
  return own;
}

/**
 * Builds claude's argv. The generated settings file is attached only when the
 * native helper actually exists on disk: hooks pointing at a missing binary
 * would fire on every matched Task and Bash call and invoke nothing, degrading
 * a working session to buy a mood engine that cannot run yet. The helper
 * arrives in step 2; until then the harness runs without hooks.
 */
function buildClaudeArgs({ settingsFile, helperExists } = {}) {
  const args = ['--dangerously-skip-permissions'];
  if (helperExists && settingsFile) args.push('--settings', settingsFile);
  return args;
}

module.exports = { buildHarnessSettings, writeHarnessSettings, buildClaudeArgs, findUserStatusLine };
