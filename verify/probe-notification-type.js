'use strict';
/**
 * Does the installed Claude Code still send `notification_type`?  (re-runnable)
 *
 *   node verify/probe-notification-type.js     (exit 0 = every check held)
 *
 * host/attention.js raises a Notification only for the types that wait on you,
 * and treats a Notification with NO type as an older CLI (it raises, as it
 * always did). So if the CLI renamed the field, every idle reminder and login
 * would toast again and no test would fail (Miguel, notify review 5). No
 * fixture in this repo holds a real Notification payload, and capturing one
 * needs a billed turn, so this reads the CLI's OWN hook-input schema out of
 * its bundle instead: the Notification input object, and every type name
 * attention.js depends on. Free, and it fails the day the CLI moves.
 *
 * Measured 2026-10-01 against 2.1.286:
 *   u({hook_event_name:x("Notification"),message:o(),title:o().optional(),notification_type:o()})
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NEEDED = ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'idle_prompt'];

function findBundle() {
  let npmRoot;
  try { npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim(); } catch { return null; }
  const base = path.join(npmRoot, '@anthropic-ai', 'claude-code');
  for (const rel of ['bin/claude.exe', 'bin/claude', 'cli.js']) {
    const p = path.join(base, rel);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const bundle = findBundle();
check('found the installed Claude Code bundle', Boolean(bundle), bundle || 'npm root -g has no @anthropic-ai/claude-code');
if (bundle) {
  const text = fs.readFileSync(bundle).toString('latin1');
  const schema = /hook_event_name:[\w$]+\("Notification"\),[^{}]{0,200}?notification_type:/.exec(text);
  check('the Notification hook input schema carries notification_type', Boolean(schema), schema ? schema[0].slice(0, 120) : '');
  for (const t of NEEDED) check(`the CLI knows the type ${t}`, text.includes(`"${t}"`));
}
console.log(failures ? `\nprobe-notification-type: ${failures} FAILED` : '\nprobe-notification-type: every check held');
process.exit(failures ? 1 : 0);
