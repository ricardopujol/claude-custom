'use strict';
/**
 * The feed an agent card's Pause waits on (BACKLOG #19, PR #158 Dexter R2-1). The page only calls an agent "paused" after it has SEEN OUR TaskStop
 * start, and that call reaches the page only if the host hooks it: Claude Code reads a matcher made only of names and `|` as an EXACT name list
 * (2.1.296 bundle: `pX` sends a matcher that passes /^[a-zA-Z0-9_|]+$/ through `Mdn`, which splits on `|` and tests `names.includes(toolName)`; anything
 * else is a regex). So the contract is tested at the seam: the tool names the page switches on must be in the matcher lists, split on `|`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildHarnessSettings } = require('../host/settings-writer');
const { createProcessTracker } = require('../host/processes');

const opts = { helperPath: 'C:/tools/claude-custom-hook.exe', pipeName: '\\\\.\\pipe\\claude-custom-abc123' };
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');

// Every tool name the renderer's agent-pause feed switches on: p.tool === 'TaskStop'.
const pageTools = [...RENDERER.matchAll(/p\.tool === '([A-Za-z]+)'/g)].map(m => m[1]);

test('the page switches on TaskStop, and the hook matchers deliver it: an EXACT name list on PreToolUse and on the closing events', () => {
  assert.ok(pageTools.includes('TaskStop'), 'the page reads TaskStop from the running list');
  const s = buildHarnessSettings(opts);
  for (const [event, entry] of [['PreToolUse', s.hooks.PreToolUse[0]], ['PostToolUse', s.hooks.PostToolUse[0]], ['PostToolUseFailure', s.hooks.PostToolUseFailure[0]]]) {
    assert.match(entry.matcher, /^[a-zA-Z0-9_|]+$/, `${event}: a plain list, which Claude Code matches by exact name`);
    for (const tool of pageTools) assert.ok(entry.matcher.split('|').includes(tool), `${event} must hook ${tool} (it is not matched by a prefix or a substring)`);
  }
});

test('the old list never delivered it (the counterexample: "Agent|Task|Bash" splits to three names, none is TaskStop)', () => {
  assert.ok(!'Agent|Task|Bash'.split('|').includes('TaskStop'));
});

test('a real TaskStop payload is listed with the task it stops, closes on its result, and other tools carry no task id', () => {
  let now = 1000;
  const t = createProcessTracker({ now: () => now });
  t.handle({ event: 'PreToolUse', payload: { tool_name: 'TaskStop', tool_input: { task_id: 'a1b2c3d4e5' }, tool_use_id: 'tu1' } });
  t.handle({ event: 'PreToolUse', payload: { tool_name: 'Bash', tool_input: { command: 'npm run dev', task_id: 'zzz' }, tool_use_id: 'tu2' } });
  const list = t.list();
  const stop = list.find(p => p.tool === 'TaskStop');
  assert.strictEqual(stop.taskId, 'a1b2c3d4e5');
  assert.strictEqual(stop.state, 'running');
  assert.strictEqual(typeof stop.startedAt, 'number');
  assert.ok(!('taskId' in list.find(p => p.tool === 'Bash')));
  t.handle({ event: 'PostToolUse', payload: { tool_name: 'TaskStop', tool_input: { task_id: 'a1b2c3d4e5' }, tool_use_id: 'tu1' } });
  assert.deepStrictEqual(t.list().map(p => p.tool), ['Bash']);
});

test('the deprecated shell_id names the target too, and an odd id (a path, a newline, too long, not a string) is not passed on', () => {
  const t = createProcessTracker();
  const ids = [];
  for (const [i, input] of [{ shell_id: 'bapl6liul' }, { task_id: 'a\nb' }, { task_id: 'C:\\x' }, { task_id: 'x'.repeat(201) }, { task_id: 5 }, {}, null].entries()) {
    t.handle({ event: 'PreToolUse', payload: { tool_name: 'TaskStop', tool_input: input, tool_use_id: 'u' + i } });
  }
  for (const p of t.list()) ids.push(p.taskId);
  assert.deepStrictEqual(ids.filter(Boolean), ['bapl6liul']);
  assert.strictEqual(ids.length - ids.filter(Boolean).length, 6);
});

test('host.js adds the live runs\' names and ids to every processes message', () => {
  const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');
  assert.ok(HOST.includes('createProcessesBroadcast((msg) => broadcastControl({ ...msg, agents: liveAgents() }))'));
  assert.ok(HOST.includes('mood.invocations().filter(i => typeof i.agentId === \'string\' && i.agentId'));
});
