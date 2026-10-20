'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  MIN_CLAUDE_VERSION, parseVersion, compareVersions,
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

test('checkSignedIn: only existence is asked, never contents', () => {
  const asked = [];
  const ok = checkSignedIn({ configDir: 'C:\\cfg', env: {}, exists: (p) => { asked.push(p); return true; } });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(asked, [path.join('C:\\cfg', '.credentials.json')]);
  const no = checkSignedIn({ configDir: 'C:\\cfg', env: {}, exists: () => false });
  assert.equal(no.status, 'fail');
  assert.match(no.fix, /claude/);
});

test('checkSignedIn: an API key in the environment counts, an empty one does not', () => {
  assert.equal(checkSignedIn({ configDir: 'c', env: { ANTHROPIC_API_KEY: 'sk-x' }, exists: () => false }).status, 'ok');
  assert.equal(checkSignedIn({ configDir: 'c', env: { ANTHROPIC_API_KEY: '  ' }, exists: () => false }).status, 'fail');
  assert.equal(checkSignedIn({ configDir: 'c', env: { ANTHROPIC_API_KEY: 5 }, exists: () => false }).status, 'fail');
  const detail = checkSignedIn({ configDir: 'c', env: { ANTHROPIC_API_KEY: 'sk-secret' }, exists: () => false }).detail;
  assert.ok(!detail.includes('sk-secret'));
});

test('checkSignedIn: no config dir known is a fail', () => {
  assert.equal(checkSignedIn({ env: {}, exists: () => true }).status, 'fail');
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
