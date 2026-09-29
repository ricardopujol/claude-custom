'use strict';
/**
 * host/loadout-hook.js -- the PreToolUse hook that rewrites an Agent spawn
 * (BACKLOG #17). Spawned as a child with stdin, exactly as the CLI runs it,
 * because "it exits 0 and prints nothing on every failure" is a property of the
 * PROCESS, not of a function.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { tmpDir } = require('./tmp-dir');
const L = require('../host/loadout');
const hook = require('../host/loadout-hook');

const HOOK = path.join(__dirname, '..', 'host', 'loadout-hook.js');

function stateWith(loadout) {
  const dir = tmpDir('cc-loadout-hook-');
  if (loadout !== undefined) {
    fs.writeFileSync(path.join(dir, 'loadout.json'), typeof loadout === 'string' ? loadout : JSON.stringify(loadout));
  }
  return dir;
}
const belt = (agent, ...ids) => ids.reduce((l, id) => L.equip(l, agent, id).loadout, L.emptyLoadout());

function run(stdin, args) {
  return spawnSync(process.execPath, [HOOK, ...args], { input: stdin, encoding: 'utf8', windowsHide: true, timeout: 15000 });
}
const payload = (over = {}) => JSON.stringify({
  hook_event_name: 'PreToolUse', tool_name: 'Agent',
  tool_input: { subagent_type: 'code-reviewer', prompt: 'Review it', description: 'd' }, ...over,
});

test('an equipped spawn gets exactly the documented updatedInput envelope', () => {
  const dir = stateWith(belt('code-reviewer', 'pace-haiku', 'verify-with-test'));
  const r = run(payload(), ['--state', dir]);
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, {
    subagent_type: 'code-reviewer', description: 'd', model: 'haiku',
    prompt: 'Before you finish, add or run the test that fails without your change.\n\nReview it',
  });
  assert.deepStrictEqual(Object.keys(out.hookSpecificOutput).sort(), ['hookEventName', 'updatedInput'],
    'no permissionDecision: the hook must not answer the user\'s permission prompt for them');
});

test('the older Task tool name is rewritten too', () => {
  const dir = stateWith(belt('code-reviewer', 'pace-opus'));
  const r = run(payload({ tool_name: 'Task' }), ['--state', dir]);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.model, 'opus');
});

test('nothing equipped for this agent: prints nothing, exits 0', () => {
  const dir = stateWith(belt('someone-else', 'pace-haiku'));
  const r = run(payload(), ['--state', dir]);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('a tool that is not Agent/Task is ignored even if its input looks like a spawn', () => {
  const dir = stateWith(belt('code-reviewer', 'pace-haiku'));
  for (const tool_name of ['Bash', 'Read', 'agent', '', undefined]) {
    const r = run(payload({ tool_name }), ['--state', dir]);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', String(tool_name));
  }
});

test('every failure path is silent and exits 0', () => {
  const good = stateWith(belt('code-reviewer', 'pace-haiku'));
  const cases = [
    ['no --state', payload(), []],
    ['--state with no value', payload(), ['--state']],
    ['state dir does not exist', payload(), ['--state', path.join(good, 'nope')]],
    ['empty stdin', '', ['--state', good]],
    ['stdin is not JSON', 'not json {', ['--state', good]],
    ['stdin is JSON but not an object', '7', ['--state', good]],
    ['stdin is null', 'null', ['--state', good]],
    ['no tool_input', JSON.stringify({ tool_name: 'Agent' }), ['--state', good]],
    ['tool_input is a string', JSON.stringify({ tool_name: 'Agent', tool_input: 'x' }), ['--state', good]],
    ['loadout file is corrupt', payload(), ['--state', stateWith('{"agents": {"code-rev')]],
    ['loadout file is JSON junk', payload(), ['--state', stateWith('[1,2,3]')]],
    ['loadout file is a directory', payload(), ['--state', (() => {
      const d = stateWith(); fs.mkdirSync(path.join(d, 'loadout.json')); return d;
    })()]],
  ];
  for (const [name, stdin, args] of cases) {
    const r = run(stdin, args);
    assert.strictEqual(r.status, 0, name);
    assert.strictEqual(r.stdout, '', name);
  }
});

test('a hand-edited loadout with two Pace items applies neither conflict', () => {
  const dir = stateWith({ agents: { 'code-reviewer': ['pace-haiku', 'pace-opus'] } });
  const out = JSON.parse(run(payload(), ['--state', dir]).stdout);
  assert.strictEqual(out.hookSpecificOutput.updatedInput.model, 'haiku');
});

test('the loadout is re-read on every invocation: a change lands on the next spawn, no restart', () => {
  const dir = stateWith(belt('code-reviewer', 'pace-haiku'));
  assert.strictEqual(JSON.parse(run(payload(), ['--state', dir]).stdout).hookSpecificOutput.updatedInput.model, 'haiku');
  fs.writeFileSync(path.join(dir, 'loadout.json'), JSON.stringify(belt('code-reviewer', 'pace-opus')));
  assert.strictEqual(JSON.parse(run(payload(), ['--state', dir]).stdout).hookSpecificOutput.updatedInput.model, 'opus');
  fs.writeFileSync(path.join(dir, 'loadout.json'), JSON.stringify(L.emptyLoadout()));
  assert.strictEqual(run(payload(), ['--state', dir]).stdout, '');
});

test('decide() is the same logic without a process: null when there is nothing to change', () => {
  const dir = stateWith(belt('code-reviewer', 'pace-haiku'));
  assert.strictEqual(hook.decide(payload({ tool_name: 'Bash' }), dir), null);
  assert.strictEqual(hook.decide('garbage', dir), null);
  assert.strictEqual(hook.decide(payload(), null), null);
  assert.strictEqual(typeof hook.decide(payload(), dir), 'string');
});

test('the hook stays cheap to start: it requires only the loadout core and payload contract', () => {
  // Node startup is paid per Agent spawn. This pins the require graph so a
  // future import of the store or the host does not quietly add to it.
  const src = fs.readFileSync(HOOK, 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(requires, ['./loadout', './payload-contract', 'fs', 'path']);
});
