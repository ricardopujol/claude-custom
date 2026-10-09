'use strict';
// Split out of test/settings-writer.test.js (release-gate lane, 2026-10-09): the tests below run real processes, so they stay out of Stryker's command.
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

// A message to a finished agent RESUMES it, with no Agent call; unhooked, the
// resumed agent never showed working and a hidden card never came back. The
// SendMessage RESULT names the run it resumed (host/mood-machine.js
// message()); its PreToolUse is only intent, and a denied send never runs.

// --- claude argv construction -------------------------------------------

const { buildClaudeArgs } = require('../host/settings-writer');
const { tmpDir } = require('./tmp-dir');

// --- shell survival ---------------------------------------------------------
// Claude Code runs a hook command through a shell. On Windows that shell can be
// a POSIX one (Git Bash), where a backslash inside double quotes is an ESCAPE:
// the pipe name arrives one backslash short, the helper cannot open it, catches
// the failure and exits 0 -- so hooks silently never arrive. That is what both
// "agents deploy but the roster stays empty" and "no notification when a task
// ends" actually were.

test('the bare pipe name survives a POSIX shell unchanged', (t) => {
  // Ask a real shell what it would hand the helper, rather than reasoning about
  // escaping rules -- reasoning about them is how this shipped broken.
  const { spawnSync } = require('child_process');
  // Not spawnSync('bash'): from PowerShell that is the WSL launcher, which fails without an error (BACKLOG #72).
  const sh = posixShell();
  if (!sh) { t.skip('no POSIX shell on this machine'); return; }
  const s = buildHarnessSettings({ helperPath: 'C:\\h\\hook-helper.exe', pipeName: '\\\\.\\pipe\\claude-custom-42' });
  const cmd = s.hooks.PreToolUse[0].hooks[0].command;
  const pipeArg = /--pipe\s+("[^"]*"|\S+)/.exec(cmd)[1];
  const r = spawnSync(sh, ['-c', `printf %s ${pipeArg}`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'claude-custom-42');
});

// --- the tool belt's hook (BACKLOG #17) ---------------------------------------

const loadoutHook = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  scriptPath: 'C:\\proj\\claude-custom\\host\\loadout-hook.js',
  stateDir: 'C:\\proj\\claude-custom\\.harness\\state',
};

// Backlog #44 + #47 (worktree occupancy): the occupancy claim needs a SUBAGENT's file tool calls, and the
// host only ever saw Agent|Task|Bash. Opt-in, so the default settings are exactly what they always were.

// Backlog #52 (bedtime): the night is read from the loop's own ScheduleWakeup calls, which no matcher above saw.
// Opt-in and SEPARATE entries (Pre for the call, Post for the CLI's `scheduledFor`), so the mood engine's are untouched.

// BACKLOG #71: the artifact shelf is filled from the Artifact tool's own PostToolUse (host/canvas-shelf.js). Result only: a
// publish that is refused or fails has no address to put on the shelf, and PreToolUse is only intent.

// BACKLOG #71: Claude's panel's MCP server rides in on --mcp-config (a CLI flag: nothing is written to the user's config, and it
// is ADDED to the user's own servers). Never --strict-mcp-config, which would switch every other server off.
const CANVAS = { nodePath: 'node', scriptPath: 'C:\\app\\host\\canvas-mcp.js', root: 'C:\\app\\.harness\\state', pointerFile: 'C:\\app\\.harness\\state\\canvas\\_tab-7.json' };

