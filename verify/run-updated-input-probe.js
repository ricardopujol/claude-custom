'use strict';
/* FF9 Q1 driver — does `updatedInput` on `PreToolUse(Agent)` actually change
   what the subagent runs with?

   Drives the REAL `claude` CLI, non-interactively, twice:
     - "control" run: a temp project with no hooks at all.
     - "hook"    run: an identical prompt in a temp project whose
       .claude/settings.json installs verify/probe-updated-input.js as the
       PreToolUse(Agent) command. That hook rewrites tool_input.model to
       "haiku" and appends a sentence to tool_input.prompt.

   Both prompts force exactly ONE Agent tool call -- this spends Ricardo's
   quota, so this file must never be looped or retried casually. The verdict
   comes ONLY from the subagent's own transcript under
   ~/.claude/projects/<encoded-dir>/<session>/subagents/*.jsonl -- the parent
   transcript's tool_input is the REQUEST the hook made, not evidence of what
   actually ran.

   The parent session is pinned to --model sonnet identically in both runs.
   That is a cost control, not a test variable: whatever the untouched default
   subagent model would be shows up in the control run either way, and the
   comparison only cares whether the hook run diverges from it.

   Run: node verify/run-updated-input-probe.js
   ELECTRON_RUN_AS_NODE is deleted from the child env -- this probe is itself
   normally launched from inside a Claude Code session, and that variable
   would otherwise make the spawned `claude.exe` start as plain Node. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const CLAUDE_BIN = process.env.CLAUDE_CUSTOM_BIN
  || path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const HOOK_SCRIPT = path.join(__dirname, 'probe-updated-input.js');
const BASE = path.join(os.tmpdir(), 'claude-custom-ff9-probe');
const HOOK_DIR = path.join(BASE, 'hook-run');
const CONTROL_DIR = path.join(BASE, 'control-run');
const HOOK_LOG = path.join(BASE, 'ff9-hook.log');

const PROMPT = "Use the Agent tool with subagent_type general-purpose and the "
  + "prompt 'reply with the single word OK'. Do nothing else.";

function projectsDirFor(cwd) {
  // Claude Code's own encoding, confirmed on disk against an existing
  // project: the drive-letter colon and every path separator become a dash.
  const encoded = cwd.replace(/[:\\/]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function writeHookSettings(cwd) {
  const settingsDir = path.join(cwd, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  // Wrapped in literal quotes here, NOT JSON.stringify'd -- the surrounding
  // JSON.stringify(settings, null, 2) below is the only escaping pass this
  // path needs. Escaping it twice would leave doubled backslashes in the
  // command Claude Code actually hands to the shell.
  const command = `node "${HOOK_SCRIPT}"`;
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Agent', hooks: [{ type: 'command', command, timeout: 10 }] }],
    },
  };
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

function runSession(cwd, { withHook }) {
  fs.mkdirSync(cwd, { recursive: true });
  if (withHook) writeHookSettings(cwd);

  const env = cleanEnv();
  env.FF9_HOOK_LOG = HOOK_LOG;

  const t0 = Date.now();
  const r = spawnSync(CLAUDE_BIN, [
    '-p', PROMPT,
    '--model', 'sonnet',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const elapsed = Date.now() - t0;

  let result = null;
  try { result = JSON.parse(r.stdout); } catch { /* reported raw below */ }

  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '', result, elapsed };
}

function findSubagentTranscripts(cwd, sessionId) {
  if (!sessionId) return [];
  const dir = path.join(projectsDirFor(cwd), sessionId, 'subagents');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
}

function readModelsAndText(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  const models = [];
  let lastText = '';
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj.message;
    if (msg && msg.model) models.push(msg.model);
    if (msg && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') lastText = block.text;
      }
    }
  }
  return { models, lastText };
}

(async () => {
  console.log('=== FF9 Q1 probe: does PreToolUse updatedInput reach the subagent? ===\n');
  console.log('claude binary :', CLAUDE_BIN);
  console.log('claude exists :', fs.existsSync(CLAUDE_BIN));
  console.log('hook script   :', HOOK_SCRIPT);
  console.log('hook dir      :', HOOK_DIR);
  console.log('control dir   :', CONTROL_DIR);
  console.log('hook log      :', HOOK_LOG);
  console.log('');

  try { fs.rmSync(HOOK_LOG, { force: true }); } catch { /* first run */ }

  console.log('--- control run (no hook installed) ---');
  const control = runSession(CONTROL_DIR, { withHook: false });
  console.log('exit status   :', control.status, ' elapsed:', control.elapsed + 'ms');
  if (!control.result) {
    console.log('STOP: control run produced no parseable JSON result.');
    console.log('stdout:', control.stdout.slice(0, 3000));
    console.log('stderr:', control.stderr.slice(0, 3000));
    process.exit(1);
  }
  console.log('session_id    :', control.result.session_id);
  console.log('result text   :', control.result.result);
  console.log('total_cost_usd:', control.result.total_cost_usd);

  console.log('\n--- hook run (PreToolUse(Agent) rewrites model + prompt) ---');
  const hookRun = runSession(HOOK_DIR, { withHook: true });
  console.log('exit status   :', hookRun.status, ' elapsed:', hookRun.elapsed + 'ms');
  if (!hookRun.result) {
    console.log('STOP: hook run produced no parseable JSON result.');
    console.log('stdout:', hookRun.stdout.slice(0, 3000));
    console.log('stderr:', hookRun.stderr.slice(0, 3000));
    process.exit(1);
  }
  console.log('session_id    :', hookRun.result.session_id);
  console.log('result text   :', hookRun.result.result);
  console.log('total_cost_usd:', hookRun.result.total_cost_usd);

  console.log('\n--- hook invocation log (verify/probe-updated-input.js, stdin/stdout it saw) ---');
  try {
    console.log(fs.readFileSync(HOOK_LOG, 'utf8').trim() || '(empty)');
  } catch (e) {
    console.log('(no hook log file at all — the hook process never ran)', e.message);
  }

  console.log('\n--- subagent transcripts ---');
  const controlSub = findSubagentTranscripts(CONTROL_DIR, control.result.session_id);
  const hookSub = findSubagentTranscripts(HOOK_DIR, hookRun.result.session_id);
  console.log('control subagent files:', controlSub);
  console.log('hook subagent files   :', hookSub);

  const summarize = (label, files) => {
    if (!files.length) { console.log(`${label}: NO SUBAGENT TRANSCRIPT FOUND`); return null; }
    const { models, lastText } = readModelsAndText(files[0]);
    console.log(`${label}: models seen = [${models.join(', ')}]`);
    console.log(`${label}: final text  = ${JSON.stringify(lastText)}`);
    return { models, lastText };
  };

  const controlSummary = summarize('control', controlSub);
  const hookSummary = summarize('hook', hookSub);

  console.log('\n=== VERDICT ===');
  if (!controlSummary || !hookSummary) {
    console.log('COULD NOT MEASURE: at least one run produced no subagent transcript to compare.');
    process.exit(1);
  }

  const controlWasHaiku = controlSummary.models.length > 0 && controlSummary.models.every(m => /haiku/i.test(m));
  const hookIsHaiku = hookSummary.models.length > 0 && hookSummary.models.every(m => /haiku/i.test(m));
  const modelHonoured = hookIsHaiku && !controlWasHaiku;

  const controlHasPineapple = /PINEAPPLE/i.test(controlSummary.lastText);
  const hookHasPineapple = /PINEAPPLE/i.test(hookSummary.lastText);
  const promptHonoured = hookHasPineapple && !controlHasPineapple;

  console.log('control subagent models :', controlSummary.models);
  console.log('hook subagent models    :', hookSummary.models);
  console.log('model rewrite           :', modelHonoured ? 'HONOURED' : 'NOT HONOURED');
  console.log('control final text      :', controlSummary.lastText);
  console.log('hook final text         :', hookSummary.lastText);
  console.log('prompt rewrite          :', promptHonoured ? 'HONOURED' : 'NOT HONOURED');
})();
