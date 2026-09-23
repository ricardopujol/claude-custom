'use strict';
/* FF9 probe hook — NOT the C# helper, not shipped.

   Installed as the PreToolUse command in a temp project's .claude/settings.json
   (see verify/run-updated-input-probe.js, which builds that file and drives the
   real CLI). Claude Code invokes this once per matched tool call, feeding the
   hook payload on stdin and reading STDOUT as control data: printing
   { hookSpecificOutput: { hookEventName, updatedInput } } is documented to
   rewrite the tool's input before it runs.

   This script answers nothing itself — it only performs the rewrite and logs
   what it saw/sent so the driver can compare against the subagent transcript,
   which is the only place "honoured" can actually be confirmed. Guessing from
   this script's own stdout would just be trusting the request again.

   stdout is reserved for the control JSON. All diagnostics go to a log FILE,
   never to stdout or stderr, so a stray console.log can never corrupt the
   control channel Claude Code is about to parse. */

const fs = require('fs');
const path = require('path');

const LOG_PATH = process.env.FF9_HOOK_LOG
  || path.join(__dirname, '..', '.harness', 'ff9-hook.log');

function log(obj) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
  } catch {
    // A failed log write must never take down the hook -- Claude Code is
    // blocked on this process's exit.
  }
}

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }

let payload = null;
try { payload = JSON.parse(raw); } catch (e) {
  log({ event: 'parse-error', error: e.message, raw: raw.slice(0, 500) });
  process.exit(0);
}

const isAgentLaunch = payload
  && payload.hook_event_name === 'PreToolUse'
  && (payload.tool_name === 'Agent' || payload.tool_name === 'Task');

if (!isAgentLaunch) {
  log({ event: 'pass-through', hook_event_name: payload && payload.hook_event_name,
        tool_name: payload && payload.tool_name });
  process.exit(0);
}

const originalInput = payload.tool_input || {};
const updatedInput = { ...originalInput, model: 'haiku' };
if (typeof originalInput.prompt === 'string') {
  updatedInput.prompt = originalInput.prompt + ' End your reply with the word PINEAPPLE.';
}

log({
  event: 'rewrite',
  session_id: payload.session_id,
  original_model: originalInput.model,
  original_prompt: originalInput.prompt,
  updated_model: updatedInput.model,
  updated_prompt: updatedInput.prompt,
});

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput,
  },
}));
process.exit(0);
