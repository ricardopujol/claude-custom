'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  MIN_CLAUDE_VERSION, parseVersion, compareVersions,
  CLAUDE_TIMEOUT_MS, execOnce, realDeps, ollamaProbe,
  checkClaude, checkHelper, checkSignedIn, checkOllama, runChecks, summarize,
} = require('../host/first-run');

test('parseVersion reads the first x.y.z and nothing else', () => {
  assert.deepEqual(parseVersion('2.1.304 (Claude Code)'), [2, 1, 304]);
  assert.deepEqual(parseVersion('v10.0.1\n'), [10, 0, 1]);
  for (const bad of ['', 'claude', '2.1', null, undefined, 7, {}]) assert.equal(parseVersion(bad), null);
});

test('compareVersions orders numerically, not as text', () => {
  assert.equal(compareVersions([2, 1, 304], [2, 1, 9]), 1);
  assert.equal(compareVersions([2, 0, 0], [2, 1, 0]), -1);
  assert.equal(compareVersions([2, 1, 0], [2, 1, 0]), 0);
});

test('checkClaude: ok at or above the floor', async () => {
  const r = await checkClaude({ run: async () => ({ ok: true, stdout: '2.1.304 (Claude Code)' }) });
  assert.equal(r.id, 'claude');
  assert.equal(r.status, 'ok');
  assert.equal(r.required, true);
  assert.match(r.detail, /2\.1\.304/);
});

test('checkClaude: older than the floor fails with the fix', async () => {
  const r = await checkClaude({ run: async () => ({ ok: true, stdout: '1.0.3 (Claude Code)' }) });
  assert.equal(r.status, 'fail');
  assert.match(r.fix, /claude update/);
  assert.ok(r.detail.includes(MIN_CLAUDE_VERSION));
});

test('checkClaude: a missing binary or unreadable output never reads as ok', async () => {
  const gone = await checkClaude({ run: async () => ({ ok: false, error: 'ENOENT' }) });
  assert.equal(gone.status, 'fail');
  assert.match(gone.fix, /npm install -g @anthropic-ai\/claude-code/);
  const odd = await checkClaude({ run: async () => ({ ok: true, stdout: 'hello' }) });
  assert.equal(odd.status, 'fail');
  const thrown = await checkClaude({ run: async () => { throw new Error('boom'); } });
  assert.equal(thrown.status, 'fail');
  const nothing = await checkClaude({});
  assert.equal(nothing.status, 'fail');
});

test('checkHelper: absent file fails and names the build command', async () => {
  const r = await checkHelper({ helperPath: 'C:\\x\\hook-helper.exe', exists: () => false, run: async () => ({ ok: true }) });
  assert.equal(r.status, 'fail');
  assert.match(r.fix, /npm run build:helper/);
  assert.match(r.detail, /hook-helper\.exe/);
});

test('checkHelper: present but will not run fails; runs cleanly is ok', async () => {
  const bad = await checkHelper({ helperPath: 'h.exe', exists: () => true, run: async () => ({ ok: false, error: 'EACCES' }) });
  assert.equal(bad.status, 'fail');
  const good = await checkHelper({ helperPath: 'h.exe', exists: () => true, run: async () => ({ ok: true, stdout: '' }) });
  assert.equal(good.status, 'ok');
  assert.equal(good.required, true);
});

test('checkHelper: a missing path or exists() that throws is a fail, not an ok', async () => {
  assert.equal((await checkHelper({ exists: () => true, run: async () => ({ ok: true }) })).status, 'fail');
  assert.equal((await checkHelper({ helperPath: 'h', exists: () => { throw new Error('x'); }, run: async () => ({ ok: true }) })).status, 'fail');
});

const LOGIN = { claudeAiOauth: { accessToken: 'tok' } };
const signedIn = (over) => checkSignedIn({ configDir: 'cfg', env: {}, exists: () => true, readJson: () => LOGIN, ...over });

test('checkSignedIn: ok only when the credentials file holds the Claude login entry; the token never reaches the result', () => {
  const asked = [];
  const ok = signedIn({ exists: (p) => { asked.push(p); return true; }, readJson: (p) => { asked.push(p); return { claudeAiOauth: { accessToken: 'sk-secret-token' } }; } });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(asked, [path.join('cfg', '.credentials.json'), path.join('cfg', '.credentials.json')]);
  assert.ok(!JSON.stringify(ok).includes('sk-secret-token'));
});

test('checkSignedIn: a file with no login in it is a fail (empty, {}, MCP tokens only, unreadable, a non-object login)', () => {
  for (const doc of [null, undefined, {}, [], 'x', { mcpOAuth: { a: 1 } }, { claudeAiOauth: null }, { claudeAiOauth: 'x' }]) {
    const r = signedIn({ readJson: () => doc });
    assert.equal(r.status, 'fail', JSON.stringify(doc));
    assert.match(r.fix, /claude/);
  }
  assert.equal(signedIn({ readJson: () => { throw new Error('bad json'); } }).status, 'fail');
  assert.equal(signedIn({ readJson: undefined }).status, 'fail');
});

test('checkSignedIn: no file means fail, and a file we cannot ask about is not ok', () => {
  assert.equal(signedIn({ exists: () => false }).status, 'fail');
  assert.equal(signedIn({ exists: () => { throw new Error('fs'); } }).status, 'fail');
  assert.equal(signedIn({ exists: undefined }).status, 'fail');
});

test('checkSignedIn: a credential in the SESSION environment counts, and the result names the mechanism, never the value', () => {
  const cases = [
    [{ ANTHROPIC_API_KEY: 'sekret-a' }, /API key/],
    [{ ANTHROPIC_AUTH_TOKEN: 'sekret-b' }, /auth token/],
    [{ CLAUDE_CODE_OAUTH_TOKEN: 'sekret-c' }, /OAuth token/],
    [{ CLAUDE_CODE_USE_BEDROCK: '1' }, /Bedrock/],
    [{ CLAUDE_CODE_USE_VERTEX: 'true' }, /Vertex/],
  ];
  for (const [env, what] of cases) {
    const r = signedIn({ env, exists: () => false });
    assert.equal(r.status, 'ok', JSON.stringify(env));
    assert.match(r.detail, /signed in via/);
    assert.match(r.detail, what);
    for (const v of Object.values(env)) assert.ok(!r.detail.includes(v) || v === '1' || v === 'true');
  }
});

test('checkSignedIn: an empty, blank or non-string credential, or a switched-off cloud flag, does not count', () => {
  for (const env of [{ ANTHROPIC_API_KEY: '  ' }, { ANTHROPIC_AUTH_TOKEN: '' }, { CLAUDE_CODE_OAUTH_TOKEN: 5 }, { ANTHROPIC_API_KEY: null },
    { CLAUDE_CODE_USE_BEDROCK: '0' }, { CLAUDE_CODE_USE_VERTEX: 'false' }, { CLAUDE_CODE_USE_BEDROCK: '' }]) {
    assert.equal(signedIn({ env, exists: () => false }).status, 'fail', JSON.stringify(env));
  }
});

test('checkSignedIn: the env the host builds for the OpenRouter provider counts as signed in', () => {
  const { buildProviderEnv } = require('../host/providers');
  const env = buildProviderEnv({ provider: 'openrouter', apiKey: 'or-key', baseUrl: 'https://openrouter.ai/api', model: 'x/y' });
  assert.equal(signedIn({ env, exists: () => false }).status, 'ok');
});

test('checkSignedIn: no config dir known is a fail', () => {
  assert.equal(checkSignedIn({ env: {}, exists: () => true, readJson: () => LOGIN }).status, 'fail');
});

test('checkOllama is optional: reachable is ok, anything else is info and never required', async () => {
  const up = await checkOllama({ probe: async () => ({ ok: true }) });
  assert.equal(up.status, 'ok');
  assert.equal(up.required, false);
  for (const probe of [async () => ({ ok: false }), async () => { throw new Error('refused'); }, undefined]) {
    const r = await checkOllama({ probe });
    assert.equal(r.status, 'info');
    assert.equal(r.required, false);
  }
});

test('runChecks returns all four in a fixed order and survives a check that throws', async () => {
  const deps = {
    run: async () => ({ ok: true, stdout: '2.1.304' }),
    helperPath: 'h.exe', exists: () => true, configDir: 'c', env: {},
    probe: async () => { throw new Error('down'); },
  };
  const rs = await runChecks(deps);
  assert.deepEqual(rs.map(r => r.id), ['claude', 'helper', 'signin', 'ollama']);
  const broken = await runChecks({ ...deps, exists: () => { throw new Error('fs'); } });
  assert.equal(broken.length, 4);
  assert.equal(broken.find(r => r.id === 'signin').status, 'fail');
});

test('summarize: all required ok means no banner; the first failing required check is the one line', () => {
  const ok = { id: 'x', required: true, status: 'ok', label: 'X', detail: '', fix: null };
  assert.equal(summarize([ok]).banner, null);
  const bad = { id: 'helper', required: true, status: 'fail', label: 'Hooks', detail: 'missing', fix: 'Hooks are off: run `npm run build:helper`' };
  const s = summarize([ok, bad, { ...bad, id: 'signin', fix: 'second' }]);
  assert.equal(s.banner, 'Hooks are off: run `npm run build:helper`');
  assert.equal(s.checks.length, 3);
});

test('summarize: an optional failure or info never raises the banner', () => {
  const opt = { id: 'ollama', required: false, status: 'info', label: 'Ollama', detail: 'not running', fix: null };
  assert.equal(summarize([opt]).banner, null);
});

test('summarize: no results at all is not a clean bill', () => {
  assert.equal(summarize([]).banner, null);
  assert.equal(summarize([]).checks.length, 0);
  assert.equal(summarize(undefined).checks.length, 0);
});

test('parseVersion: the line that names Claude Code wins, and the LAST x.y.z on it is the one', () => {
  assert.deepEqual(parseVersion('Using node 22.11.0\n1.0.67 (Claude Code)'), [1, 0, 67]);
  assert.deepEqual(parseVersion('1.0.67 (Claude Code)\nUsing node 22.11.0'), [1, 0, 67]);
  assert.deepEqual(parseVersion('C:\\v9.9.9\\claude 2.1.304 (Claude Code)'), [2, 1, 304]);
  assert.deepEqual(parseVersion('wrapper 1.2.3\nlauncher 4.5.6'), [4, 5, 6], 'with no Claude Code line, the last line that has a version');
  assert.equal(parseVersion('Claude Code, no number'), null);
});

test('the floor is exact: 2.1.0 passes, 2.0.99 fails, 2.1.1 passes, a prerelease of the floor fails', async () => {
  const at = (out) => checkClaude({ run: async () => ({ ok: true, stdout: out }) });
  assert.equal((await at(`${MIN_CLAUDE_VERSION} (Claude Code)`)).status, 'ok');
  assert.equal((await at('2.1.1 (Claude Code)')).status, 'ok');
  assert.equal((await at('2.0.99 (Claude Code)')).status, 'fail');
  assert.equal((await at('2.1.0-beta.3 (Claude Code)')).status, 'fail');
  assert.equal((await at('2.2.0-beta.1 (Claude Code)')).status, 'ok', 'a prerelease of a LATER version is above the floor');
  assert.equal((await at('Using node 22.11.0\n1.0.67 (Claude Code)')).status, 'fail', 'a wrapper line is not the CLI version');
  assert.match((await at('2.1.0-beta.3 (Claude Code)')).detail, /prerelease/);
});

test('a version check that timed out says it did not answer, and never says Claude Code is not installed', async () => {
  const r = await checkClaude({ run: async () => ({ ok: false, timedOut: true, error: 'ETIMEDOUT' }) });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, new RegExp(`didn't answer in ${CLAUDE_TIMEOUT_MS / 1000} s`));
  assert.ok(!/isn't installed/.test(r.fix));
  assert.match(r.fix, /terminal/);
  const gone = await checkClaude({ run: async () => ({ ok: false, error: 'ENOENT' }) });
  assert.match(gone.fix, /isn't installed/);
});

test('a helper that timed out is a fail that says so', async () => {
  const r = await checkHelper({ helperPath: 'h.exe', exists: () => true, run: async () => ({ ok: false, timedOut: true }) });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /didn't finish/);
});

test('execOnce: fixed argv, no shell for an exe, windowsHide, the timeout, and a temp folder as cwd', async () => {
  const seen = [];
  const exec = (file, args, opts, cb) => { seen.push([file, args, opts]); cb(null, '2.1.304 (Claude Code)\n'); };
  const r = await execOnce('C:/bin/claude.exe', ['--version'], 8000, { A: '1' }, exec);
  assert.deepEqual(r, { ok: true, stdout: '2.1.304 (Claude Code)\n' });
  const [file, args, opts] = seen[0];
  assert.equal(file, 'C:/bin/claude.exe');
  assert.deepEqual(args, ['--version']);
  assert.equal(opts.timeout, 8000);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.shell, false);
  assert.deepEqual(opts.env, { A: '1' });
  assert.equal(opts.cwd, require('os').tmpdir());
});

test('execOnce: a .cmd or .bat wrapper goes through the shell, quoted', async () => {
  for (const f of ['C:/tools/my claude.cmd', 'C:/tools/c.BAT']) {
    const seen = [];
    await execOnce(f, ['--version'], 1000, {}, (file, args, opts, cb) => { seen.push([file, opts.shell]); cb(null, ''); });
    assert.deepEqual(seen[0], [`"${f}"`, true]);
  }
});

test('execOnce: a timeout reads as timedOut, another failure as an error, a throw as an error', async () => {
  const killed = await execOnce('x.exe', [], 10, {}, (f, a, o, cb) => { const e = new Error('Command failed'); e.killed = true; e.code = null; cb(e, ''); });
  assert.equal(killed.ok, false);
  assert.equal(killed.timedOut, true);
  const failed = await execOnce('x.exe', [], 10, {}, (f, a, o, cb) => { const e = new Error('x'); e.code = 'ENOENT'; cb(e, ''); });
  assert.deepEqual(failed, { ok: false, timedOut: false, error: 'ENOENT' });
  const thrown = await execOnce('x.exe', [], 10, {}, () => { throw new Error('EINVAL'); });
  assert.deepEqual(thrown, { ok: false, error: 'EINVAL' });
});

test('realDeps: the CLI runs with --version, the helper with NO arguments, and the session env is what the checks read', async () => {
  const deps = realDeps({ claudeBin: 'C:/bin/claude.exe', helperPath: 'C:/h/hook-helper.exe', configDir: 'cfg', env: { ANTHROPIC_AUTH_TOKEN: 't' } });
  assert.equal(deps.helperPath, 'C:/h/hook-helper.exe');
  assert.equal(deps.configDir, 'cfg');
  assert.deepEqual(deps.env, { ANTHROPIC_AUTH_TOKEN: 't' });
  assert.equal(typeof deps.run, 'function');
  assert.equal(typeof deps.runHelper, 'function');
  assert.equal(deps.readJson('C:/no/such/file.json'), null);
});

test('ollamaProbe: GETs /api/tags without doubling the slash, ok only on a 2xx, and gives up on a hang', async () => {
  const urls = [];
  const up = await ollamaProbe('http://h:1/', 50, async (u) => { urls.push(u); return { ok: true }; });
  assert.deepEqual(up, { ok: true });
  assert.deepEqual(urls, ['http://h:1/api/tags']);
  assert.deepEqual(await ollamaProbe('http://h:1', 50, async () => ({ ok: false })), { ok: false });
  assert.deepEqual(await ollamaProbe('http://h:1', 50, async () => { throw new Error('refused'); }), { ok: false });
  const hung = await ollamaProbe('http://h:1', 20, (u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))));
  assert.deepEqual(hung, { ok: false });
  assert.deepEqual(await ollamaProbe('http://h:1', 50, null), { ok: false });
});

test('checkHelper: in an installed build the fix is a reinstall, not a build command', async () => {
  const dev = await checkHelper({ helperPath: 'h', exists: () => false, run: async () => ({ ok: true }) });
  assert.match(dev.fix, /npm run build:helper/);
  const inst = await checkHelper({ helperPath: 'h', exists: () => false, run: async () => ({ ok: true }), packaged: true });
  assert.match(inst.fix, /reinstall/);
  assert.ok(!/build:helper/.test(inst.fix));
  const viaRun = await runChecks({ run: async () => ({ ok: true, stdout: '2.1.304' }), helperPath: 'h', exists: () => false, packaged: true });
  assert.match(viaRun.find(r => r.id === 'helper').fix, /reinstall/);
});
