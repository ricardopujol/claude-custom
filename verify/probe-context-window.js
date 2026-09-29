'use strict';
/* Does the statusLine document carry the context window? Measured on the REAL
   CLI, sending NO prompt -- /model is a local command, so this spends no tokens.

     node verify/probe-context-window.js

   host/status-relay.js forwards the statusLine document to the host UNCHANGED
   (JSON.parse -> `Status` event payload), so what the CLI puts on the statusLine
   stdin is exactly what host.js's readStatus sees. This probe therefore hooks a
   capture command into the same seam (like probe-top-bar-truth.js) rather than
   standing up the whole host.

   Safety: ANTHROPIC_API_KEY and ELECTRON_RUN_AS_NODE are deleted from the child
   env. /model persists to settings, so every settings file it could touch is
   snapshotted and restored byte for byte. The spawned tree is registered with
   the hygiene registry so Ctrl+C cannot orphan a `claude`.

   MEASURED 2026-09-29, claude 2.1.284, fresh session, no prompt sent:
   The document HAS a top-level `context_window` object (top-level keys:
   session_id, transcript_path, cwd, scratchpad_dir, model, workspace, version,
   output_style, cost, context_window, exceeds_200k_tokens, fast_mode, thinking,
   rate_limits; `effort` and `prompt_id` also appear once set). Fresh session:
     "context_window": {
       "total_input_tokens": 0,            // number
       "total_output_tokens": 0,           // number
       "context_window_size": 200000,      // number: the model's own window
       "current_usage": null,              // null before the first turn
       "used_percentage": null,            // null before the first turn (NOT 0)
       "remaining_percentage": null }      // null before the first turn
   After `/model sonnet[1m]` (re-fires with no turn, model.id
   "claude-sonnet-5-5[1m]"): identical, but context_window_size = 1000000.
   So the size tracks the model and the used figure is null -- not 0 -- until
   the CLI has counted. NOT MEASURED ($0 rule: it takes a billed turn): the
   populated form of used_percentage / current_usage. host/hook-session.js
   readContext reads used_percentage as a number 0..100 (its sibling
   rate_limits.*.used_percentage is a 0..100 number) and applies it to
   context_window_size. Confirm on the first real turn (see the PR). */
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- statusLine mode: append one stdin document and print a status line ----
if (process.argv[2] === '--status') {
  let buf = '';
  process.stdin.on('data', d => { buf += d; });
  process.stdin.on('end', () => {
    fs.appendFileSync(process.argv[3], JSON.stringify({ at: Date.now(), raw: buf }) + '\n');
    process.stdout.write('probe-status');
  });
  return;
}

const pty = require('node-pty');
const { createHygieneRegistry } = require('./lib/process-hygiene');
const { killPidTree } = require('../host/kill-tree');
const { createSettingsGuard } = require('./lib/settings-guard');

const COLS = 110;
const ROWS = 34;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPO = path.join(__dirname, '..');
const stamp = Date.now();
const statusLog = path.join(os.tmpdir(), `cc-probe-ctx-${stamp}.jsonl`);
const settingsFile = path.join(os.tmpdir(), `cc-probe-ctx-settings-${stamp}.json`);
const node = process.execPath.replace(/\\/g, '/');
const self = __filename.replace(/\\/g, '/');

const guarded = [
  path.join(os.homedir(), '.claude', 'settings.json'),
  path.join(os.homedir(), '.claude', 'settings.local.json'),
  path.join(REPO, '.claude', 'settings.json'),
  path.join(REPO, '.claude', 'settings.local.json'),
];
// Restored on 'exit' as well as in the finally below: process-hygiene's SIGINT
// handler ends in process.exit(130), which skips a finally (Miguel, PR #67 M1).
// Installed here, before claude is spawned or /model is typed.
const guard = createSettingsGuard(guarded);
guard.installExitRestore();
const restore = guard.restore;

const hygiene = createHygieneRegistry();
hygiene.setResumeFn(() => true);
hygiene.install();

const docs = () => (fs.existsSync(statusLog) ? fs.readFileSync(statusLog, 'utf8') : '')
  .split('\n').filter(Boolean).map(l => JSON.parse(l))
  .map(s => { try { return { at: s.at, doc: JSON.parse(s.raw) }; } catch { return { at: s.at, doc: null, raw: s.raw }; } });
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const describe = (o, pad = '    ') => Object.entries(o || {})
  .map(([k, v]) => `${pad}${k}: ${typeOf(v)} = ${JSON.stringify(v)}`).join('\n');

async function main() {
  fs.writeFileSync(settingsFile, JSON.stringify({
    statusLine: { type: 'command', command: `"${node}" "${self}" --status "${statusLog.replace(/\\/g, '/')}"`, padding: 0 },
  }));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ELECTRON_RUN_AS_NODE;
  const shell = process.platform === 'win32' ? 'cmd.exe' : 'claude';
  const args = process.platform === 'win32' ? ['/c', 'claude', '--settings', settingsFile] : ['--settings', settingsFile];
  const child = pty.spawn(shell, args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: REPO, env });
  hygiene.registerSpawnedTree(child.pid);
  child.onData(() => { /* the screen is not what is measured here */ });
  let failed = false;
  try {
    for (let t = 0; t < 40000 && !docs().length; t += 500) await sleep(500);
    await sleep(3000);
    const first = docs();
    console.log(`statusLine fired ${first.length}x at boot`);
    if (!first.length) throw new Error('no statusLine document at boot');
    const boot = first[first.length - 1].doc;
    console.log('top-level keys:', Object.keys(boot).join(', '));
    console.log('\ncontext_window (boot):');
    console.log(boot.context_window ? describe(boot.context_window) : '    (ABSENT)');
    if (boot.context_window && boot.context_window.current_usage && typeof boot.context_window.current_usage === 'object') {
      console.log('  current_usage:\n' + describe(boot.context_window.current_usage, '      '));
    }

    // Re-fire without a turn: /model to a 1M alias. No prompt is ever sent.
    const before = docs().length;
    child.write('/model sonnet[1m]');
    await sleep(600);
    child.write('\r');
    await sleep(5000);
    const after = docs().slice(before);
    console.log(`\nafter /model sonnet[1m]: ${after.length} more document(s)`);
    for (const s of after) {
      const d = s.doc || {};
      console.log(`  model.id=${d.model && d.model.id}`);
      console.log(d.context_window ? describe(d.context_window) : '    context_window ABSENT');
    }
    const last = docs().slice(-1)[0].doc;
    console.log('\nfull last doc:\n' + JSON.stringify(last, null, 1).slice(0, 2500));
  } catch (err) {
    failed = true;
    console.error('probe error:', err);
  } finally {
    hygiene.unregisterSpawnedTree(child.pid);
    try { killPidTree(child.pid); } catch { /* already gone */ }
    await sleep(1500);
    const changed = restore();
    console.log(`\nsettings restored: ${changed.length ? changed.join(', ') : 'nothing had changed'}`);
    console.log(`status log kept at ${statusLog}`);
    fs.rmSync(settingsFile, { force: true });
    process.exit(failed ? 1 : 0);
  }
}
main();
