'use strict';
/**
 * The mod's own directory (mods/claude-custom, BACKLOG #119 A2) is checked the way the CLI checks it: `claude plugin validate --strict`
 * reads the manifest and statically analyses the hooks module, and `claude plugin test` runs the mod's own suite
 * (mods/claude-custom/tests/feed.test.ts). Both need the real `claude` on PATH, so they are skipped with a named reason where it isn't.
 * The static checks below need nothing: the mod does only what it says (reads, posts to loopback, never changes a decision).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'mods', 'claude-custom');
const read = (...p) => fs.readFileSync(path.join(DIR, ...p), 'utf8').replace(/\r\n/g, '\n');
const REGISTER = read('hooks', 'register.js');
const RECORDS = read('hooks', 'records.js');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

// The same places the host looks (host/host.js resolveClaude): the native binary an npm install leaves, then ~/.local/bin. Not the npm
// `claude.cmd` shim, which needs a shell and so a quoting scheme for the paths below.
function findClaude() {
  const home = require('os').homedir();
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude'),
  ];
  return candidates.find(c => c && fs.existsSync(c)) || (process.platform === 'win32' ? null : 'claude');
}
const CLAUDE = findClaude();
function claudeVersion() {
  if (CLAUDE === null) return null;
  const r = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  return r.error || r.status !== 0 ? null : String(r.stdout).trim();
}
const VERSION = claudeVersion();
const skip = VERSION === null ? 'the `claude` CLI is not installed where the host looks for it, or not runnable' : false;

function claude(args) {
  return spawnSync(CLAUDE, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, cwd: DIR });
}

test('claude plugin validate --strict passes on the mod directory', { skip }, () => {
  const r = claude(['plugin', 'validate', DIR, '--strict']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Validation passed/);
});

test('the validator sees exactly the hooks and calls the mod is meant to have, and no more', { skip }, () => {
  const out = claude(['plugin', 'validate', DIR, '--strict']).stdout;
  const hooks = /register\.js hooks: ([^\n]*)/.exec(out);
  assert.ok(hooks, out);
  assert.deepStrictEqual(hooks[1].split(', ').sort(), ['session.end', 'session.measure', 'session.start', 'tool.check', 'turn.complete', 'turn.start']);
  const calls = /register\.js calls: ([^\n]*)/.exec(out);
  assert.ok(calls, out);
  const names = calls[1].replace(/\s*\(via [^)]*\)/g, '').split(', ').sort();
  assert.deepStrictEqual(names, ['$.agent.list', '$.clock.now', '$.env.get', '$.http.fetch', '$.session.id', '$.session.usage']);
  assert.match(out, /env reads: CLAUDE_CUSTOM_MOD_PORT, CLAUDE_CUSTOM_MOD_TOKEN/);
  assert.match(out, /env writes: nothing/);
});

test('claude plugin test passes the mod\'s own suite', { skip }, () => {
  const r = claude(['plugin', 'test']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, / 0 fail/);
  assert.match(r.stdout, /\d+ pass/);
});

test('the mod\'s manifest name is not one the CLI refuses (nothing starting with claude-)', () => {
  const m = JSON.parse(fs.readFileSync(path.join(DIR, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.ok(!m.name.startsWith('claude-'));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DIR, 'hooks', 'hooks.json'), 'utf8')).modules[0], './register.js');
});

test('the mod only observes: it uses no call that changes the session, the screen or the machine', () => {
  const code = strip(REGISTER) + strip(RECORDS);
  const used = new Set([...code.matchAll(/\$\.([a-z]+)\.([a-zA-Z]+)\(/g)].map(m => `${m[1]}.${m[2]}`));
  assert.deepStrictEqual([...used].sort(), ['agent.list', 'clock.now', 'env.get', 'http.fetch', 'session.id', 'session.usage']);
  for (const banned of ['$.ui', '$.prompt', '$.session.send', '$.session.append', '$.session.compact', '$.process', '$.fs', '$.store', '$.tool.call', '$.model', '$.env.set', '$.turn.abort', '$.config']) {
    assert.ok(!code.includes(banned), banned);
  }
});

test('tool.check hands back what next(e) resolved to, after calling it first, and a throw in the feed cannot replace it', () => {
  const hook = strip(REGISTER).slice(strip(REGISTER).indexOf("on('tool.check'"));
  const body = hook.slice(0, hook.indexOf('\n  })') + 5);
  const first = body.indexOf('await next(e)');
  assert.ok(first !== -1);
  assert.ok(first < body.indexOf('sendAsk'), 'next(e) comes before anything else');
  assert.match(body, /try \{[\s\S]*sendAsk[\s\S]*\} catch/);
  assert.match(body, /return decision\n/);
  assert.doesNotMatch(body, /decision:\s*['"]/, 'it never builds a decision of its own');
});

test('the mod posts only to 127.0.0.1, with the port and token from its environment, and never awaits the response', () => {
  const code = strip(REGISTER);
  assert.match(code, /`http:\/\/127\.0\.0\.1:\$\{port\}\/mod\?token=\$\{token\}`/);
  assert.strictEqual((code.match(/https?:\/\//g) || []).length, 1, 'one URL in the file');
  assert.match(code, /\$\.http\.fetch\([^\n]*\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(code, /await \$\.http\.fetch/);
});
