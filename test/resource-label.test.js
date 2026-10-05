'use strict';
/** host/resource-label.js: the name a Resources child row shows (what it runs, not its image). */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { displayName, tokens, MAX } = require('../host/resource-label');

const N = 'C:\\Program Files\\nodejs\\node.exe';

test('an interpreter running a script shows the script\'s file name', () => {
  assert.strictEqual(displayName(`"${N}" "C:\\Users\\r\\AppData\\Local\\Temp\\cc probe\\burn.js" 8 out.pid 100`, 'node.exe'), 'burn.js');
  assert.strictEqual(displayName('node C:\\x\\bystander.js C:\\x\\by.pid', 'node.exe'), 'bystander.js');
  assert.strictEqual(displayName('node --max-old-space-size=4096 ./build/run.mjs', 'node.exe'), 'run.mjs');
  assert.strictEqual(displayName('python3 /srv/app/serve.py --port 80', 'python3'), 'serve.py');
  assert.strictEqual(displayName('bash ./scripts/deploy.sh prod', 'bash.exe'), 'deploy.sh');
});

test('an interpreter with no script shows the image and its first words', () => {
  assert.strictEqual(displayName('node --test', 'node.exe'), 'node --test');
  assert.strictEqual(displayName('"C:\\Program Files\\nodejs\\node.exe" --test --test-concurrency=2 extra', 'node.exe'), 'node --test');
  assert.strictEqual(displayName('node.exe', 'node.exe'), 'node');
});

test('a tool with no extension shows its name and subcommand: `stryker run`', () => {
  assert.strictEqual(displayName('node C:\\r\\node_modules\\.bin\\stryker run --concurrency 2', 'node.exe'), 'stryker run');
  assert.strictEqual(displayName('npx stryker run --concurrency 2', 'node.exe'), 'stryker run');
  assert.strictEqual(displayName('node C:\\n\\node_modules\\npm\\bin\\npx-cli.js stryker run', 'node.exe'), 'stryker run');
});

test('D6: npm, pnpm and yarn show the subcommand, also through their node entry scripts', () => {
  assert.strictEqual(displayName('node C:\\n\\node_modules\\npm\\bin\\npm-cli.js run build -- --watch', 'node.exe'), 'npm run build');
  assert.strictEqual(displayName('npm test', 'npm.cmd'), 'npm test');
  assert.strictEqual(displayName('npm', 'npm.cmd'), 'npm');
  assert.strictEqual(displayName('node "C:\\Users\\r\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs" run build', 'node.exe'), 'pnpm run build');
  assert.strictEqual(displayName('node C:\\x\\yarn\\bin\\yarn.js build', 'node.exe'), 'yarn build');
});

test('D3/I1: a flag\'s VALUE is never the script', () => {
  assert.strictEqual(displayName('node --require ./setup.js burn.js', 'node.exe'), 'burn.js');
  assert.strictEqual(displayName('node -r ./preload.js app.js', 'node.exe'), 'app.js');
  assert.strictEqual(displayName('node -r ts-node/register src/main.ts', 'node.exe'), 'main.ts');
  assert.strictEqual(displayName('node --import ./reg.mjs server.js', 'node.exe'), 'server.js');
  assert.strictEqual(displayName('node --loader ts-node/esm x.ts', 'node.exe'), 'x.ts');
  assert.strictEqual(displayName('node --inspect=9229 burn.js', 'node.exe'), 'burn.js');
  assert.strictEqual(displayName('powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\x\\build.ps1', 'powershell.exe'), 'build.ps1');
  assert.strictEqual(displayName('python -W ignore -X dev tool.py', 'python.exe'), 'tool.py');
});

test('D3/I1: node -e and -p run code: the label is `node -e`, never a fragment of the code', () => {
  assert.strictEqual(displayName('node -e "console.log(1/2)"', 'node.exe'), 'node -e');
  assert.strictEqual(displayName('node -e "require(\'fs\').readFileSync(\'a/b\')"', 'node.exe'), 'node -e');
  assert.strictEqual(displayName('node -p "process.argv[1]/2"', 'node.exe'), 'node -p');
  assert.strictEqual(displayName('node --eval "x/y"', 'node.exe'), 'node --eval');
  assert.strictEqual(displayName('python -c "import os; os.sep"', 'python.exe'), 'python -c');
  assert.strictEqual(displayName('python -m pytest -x', 'python.exe'), 'pytest');
});

test('D1: bash -c with options in between, and combined short flags, label the command that runs', () => {
  assert.strictEqual(displayName('bash -c -l "npm test"', 'bash.exe'), 'npm test');
  assert.strictEqual(displayName('bash -lc "npx stryker run"', 'bash.exe'), 'stryker run');
  assert.strictEqual(displayName('bash -c -i -l "node /c/x/burn.js 8"', 'bash.exe'), 'burn.js');
  assert.strictEqual(displayName('bash -o pipefail -c "npm run build"', 'bash.exe'), 'npm run build');
  assert.strictEqual(displayName('"C:\\Program Files\\Git\\bin\\bash.exe" -c -l "source C:/Users/r/.claude/shell-snapshots/snapshot-bash-1.sh && eval \'npm test\' < /dev/null && pwd -P >| /tmp/claude-ab-cwd"', 'bash.exe'), 'npm test');
  assert.strictEqual(displayName('bash -c -l "source /x/snap.sh && eval \\"node C:/w/burn.js 8\\" < /dev/null && pwd -P >| /tmp/c"', 'bash.exe'), 'burn.js');
  assert.strictEqual(displayName('bash -c "cd /w && npm test"', 'bash.exe'), 'npm test');
  assert.strictEqual(displayName('sh -c "FOO=1 node ./a/serve.js"', 'sh.exe'), 'serve.js');
});

test('D5: only cmd skips /switches; a POSIX path is a script for bash and sh', () => {
  assert.strictEqual(displayName('bash /c/Users/ricar/build.sh', 'bash.exe'), 'build.sh');
  assert.strictEqual(displayName('sh /usr/local/bin/x.sh arg', 'sh.exe'), 'x.sh');
  assert.strictEqual(displayName('cmd /d /s', 'cmd.exe'), 'cmd');
});

test('D2: cmd\'s outer-quote form, with and without a space in the path', () => {
  assert.strictEqual(displayName('C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Program Files\\nodejs\\npm.cmd" run build"', 'cmd.exe'), 'npm run build');
  assert.strictEqual(displayName('C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\nodejs\\npm.cmd" run build"', 'cmd.exe'), 'npm run build');
  assert.strictEqual(displayName('cmd.exe /d /s /c "node C:\\x\\burn.js 8"', 'cmd.exe'), 'burn.js');
  assert.strictEqual(displayName('cmd /c npm run build', 'cmd.exe'), 'npm run build');
  assert.strictEqual(displayName('cmd /c "C:\\Program Files\\nodejs\\npm.cmd" test', 'cmd.exe'), 'npm test');
});

test('a PowerShell command or file shows what it runs', () => {
  assert.strictEqual(displayName('powershell.exe -NoProfile -Command "node C:\\x\\sync.js"', 'powershell.exe'), 'sync.js');
  assert.strictEqual(displayName('pwsh -File C:\\x\\go.ps1', 'pwsh.exe'), 'go.ps1');
  assert.strictEqual(displayName('pwsh -NoLogo -c node C:\\x\\a.js 1', 'pwsh.exe'), 'a.js');
  assert.strictEqual(displayName('powershell -EncodedCommand AAAA', 'powershell.exe'), 'powershell');
  assert.strictEqual(displayName('bash', 'bash.exe'), 'bash');
});

test('D7: an unquoted program path with spaces, or one that disagrees with the image, still finds the script', () => {
  assert.strictEqual(displayName('C:\\Program Files\\nodejs\\node.exe C:\\x\\burn.js', 'node.exe'), 'burn.js');
  assert.strictEqual(displayName('"C:\\Program Files\\nodejs\\node.exe" C:\\x\\burn.js', 'node.exe'), 'burn.js');
  assert.strictEqual(displayName('Z:\\weird\\spoof.exe C:\\x\\burn.js', 'node.exe'), 'burn.js', 'the program is the image, the arguments are what followed argv0');
});

test('any other program shows its image name without .exe', () => {
  assert.strictEqual(displayName('git status --short', 'git.exe'), 'git');
  assert.strictEqual(displayName('"C:\\Program Files\\Docker\\docker.exe" run -it x', 'docker.exe'), 'docker');
  assert.strictEqual(displayName('esbuild.exe --watch', 'esbuild.exe'), 'esbuild');
});

test('odd command lines fall back to the image name and never throw', () => {
  assert.strictEqual(displayName('', 'node.exe'), 'node');
  assert.strictEqual(displayName('   ', 'git.exe'), 'git');
  assert.strictEqual(displayName(null, 'node.exe'), 'node');
  assert.strictEqual(displayName(undefined, undefined), '?');
  assert.strictEqual(displayName('"unterminated C:\\a b\\c.js', 'node.exe'), 'node', 'an open quote runs to the end of the line');
  assert.strictEqual(displayName('""', 'node.exe'), 'node');
  assert.strictEqual(displayName(42, 'node.exe'), 'node');
  assert.strictEqual(displayName('', ' '), '?', 'a blank image is not a label either');
  assert.strictEqual(displayName(' ', ' '), '?');
});

test('D10: the result never starts with a dash or slash, never holds a quote, and a flag-only tail falls back to the program', () => {
  assert.strictEqual(displayName('bash -c -l', 'bash.exe'), 'bash');
  assert.strictEqual(displayName('bash -c -l "-x"', 'bash.exe'), 'bash');
  assert.ok(!/["']/.test(displayName('node "C:\\a b\\it\'s.js"', 'node.exe')));
});

// The command line Claude Code's Bash tool REALLY gives bash.exe, captured from this machine's process table (2026-10-05):
// the tool's command is one single-quoted `eval` argument inside a `-c "..."` payload, with a snapshot, exports and
// `pwd -P` around it. (`-c -l` forms exist too; those are covered above.)
const BASH_TOOL = String.raw`"C:\Program Files\Git\bin\bash.exe" -c "source /c/Users/ricar/.claude/shell-snapshots/snapshot-bash-1791203932202-9fw7k5.sh 2>/dev/null || true && export TEMP='C:\Users\ricar\AppData\Local\Temp' TMP='C:\Users\ricar\AppData\Local\Temp' && shopt -u extglob 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'CMD' < /dev/null && pwd -P >| /c/Users/ricar/AppData/Local/Temp/claude-cfc0-cwd"`;
const bashTool = c => BASH_TOOL.replace('CMD', () => c);

test('a REAL Claude Code Bash-tool command line labels as the command it runs', () => {
  assert.strictEqual(displayName(bashTool('node C:/w/burn.js 8'), 'bash.exe'), 'burn.js');
  assert.strictEqual(displayName(bashTool('npm run build 2>&1 | tail -5'), 'bash.exe'), 'npm run build');
  assert.strictEqual(displayName(bashTool('npx stryker run --concurrency 2'), 'bash.exe'), 'stryker run');
  assert.strictEqual(displayName(bashTool(String.raw`powershell.exe -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='\"'\"'bash.exe'\"'\"'\\\" | Select-Object ProcessId\" 2>&1 | cut -c1-600`), 'bash.exe'), 'Get-CimInstance');
  assert.strictEqual(displayName(bashTool('git status --short'), 'bash.exe'), 'git');
  assert.strictEqual(displayName(String.raw`"C:\Program Files\Git\bin\..\usr\bin\bash.exe" -c "source /x.sh && eval 'node /c/w/a.js' < /dev/null && pwd -P >| /tmp/c"`, 'bash.exe'), 'a.js');
});

test('tokens: Windows quoting, escaped quotes, an open quote, a cap', () => {
  assert.deepStrictEqual(tokens('a "b c" d'), ['a', 'b c', 'd']);
  assert.deepStrictEqual(tokens('x "say \\"hi\\"" y'), ['x', 'say "hi"', 'y']);
  assert.deepStrictEqual(tokens('C:\\a\\b "C:\\a b\\"'), ['C:\\a\\b', 'C:\\a b"']);
  assert.deepStrictEqual(tokens('"open quote'), ['open quote']);
  assert.deepStrictEqual(tokens("sh 'a b' c", { posix: true }), ['sh', 'a b', 'c']);
  assert.ok(tokens('a '.repeat(500)).length <= 64);
});

test('a long label is clipped to MAX with an ellipsis', () => {
  const s = displayName(`node ${'a'.repeat(200)}.js`, 'node.exe');
  assert.strictEqual(s.length, MAX);
  assert.ok(s.endsWith('…'));
});

// ---- properties ----
const baseArb = fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/);
const dirArb = fc.stringMatching(/^[a-z][a-z0-9 ]{0,8}$/);
const EXTS = ['.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.ps1'];
const pathArb = fc.tuple(baseArb, fc.constantFrom(...EXTS), dirArb, fc.constantFrom('win', 'fwd', 'posix', 'unc', 'bare')).map(([b, e, d, kind]) => {
  const file = `${b}${e}`;
  const path = { win: `C:\\${d}\\${file}`, fwd: `C:/${d}/${file}`, posix: `/c/${d.replace(/ /g, '')}/${file}`, unc: `\\\\srv\\${d.replace(/ /g, '')}\\${file}`, bare: file }[kind];
  return { file, path, spaced: / /.test(path) };
});
const q = p => (/ /.test(p) ? `"${p}"` : p);
// every flag-with-value form the node grammar knows, in front of the script
const NODE_FLAGS = ['', '--require ./a.js ', '-r ts-node/register ', '--import ./b.mjs ', '--loader x/y ', '--inspect=9229 ', '--max-old-space-size=4096 ', '-r ./a.js --require ./b.js '];
// every way a command can be wrapped
const WRAPS = [
  c => c,
  c => `cmd /d /s /c "${c}"`,
  c => `cmd.exe /c ${c}`,
  c => `bash -c ${JSON.stringify(c.replace(/\\/g, '/'))}`,
  c => `bash -c -l ${JSON.stringify(c.replace(/\\/g, '/'))}`,
  c => `bash -lc ${JSON.stringify(c.replace(/\\/g, '/'))}`,
  c => `powershell -NoProfile -Command ${JSON.stringify(c)}`,
];

test('property: node, any value-taking flags, a script path of any shape, in any wrapper, labels as the script\'s file name', () => {
  fc.assert(fc.property(pathArb, fc.constantFrom(...NODE_FLAGS), fc.integer({ min: 0, max: WRAPS.length - 1 }), (p, flags, w) => {
    // a quoted path inside a bash/powershell payload needs its own quotes escaped; the bare/POSIX paths never need them
    fc.pre(!(w >= 3 && /["]/.test(q(p.path))));
    const cmd = WRAPS[w](`node ${flags}${q(p.path)} 1 2`);
    const prog = w === 0 ? 'node.exe' : ['', 'cmd.exe', 'cmd.exe', 'bash.exe', 'bash.exe', 'bash.exe', 'powershell.exe'][w];
    assert.strictEqual(displayName(cmd, prog), p.file, cmd);
  }), { numRuns: 400 });
});

test('property: -e/-p never leak a fragment of the code, and the result has no quote, no leading - or /, and is never blank', () => {
  const junk = fc.string({ maxLength: 40 });
  fc.assert(fc.property(fc.oneof(junk, fc.constantFrom('console.log(1/2)', 'a/b', '"quoted/x"', '--x', '/c', '-l')), fc.constantFrom('node -e', 'node -p', 'node --eval', 'python -c'), (code, head) => {
    const out = displayName(`${head} ${JSON.stringify(code)}`, `${head.split(' ')[0]}.exe`);
    assert.strictEqual(out, head, 'the label is the program and its code flag only');
  }), { numRuns: 300 });
});

test('property: for any command line and image the label is short, non-blank, quote-free, and never starts with - or /', () => {
  const noise = fc.oneof(fc.string(), fc.array(fc.constantFrom('node', 'bash', '-c', '-l', '-lc', '/c', '/d', '"', "'", '\\', '/x/y.js', 'a b', 'cmd', 'npm', 'run', '-e', '--', '-r', 'X'), { maxLength: 12 }).map(a => a.join(' ')));
  fc.assert(fc.property(fc.oneof(noise, fc.constant(null), fc.integer(), fc.array(fc.string())), fc.oneof(fc.string(), fc.constantFrom('node.exe', 'bash.exe', 'cmd.exe', 'powershell.exe', 'npm.cmd', ' ', ''), fc.constant(undefined)), (cmd, image) => {
    const s = displayName(cmd, image);
    assert.strictEqual(typeof s, 'string');
    assert.ok(s.trim() !== '' && s.length <= MAX, JSON.stringify([cmd, image, s]));
    assert.ok(!/["']/.test(s), `quote in ${JSON.stringify(s)}`);
    assert.ok(!/^[-/]/.test(s), `leading dash or slash in ${JSON.stringify(s)}`);
    assert.strictEqual(s, s.trim());
  }), { numRuns: 1500 });
});

test('property: a program that is not an interpreter, shell or wrapper shows exactly its image without .exe', () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/), fc.string(), (base, args) => {
    fc.pre(!/^(?:node|nodejs|bun|deno|ruby|python\d*|py|pythonw|bash|sh|zsh|dash|ash|cmd|powershell|pwsh|npx|npm|yarn|pnpm|pnpx)$/.test(base));
    assert.strictEqual(displayName(`"C:\\Tools x\\${base}.exe" ${args}`, `${base}.exe`), base);
  }));
});

test('a compound Bash-tool command (cd && env ... && node script) labels as the program that does the work', () => {
  assert.strictEqual(displayName(bashTool('cd /c/proj && env -u ELECTRON_RUN_AS_NODE -u X=1 FOO=bar node verify/probe-x.js 2>&1 | tail -3'), 'bash.exe'), 'probe-x.js');
  assert.strictEqual(displayName(bashTool('cd /c/proj && npm test'), 'bash.exe'), 'npm test');
  assert.strictEqual(displayName(bashTool('cd /c/proj'), 'bash.exe'), 'cd');
});
