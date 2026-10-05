'use strict';
/** host/resource-label.js: the name a Resources child row shows (what it runs, not its image). */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { displayName, MAX } = require('../host/resource-label');

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
  assert.strictEqual(displayName('"C:\\Program Files\\nodejs\\node.exe" --test --test-concurrency=2 extra', 'node.exe'), 'node --test --test-concurrency=2');
  assert.strictEqual(displayName('node.exe', 'node.exe'), 'node');
});

test('a tool with no extension shows its name and subcommand: `stryker run`', () => {
  assert.strictEqual(displayName('node C:\\r\\node_modules\\.bin\\stryker run --concurrency 2', 'node.exe'), 'stryker run');
  assert.strictEqual(displayName('npx stryker run --concurrency 2', 'node.exe'), 'stryker run');
  assert.strictEqual(displayName('node C:\\n\\node_modules\\npm\\bin\\npx-cli.js stryker run', 'node.exe'), 'stryker run');
});

test('npm shows the subcommand', () => {
  assert.strictEqual(displayName('node C:\\n\\node_modules\\npm\\bin\\npm-cli.js run build -- --watch', 'node.exe'), 'npm run build');
  assert.strictEqual(displayName('npm test', 'npm.cmd'), 'npm test');
  assert.strictEqual(displayName('npm', 'npm.cmd'), 'npm');
});

test('a shell\'s command payload is judged the same way', () => {
  assert.strictEqual(displayName('cmd.exe /d /s /c "node C:\\x\\burn.js 8"', 'cmd.exe'), 'burn.js');
  assert.strictEqual(displayName('cmd /c npm run build', 'cmd.exe'), 'npm run build');
  assert.strictEqual(displayName('bash -c "npx stryker run"', 'bash.exe'), 'stryker run');
  assert.strictEqual(displayName('powershell.exe -NoProfile -Command "node C:\\x\\sync.js"', 'powershell.exe'), 'sync.js');
  assert.strictEqual(displayName('pwsh -File C:\\x\\go.ps1', 'pwsh.exe'), 'go.ps1');
  assert.strictEqual(displayName('bash', 'bash.exe'), 'bash');
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
  assert.strictEqual(displayName('"unterminated C:\\a b\\c.js', 'node.exe'), 'c.js', 'an open quote runs to the end of the line');
  assert.strictEqual(displayName('""', 'node.exe'), 'node');
  assert.strictEqual(displayName(42, 'node.exe'), 'node');
});

test('a long label is clipped to MAX with an ellipsis', () => {
  const s = displayName(`node ${'a'.repeat(200)}.js`, 'node.exe');
  assert.strictEqual(s.length, MAX);
  assert.ok(s.endsWith('…'));
});

test('property: for any command line and image it never throws and returns a short non-empty string', () => {
  fc.assert(fc.property(fc.oneof(fc.string(), fc.constant(null), fc.integer(), fc.array(fc.string())), fc.oneof(fc.string(), fc.constant(undefined)), (cmd, name) => {
    const s = displayName(cmd, name);
    assert.strictEqual(typeof s, 'string');
    assert.ok(s.length > 0 && s.length <= MAX, JSON.stringify(s));
  }), { numRuns: 500 });
});

test('property: a program that is not an interpreter, shell or wrapper shows exactly its image without .exe', () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/), fc.string(), (base, args) => {
    fc.pre(!/^(?:node|nodejs|python|python3|pythonw|py|ruby|deno|bun|bash|sh|zsh|cmd|powershell|pwsh|npx|npm|yarn|pnpm)$/.test(base));
    assert.strictEqual(displayName(`"C:\\Tools x\\${base}.exe" ${args}`, `${base}.exe`), base);
  }));
});

test('property: a script path with spaces, in quotes, shows just its file name', () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/), fc.stringMatching(/^[a-z][a-z0-9 ]{0,10}$/), (file, dir) => {
    assert.strictEqual(displayName(`node "C:\\${dir}\\${file}.js" 1 2`, 'node.exe'), `${file}.js`);
  }));
});
