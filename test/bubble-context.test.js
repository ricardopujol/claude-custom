'use strict';
/**
 * BACKLOG #80 / #55: what the bubbles know about an agent's current work (host/bubble-activity.js: the last tool and file NAMES
 * from hook events, never their contents) and whose voice it speaks in (host/bubble-voice.js: the agent's own .md).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tmpDir } = require('./tmp-dir');
const { createActivity } = require('../host/bubble-activity');
const { createVoiceReader, validAgentName } = require('../host/bubble-voice');

const pre = (agent, tool, input) => ({ event: 'PreToolUse', payload: { agent_type: agent, tool_name: tool, tool_input: input } });

// --- activity ------------------------------------------------------------------------------------

test('the last tool and the file names an agent touched are remembered per agent', () => {
  const a = createActivity();
  a.note(pre('miguel', 'Read', { file_path: 'C:\\p\\a.js' }));
  a.note(pre('miguel', 'Edit', { file_path: 'C:\\p\\b.js', old_string: 'SECRET BODY', new_string: 'MORE' }));
  a.note(pre('dexter', 'Bash', { command: 'echo LEAK' }));
  const m = a.of('miguel');
  assert.strictEqual(m.tool, 'Edit');
  assert.deepStrictEqual(m.files, ['b.js', 'a.js']);
  assert.strictEqual(a.of('dexter').tool, 'Bash');
  assert.deepStrictEqual(a.of('dexter').files, []);
});

test('nothing but names is kept: no command, no contents', () => {
  const a = createActivity();
  a.note(pre('x', 'Edit', { file_path: 'C:\\p\\a.js', old_string: 'TOP_SECRET', new_string: 'S2', command: 'rm -rf' }));
  assert.ok(!JSON.stringify(a.of('x')).match(/TOP_SECRET|S2|rm -rf/));
});

test('an agent with no events is empty, not an error; odd events are ignored', () => {
  const a = createActivity();
  assert.deepStrictEqual(a.of('nobody'), { tool: undefined, files: [] });
  a.note(null); a.note({}); a.note({ event: 'PreToolUse' }); a.note(pre(7, 'Read', {}));
  a.note(pre('y', { weird: 1 }, 'string'));
  assert.deepStrictEqual(a.of('y'), { tool: undefined, files: [] });
});

test('only a few files and a bounded number of agents are held', () => {
  const a = createActivity();
  for (let i = 0; i < 10; i++) a.note(pre('x', 'Read', { file_path: `/p/f${i}.js` }));
  assert.strictEqual(a.of('x').files.length, 3);
  for (let i = 0; i < 1000; i++) a.note(pre('agent' + i, 'Read', {}));
  assert.ok(a.size() <= 200);
});

test('an agent called __proto__ is an ordinary agent', () => {
  const a = createActivity();
  a.note(pre('__proto__', 'Read', { file_path: '/p/q.js' }));
  assert.strictEqual(a.of('__proto__').tool, 'Read');
  assert.strictEqual(a.of('constructor').tool, undefined);
});

// --- voice ---------------------------------------------------------------------------------------

test('validAgentName admits plain names and refuses path tricks', () => {
  assert.strictEqual(validAgentName('miguel'), true);
  assert.strictEqual(validAgentName('code-reviewer.v2'), true);
  for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', 'x'.repeat(100), 5, null]) assert.strictEqual(validAgentName(bad), false, String(bad));
});

function agentsDir(root, name, body) {
  const dir = path.join(root, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.md'), body);
}

test('the voice comes from the agent file: the project first, then the install', async () => {
  const cfg = tmpDir('voice-cfg');
  const proj = tmpDir('voice-proj');
  agentsDir(cfg, 'miguel', '---\ndescription: Global Miguel.\n---\n');
  agentsDir(path.join(proj, '.claude'), 'miguel', '---\ndescription: Project Miguel.\n---\nAlways sign off with "Hasta luego".\n');
  const r = createVoiceReader({ configDir: cfg, cwd: proj });
  const v = await r.voiceOf('miguel');
  assert.strictEqual(v.description, 'Project Miguel.');
  assert.match(v.signOff, /Hasta luego/);
  agentsDir(cfg, 'dexter', '---\ndescription: Dry logic reviewer.\n---\n');
  assert.strictEqual((await r.voiceOf('dexter')).description, 'Dry logic reviewer.');
});

test('no file, an unreadable file or a bad name is a neutral voice (null)', async () => {
  const r = createVoiceReader({ configDir: tmpDir('voice-none'), cwd: tmpDir('voice-none2') });
  assert.strictEqual(await r.voiceOf('ghost'), null);
  assert.strictEqual(await r.voiceOf('../etc/passwd'), null);
  const broken = createVoiceReader({ configDir: 'x', cwd: 'y', readFile: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
  assert.strictEqual(await broken.voiceOf('miguel'), null);
});

test('a voice is cached for a while, and read again after it', async () => {
  let reads = 0;
  let t = 1000;
  const r = createVoiceReader({ configDir: 'c', cwd: 'p', now: () => t, ttlMs: 5000,
    readFile: async () => { reads++; return '---\ndescription: Hi there.\n---\n'; } });
  await r.voiceOf('a'); await r.voiceOf('a');
  assert.strictEqual(reads, 1);
  t += 5001;
  await r.voiceOf('a');
  assert.strictEqual(reads, 2);
});

// --- the task line -------------------------------------------------------------------------------

test("the mood machine hands over the task line of an agent's newest open run, and undefined otherwise", () => {
  const { createMoodMachine } = require('../host/mood-machine');
  const m = createMoodMachine();
  assert.strictEqual(m.taskOf('miguel'), undefined);
  m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 't1', tool_input: { subagent_type: 'miguel', description: 'review the diff' } } });
  m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 't2', tool_input: { subagent_type: 'miguel', description: 'second pass' } } });
  m.handle({ event: 'PreToolUse', payload: { tool_name: 'Agent', tool_use_id: 't3', tool_input: { subagent_type: 'dexter' } } });
  assert.strictEqual(m.taskOf('miguel'), 'second pass');
  assert.strictEqual(m.taskOf('dexter'), undefined);
  assert.strictEqual(m.taskOf('nobody'), undefined);
});
