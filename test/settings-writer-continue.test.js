'use strict';
/**
 * buildClaudeArgs / argsForSpawn and the resume of a lane's MAIN session (BACKLOG #166; PR #250 Dexter 1, Miguel Y1). The CLI's
 * `--continue` takes the folder's newest conversation, which may be a side session's, so a main session is started with
 * `--resume <its own session id>` (host/main-session.js) or fresh; `--continue` is never passed. A side session and a shell tab
 * start fresh. The flag is opt-in, so every other caller's arguments are exactly what they were.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { buildClaudeArgs, argsForSpawn } = require('../host/settings-writer');

const base = { settingsFile: 'C:/h/s.json', helperExists: true };
const ID = '11111111-aaaa-4bbb-8ccc-000000000001';

test('a main session given a session id gets --resume <id>; the rest of its arguments are untouched', () => {
  const plain = buildClaudeArgs(base);
  const resumed = buildClaudeArgs({ ...base, resumeSessionId: ID });
  const at = resumed.indexOf('--resume');
  assert.ok(at >= 0);
  assert.strictEqual(resumed[at + 1], ID);
  assert.deepStrictEqual(resumed.filter((a, i) => i !== at && i !== at + 1), plain);
});

test('--continue is never passed: not by any option, not for any session', () => {
  for (const o of [{}, { resumeSessionId: ID }, { continueSession: true }, { side: true, resumeSessionId: ID }]) {
    assert.ok(!buildClaudeArgs({ ...base, ...o }).includes('--continue'), JSON.stringify(o));
  }
});

test('anything but a well-formed id is no resume, and a side session never resumes', () => {
  for (const v of [undefined, null, '', 5, {}, '--help', '../x', 'a b', 'short']) {
    assert.ok(!buildClaudeArgs({ ...base, resumeSessionId: v }).includes('--resume'), String(v));
  }
  assert.ok(!buildClaudeArgs({ ...base, side: true, resumeSessionId: ID }).includes('--resume'));
});

test('--resume comes before --settings and --plugin-dir (a flag and its value, not a value of another)', () => {
  const args = buildClaudeArgs({ ...base, resumeSessionId: ID, modDir: 'C:/m' });
  const at = args.indexOf('--resume');
  for (const flag of ['--settings', '--plugin-dir']) assert.ok(args.indexOf(flag) > at + 1, flag);
});

test('argsForSpawn: a main session with an id carries --resume AND the mod\'s plugin directory (Miguel Y1)', () => {
  const options = { ...base };
  const args = argsForSpawn({ args: ['ARGS'], options, modDir: 'C:/m', resumeId: ID });
  assert.ok(args.includes('--resume') && args.includes(ID));
  assert.strictEqual(args[args.indexOf('--plugin-dir') + 1], 'C:/m', 'the rebuild keeps the plugin');
});

test('argsForSpawn: a main session with no id is what it was without any resume', () => {
  assert.deepStrictEqual(argsForSpawn({ args: ['ARGS'], options: base, modDir: 'C:/m', resumeId: null }), buildClaudeArgs({ ...base, modDir: 'C:/m' }));
});

test('argsForSpawn: a side session and a shell host get the base arguments as they are, whatever id is offered', () => {
  const sideArgs = ['SIDE-ARGS'];
  assert.strictEqual(argsForSpawn({ side: true, args: sideArgs, options: { ...base, side: true }, resumeId: ID }), sideArgs);
  assert.strictEqual(argsForSpawn({ shell: true, args: sideArgs, options: base, resumeId: ID }), sideArgs);
});

test('host.js wires it: the id is recorded from a main host\'s SessionStart, and the spawn asks argsForSpawn with the store\'s answer', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(host, /const \{ recordMainSession, resumeIdFor \} = require\('\.\/main-session'\);/);
  const fn = host.slice(host.indexOf('function claudeArgs()'), host.indexOf('function claudeArgs()') + 700);
  assert.match(fn, /resumeIdFor\(\{ file: MAIN_SESSIONS_FILE, cwd: CWD, store: \{ log: \(l\) => console\.log\(l\) \} \}\)/);
  assert.match(fn, /argsForSpawn\(\{ side: SIDE, shell: SHELL, args: ARGS, options: ARGS_OPTIONS, modDir: ARGS_MOD_DIR, resumeId \}\)/);
  assert.ok(!/hasConversation|continueSession/.test(host), 'no blind --continue left in the host');
  assert.match(host, /if \(!SIDE && !SHELL\) recordMainSession\(\{ file: MAIN_SESSIONS_FILE, cwd: CWD, sessionId \}\)/);
  assert.match(host, /const modDir = modPluginDirFor\(\{ enabled, version, dir: MOD_DIR, forced \}\);/);
  assert.strictEqual((host.match(/modPluginDirFor\(/g) || []).length, 1, 'modPluginDirFor is called once');
});
