'use strict';
/**
 * The hooks the Changes panel needs (BACKLOG #119 A3, PR #199 Dexter 2): a tool name the notifier handles but no hook registers is dead.
 * The edit tools' PostToolUse is registered only when asked (`changes: true`), as a SEPARATE entry after the mood engine's, and the host
 * ends those events before the mood engine sees them.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { buildHarnessSettings, CHANGES_POST_MATCHER } = require('../host/settings-writer');
const { CHANGING_TOOLS, POST_ONLY_TOOLS } = require('../host/changes-notifier');

const opts = { helperPath: 'C:/tools/claude-custom-hook.exe', pipeName: '\\\\.\\pipe\\claude-custom-abc123' };
const names = (matcher) => String(matcher).split('|');
const matchersOf = (s, event) => (s.hooks[event] || []).flatMap(e => names(e.matcher));

test('without the option nothing changes: the edit tools get no PostToolUse hook, and the mood engine entry stays alone', () => {
  const s = buildHarnessSettings(opts);
  assert.ok(!s.hooks.PostToolUse.some(e => e.matcher === CHANGES_POST_MATCHER));
  assert.strictEqual(s.hooks.PostToolUse.length, 1);
});

test('`changes: true` adds ONE separate PostToolUse entry after the mood engine\'s, running the same helper for event PostToolUse', () => {
  const s = buildHarnessSettings({ ...opts, changes: true });
  assert.strictEqual(s.hooks.PostToolUse.length, 2);
  assert.notStrictEqual(s.hooks.PostToolUse[0].matcher, CHANGES_POST_MATCHER, 'PostToolUse[0] is still the mood engine\'s');
  assert.strictEqual(s.hooks.PostToolUse[1].matcher, CHANGES_POST_MATCHER);
  assert.match(s.hooks.PostToolUse[1].hooks[0].command, /--event PostToolUse/);
  for (const k of Object.keys(s.hooks)) if (k !== 'PostToolUse') assert.deepStrictEqual(s.hooks[k], buildHarnessSettings(opts).hooks[k], `${k} is untouched`);
});

test('EVERY tool the notifier treats as changing is in some registered matcher (a handled name with no hook is dead)', () => {
  const s = buildHarnessSettings({ ...opts, changes: true, occupancy: true });
  const registered = new Set([...matchersOf(s, 'PreToolUse'), ...matchersOf(s, 'PostToolUse')]);
  for (const tool of CHANGING_TOOLS) assert.ok(registered.has(tool), `${tool} has a hook`);
  // and every tool the host ENDS the Post of (isChangesOnly) is exactly what the extra entry registers
  assert.deepStrictEqual([...POST_ONLY_TOOLS].sort(), names(CHANGES_POST_MATCHER).sort());
  // Stop and SubagentStop arm it too: both are hooked
  assert.ok(s.hooks.Stop && s.hooks.SubagentStop);
});

test('the edit tools\' Post is for an edit that LANDED: it is registered for Post, not only for Pre', () => {
  const s = buildHarnessSettings({ ...opts, changes: true });
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'PowerShell']) assert.ok(matchersOf(s, 'PostToolUse').includes(tool), tool);
});

test('host.js asks for it, and ends those events before the mood engine and the Running panel see them', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
  assert.match(src, /changes: true,/);
  const at = src.indexOf('if (isChangesOnly(ev)) return;');
  assert.ok(at !== -1);
  assert.ok(at > src.indexOf('attention.activity(ev);'), 'after the consumers that see every event');
  assert.ok(at < src.indexOf('if (isOccupancyOnly(ev)) { mood.handle(ev); return; }'), 'before the mood engine');
  assert.ok(src.indexOf('changesNotifier.handle(ev);') < at, 'the notifier saw it first');
});
