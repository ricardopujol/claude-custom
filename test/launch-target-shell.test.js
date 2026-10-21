'use strict';
/**
 * BACKLOG #119 A5: the launch target "shell" (host/launch-target.js). A shell tab's pty runs the person's shell instead of
 * `claude`. Which binary is a pure decision: CLAUDE_CUSTOM_SHELL wins as given, else PowerShell 7 when it is on PATH, else
 * Windows PowerShell. Every collaborator (PATH lookup, file existence) is injected.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { pickShell, shellEnv } = require('../host/launch-target');

const WIN = { platform: 'win32', systemRoot: 'C:\\Windows' };
const PS5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('pwsh on PATH is the pick, with no arguments', () => {
  const r = pickShell({}, { ...WIN, onPath: (n) => (n === 'pwsh.exe' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null), exists: () => true });
  assert.deepStrictEqual(r, { bin: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: [], source: 'pwsh' });
});

test('no pwsh: Windows PowerShell, at its fixed System32 path', () => {
  const r = pickShell({}, { ...WIN, onPath: () => null, exists: (p) => p === PS5 });
  assert.deepStrictEqual(r, { bin: PS5, args: [], source: 'powershell' });
});

test('no pwsh and no System32 copy found: the bare name, left for the pty to resolve', () => {
  const r = pickShell({}, { ...WIN, onPath: () => null, exists: () => false });
  assert.deepStrictEqual(r, { bin: 'powershell.exe', args: [], source: 'powershell' });
});

test('CLAUDE_CUSTOM_SHELL as an absolute path is returned exactly as given, found or not', () => {
  const r = pickShell({ CLAUDE_CUSTOM_SHELL: 'D:\\tools\\nu.exe' }, { ...WIN, onPath: () => 'C:\\x\\pwsh.exe', exists: () => false });
  assert.deepStrictEqual(r, { bin: 'D:\\tools\\nu.exe', args: [], source: 'override' });
});

test('CLAUDE_CUSTOM_SHELL as a command on PATH resolves to the file found; unresolved it stays the name', () => {
  const found = pickShell({ CLAUDE_CUSTOM_SHELL: 'nu' }, { ...WIN, onPath: (n) => (n === 'nu' || n === 'nu.exe' ? 'C:\\bin\\nu.exe' : null), exists: () => true });
  assert.strictEqual(found.bin, 'C:\\bin\\nu.exe');
  assert.strictEqual(found.source, 'override');
  const missing = pickShell({ CLAUDE_CUSTOM_SHELL: 'nu' }, { ...WIN, onPath: () => null, exists: () => false });
  assert.strictEqual(missing.bin, 'nu');
});

test('a blank or whitespace override is no override', () => {
  for (const v of ['', '   ', '\t']) {
    const r = pickShell({ CLAUDE_CUSTOM_SHELL: v }, { ...WIN, onPath: () => null, exists: () => false });
    assert.strictEqual(r.source, 'powershell', JSON.stringify(v));
  }
});

test('an override with surrounding spaces or quotes is trimmed of both', () => {
  const r = pickShell({ CLAUDE_CUSTOM_SHELL: '  "D:\\t\\nu.exe" ' }, { ...WIN, onPath: () => null, exists: () => true });
  assert.strictEqual(r.bin, 'D:\\t\\nu.exe');
});

test('off Windows: $SHELL, else /bin/sh', () => {
  assert.strictEqual(pickShell({ SHELL: '/usr/bin/zsh' }, { platform: 'linux', onPath: () => null, exists: () => true }).bin, '/usr/bin/zsh');
  assert.strictEqual(pickShell({}, { platform: 'linux', onPath: () => null, exists: () => true }).bin, '/bin/sh');
});

test('property: the pick is deterministic, has no arguments, and is the override or a binary that exists or a bare PowerShell name', () => {
  const name = fc.stringMatching(/^[A-Za-z0-9_.\\:-]{1,20}$/);
  fc.assert(fc.property(
    fc.option(name, { nil: undefined }), fc.boolean(), fc.boolean(), name,
    (override, hasPwsh, hasPs5, pwshPath) => {
      const env = override === undefined ? {} : { CLAUDE_CUSTOM_SHELL: override };
      const deps = { ...WIN, onPath: (n) => (hasPwsh && n === 'pwsh.exe' ? pwshPath : null), exists: (p) => (hasPs5 && p === PS5) || (hasPwsh && p === pwshPath) };
      const a = pickShell(env, deps);
      const b = pickShell(env, deps);
      assert.deepStrictEqual(a, b);
      assert.deepStrictEqual(a.args, []);
      assert.ok(typeof a.bin === 'string' && a.bin !== '');
      if (override !== undefined && override.trim() !== '') {
        assert.strictEqual(a.source, 'override');
      } else {
        assert.ok(a.bin === pwshPath || a.bin === PS5 || a.bin === 'powershell.exe', a.bin);
        if (hasPwsh) assert.strictEqual(a.bin, pwshPath);
      }
    },
  ), { numRuns: 200, seed: 7501 });
});

test('shellEnv: nothing of the harness reaches an arbitrary program, and ELECTRON_RUN_AS_NODE never does', () => {
  const out = shellEnv({
    PATH: 'C:\\bin', HOME: 'h', CLAUDE_CUSTOM_TOKEN: 'secret', CLAUDE_CUSTOM_PORT: '4100', CLAUDE_CUSTOM_BIN: 'x',
    CLAUDE_CUSTOM_SHELL: 'nu', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  });
  assert.deepStrictEqual(Object.keys(out).sort(), ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'HOME', 'PATH']);
});

test('shellEnv does not change its input', () => {
  const base = { CLAUDE_CUSTOM_TOKEN: 't', ELECTRON_RUN_AS_NODE: '1', A: 'b' };
  shellEnv(base);
  assert.deepStrictEqual(base, { CLAUDE_CUSTOM_TOKEN: 't', ELECTRON_RUN_AS_NODE: '1', A: 'b' });
});
