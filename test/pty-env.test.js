'use strict';
/**
 * BACKLOG #74 F (2), Ricardo 2026-11-06: "Only inside claude-custom". Every session the host starts (the branch session, a side
 * session, a shell tab) gets PYTHON_BASIC_REPL=1 in its pty's environment, so a console-less Python REPL an agent's shell starts gets
 * EOF and exits instead of looping into a multi-GB task-output file. Nothing is set user-wide: only the env handed to pty.spawn.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { ptyEnv, HARNESS_SESSION_ENV } = require('../host/pty-env');

const base = { PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\r' };
const shellEnv = (e) => ({ ...e, SHELLED: '1' });
const kinds = ['branch', 'side', 'shell'];
const make = (kind, over = {}) => ptyEnv({ kind, base, shellEnv, sessionEnv: { WORKTREE_NAME: 'w' }, providerEnv: { P: '1' }, modEnv: { M: '1' }, ...over });

test('#74 F2: PYTHON_BASIC_REPL=1 is in the pty env of all three kinds of session', () => {
  for (const kind of kinds) assert.strictEqual(make(kind).PYTHON_BASIC_REPL, '1', kind);
  assert.deepStrictEqual(HARNESS_SESSION_ENV, { PYTHON_BASIC_REPL: '1' });
});

test('#74 F2: an inherited PYTHON_BASIC_REPL is overridden, whatever the launching shell had', () => {
  for (const kind of kinds) {
    assert.strictEqual(make(kind, { base: { ...base, PYTHON_BASIC_REPL: '0' } }).PYTHON_BASIC_REPL, '1', kind);
    assert.strictEqual(make(kind, { sessionEnv: { PYTHON_BASIC_REPL: '' } }).PYTHON_BASIC_REPL, '1', kind);
  }
});

test('#74 F2: nothing user-wide: building the env changes neither the host\'s own environment nor the base it was given', () => {
  const before = process.env.PYTHON_BASIC_REPL;
  const b = { ...base };
  for (const kind of kinds) make(kind, { base: b });
  assert.strictEqual(process.env.PYTHON_BASIC_REPL, before);
  assert.deepStrictEqual(b, base);
});

test('the env is otherwise what host.js built before: a claude session is marked, a shell tab gets none of the harness\'s own', () => {
  for (const kind of ['branch', 'side']) {
    const e = make(kind);
    assert.strictEqual(e.CLAUDE_CUSTOM_SESSION, '1', kind);
    assert.strictEqual(e.TERM, 'xterm-256color');
    assert.strictEqual(e.COLORTERM, 'truecolor');
    assert.strictEqual(e.WORKTREE_NAME, 'w');
    assert.strictEqual(e.P, '1', 'providerEnv');
    assert.strictEqual(e.M, '1', 'the mod env');
    assert.strictEqual(e.SHELLED, undefined, 'shellEnv is only for a shell tab');
  }
  const s = make('shell');
  assert.strictEqual(s.SHELLED, '1');
  assert.strictEqual(s.CLAUDE_CUSTOM_SESSION, undefined);
  assert.strictEqual(s.P, undefined, 'no provider env in a shell tab');
  assert.strictEqual(s.M, undefined, 'no mod env in a shell tab');
  assert.strictEqual(s.WORKTREE_NAME, 'w');
  assert.strictEqual(s.TERM, 'xterm-256color');
});

test('#74 F2: host.js hands pty.spawn the env from ptyEnv, and it is the only pty.spawn in host/', () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const host = strip(fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8'));
  const at = host.indexOf('pty.spawn(');
  assert.ok(at > 0);
  assert.match(host.slice(at, at + 600), /env: ptyEnv\(\{ kind: SHELL \? 'shell' : SIDE \? 'side' : 'branch'/);
  const dir = path.join(__dirname, '..', 'host');
  const spawns = fs.readdirSync(dir).filter(f => f.endsWith('.js'))
    .flatMap(f => (strip(fs.readFileSync(path.join(dir, f), 'utf8')).match(/\bpty\.spawn\(/g) || []).map(() => f));
  assert.deepStrictEqual(spawns, ['host.js']);
});
