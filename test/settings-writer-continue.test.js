'use strict';
/**
 * buildClaudeArgs and `--continue` (BACKLOG #166; documentation/DESIGN_TABS_SESSIONS.md 3.1): a lane's MAIN session resumes with the
 * CLI's own --continue; a side session and a shell tab start fresh. The flag is opt-in (`continueSession: true`), so every existing
 * caller's arguments are exactly what they were. Whether there is anything to continue is host/continue-flag.js's question: the
 * interactive CLI with nothing to continue exits 1 (measured, verify/probe-continue.js), so the host asks before it passes the flag.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { buildClaudeArgs } = require('../host/settings-writer');

const base = { settingsFile: 'C:/h/s.json', helperExists: true };

test('a main session asked to continue gets --continue; the rest of its arguments are untouched', () => {
  const plain = buildClaudeArgs(base);
  const cont = buildClaudeArgs({ ...base, continueSession: true });
  assert.deepStrictEqual(cont.filter(a => a !== '--continue'), plain);
  assert.strictEqual(cont.filter(a => a === '--continue').length, 1);
});

test('without the option (or with anything but a real true) there is no --continue', () => {
  assert.ok(!buildClaudeArgs(base).includes('--continue'));
  for (const v of [false, undefined, null, 'yes', 1, {}]) assert.ok(!buildClaudeArgs({ ...base, continueSession: v }).includes('--continue'), String(v));
});

test('a side session never continues, whatever is asked: it starts fresh in plan mode', () => {
  assert.ok(!buildClaudeArgs({ ...base, side: true, continueSession: true }).includes('--continue'));
});

test('--continue comes before --settings and --plugin-dir (a flag, not a value of one)', () => {
  const args = buildClaudeArgs({ ...base, continueSession: true, modDir: 'C:/m' });
  const at = args.indexOf('--continue');
  assert.ok(at >= 0);
  for (const flag of ['--settings', '--plugin-dir']) assert.ok(args.indexOf(flag) > at, flag);
  assert.notStrictEqual(args[at - 1], '--settings');
});

test('host.js starts a lane\'s main claude with --continue when the CLI\'s store has a conversation, and a side or shell host never', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(host, /const \{ hasConversation \} = require\('\.\/continue-flag'\);/);
  const fn = host.slice(host.indexOf('function claudeArgs()'), host.indexOf('function claudeArgs()') + 600);
  assert.match(fn, /if \(SIDE \|\| SHELL\) return ARGS;/);
  assert.match(fn, /continueSession: hasConversation\(CWD\)/);
  assert.match(host, /pty\.spawn\(SHELL \? SHELL_TARGET\.bin : CLAUDE_BIN, SHELL \? SHELL_TARGET\.args : claudeArgs\(\)/);
  // the mod's directory is kept when ARGS is rebuilt for it, so a spawn-time rebuild keeps the plugin
  assert.match(host, /ARGS_MOD_DIR = modPluginDirFor\(/);
});
