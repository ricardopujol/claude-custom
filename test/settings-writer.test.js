'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildHarnessSettings, writeHarnessSettings } = require('../host/settings-writer');

const HELPER = 'C:/tools/claude-custom-hook.exe';
const PIPE = '\\\\.\\pipe\\claude-custom-abc123';
const opts = { helperPath: HELPER, pipeName: PIPE };

test('supplies exactly one top-level key: hooks', () => {
  // Load-bearing. --settings replaces single-valued keys WHOLESALE, so any
  // extra key here would silently destroy the user's version of it. Measured:
  // a partial statusLine object wiped the user's statusLine.command.
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

test('PreToolUse covers Task and Bash, and nothing else', () => {
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
    assert.ok(!new RegExp(`\b${tool}\b`).test(m), `${tool} must not be matched`);
  }
});

test('PostToolUse is scoped to Task and Bash only', () => {
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
    ['Notification', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop']
  );
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

test('the bare pipe name survives a POSIX shell unchanged', () => {
  // Ask a real shell what it would hand the helper, rather than reasoning about
  // escaping rules -- reasoning about them is how this shipped broken.
  const { spawnSync } = require('child_process');
  const s = buildHarnessSettings({ helperPath: 'C:\\h\\hook-helper.exe', pipeName: '\\\\.\\pipe\\claude-custom-42' });
  const cmd = s.hooks.PreToolUse[0].hooks[0].command;
  const pipeArg = /--pipe\s+("[^"]*"|\S+)/.exec(cmd)[1];
  const r = spawnSync('bash', ['-c', `printf %s ${pipeArg}`], { encoding: 'utf8' });
  if (r.error) return;   // no POSIX shell here; the assertion above still holds
  assert.strictEqual(r.stdout, 'claude-custom-42');
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
