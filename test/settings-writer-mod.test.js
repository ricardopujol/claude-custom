'use strict';
/**
 * BACKLOG #119 A2: the claude-custom mod rides in on `--plugin-dir <dir>`, a CLI flag, so nothing is written to the user's own
 * config (the founding bet). buildClaudeArgs adds it for a directory it is given and for nothing else.
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildClaudeArgs } = require('../host/settings-writer');

const base = { settingsFile: 'C:/h/s.json', helperExists: true };

test('no modDir, no flag: the arguments are exactly what they were', () => {
  assert.deepStrictEqual(buildClaudeArgs(base), ['--dangerously-skip-permissions', '--settings', 'C:/h/s.json']);
  assert.deepStrictEqual(buildClaudeArgs({ ...base, modDir: null }), ['--dangerously-skip-permissions', '--settings', 'C:/h/s.json']);
});

test('a modDir adds --plugin-dir with the directory, forward slashes only', () => {
  const args = buildClaudeArgs({ ...base, modDir: 'C:\\Users\\ricar\\VibeCode\\claude-custom\\dev\\mods\\claude-custom' });
  const at = args.indexOf('--plugin-dir');
  assert.ok(at !== -1);
  assert.strictEqual(args[at + 1], 'C:/Users/ricar/VibeCode/claude-custom/dev/mods/claude-custom');
  assert.ok(!args[at + 1].includes('\\'));
});

test('the flag is not tied to the hook helper: a host without one still gets the mod', () => {
  const args = buildClaudeArgs({ helperExists: false, modDir: 'C:/m' });
  assert.deepStrictEqual(args, ['--dangerously-skip-permissions', '--plugin-dir', 'C:/m']);
});

test('a side session (plan mode) gets the mod too: it only observes', () => {
  const args = buildClaudeArgs({ ...base, side: true, modDir: 'C:/m' });
  assert.ok(args.includes('--plugin-dir'));
  assert.ok(args.includes('plan'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('an empty, non-string or missing modDir adds nothing', () => {
  for (const modDir of ['', 5, {}, [], undefined, false]) assert.ok(!buildClaudeArgs({ ...base, modDir }).includes('--plugin-dir'), String(modDir));
});

test('--plugin-dir appears once and its value is never another flag', () => {
  const args = buildClaudeArgs({ ...base, modDir: 'C:/m', canvasMcp: { nodePath: 'node', scriptPath: 'C:/c.js', root: 'C:/r', pointerFile: 'C:/p.json' } });
  assert.strictEqual(args.filter(a => a === '--plugin-dir').length, 1);
  assert.ok(!args[args.indexOf('--plugin-dir') + 1].startsWith('--'));
  assert.ok(args.includes('--mcp-config'), 'the panel\'s server is untouched');
});
