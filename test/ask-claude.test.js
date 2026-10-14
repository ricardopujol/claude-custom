'use strict';
/**
 * host/ask-claude.js (BACKLOG #33, Round 8): a Claude model (Haiku / Sonnet) answers through the REAL `claude` CLI on the person's
 * plan. Pinned here with a fake spawn: what it is given (flags, stdin, env), and that every way it can fail is named.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createClaudeAnswerer, CLAUDE_MODELS, STRIPPED_ENV } = require('../host/ask-claude');

function fakeSpawn(script) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const written = [];
    child.stdin = { write: (s) => written.push(s), end: () => { child.stdinEnded = true; }, on: () => {} };
    calls.push({ bin, args, opts, child, written });
    setImmediate(() => script(child, { bin, args, opts, written }));
    return child;
  };
  return { spawn, calls };
}
const finish = (child, code, out = '', err = '') => {
  if (out) child.stdout.emit('data', Buffer.from(out));
  if (err) child.stderr.emit('data', Buffer.from(err));
  child.exitCode = code;
  child.emit('close', code);
};
const okJson = (result) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result });

const make = (script, extra = {}) => {
  const f = fakeSpawn(script);
  return { f, a: createClaudeAnswerer({ spawn: f.spawn, claudeBin: 'claude-test', env: { PATH: 'x' }, killFn: () => true, ...extra }) };
};

test('a model is only haiku or sonnet', () => {
  assert.deepStrictEqual(Object.keys(CLAUDE_MODELS), ['haiku', 'sonnet']);
});

test('generate: sends the prompt on stdin, answers with the CLI result text', async () => {
  const { f, a } = make((c) => finish(c, 0, okJson('The idea.')));
  const r = await a.generate({ model: 'haiku', system: 'SYS', prompt: 'PROMPT BODY' });
  assert.deepStrictEqual(r, { ok: true, text: 'The idea.' });
  assert.deepStrictEqual(f.calls[0].written, ['PROMPT BODY']);
  assert.strictEqual(f.calls[0].child.stdinEnded, true);
  assert.strictEqual(f.calls[0].bin, 'claude-test');
});

test('generate: the CLI is read-only by construction: no tools, no MCP, no saved session, no settings, no skills', async () => {
  const { f, a } = make((c) => finish(c, 0, okJson('x')));
  await a.generate({ model: 'sonnet', system: 'SYS', prompt: 'P' });
  const args = f.calls[0].args;
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes('-p'));
  assert.strictEqual(at('--model'), 'sonnet');
  assert.strictEqual(at('--tools'), '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.strictEqual(at('--setting-sources'), '');
  assert.strictEqual(at('--output-format'), 'json');
  assert.strictEqual(at('--system-prompt'), 'SYS');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--bare'), '--bare would need an API key');
  assert.strictEqual(f.calls[0].opts.windowsHide, true);
  assert.deepStrictEqual(f.calls[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
});

test('generate: the child can never bill: the API key and the harness variables are stripped from its environment', async () => {
  const env = {
    PATH: 'p', ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_AUTH_TOKEN: 'tok', ELECTRON_RUN_AS_NODE: '1',
    CLAUDE_CUSTOM_PORT: '1', CLAUDE_CUSTOM_CWD: 'c', HOME: 'h',
  };
  const f = fakeSpawn((c) => finish(c, 0, okJson('x')));
  const a = createClaudeAnswerer({ spawn: f.spawn, claudeBin: 'c', env, killFn: () => true });
  await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  const got = f.calls[0].opts.env;
  assert.deepStrictEqual(Object.keys(got).sort(), ['HOME', 'PATH']);
  assert.ok(STRIPPED_ENV.includes('ANTHROPIC_API_KEY'));
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-secret', 'the caller\'s own environment is not touched');
});

test('generate: an unknown model is refused before anything runs', async () => {
  const { f, a } = make(() => assert.fail('must not spawn'));
  assert.deepStrictEqual(await a.generate({ model: 'opus', system: 's', prompt: 'p' }), { ok: false, reason: 'unknown-model', model: 'opus' });
  assert.strictEqual(f.calls.length, 0);
});

test('generate: an empty prompt is refused', async () => {
  const { a } = make(() => assert.fail('must not spawn'));
  assert.deepStrictEqual(await a.generate({ model: 'haiku', system: 's', prompt: '  ' }), { ok: false, reason: 'empty-prompt' });
});

test('generate: no claude on the machine is named, not an empty answer', async () => {
  const { a } = make((c) => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; c.emit('error', e); });
  assert.deepStrictEqual(await a.generate({ model: 'haiku', system: 's', prompt: 'p' }), { ok: false, reason: 'claude-missing' });
});

test('generate: a CLI that says it is not signed in is named', async () => {
  const body = JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login', api_error_status: 401 });
  const { a } = make((c) => finish(c, 1, body));
  const r = await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not-signed-in');
});

test('generate: any other failed run keeps the CLI\'s own words (shortened), never an empty answer', async () => {
  const { a } = make((c) => finish(c, 1, '', 'boom '.repeat(200)));
  const r = await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'claude-failed');
  assert.ok(r.detail.length <= 300 && r.detail.startsWith('boom'));
});

test('generate: an error result with exit 0 is a failure too', async () => {
  const body = JSON.stringify({ type: 'result', is_error: true, result: 'Overloaded', api_error_status: 529 });
  const { a } = make((c) => finish(c, 0, body));
  const r = await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, 'claude-failed', 'Overloaded']);
});

test('generate: output that is not the CLI\'s JSON, or has no text, is bad-reply', async () => {
  for (const out of ['not json', JSON.stringify({ type: 'result', is_error: false, result: '   ' }), JSON.stringify({ is_error: false })]) {
    const { a } = make((c) => finish(c, 0, out));
    assert.deepStrictEqual(await a.generate({ model: 'haiku', system: 's', prompt: 'p' }), { ok: false, reason: 'bad-reply' });
  }
});

test('generate: a run that outlasts the deadline is killed (its own pid, once) and named timeout', async () => {
  const killed = [];
  const { a, f } = make(() => { /* never finishes */ }, { timeoutMs: 20, killFn: (child) => { killed.push(child.pid); setImmediate(() => finish(child, null)); return true; } });
  const r = await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.deepStrictEqual(r, { ok: false, reason: 'timeout' });
  assert.deepStrictEqual(killed, [f.calls[0].child.pid]);
});

test('generate: a result that arrives after the deadline is nobody\'s (settles once)', async () => {
  const { a } = make((c) => setTimeout(() => finish(c, 0, okJson('late')), 60), { timeoutMs: 20, killFn: () => true });
  assert.deepStrictEqual(await a.generate({ model: 'haiku', system: 's', prompt: 'p' }), { ok: false, reason: 'timeout' });
});

test('generate: stdout is capped so a runaway child cannot fill memory', async () => {
  const { a } = make((c) => { c.stdout.emit('data', Buffer.alloc(3_000_000, 97)); finish(c, 0, ''); }, { maxOutputBytes: 1000 });
  const r = await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.deepStrictEqual(r, { ok: false, reason: 'bad-reply' });
});
