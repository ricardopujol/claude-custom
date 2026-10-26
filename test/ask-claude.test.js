'use strict';
/**
 * host/ask-claude.js (BACKLOG #33, Round 8): a Claude model (Haiku / Sonnet) answers through the REAL `claude` CLI on the person's
 * plan. Pinned here with a fake spawn: what it is given (flags, stdin, env), and that every way it can fail is named.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createClaudeAnswerer, CLAUDE_MODELS, ENV_ALLOW, childEnv } = require('../host/ask-claude');

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

test('generate: the child can never bill or be routed elsewhere: its environment is an allow-list', async () => {
  const env = {
    PATH: 'p', HOME: 'h', ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_AUTH_TOKEN: 'tok', ELECTRON_RUN_AS_NODE: '1',
    CLAUDE_CUSTOM_PORT: '1', CLAUDE_CUSTOM_CWD: 'c',
  };
  const f = fakeSpawn((c) => finish(c, 0, okJson('x')));
  const a = createClaudeAnswerer({ spawn: f.spawn, claudeBin: 'c', env, killFn: () => true });
  await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.deepStrictEqual(Object.keys(f.calls[0].opts.env).sort(), ['HOME', 'PATH']);
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-secret', 'the caller\'s own environment is not touched');
});

test('childEnv: routing, headers, model remaps, provider switches, cloud credentials and proxies never reach the child, in any case (PR #169 Dexter 1, 2, 7)', () => {
  const hostile = {
    anthropic_api_key: 'k', ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_CUSTOM_HEADERS: 'x: y', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-opus',
    ANTHROPIC_MODEL: 'm', Anthropic_Auth_Token: 't', ANTHROPIC_FOUNDRY_BASE_URL: 'u', CLAUDE_CODE_USE_BEDROCK: '1', claude_code_use_vertex: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', AWS_PROFILE: 'p', GOOGLE_APPLICATION_CREDENTIALS: 'g', CLOUD_ML_REGION: 'r',
    HTTPS_PROXY: 'http://proxy', http_proxy: 'http://proxy', ALL_PROXY: 'p', NODE_OPTIONS: '--require x', ELECTRON_RUN_AS_NODE: '1',
    claude_custom_cwd: 'c', CLAUDE_CUSTOM_PORT: '1', OPENAI_API_KEY: 'o', SOMETHING_ELSE: 'z',
  };
  assert.deepStrictEqual(childEnv(hostile), {}, 'nothing hostile survives, not one name');
});

test('childEnv: what the CLI needs to run and to find the person\'s own login does pass, with its own case', () => {
  const ok = { Path: 'p', SystemRoot: 'C:\\Windows', USERPROFILE: 'u', APPDATA: 'a', LOCALAPPDATA: 'l', TEMP: 't', TMP: 't', HOME: 'h', CLAUDE_CONFIG_DIR: 'C:\\cfg', CLAUDE_CODE_OAUTH_TOKEN: 'o', LC_ALL: 'C', lang: 'en' };
  assert.deepStrictEqual(childEnv(ok), ok);
  assert.ok(ENV_ALLOW.includes('PATH') && !ENV_ALLOW.some(n => n.startsWith('ANTHROPIC')), 'no ANTHROPIC name on the list');
});

test('PR #169 Dexter N5: a relative CLAUDE_CONFIG_DIR is resolved against the host\'s cwd (the child runs elsewhere), an absolute one is kept', () => {
  const path = require('path');
  const anchor = path.resolve('proj-dir');
  assert.strictEqual(childEnv({ CLAUDE_CONFIG_DIR: '.cc' }, { anchor }).CLAUDE_CONFIG_DIR, path.join(anchor, '.cc'));
  assert.strictEqual(childEnv({ claude_config_dir: '..\\other' }, { anchor }).claude_config_dir, path.resolve(anchor, '..\\other'));
  const abs = path.resolve('C:/Users/x/.claude');
  assert.strictEqual(childEnv({ CLAUDE_CONFIG_DIR: abs }, { anchor }).CLAUDE_CONFIG_DIR, abs);
  assert.strictEqual(childEnv({ CLAUDE_CONFIG_DIR: '' }, { anchor }).CLAUDE_CONFIG_DIR, '', 'empty is left as it is');
});

test('the spawned child gets the resolved config dir', async () => {
  const path = require('path');
  const f = fakeSpawn((c) => finish(c, 0, okJson('x')));
  const a = createClaudeAnswerer({ spawn: f.spawn, claudeBin: 'c', env: { CLAUDE_CONFIG_DIR: '.cc', PATH: 'p' }, anchor: path.resolve('proj-dir'), killFn: () => true });
  await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.strictEqual(f.calls[0].opts.env.CLAUDE_CONFIG_DIR, path.join(path.resolve('proj-dir'), '.cc'));
});

test('childEnv: a value that is not a string is dropped, and a missing environment is empty', () => {
  assert.deepStrictEqual(childEnv({ PATH: undefined, HOME: 5, TEMP: 't' }), { TEMP: 't' });
  assert.deepStrictEqual(childEnv(null), {});
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

test('generate: "Not logged in" said on stderr with no JSON at all is not-signed-in too (PR #169 Dexter 6)', async () => {
  const { a } = make((c) => finish(c, 1, '', 'Not logged in · Please run /login'));
  const r = await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'not-signed-in']);
  assert.match(r.detail, /Not logged in/);
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

test('generate: stdout is capped so a runaway child cannot fill memory, and it is ended at once, not at the deadline', async () => {
  const killed = [];
  const { a, f } = make((c) => { c.stdout.emit('data', Buffer.alloc(3_000_000, 97)); }, { maxOutputBytes: 1000, killFn: (child) => { killed.push(child.pid); return true; } });
  const r = await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.deepStrictEqual(r, { ok: false, reason: 'bad-reply' });
  assert.deepStrictEqual(killed, [f.calls[0].child.pid]);
});

// --- kill tests for the release-176 survivors (BACKLOG #94) ----------------------

test('S9: a 401 status alone means signed out, whatever the words say', async () => {
  const body = JSON.stringify({ type: 'result', is_error: true, result: 'something unrelated', api_error_status: 401 });
  const { a } = make((c) => finish(c, 1, body));
  const r = await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.deepStrictEqual(r, { ok: false, reason: 'not-signed-in', detail: 'something unrelated' });
});

test('S9: the sign-out words alone mean signed out, whatever the status says', async () => {
  const body = JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login', api_error_status: 500 });
  const { a } = make((c) => finish(c, 1, body));
  const r = await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'not-signed-in']);
  assert.match(r.detail, /Not logged in/);
});

test('S9: an error that is neither a 401 nor the sign-out words is claude-failed with the CLI\'s words', async () => {
  const body = JSON.stringify({ type: 'result', is_error: true, result: 'Overloaded', api_error_status: 529 });
  const { a } = make((c) => finish(c, 1, body));
  assert.deepStrictEqual(await a.generate({ model: 'haiku', system: 's', prompt: 'p' }), { ok: false, reason: 'claude-failed', detail: 'Overloaded' });
});

test('S9: stdout of exactly maxOutputBytes is accepted, one byte more is bad-reply and ends the child', async () => {
  const cap = 200;
  const base = Buffer.byteLength(okJson(''));
  const exact = okJson('x'.repeat(cap - base));
  assert.strictEqual(Buffer.byteLength(exact), cap);
  const accepted = make((c) => finish(c, 0, exact), { maxOutputBytes: cap });
  assert.deepStrictEqual(await accepted.a.generate({ model: 'haiku', system: 's', prompt: 'p' }), { ok: true, text: 'x'.repeat(cap - base) });
  const killed = [];
  const over = make((c) => finish(c, 0, okJson('x'.repeat(cap - base + 1))), { maxOutputBytes: cap, killFn: (child) => { killed.push(child.pid); return true; } });
  assert.deepStrictEqual(await over.a.generate({ model: 'haiku', system: 's', prompt: 'p' }), { ok: false, reason: 'bad-reply' });
  assert.strictEqual(killed.length, 1);
});

test('S9: a runaway child is ended once, however many more chunks it sends', async () => {
  const killed = [];
  const { a } = make((c) => { c.stdout.emit('data', Buffer.alloc(500, 97)); c.stdout.emit('data', Buffer.alloc(500, 97)); c.stdout.emit('data', Buffer.alloc(500, 97)); },
    { maxOutputBytes: 400, killFn: (child) => { killed.push(child.pid); return true; } });
  assert.deepStrictEqual(await a.generate({ model: 'haiku', system: 's', prompt: 'p' }), { ok: false, reason: 'bad-reply' });
  assert.strictEqual(killed.length, 1);
});

test('S9: a killFn that throws does not stop the reply being named bad-reply', async () => {
  const { a } = make((c) => { c.stdout.emit('data', Buffer.alloc(500, 97)); }, { maxOutputBytes: 400, killFn: () => { throw new Error('gone'); } });
  assert.deepStrictEqual(await a.generate({ model: 'haiku', system: 's', prompt: 'p' }), { ok: false, reason: 'bad-reply' });
});

test('S9: stderr is read until it holds 4000 characters: a chunk that finds it full is dropped, one that finds it short is kept', async () => {
  const full = make((c) => { c.stderr.emit('data', Buffer.from('a'.repeat(4000))); c.stderr.emit('data', Buffer.from(' Not logged in')); c.exitCode = 1; c.emit('close', 1); });
  const r1 = await full.a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.deepStrictEqual([r1.ok, r1.reason], [false, 'claude-failed'], 'the words after 4000 characters were never read');
  const short = make((c) => { c.stderr.emit('data', Buffer.from('a'.repeat(3999))); c.stderr.emit('data', Buffer.from(' Not logged in')); c.exitCode = 1; c.emit('close', 1); });
  const r2 = await short.a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.deepStrictEqual([r2.ok, r2.reason], [false, 'not-signed-in'], 'a chunk that found room was kept');
});

test('S9: the allow-list is exactly the names the CLI needs, each one reaches the child, and a name beside it does not', async () => {
  const EXPECTED = [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
    'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'LOGNAME', 'USER', 'SHELL',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
    'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN',
  ];
  assert.deepStrictEqual([...ENV_ALLOW], EXPECTED);
  const env = {};
  for (const name of EXPECTED) env[name] = name === 'CLAUDE_CONFIG_DIR' ? require('path').resolve('abs-cfg') : `v-${name}`;
  const f = fakeSpawn((c) => finish(c, 0, okJson('x')));
  const a = createClaudeAnswerer({ spawn: f.spawn, claudeBin: 'c', env: { ...env, PATHX: 'no', XPATH: 'no', 'HOME ': 'no', ANTHROPIC_API_KEY: 'no' }, killFn: () => true });
  await a.generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.deepStrictEqual(f.calls[0].opts.env, env);
});

test('S9: names starting LC_ pass in any case, a name merely containing LC_ does not', () => {
  assert.deepStrictEqual(childEnv({ LC_ALL: 'C', lc_messages: 'en', XLC_ALL: 'no', LC: 'no' }), { LC_ALL: 'C', lc_messages: 'en' });
});

test('S9: the child runs in a folder of its own unless one is given', async () => {
  const f = fakeSpawn((c) => finish(c, 0, okJson('x')));
  await createClaudeAnswerer({ spawn: f.spawn, claudeBin: 'c', env: {}, killFn: () => true }).generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.strictEqual(require('path').basename(f.calls[0].opts.cwd), 'claude-custom-ask-claude');
  const g = fakeSpawn((c) => finish(c, 0, okJson('x')));
  await createClaudeAnswerer({ spawn: g.spawn, claudeBin: 'c', env: {}, cwd: 'C:\\mine', killFn: () => true }).generate({ model: 'haiku', system: 's', prompt: 'p' });
  assert.strictEqual(g.calls[0].opts.cwd, 'C:\\mine');
});
