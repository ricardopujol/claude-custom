'use strict';
/**
 * BACKLOG #119 A5: the launch target "shell" (host/launch-target.js). A shell tab's pty runs the person's shell instead of
 * `claude`. Which binary is a pure decision: CLAUDE_CUSTOM_SHELL wins as given, else PowerShell 7 when it is on PATH, else
 * Windows PowerShell. Every collaborator (PATH lookup, file existence) is injected.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { pickShell, shellEnv, findOnPath, splitCommand, launchEnv } = require('../host/launch-target');

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

// --- PR #208 review: Dexter 2 (PATHEXT), Miguel Y1 (findOnPath and the real default), Dexter 1 (override with arguments), Dexter 3 ---

// A fake file system: stat(file) says isFile for exactly the listed files, and throws for the rest.
const fakeFs = (files) => {
  const set = new Set(files.map(f => f.toLowerCase()));
  return (f) => { if (set.has(String(f).toLowerCase())) return { isFile: () => true }; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
};
const NPM = 'C:\\Users\\r\\AppData\\Roaming\\npm';
const win = (files, over = {}) => ({ platform: 'win32', pathVar: `${NPM};C:\\bin`, stat: fakeFs(files), pathExt: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', ...over });

test('findOnPath: npm\'s extensionless shim never beats name.cmd (Dexter 2)', () => {
  const files = [`${NPM}\\codex`, `${NPM}\\codex.cmd`, `${NPM}\\codex.ps1`];
  assert.strictEqual(findOnPath('codex', win(files)), `${NPM}\\codex.cmd`);
});

test('findOnPath: only an extensionless file is no match on Windows', () => {
  assert.strictEqual(findOnPath('codex', win([`${NPM}\\codex`, `${NPM}\\codex.ps1`])), null);
});

test('findOnPath: a command that exists only as name.exe is found, and the order is PATHEXT\'s', () => {
  assert.strictEqual(findOnPath('nu', win(['C:\\bin\\nu.exe'])), 'C:\\bin\\nu.exe');
  assert.strictEqual(findOnPath('x', win(['C:\\bin\\x.cmd', 'C:\\bin\\x.exe'])), 'C:\\bin\\x.exe', '.EXE before .CMD in PATHEXT');
  assert.strictEqual(findOnPath('x', win(['C:\\bin\\x.cmd', 'C:\\bin\\x.exe'], { pathExt: '.CMD;.EXE' })), 'C:\\bin\\x.cmd');
});

test('findOnPath: folders are searched in order, and an earlier folder wins over a better extension later', () => {
  assert.strictEqual(findOnPath('x', win([`${NPM}\\x.cmd`, 'C:\\bin\\x.exe'])), `${NPM}\\x.cmd`);
});

test('findOnPath: a name that already ends in a runnable extension is taken as it is; a .ps1 or .js is not runnable', () => {
  assert.strictEqual(findOnPath('pwsh.exe', win(['C:\\bin\\pwsh.exe'])), 'C:\\bin\\pwsh.exe');
  assert.strictEqual(findOnPath('tool.ps1', win(['C:\\bin\\tool.ps1'])), null);
  assert.strictEqual(findOnPath('PWSH.EXE', win(['C:\\bin\\pwsh.exe'])), 'C:\\bin\\PWSH.EXE', 'case-insensitive file system; the name is kept as typed');
});

test('findOnPath: a missing or empty PATHEXT falls back to the four runnable extensions; non-runnable ones are ignored', () => {
  assert.strictEqual(findOnPath('x', win(['C:\\bin\\x.bat'], { pathExt: undefined })), 'C:\\bin\\x.bat');
  assert.strictEqual(findOnPath('x', win(['C:\\bin\\x.bat'], { pathExt: '.VBS;.JS' })), 'C:\\bin\\x.bat');
  assert.strictEqual(findOnPath('x', win(['C:\\bin\\x.vbs'], { pathExt: '.VBS' })), null);
});

test('findOnPath: quoted and blank PATH entries are tolerated; a name with a folder in it, or no name, is not looked up', () => {
  assert.strictEqual(findOnPath('nu', win(['C:\\my bin\\nu.exe'], { pathVar: ';  ;"C:\\my bin"' })), 'C:\\my bin\\nu.exe');
  assert.strictEqual(findOnPath('a\\nu', win(['C:\\bin\\a\\nu.exe'])), null);
  assert.strictEqual(findOnPath('', win([])), null);
  assert.strictEqual(findOnPath(undefined, win([])), null);
});

test('findOnPath: off Windows the bare name is the file', () => {
  const stat = fakeFs(['/usr/bin/zsh']);
  assert.strictEqual(findOnPath('zsh', { platform: 'linux', pathVar: '/bin:/usr/bin', stat }), '/usr/bin/zsh');
});

test('pickShell with the REAL findOnPath over a fake PATH and fake files: pwsh found as pwsh.exe, else the System32 copy (Miguel Y1)', () => {
  const PS7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const onPath = (n) => findOnPath(n, win([PS7], { pathVar: 'C:\\Program Files\\PowerShell\\7' }));
  assert.strictEqual(pickShell({}, { ...WIN, onPath, exists: () => true }).bin, PS7);
  const none = (n) => findOnPath(n, win([], { pathVar: 'C:\\Program Files\\PowerShell\\7' }));
  assert.strictEqual(pickShell({}, { ...WIN, onPath: none, exists: (p) => p === PS5 }).bin, PS5);
});

test('pickShell: CLAUDE_CUSTOM_SHELL=codex resolves to codex.cmd, not the shim (Dexter 2, end to end through the real lookup)', () => {
  const files = [`${NPM}\\codex`, `${NPM}\\codex.cmd`];
  const r = pickShell({ CLAUDE_CUSTOM_SHELL: 'codex' }, { ...WIN, onPath: (n) => findOnPath(n, win(files)), exists: (f) => files.includes(f) });
  assert.deepStrictEqual(r, { bin: `${NPM}\\codex.cmd`, args: [], source: 'override' });
});

test('pickShell: an override with arguments is cut into the program and its arguments (Dexter 1)', () => {
  const onPath = (n) => (n === 'pwsh' ? 'C:\\p\\pwsh.exe' : null);
  assert.deepStrictEqual(pickShell({ CLAUDE_CUSTOM_SHELL: 'pwsh -NoLogo -NoProfile' }, { ...WIN, onPath, exists: () => false }),
    { bin: 'C:\\p\\pwsh.exe', args: ['-NoLogo', '-NoProfile'], source: 'override' });
  assert.deepStrictEqual(pickShell({ CLAUDE_CUSTOM_SHELL: '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i' }, { ...WIN, onPath: () => null, exists: () => false }),
    { bin: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'], source: 'override' });
});

test('pickShell: an unquoted path with spaces that names an existing file is that file, with no arguments', () => {
  const file = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.deepStrictEqual(pickShell({ CLAUDE_CUSTOM_SHELL: file }, { ...WIN, onPath: () => null, exists: (f) => f === file }), { bin: file, args: [], source: 'override' });
});

test('pickShell: a path with no runnable extension gets the one that exists; one that exists as given is left alone', () => {
  assert.strictEqual(pickShell({ CLAUDE_CUSTOM_SHELL: 'D:\\tools\\nu' }, { ...WIN, onPath: () => null, exists: (f) => f === 'D:\\tools\\nu.exe' }).bin, 'D:\\tools\\nu.exe');
  assert.strictEqual(pickShell({ CLAUDE_CUSTOM_SHELL: 'D:\\tools\\nu' }, { ...WIN, onPath: () => null, exists: () => false }).bin, 'D:\\tools\\nu');
});

test('splitCommand: spaces separate, double quotes group and vanish, empty is no words', () => {
  assert.deepStrictEqual(splitCommand('a  b "c d" e"f g"h'), ['a', 'b', 'c d', 'ef gh']);
  assert.deepStrictEqual(splitCommand('   '), []);
  assert.deepStrictEqual(splitCommand('""'), ['']);
});

test('property: splitCommand of a join of quote-free words with spaces gives the words back', () => {
  fc.assert(fc.property(fc.array(fc.stringMatching(/^[A-Za-z0-9_.\\:-]{1,10}$/), { minLength: 1, maxLength: 6 }), (words) => {
    assert.deepStrictEqual(splitCommand(words.join(' ')), words);
  }), { numRuns: 100, seed: 7501 });
});

test('launchEnv lets CLAUDE_CUSTOM_SHELL through (the person\'s choice) and still strips every other CLAUDE_CUSTOM_* key (Dexter 3)', () => {
  const out = launchEnv({ CLAUDE_CUSTOM_SHELL: 'nu', CLAUDE_CUSTOM_TOKEN: 't', CLAUDE_CUSTOM_SHELL_HOST: '1', CLAUDE_CUSTOM_PORT: '1', PATH: 'p' }, 'C:/proj');
  assert.deepStrictEqual(Object.keys(out).sort(), ['CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_SHELL', 'PATH']);
  assert.strictEqual(out.CLAUDE_CUSTOM_SHELL, 'nu');
});

// --- Dexter r2 N1: an explicit path counts only as a FILE with a runnable extension; else it is completed like a bare name ---

test('N1: npm\'s extensionless shim given as a path picks the .cmd beside it, not the shim', () => {
  const files = [`${NPM}\\codex`, `${NPM}\\codex.cmd`];
  const r = pickShell({ CLAUDE_CUSTOM_SHELL: `${NPM}\\codex` }, { ...WIN, onPath: () => null, exists: (f) => files.includes(f) });
  assert.deepStrictEqual(r, { bin: `${NPM}\\codex.cmd`, args: [], source: 'override' });
});

test('N1: a folder never wins: C:\\tools\\nu (a folder) with nu.exe beside it picks nu.exe', () => {
  const files = ['C:\\tools\\nu.exe'];                // the folder is not a FILE, so `exists` (is-a-file) says no to it
  const r = pickShell({ CLAUDE_CUSTOM_SHELL: 'C:\\tools\\nu' }, { ...WIN, onPath: () => null, exists: (f) => files.includes(f) });
  assert.strictEqual(r.bin, 'C:\\tools\\nu.exe');
});

test('N1: a .exe path with spaces that is a file is still taken whole; so is a .cmd', () => {
  for (const file of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\x\\y.cmd']) {
    assert.deepStrictEqual(pickShell({ CLAUDE_CUSTOM_SHELL: file }, { ...WIN, onPath: () => null, exists: (f) => f === file }), { bin: file, args: [], source: 'override' });
  }
});

test('N1: an existing file with a NON-runnable extension is not taken whole (it falls through to a runnable sibling, else stays as given)', () => {
  const r = pickShell({ CLAUDE_CUSTOM_SHELL: 'C:\\t\\tool.ps1' }, { ...WIN, onPath: () => null, exists: (f) => f === 'C:\\t\\tool.ps1' });
  assert.strictEqual(r.bin, 'C:\\t\\tool.ps1');
  const both = pickShell({ CLAUDE_CUSTOM_SHELL: 'C:\\t\\tool' }, { ...WIN, onPath: () => null, exists: (f) => f === 'C:\\t\\tool' || f === 'C:\\t\\tool.cmd' });
  assert.strictEqual(both.bin, 'C:\\t\\tool.cmd', 'the extensionless file is not a program on Windows');
});

test('N1: the default "exists" is a real is-a-file check: a folder is false, a file is true, a missing path is false', () => {
  const { isFileSync } = require('../host/launch-target');
  assert.strictEqual(isFileSync(__dirname), false);
  assert.strictEqual(isFileSync(__filename), true);
  assert.strictEqual(isFileSync(__filename + '.nope'), false);
});

test('N1: off Windows a path that is a file is taken whole whatever its name', () => {
  const r = pickShell({ CLAUDE_CUSTOM_SHELL: '/opt/my shell/zsh' }, { platform: 'linux', onPath: () => null, exists: (f) => f === '/opt/my shell/zsh' });
  assert.strictEqual(r.bin, '/opt/my shell/zsh');
});
