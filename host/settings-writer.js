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
 *    So this file carries exactly ONE key. Anything else the harness needs
 *    travels through the pty environment instead, never through settings.
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
// Task AND Bash. Task alone was enough for the mood engine, but the process
// panel needs to see a Bash command START, not only finish -- a four-minute GPU
// job that only reports on completion is invisible for the whole time it
// matters. Bash already pays a PostToolUse hook, so this adds one more ~23ms
// call to Bash only, not to Read/Grep/Edit.
const PRE_TOOL_MATCHER = 'Task|Bash';
const POST_TOOL_MATCHER = 'Task|Bash';    // completion and error signals
const HOOK_TIMEOUT_SECONDS = 5;

const quote = s => `"${s}"`;

function buildHarnessSettings({ helperPath, pipeName } = {}) {
  if (!helperPath) throw new Error('buildHarnessSettings: helperPath is required');
  if (!pipeName) throw new Error('buildHarnessSettings: pipeName is required');

  // A native helper, not a script: Node costs 60-100ms of startup per
  // invocation and PowerShell ~200ms, paid on every matched tool call.
  const command = event =>
    `${quote(helperPath)} --pipe ${quote(pipeName)} --event ${event}`;

  const entry = (matcher, event) => ({
    matcher,
    hooks: [{ type: 'command', command: command(event), timeout: HOOK_TIMEOUT_SECONDS }],
  });

  return {
    hooks: {
      PreToolUse: [entry(PRE_TOOL_MATCHER, 'PreToolUse')],
      PostToolUse: [entry(POST_TOOL_MATCHER, 'PostToolUse')],
      SubagentStop: [entry('', 'SubagentStop')],
      // Fires once per session, not per tool call, so it adds nothing to the
      // critical path. It carries the session id, which is how the host finds
      // this session's transcript to read token spend from.
      SessionStart: [entry('', 'SessionStart')],
    },
  };
}

function writeHarnessSettings(dir, opts) {
  const settings = buildHarnessSettings(opts);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'harness-settings.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
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

module.exports = { buildHarnessSettings, writeHarnessSettings, buildClaudeArgs };
