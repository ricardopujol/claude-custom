'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildHarnessSettings, writeHarnessSettings, OCCUPANCY_MATCHER, BEDTIME_MATCHER } = require('../host/settings-writer');
const { posixShell } = require('./posix-shell');

const HELPER = 'C:/tools/claude-custom-hook.exe';
const PIPE = '\\\\.\\pipe\\claude-custom-abc123';
const opts = { helperPath: HELPER, pipeName: PIPE };

test('without a status relay, supplies exactly one top-level key: hooks', () => {
  // Load-bearing. --settings replaces single-valued keys WHOLESALE, so any
  // extra key here would silently destroy the user's version of it. Measured:
  // a partial statusLine object wiped the user's statusLine.command. The one
  // deliberate exception, statusLine as a chaining relay, is pinned in
  // test/status-relay.test.js.
  const s = buildHarnessSettings(opts);
  assert.deepStrictEqual(Object.keys(s), ['hooks']);
});

test('does NOT union the user hooks', () => {
  // Hooks ACCUMULATE across layers (verify/probe-hook-layers.js), so including
  // the user's hooks would run every one of them twice.
  const userHooks = {
    PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'sync-agent.ps1' }] }],
  };
  const s = buildHarnessSettings({ ...opts, userHooks });
  const commands = JSON.stringify(s.hooks);
  assert.ok(!commands.includes('sync-agent.ps1'), 'user hook command must not be copied in');
});

test('PreToolUse covers Task and Bash, and no read or edit tool', () => {
  // Hooks run synchronously in the critical path of tool execution, measured at
  // ~23ms each. A '*' matcher taxes every Read, Grep and edit.
  //
  // Bash was added deliberately: the process panel has to see a command START,
  // not only finish -- a four-minute GPU job that reports only on completion is
  // invisible for the whole time it matters. Bash already paid a PostToolUse
  // hook, so this is one more call on Bash, not a widening to every file op.
  const s = buildHarnessSettings(opts);
  const matchers = s.hooks.PreToolUse.map(e => e.matcher);
  assert.strictEqual(matchers.length, 1);
  const m = matchers[0];
  assert.ok(/Task/.test(m) && /Bash/.test(m), m);
  assert.ok(!m.includes('*'), 'wildcard matcher would tax every tool call');
  for (const tool of ['Read', 'Grep', 'Edit', 'Write', 'Glob']) {
    // `\\b`, not `\b`: inside a template literal `\b` is a backspace, and the
    // check could never fail.
    assert.ok(!new RegExp(`\\b${tool}\\b`).test(m), `${tool} must not be matched`);
  }
});

// A message to a finished agent RESUMES it, with no Agent call; unhooked, the
// resumed agent never showed working and a hidden card never came back. The
// SendMessage RESULT names the run it resumed (host/mood-machine.js
// message()); its PreToolUse is only intent, and a denied send never runs.
test('SendMessage is hooked on its result, not on PreToolUse', () => {
  const s = buildHarnessSettings(opts);
  assert.ok(/\bSendMessage\b/.test(s.hooks.PostToolUse[0].matcher), s.hooks.PostToolUse[0].matcher);
  assert.ok(!/\bSendMessage\b/.test(s.hooks.PreToolUse[0].matcher), 'intent alone opens nothing');
});

test('PostToolUse covers Task and Bash, and no read or edit tool', () => {
  const s = buildHarnessSettings(opts);
  const matchers = s.hooks.PostToolUse.map(e => e.matcher);
  assert.strictEqual(matchers.length, 1);
  const m = matchers[0];
  assert.ok(/\bTask\b/.test(m) && /\bBash\b/.test(m), `expected Task and Bash, got ${m}`);
  for (const tool of ['Read', 'Grep', 'Edit', 'Write', 'Glob']) {
    assert.ok(!new RegExp(`\\b${tool}\\b`).test(m), `${tool} must not be matched`);
  }
});

test('SubagentStop is hooked so agents can return to sleeping', () => {
  const s = buildHarnessSettings(opts);
  assert.ok(Array.isArray(s.hooks.SubagentStop) && s.hooks.SubagentStop.length > 0);
});

test('hooks only the events the harness actually consumes', () => {
  const s = buildHarnessSettings(opts);
  assert.deepStrictEqual(
    Object.keys(s.hooks).sort(),
    ['Notification', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart',
     'Stop', 'SubagentStop', 'UserPromptSubmit']
  );
});

test('every registered event has exactly one entry whose command names that event (an emptied list or a wrong event fails)', () => {
  const s = buildHarnessSettings(opts);
  for (const [event, entries] of Object.entries(s.hooks)) {
    assert.strictEqual(entries.length, 1, `${event} has its one entry`);
    assert.strictEqual(entries[0].hooks.length, 1, `${event} runs one command`);
    assert.match(entries[0].hooks[0].command, new RegExp(`--event ${event}$`), `${event} reports itself`);
  }
  // Attention (blocked on input) and turn-finished must not be droppable unnoticed.
  assert.strictEqual(s.hooks.Notification[0].matcher, '');
  assert.strictEqual(s.hooks.Stop[0].matcher, '');
});

test('UserPromptSubmit is hooked, every prompt, so the host knows a main-session turn opened (PR #93 Dexter F1)', () => {
  // The subagent roster can't see a turn that calls no agent: Type /merged typed into one. The helper prints
  // nothing and always exits 0 (helper/hook-helper.cs), so the hook can never add to or block a prompt.
  const s = buildHarnessSettings(opts);
  assert.ok(Array.isArray(s.hooks.UserPromptSubmit) && s.hooks.UserPromptSubmit.length === 1);
  assert.strictEqual(s.hooks.UserPromptSubmit[0].matcher, '');
  assert.match(s.hooks.UserPromptSubmit[0].hooks[0].command, /--event UserPromptSubmit$/);
});

test('PostToolUseFailure is hooked with exactly the PostToolUse matcher', () => {
  // A failed call fires PostToolUseFailure INSTEAD of PostToolUse (measured by
  // verify/probe-failure-payloads.js). Unhooked, every non-zero Bash exit was
  // left "running" in the panel. Same matcher, or a tool closes on success and
  // leaks on failure.
  const s = buildHarnessSettings(opts);
  assert.ok(Array.isArray(s.hooks.PostToolUseFailure) && s.hooks.PostToolUseFailure.length === 1);
  assert.strictEqual(s.hooks.PostToolUseFailure[0].matcher, s.hooks.PostToolUse[0].matcher);
  assert.match(s.hooks.PostToolUseFailure[0].hooks[0].command, /--event PostToolUseFailure$/);
});

test('SessionEnd is hooked so a finished session leaves nothing running', () => {
  const s = buildHarnessSettings(opts);
  assert.ok(Array.isArray(s.hooks.SessionEnd) && s.hooks.SessionEnd.length === 1);
  assert.strictEqual(s.hooks.SessionEnd[0].matcher, '');
  assert.match(s.hooks.SessionEnd[0].hooks[0].command, /--event SessionEnd$/);
});

test('SessionStart is hooked so the host learns the session id', () => {
  // Token spend is read from the session's own transcript file, which is named
  // by session id. Without this the host can only report the project total.
  // It fires once per session, so it costs nothing in the tool-call path.
  const s = buildHarnessSettings(opts);
  assert.ok(Array.isArray(s.hooks.SessionStart) && s.hooks.SessionStart.length > 0);
  assert.strictEqual(s.hooks.SessionStart[0].matcher, '');
});

test('every hook invokes the native helper with the pipe name', () => {
  // A Node hook costs 60-100ms of startup per invocation; PowerShell ~200ms.
  const s = buildHarnessSettings(opts);
  const entries = Object.values(s.hooks).flat().flatMap(e => e.hooks);
  assert.ok(entries.length >= 3);
  for (const h of entries) {
    assert.strictEqual(h.type, 'command');
    assert.ok(h.command.includes(HELPER), `helper missing in: ${h.command}`);
    // The NAME, not the \\.\pipe\ form: the command must reach the helper
    // through a shell, and that prefix does not survive one. See the
    // shell-survival tests below.
    assert.ok(h.command.includes(PIPE.split('\\').pop()),
      `pipe name missing in: ${h.command}`);
  }
});

test('a helper path containing spaces is quoted', () => {
  const s = buildHarnessSettings({ ...opts, helperPath: 'C:/Program Files/cc/hook.exe' });
  const cmd = s.hooks.PreToolUse[0].hooks[0].command;
  assert.ok(/"C:\/Program Files\/cc\/hook\.exe"/.test(cmd), `not quoted: ${cmd}`);
});

test('every hook carries a timeout so a wedged helper cannot hang a tool call', () => {
  const s = buildHarnessSettings(opts);
  for (const h of Object.values(s.hooks).flat().flatMap(e => e.hooks)) {
    assert.ok(typeof h.timeout === 'number' && h.timeout > 0, 'missing timeout');
  }
});

test('writeHarnessSettings writes parseable JSON and returns its path', () => {
  const dir = tmpDir('cc-writer-');
  const p = writeHarnessSettings(dir, opts);
  assert.ok(fs.existsSync(p), 'file not written');
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepStrictEqual(parsed, buildHarnessSettings(opts));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeHarnessSettings creates the directory if absent', () => {
  const dir = path.join(tmpDir('cc-writer-'), 'nested', 'deep');
  const p = writeHarnessSettings(dir, opts);
  assert.ok(fs.existsSync(p));
  fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
});

test('rejects a missing helper path rather than emitting a broken hook', () => {
  assert.throws(() => buildHarnessSettings({ pipeName: PIPE }), /helperPath/);
});

test('rejects a missing pipe name', () => {
  assert.throws(() => buildHarnessSettings({ helperPath: HELPER }), /pipeName/);
});

// --- claude argv construction -------------------------------------------

const { buildClaudeArgs } = require('../host/settings-writer');
const { tmpDir } = require('./tmp-dir');

test('omits --settings entirely when the native helper is absent', () => {
  // The helper arrives in step 2. Until it exists, pointing hooks at a missing
  // binary would make every matched Task and Bash call invoke nothing --
  // degrading the live session to buy a mood engine that cannot work yet.
  const args = buildClaudeArgs({ settingsFile: 'C:/h/s.json', helperExists: false });
  assert.ok(!args.includes('--settings'), `unexpected --settings in ${JSON.stringify(args)}`);
});

test('passes --settings with the file once the helper exists', () => {
  const args = buildClaudeArgs({ settingsFile: 'C:/h/s.json', helperExists: true });
  const i = args.indexOf('--settings');
  assert.ok(i >= 0, 'expected --settings');
  assert.strictEqual(args[i + 1], 'C:/h/s.json');
});

test('always keeps permissions bypassed, helper or not', () => {
  for (const helperExists of [true, false]) {
    const args = buildClaudeArgs({ settingsFile: 'C:/h/s.json', helperExists });
    assert.ok(args.includes('--dangerously-skip-permissions'), `missing for ${helperExists}`);
  }
});

// --- shell survival ---------------------------------------------------------
// Claude Code runs a hook command through a shell. On Windows that shell can be
// a POSIX one (Git Bash), where a backslash inside double quotes is an ESCAPE:
// the pipe name arrives one backslash short, the helper cannot open it, catches
// the failure and exits 0 -- so hooks silently never arrive. That is what both
// "agents deploy but the roster stays empty" and "no notification when a task
// ends" actually were.

test('the pipe argument carries no backslashes for a shell to eat', () => {
  const s = buildHarnessSettings({ helperPath: 'C:\\h\\hook-helper.exe', pipeName: '\\\\.\\pipe\\claude-custom-42' });
  const cmd = s.hooks.PreToolUse[0].hooks[0].command;
  const pipeArg = /--pipe\s+("[^"]*"|\S+)/.exec(cmd)[1];
  assert.ok(!pipeArg.includes('\\'), `pipe argument still has backslashes: ${pipeArg}`);
});

test('the pipe name keeps its identity, prefix aside', () => {
  // The helper rebuilds the prefix, so the NAME must survive intact or it
  // connects to the wrong pipe rather than to none.
  const s = buildHarnessSettings({ helperPath: 'C:\\h\\hook-helper.exe', pipeName: '\\\\.\\pipe\\claude-custom-7124' });
  assert.ok(s.hooks.Stop[0].hooks[0].command.includes('claude-custom-7124'));
});

test('a pipe name given bare is passed through as-is', () => {
  const s = buildHarnessSettings({ helperPath: 'C:\\h\\x.exe', pipeName: 'plain-name' });
  assert.ok(/--pipe\s+"?plain-name"?\s/.test(s.hooks.Stop[0].hooks[0].command));
});

test('every event command is shell-safe, not just PreToolUse', () => {
  const s = buildHarnessSettings({ helperPath: 'C:\\h\\x.exe', pipeName: '\\\\.\\pipe\\p-1' });
  for (const [event, entries] of Object.entries(s.hooks)) {
    for (const e of entries) {
      for (const h of e.hooks) {
        const pipeArg = /--pipe\s+("[^"]*"|\S+)/.exec(h.command)[1];
        assert.ok(!pipeArg.includes('\\'), `${event}: ${h.command}`);
      }
    }
  }
});

test('two hosts get two settings FILES, so neither can redirect the other\'s hooks', () => {
  // Miguel B1 / Dexter F2, both found independently. The settings file's only
  // content is this host's hook matchers pointing at PIPE_NAME, which is
  // derived per-pid -- so its CONTENTS are per-host while its NAME was fixed.
  //
  // This PR is what made that dangerous: one host at a time used to be the
  // practical reality, and two is now the advertised feature. Within a single
  // host the write and the pty spawn are ~550 lines of synchronous module init
  // apart, so two hosts booting together interleave as:
  //
  //   A writes settings(pipe A)
  //   B overwrites with settings(pipe B)
  //   A's claude starts, reads the file, connects to B's pipe
  //
  // Project A's tool events then arrive at project B's bridge: B's roster,
  // mood engine and toasts show A's activity, A's show nothing, and the bind
  // failure is logged and swallowed. Right window, wrong project's data --
  // exactly what the handshake removes, one layer down.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = tmpDir('cc-settings-');

  const a = writeHarnessSettings(dir, { helperPath: 'h.exe', pipeName: 'PIPE-A' }, 7701);
  const b = writeHarnessSettings(dir, { helperPath: 'h.exe', pipeName: 'PIPE-B' }, 7702);

  assert.notStrictEqual(a, b, 'two hosts must not share one settings file');
  assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(a, 'utf8'))).includes('PIPE-A'),
    "host A's file must still name host A's pipe after host B has written");
  assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(b, 'utf8'))).includes('PIPE-B'));
});

test('the shared settings file is STILL written, because probes read it by that exact name', () => {
  // Additive, exactly like the per-port token. verify/probe-hook-shell.js reads
  // .harness/harness-settings.json by its literal path, and each probe runs
  // against a single host -- so moving the file would fix the window and break
  // the probes. Fixing one thing by breaking another is not a fix.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = tmpDir('cc-settings-');

  writeHarnessSettings(dir, { helperPath: 'h.exe', pipeName: 'PIPE-A' }, 7701);
  assert.ok(fs.existsSync(path.join(dir, 'harness-settings.json')),
    'the fixed-name file must keep being written for the probes');
});

// --- the tool belt's hook (BACKLOG #17) ---------------------------------------

const loadoutHook = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  scriptPath: 'C:\\proj\\claude-custom\\host\\loadout-hook.js',
  stateDir: 'C:\\proj\\claude-custom\\.harness\\state',
};

test('the tool belt adds a SECOND PreToolUse entry for Agent|Task only', () => {
  const s = buildHarnessSettings({ ...opts, loadoutHook });
  assert.strictEqual(s.hooks.PreToolUse.length, 2);
  const entry = s.hooks.PreToolUse[1];
  assert.strictEqual(entry.matcher, 'Agent|Task');
  assert.strictEqual(entry.hooks.length, 1);
  assert.strictEqual(entry.hooks[0].type, 'command');
  assert.ok(entry.hooks[0].command.includes('loadout-hook.js'));
  assert.ok(entry.hooks[0].command.includes('--state'));
  // Node startup is paid per matched call: Bash must never be in this matcher.
  assert.ok(!/Bash/.test(entry.matcher));
});

test('the native helper entry is byte-identical with or without the tool belt', () => {
  const without = buildHarnessSettings(opts);
  const withHook = buildHarnessSettings({ ...opts, loadoutHook });
  assert.strictEqual(JSON.stringify(withHook.hooks.PreToolUse[0]), JSON.stringify(without.hooks.PreToolUse[0]));
  for (const event of Object.keys(without.hooks)) {
    if (event === 'PreToolUse') continue;
    assert.strictEqual(JSON.stringify(withHook.hooks[event]), JSON.stringify(without.hooks[event]), event);
  }
});

test('without loadoutHook, PreToolUse is exactly what it always was', () => {
  assert.strictEqual(buildHarnessSettings(opts).hooks.PreToolUse.length, 1);
});

test('the tool belt command carries no backslash at all (a POSIX shell eats them inside quotes)', () => {
  const s = buildHarnessSettings({ ...opts, loadoutHook });
  const command = s.hooks.PreToolUse[1].hooks[0].command;
  assert.ok(!command.includes('\\'), command);
  assert.ok(command.includes('C:/proj/claude-custom/host/loadout-hook.js'), command);
  assert.ok(command.includes('C:/proj/claude-custom/.harness/state'), command);
  assert.ok(command.startsWith('"C:/Program Files/nodejs/node.exe" '), command);
});

test('a bare `node` works as nodePath (the Electron host runs it from PATH)', () => {
  const s = buildHarnessSettings({ ...opts, loadoutHook: { ...loadoutHook, nodePath: 'node' } });
  assert.ok(s.hooks.PreToolUse[1].hooks[0].command.startsWith('"node" '));
});

test('the tool belt hook has a timeout, and it is short', () => {
  const t = buildHarnessSettings({ ...opts, loadoutHook }).hooks.PreToolUse[1].hooks[0].timeout;
  assert.strictEqual(typeof t, 'number');
  assert.ok(t > 0 && t <= 10);
});

test('a half-specified loadoutHook adds nothing rather than a broken command', () => {
  for (const bad of [{}, { nodePath: 'node' }, { ...loadoutHook, stateDir: '' }, { ...loadoutHook, scriptPath: undefined }, 'x', null]) {
    assert.strictEqual(buildHarnessSettings({ ...opts, loadoutHook: bad }).hooks.PreToolUse.length, 1, JSON.stringify(bad));
  }
});

test('F7/S5: a $, backtick or quote in the install path reaches node verbatim under a POSIX hook shell', (t) => {
  // Inside double quotes a POSIX shell expands $work and `cmd` and ends the
  // string at a bare ". `slashes` fixes the backslash trap but not these.
  const { spawnSync } = require('child_process');
  // From PowerShell `bash` is the WSL launcher, so this used to pass vacuously there (BACKLOG #72).
  const sh = posixShell();
  if (!sh) { t.skip('no POSIX shell here: nothing to be an oracle'); return; }
  const hard = 'D:\\$work\\`id`\\a"b\\claude-custom';
  const entry = buildHarnessSettings({ ...opts, loadoutHook: {
    nodePath: 'node', scriptPath: `${hard}\\host\\loadout-hook.js`, stateDir: `${hard}\\.harness\\state`,
  } }).hooks.PreToolUse[1];
  const r = spawnSync(sh, ['-c', `printf '%s\\n' ${entry.hooks[0].command}`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const words = r.stdout.split('\n').slice(0, 4);
  assert.deepStrictEqual(words, [
    'node',
    'D:/$work/`id`/a"b/claude-custom/host/loadout-hook.js',
    '--state',
    'D:/$work/`id`/a"b/claude-custom/.harness/state',
  ]);
});

test('an ordinary path is quoted exactly as before (no escapes added where none are needed)', () => {
  const s = buildHarnessSettings({ ...opts, loadoutHook });
  assert.strictEqual(s.hooks.PreToolUse[1].hooks[0].command,
    '"C:/Program Files/nodejs/node.exe" "C:/proj/claude-custom/host/loadout-hook.js" --state "C:/proj/claude-custom/.harness/state"');
});

test('the tool belt hook survives being written to disk and read back', () => {
  const dir = tmpDir('cc-settings-');
  const file = writeHarnessSettings(dir, { ...opts, loadoutHook }, 7701);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(parsed.hooks.PreToolUse[1].matcher, 'Agent|Task');
});

// Backlog #44 + #47 (worktree occupancy): the occupancy claim needs a SUBAGENT's file tool calls, and the
// host only ever saw Agent|Task|Bash. Opt-in, so the default settings are exactly what they always were.
test('occupancy adds a PreToolUse entry for the file tools, LAST, and only when asked', () => {
  const plain = buildHarnessSettings(opts);
  assert.strictEqual(plain.hooks.PreToolUse.length, 1, 'default output is unchanged');
  const s = buildHarnessSettings({ ...opts, occupancy: true });
  const last = s.hooks.PreToolUse[s.hooks.PreToolUse.length - 1];
  assert.strictEqual(last.matcher, 'Read|Edit|Write|NotebookEdit|Grep|Glob');
  // (that these are exactly host/agent-occupancy.js TOUCH_TOOLS is pinned in test/agent-occupancy.test.js)
  assert.strictEqual(JSON.stringify(s.hooks.PreToolUse[0]), JSON.stringify(plain.hooks.PreToolUse[0]),
    'the first entry still belongs to the mood engine');
  assert.strictEqual(last.hooks[0].command, plain.hooks.PreToolUse[0].hooks[0].command,
    'the same helper, the same PreToolUse event');
});

test('the occupancy entry goes AFTER the tool belt entry, so PreToolUse[1] is still the belt', () => {
  const loadoutHook = { nodePath: 'node', scriptPath: 'C:/x/loadout-hook.js', stateDir: 'C:/x/state' };
  const s = buildHarnessSettings({ ...opts, loadoutHook, occupancy: true });
  assert.strictEqual(s.hooks.PreToolUse.length, 3);
  assert.strictEqual(s.hooks.PreToolUse[1].matcher, 'Agent|Task');
  assert.strictEqual(s.hooks.PreToolUse[2].matcher, OCCUPANCY_MATCHER);
});

test('occupancy changes only PreToolUse: no other event grows a file-tool matcher', () => {
  const plain = buildHarnessSettings(opts);
  const s = buildHarnessSettings({ ...opts, occupancy: true });
  for (const event of Object.keys(plain.hooks)) {
    if (event === 'PreToolUse') continue;
    assert.strictEqual(JSON.stringify(s.hooks[event]), JSON.stringify(plain.hooks[event]), event);
  }
});

test('only a real true opts in (a truthy string is not a yes)', () => {
  for (const v of ['yes', 1, {}, [], 'false']) {
    assert.strictEqual(buildHarnessSettings({ ...opts, occupancy: v }).hooks.PreToolUse.length, 1, String(v));
  }
});

// Backlog #52 (bedtime): the night is read from the loop's own ScheduleWakeup calls, which no matcher above saw.
// Opt-in and SEPARATE entries (Pre for the call, Post for the CLI's `scheduledFor`), so the mood engine's are untouched.
test('bedtime adds a ScheduleWakeup entry to PreToolUse AND PostToolUse, after the others, and only when asked', () => {
  const plain = buildHarnessSettings(opts);
  assert.strictEqual(plain.hooks.PreToolUse.length, 1);
  assert.strictEqual(plain.hooks.PostToolUse.length, 1);
  const s = buildHarnessSettings({ ...opts, bedtime: true });
  assert.strictEqual(s.hooks.PreToolUse.length, 2);
  assert.strictEqual(s.hooks.PostToolUse.length, 2);
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const last = s.hooks[event][s.hooks[event].length - 1];
    assert.strictEqual(last.matcher, BEDTIME_MATCHER);
    assert.strictEqual(last.hooks[0].command, plain.hooks[event][0].hooks[0].command.replace(/--event \w+$/, `--event ${event}`));
    assert.strictEqual(JSON.stringify(s.hooks[event][0]), JSON.stringify(plain.hooks[event][0]), `${event}[0] still belongs to the mood engine`);
  }
  assert.strictEqual(BEDTIME_MATCHER, 'ScheduleWakeup');
});

test('bedtime changes only PreToolUse and PostToolUse, and composes with occupancy and the tool belt in a fixed order', () => {
  const plain = buildHarnessSettings(opts);
  const s = buildHarnessSettings({ ...opts, bedtime: true });
  for (const event of Object.keys(plain.hooks)) {
    if (event === 'PreToolUse' || event === 'PostToolUse') continue;
    assert.strictEqual(JSON.stringify(s.hooks[event]), JSON.stringify(plain.hooks[event]), event);
  }
  const loadoutHook = { nodePath: 'node', scriptPath: 'C:/x/loadout-hook.js', stateDir: 'C:/x/state' };
  const all = buildHarnessSettings({ ...opts, loadoutHook, occupancy: true, bedtime: true });
  assert.deepStrictEqual(all.hooks.PreToolUse.map(e => e.matcher), ['Agent|Task|Bash|TaskStop', 'Agent|Task', OCCUPANCY_MATCHER, BEDTIME_MATCHER]);
});

// BACKLOG #71: the artifact shelf is filled from the Artifact tool's own PostToolUse (host/canvas-shelf.js). Result only: a
// publish that is refused or fails has no address to put on the shelf, and PreToolUse is only intent.
test('Artifact is hooked on its result (and its failure), never on PreToolUse', () => {
  const s = buildHarnessSettings(opts);
  assert.ok(/\bArtifact\b/.test(s.hooks.PostToolUse[0].matcher), s.hooks.PostToolUse[0].matcher);
  assert.ok(/\bArtifact\b/.test(s.hooks.PostToolUseFailure[0].matcher));
  assert.ok(!/\bArtifact\b/.test(s.hooks.PreToolUse[0].matcher));
  assert.ok(!/\bArtifact\b/.test(String(OCCUPANCY_MATCHER)), 'not the occupancy entry either');
});

// BACKLOG #71: Claude's panel's MCP server rides in on --mcp-config (a CLI flag: nothing is written to the user's config, and it
// is ADDED to the user's own servers). Never --strict-mcp-config, which would switch every other server off.
const CANVAS = { nodePath: 'node', scriptPath: 'C:\\app\\host\\canvas-mcp.js', root: 'C:\\app\\.harness\\state', pointerFile: 'C:\\app\\.harness\\state\\canvas\\_tab-7.json' };

test('with the panel on, the args carry one --mcp-config whose value is a JSON string naming the server, its script and its two env vars', () => {
  const args = buildClaudeArgs({ settingsFile: 'C:/h/s.json', helperExists: true, canvasMcp: CANVAS });
  const at = args.indexOf('--mcp-config');
  assert.ok(at !== -1);
  assert.strictEqual(args.filter(a => a === '--mcp-config').length, 1);
  const cfg = JSON.parse(args[at + 1]);
  assert.deepStrictEqual(Object.keys(cfg), ['mcpServers']);
  assert.deepStrictEqual(Object.keys(cfg.mcpServers), ['canvas']);
  const s = cfg.mcpServers.canvas;
  assert.strictEqual(s.command, 'node');
  assert.deepStrictEqual(s.args, ['C:/app/host/canvas-mcp.js'], 'forward slashes: no shell treats them as an escape');
  assert.deepStrictEqual(s.env, { CLAUDE_CUSTOM_CANVAS_ROOT: 'C:/app/.harness/state', CLAUDE_CUSTOM_CANVAS_POINTER: 'C:/app/.harness/state/canvas/_tab-7.json' });
});

test('--strict-mcp-config is never passed: the user\'s own MCP servers must keep working', () => {
  for (const opts2 of [{ canvasMcp: CANVAS }, { canvasMcp: null }, {}, { helperExists: true, canvasMcp: CANVAS, settingsFile: 'x' }]) {
    assert.ok(!buildClaudeArgs(opts2).includes('--strict-mcp-config'));
  }
});

test('with the panel off (no canvasMcp) there is no --mcp-config at all, and the other args are exactly as before', () => {
  assert.deepStrictEqual(buildClaudeArgs({ settingsFile: 'C:/h/s.json', helperExists: true }), ['--dangerously-skip-permissions', '--settings', 'C:/h/s.json']);
  assert.deepStrictEqual(buildClaudeArgs({ settingsFile: 'C:/h/s.json', helperExists: true, canvasMcp: null }), ['--dangerously-skip-permissions', '--settings', 'C:/h/s.json']);
});

test('the panel DOES depend on the hook helper (PR #125 Dexter #8): without it no session id ever arrives, so it is not injected', () => {
  const args = buildClaudeArgs({ settingsFile: 'C:/h/s.json', helperExists: false, canvasMcp: CANVAS });
  assert.ok(!args.includes('--mcp-config'));
  assert.ok(!args.includes('--settings'));
  assert.ok(buildClaudeArgs({ settingsFile: 'C:/h/s.json', helperExists: true, canvasMcp: CANVAS }).includes('--mcp-config'));
});

test('an incomplete canvasMcp is no injection rather than a broken one', () => {
  for (const bad of [{}, { nodePath: 'node' }, { ...CANVAS, scriptPath: '' }, { ...CANVAS, root: undefined }, { ...CANVAS, pointerFile: 5 }]) {
    assert.ok(!buildClaudeArgs({ helperExists: false, canvasMcp: bad }).includes('--mcp-config'), JSON.stringify(bad));
  }
});

// BACKLOG #55 / PR #154 round 2 (N1): "waiting on you" is driven by the PermissionRequest hook, which names the agent.
test('PermissionRequest is hooked only when asked for, for every tool, with a short timeout', () => {
  assert.strictEqual(buildHarnessSettings(opts).hooks.PermissionRequest, undefined, 'a host that does not ask writes the settings it always did');
  const s = buildHarnessSettings({ ...opts, permissionRequest: true });
  const entry = s.hooks.PermissionRequest;
  assert.ok(Array.isArray(entry) && entry.length === 1);
  assert.strictEqual(entry[0].matcher, '', 'every tool');
  assert.match(entry[0].hooks[0].command, /--event PermissionRequest$/);
  assert.strictEqual(entry[0].hooks[0].type, 'command');
  assert.ok(entry[0].hooks[0].timeout <= 2, 'awaited before the prompt is shown: short');
  assert.strictEqual(buildHarnessSettings({ ...opts, permissionRequest: 'yes' }).hooks.PermissionRequest, undefined, 'only an explicit true');
});

test('PermissionRequest uses the same native helper as every other hook, and adds nothing else', () => {
  const plain = buildHarnessSettings(opts).hooks;
  const withIt = buildHarnessSettings({ ...opts, permissionRequest: true }).hooks;
  const { PermissionRequest, ...rest } = withIt;
  assert.deepStrictEqual(rest, plain, 'no other hook changes');
  assert.ok(PermissionRequest[0].hooks[0].command.startsWith(plain.Stop[0].hooks[0].command.replace(/--event Stop$/, '')));
});

// --- kill tests for the release-176 survivors (BACKLOG #94) ----------------------

const { findUserStatusLine, findUserTheme } = require('../host/settings-writer');
const { tmpDir: killsTmpDir } = require('./tmp-dir');

const relay = (userStatusLine) => ({ ...opts, statusRelay: { nodePath: 'C:/n/node.exe', scriptPath: 'C:/cc/status-relay.js', userStatusLine } });

test('M10: only a status line that is an object with type command and a string command is chained', () => {
  const chained = (u) => / --then /.test(buildHarnessSettings(relay(u)).statusLine.command);
  assert.strictEqual(chained({ type: 'command', command: 'echo hi' }), true);
  assert.strictEqual(chained({ type: 'other', command: 'echo hi' }), false);
  assert.strictEqual(chained({ type: 'command', command: 42 }), false);
  assert.strictEqual(chained({ type: 'command', command: '' }), false);
  assert.strictEqual(chained('echo hi'), false);
  assert.strictEqual(chained(null), false);
});

test('M10: a user status line that is not an object contributes none of its fields', () => {
  const sl = buildHarnessSettings(relay('echo hi')).statusLine;
  assert.deepStrictEqual(Object.keys(sl).sort(), ['command', 'padding', 'type']);
  assert.strictEqual(sl.padding, 0);
});

test('M10: the pipe prefix is stripped only from the front of the name', () => {
  const inside = 'zz\\\\.\\pipe\\name';
  const cmd = buildHarnessSettings({ helperPath: HELPER, pipeName: inside }).hooks.PreToolUse[0].hooks[0].command;
  assert.ok(cmd.includes('zz'), cmd);
  assert.ok(cmd.includes('.\\pipe\\name'), 'the middle of the name is left alone');
  const front = buildHarnessSettings({ helperPath: HELPER, pipeName: PIPE }).hooks.PreToolUse[0].hooks[0].command;
  assert.ok(front.includes('--pipe "claude-custom-abc123"'), front);
});

test('M10: a loadout hook that is not an object, or is missing a part, adds no entry', () => {
  const entries = (loadoutHook) => buildHarnessSettings({ ...opts, loadoutHook }).hooks.PreToolUse.length;
  assert.strictEqual(entries({ nodePath: 'n', scriptPath: 's', stateDir: 'd' }), 2);
  assert.strictEqual(entries('nope'), 1);
  assert.strictEqual(entries({ nodePath: 'n', scriptPath: 's' }), 1);
  assert.strictEqual(entries(undefined), 1);
});

test('M10: findUserStatusLine returns a runnable command, and null for anything else', () => {
  const dir = killsTmpDir('cc-sl-');
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(cfg);
  const put = (sl) => fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ statusLine: sl }));
  put({ type: 'command', command: 'echo hi' });
  assert.deepStrictEqual(findUserStatusLine({ configDir: cfg }), { type: 'command', command: 'echo hi' });
  for (const bad of [{ type: 'command', command: 123 }, { type: 'command', command: '' }, { type: 'x', command: 'echo' }, 'echo', null]) {
    put(bad);
    assert.strictEqual(findUserStatusLine({ configDir: cfg }), null, JSON.stringify(bad));
  }
});

test('M10: the theme sits in .claude.json BESIDE a .claude config dir, and a dir with another name does not look there', () => {
  const home = killsTmpDir('cc-theme-home-');
  const dotClaude = path.join(home, '.claude');
  const other = path.join(home, 'other');
  fs.mkdirSync(dotClaude);
  fs.mkdirSync(other);
  assert.strictEqual(findUserTheme({ configDir: dotClaude }), null);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ theme: 'light-ansi' }));
  assert.strictEqual(findUserTheme({ configDir: dotClaude }), 'light-ansi');
  assert.strictEqual(findUserTheme({ configDir: other }), null, 'its parent holds a .claude.json, which is not its global config');
});

test('M10: findUserTheme with no config dir reads the project layers only, and with nothing at all finds nothing', () => {
  const cwd = killsTmpDir('cc-theme-cwd-only-');
  fs.mkdirSync(path.join(cwd, '.claude'));
  assert.strictEqual(findUserTheme({ cwd }), null);
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ theme: 'dark-ansi' }));
  assert.strictEqual(findUserTheme({ cwd }), 'dark-ansi');
  assert.strictEqual(findUserTheme(), null);
  assert.strictEqual(findUserTheme({}), null);
});

test('M10: only the CLI\'s own theme names are accepted, whole', () => {
  const cfg = killsTmpDir('cc-theme-names-');
  const file = path.join(cfg, 'settings.json');
  const themeOf = (t) => { fs.writeFileSync(file, JSON.stringify({ theme: t })); return findUserTheme({ configDir: cfg }); };
  for (const ok of ['auto', 'dark', 'light', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi']) assert.strictEqual(themeOf(ok), ok);
  for (const bad of ['xdark', 'darkx', 'dark-', 'auto2', 'dark-ansi-x', 'Dark', ' dark', 'dark\n', '']) assert.strictEqual(themeOf(bad), null, JSON.stringify(bad));
  fs.writeFileSync(file, 'null');
  assert.strictEqual(findUserTheme({ configDir: cfg }), null);
  fs.writeFileSync(file, JSON.stringify({ theme: ['dark'] }));
  assert.strictEqual(findUserTheme({ configDir: cfg }), null);
});

test('M10: a half-written file is retried after a real pause of about RETRY_WAIT_MS', () => {
  const cfg = killsTmpDir('cc-theme-wait-');
  const file = path.join(cfg, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark' }));
  let reads = 0;
  const fsImpl = { readFileSync: (f, enc) => { if (f === file && ++reads === 1) return '{ "theme": "da'; return fs.readFileSync(f, enc); } };
  const t0 = process.hrtime.bigint();
  assert.strictEqual(findUserTheme({ configDir: cfg, fsImpl }), 'dark');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms >= 50, `the default sleep waited ${ms} ms`);
});

test('M10: without a port the shared file is returned and no per-port file is created; port 0 is a port', () => {
  const dir = killsTmpDir('cc-hs-');
  const shared = writeHarnessSettings(dir, { helperPath: 'h.exe', pipeName: 'P' });
  assert.strictEqual(path.basename(shared), 'harness-settings.json');
  assert.deepStrictEqual(fs.readdirSync(dir), ['harness-settings.json']);
  const zero = writeHarnessSettings(dir, { helperPath: 'h.exe', pipeName: 'P' }, 0);
  assert.strictEqual(path.basename(zero), 'harness-settings-0.json');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['harness-settings-0.json', 'harness-settings.json']);
  const nul = writeHarnessSettings(dir, { helperPath: 'h.exe', pipeName: 'P' }, null);
  assert.strictEqual(path.basename(nul), 'harness-settings.json');
});

// BACKLOG #119 A7 (the Schedules panel): cron jobs are CronCreate / CronDelete calls, which no matcher above saw. Opt-in and SEPARATE
// entries after the bedtime one (Pre for the intent, Post for the result that carries the job's id), so the mood engine's are untouched.
test('schedules adds a CronCreate|CronDelete entry to PreToolUse AND PostToolUse, last, and only when asked', () => {
  const { CRON_MATCHER } = require('../host/settings-writer');
  assert.strictEqual(CRON_MATCHER, 'CronCreate|CronDelete');
  const plain = buildHarnessSettings(opts);
  const s = buildHarnessSettings({ ...opts, schedules: true });
  for (const event of ['PreToolUse', 'PostToolUse']) {
    assert.strictEqual(s.hooks[event].length, plain.hooks[event].length + 1);
    const last = s.hooks[event][s.hooks[event].length - 1];
    assert.strictEqual(last.matcher, CRON_MATCHER);
    assert.strictEqual(last.hooks[0].command, plain.hooks[event][0].hooks[0].command.replace(/--event \w+$/, `--event ${event}`));
    assert.strictEqual(JSON.stringify(s.hooks[event][0]), JSON.stringify(plain.hooks[event][0]), `${event}[0] still belongs to the mood engine`);
  }
  for (const v of [false, undefined, null, 'yes', 1]) {
    assert.strictEqual(buildHarnessSettings({ ...opts, schedules: v }).hooks.PreToolUse.length, plain.hooks.PreToolUse.length, String(v));
  }
});

test('schedules composes with bedtime after it, and changes nothing but PreToolUse and PostToolUse', () => {
  const { CRON_MATCHER } = require('../host/settings-writer');
  const plain = buildHarnessSettings(opts);
  const both = buildHarnessSettings({ ...opts, bedtime: true, schedules: true });
  assert.deepStrictEqual(both.hooks.PreToolUse.map(e => e.matcher).slice(-2), [BEDTIME_MATCHER, CRON_MATCHER]);
  assert.deepStrictEqual(both.hooks.PostToolUse.map(e => e.matcher).slice(-2), [BEDTIME_MATCHER, CRON_MATCHER]);
  for (const event of Object.keys(plain.hooks)) {
    if (event === 'PreToolUse' || event === 'PostToolUse') continue;
    assert.strictEqual(JSON.stringify(both.hooks[event]), JSON.stringify(plain.hooks[event]), event);
  }
});
