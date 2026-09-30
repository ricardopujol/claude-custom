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

test('a hand-edited loadout with two Pace items applies the FIRST and drops the conflicting second', () => {
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

// --- PR #68, Miguel I3: the stdin paths -------------------------------------------

const { EventEmitter } = require('node:events');

function fakeStdin() {
  const s = new EventEmitter();
  s.setEncoding = () => {};
  s.destroyed = false;
  s.destroy = () => { s.destroyed = true; };
  return s;
}
const ARGV = (dir) => ['node', 'hook', '--state', dir];

test('run(): a stdin that never closes is answered after the timeout, and destroyed', async () => {
  const dir = stateWith(belt('code-reviewer', 'pace-haiku'));
  const stdin = fakeStdin();
  const written = [];
  const started = Date.now();
  const p = hook.run({ stdin, argv: ARGV(dir), write: s => written.push(s), timeoutMs: 40 });
  stdin.emit('data', payload());          // the payload arrived, the CLI never ended stdin
  await p;
  assert.ok(Date.now() - started >= 35, 'it waited for the timeout rather than answering early');
  assert.strictEqual(written.length, 1);
  assert.strictEqual(JSON.parse(written[0]).hookSpecificOutput.updatedInput.model, 'haiku');
  assert.strictEqual(stdin.destroyed, true, 'stdin is destroyed so the loop can drain without process.exit');
});

test('run(): a stdin error still answers exactly once', async () => {
  const dir = stateWith(belt('code-reviewer', 'pace-haiku'));
  const stdin = fakeStdin();
  const written = [];
  const p = hook.run({ stdin, argv: ARGV(dir), write: s => written.push(s), timeoutMs: 5000 });
  stdin.emit('data', payload());
  stdin.emit('error', new Error('EPIPE'));
  stdin.emit('end');                       // a late end must not answer twice
  await p;
  assert.strictEqual(written.length, 1);
});

test('run(): end before the timeout answers at once', async () => {
  const dir = stateWith(belt('code-reviewer', 'pace-haiku'));
  const stdin = fakeStdin();
  const written = [];
  const started = Date.now();
  const p = hook.run({ stdin, argv: ARGV(dir), write: s => written.push(s), timeoutMs: 5000 });
  stdin.emit('data', payload());
  stdin.emit('end');
  await p;
  assert.ok(Date.now() - started < 1000);
  assert.strictEqual(written.length, 1);
});

test('run(): nothing to change writes nothing', async () => {
  const dir = stateWith(belt('someone-else', 'pace-haiku'));
  const stdin = fakeStdin();
  const written = [];
  const p = hook.run({ stdin, argv: ARGV(dir), write: s => written.push(s), timeoutMs: 5000 });
  stdin.emit('data', payload());
  stdin.emit('end');
  await p;
  assert.deepStrictEqual(written, []);
});

test('as a process: stdin left OPEN still gets the answer and a clean exit (the 3 s branch)', () => {
  const dir = stateWith(belt('code-reviewer', 'pace-haiku'));
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, '--state', dir], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    const started = Date.now();
    child.on('close', (code) => {
      try {
        assert.strictEqual(code, 0);
        assert.strictEqual(JSON.parse(out).hookSpecificOutput.updatedInput.model, 'haiku');
        assert.ok(Date.now() - started < 8000);
        resolve();
      } catch (e) { reject(e); }
    });
    child.stdin.write(payload());          // never end()
  });
});

test('a 300 KB prompt comes back complete, not truncated', () => {
  const dir = stateWith(belt('code-reviewer', 'verify-with-test'));
  const big = 'x'.repeat(300 * 1024);
  const r = run(payload({ tool_input: { subagent_type: 'code-reviewer', prompt: big, description: 'd' } }), ['--state', dir]);
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout);               // throws if truncated
  assert.ok(out.hookSpecificOutput.updatedInput.prompt.endsWith(big));
});
