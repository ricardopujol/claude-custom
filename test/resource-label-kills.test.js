'use strict';
/**
 * Kill tests for host/resource-label.js (BACKLOG #70, Mortimer's release-#117 survivor 6). Each row is an input that only
 * the CORRECT form of a regex anchor, a `startsWith`, or a boundary labels this way: the mutated form names something else.
 * The comment on each row says which mutant it is there for.
 */
const test = require('node:test');
const assert = require('node:assert');

const { displayName, tokens, MAX } = require('../host/resource-label');

const nest = (k, inner) => { let s = inner; for (let i = 0; i < k; i++) s = `cmd /c ${s}`; return s; };
const check = rows => { for (const [cmd, image, want] of rows) assert.strictEqual(displayName(cmd, image), want, JSON.stringify(cmd)); };

test('kills: the script-extension, wrapper-entry and .exe regexes are anchored at both ends', () => {
  check([
    ['node C:\\a\\b.pyx run', 'node.exe', 'b.pyx run'],          // SCRIPT_EXT without `$`: `.py` would match `.pyx`
    ['node C:\\x\\xnpm-cli.js run', 'node.exe', 'xnpm-cli.js'],  // WRAPPER_ENTRY without `^`: `xnpm-cli.js` is not npm
    ['node C:\\x\\npm.jsx run', 'node.exe', 'npm.jsx'],          // WRAPPER_ENTRY without `$`: `npm.jsx` is a script, not npm
    ['tool.combo', 'tool.combo', 'tool.combo'],                  // stripExe without `$`: `.com` inside a name is not an extension
  ]);
});

test('kills: a python version suffix and pythonw are read as python', () => {
  check([
    ['python3.12 serve.py', 'python3.12.exe', 'serve.py'],       // `[\d.]*` -> `[\d.]`: `python3.12` must still be python
    ['pythonw app.pyw', 'pythonw.exe', 'app.pyw'],
  ]);
});

test('kills: the interpreter grammar around `--`, `-m`, `--flag=value` and the flag-only tail', () => {
  check([
    ['node --', 'node.exe', 'node'],                             // `--` with nothing after it is not a script
    ['node -- x.js a', 'node.exe', 'x.js'],
    ['node --eval=1', 'node.exe', 'node --eval'],                // `--eval=code` is the eval flag
    ['python -m', 'python.exe', 'python'],                       // `-m` with no module names python
    ['node -m foo/bar run.js', 'node.exe', 'bar run.js'],        // only python reads `-m` as a module
    ['node --inspect --trace-warnings --no-deprecation', 'node.exe', 'node --inspect --trace-warnings'], // two flags at most
  ]);
});

test('kills: nested commands stop at DEPTH (4 levels labelled, the 5th is too deep)', () => {
  check([
    [nest(4, 'npm test'), 'cmd.exe', 'npm test'],
    [nest(5, 'npm test'), 'cmd.exe', 'cmd'],
  ]);
});

test('kills: a POSIX shell: `--`, long options, and short-flag clusters', () => {
  check([
    ['bash -- x.sh a', 'bash.exe', 'x.sh'],
    ['bash --', 'bash.exe', 'bash'],
    ['bash -c -- npm', 'bash.exe', 'bash'],                      // after -c, `--` ends the options: no script to name
    ['bash --norc x.sh', 'bash.exe', 'x.sh'],                    // a long option is skipped
    ['bash run-c x.sh', 'bash.exe', 'run-c x.sh'],               // the flag-cluster regex is anchored at `^`
    ['bash -l5 x.sh', 'bash.exe', 'bash'],                       // ... and at `$`
    ['bash +c "a.sh b"', 'bash.exe', 'a.sh b'],                  // `+c` is not `-c`: no command string follows
    ['bash -c "a.sh b"', 'bash.exe', 'a.sh'],
  ]);
});

test('kills: the cmd /c and /k switch is a whole word', () => {
  check([
    ['"C:\\w\\cmd.exe"/c npm test', 'cmd.exe', 'npm test'],      // /c right after a quoted argv0 (the `^` alternative)
    ['cmd /d x/c npm test', 'cmd.exe', 'cmd'],                   // `x/c` is not the switch
    ['cmd /cx npm test', 'cmd.exe', 'cmd'],                      // nor is `/cx`
    ['cmd /k npm test', 'cmd.exe', 'npm test'],
  ]);
});

test('kills: the PowerShell -File, -Command, -EncodedCommand and value options are whole words', () => {
  check([
    ['pwsh -wx a.ps1', 'pwsh.exe', 'a.ps1'],                     // PS_VALUE without `$`: `-wx` takes no value
    ['pwsh a-ep b.ps1', 'pwsh.exe', 'a-ep'],                     // PS_VALUE without `^`
    ['pwsh -fo npm run', 'pwsh.exe', 'npm run'],                 // `-fo` is not -File
    ['pwsh x-f npm run', 'pwsh.exe', 'x-f'],
    ['pwsh -File', 'pwsh.exe', 'pwsh'],
    ['pwsh -cx C:\\t\\x.cmd', 'pwsh.exe', 'x.cmd'],              // `-cx` is not -Command
    ['pwsh a-c C:\\t\\x.cmd', 'pwsh.exe', 'a-c'],
    ['pwsh -Command', 'pwsh.exe', 'pwsh'],
    ['cmd /c pwsh -Command', 'cmd.exe', 'pwsh'],                 // nested, an empty -Command tail names pwsh, not the outer cmd
    ['pwsh -ec AAAA', 'pwsh.exe', 'pwsh'],
    ['pwsh -ex C:\\t\\x.cmd', 'pwsh.exe', 'x.cmd'],              // `-ex` is not -EncodedCommand
    ['pwsh C:\\t\\x.cmd', 'pwsh.exe', 'x.cmd'],                  // a script keeps its extension
  ]);
});

test('kills: the fallback strips only LEADING dashes and slashes from the image', () => {
  check([
    ['', '--tool.exe', 'tool'],
    ['', 'a-b.exe', 'a-b'],
  ]);
});

test('kills: a label of exactly MAX characters is not clipped, MAX + 1 is', () => {
  const at = displayName(`node ${'a'.repeat(MAX - 3)}.js`, 'node.exe');
  assert.strictEqual(at, `${'a'.repeat(MAX - 3)}.js`);
  const over = displayName(`node ${'a'.repeat(MAX - 2)}.js`, 'node.exe');
  assert.strictEqual(over, `${'a'.repeat(MAX - 2)}.…`);
  assert.strictEqual(over.length, MAX);
});

test('kills: tokens keeps exactly 64 tokens, the last one included, and never a 65th', () => {
  const words = n => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  assert.deepStrictEqual(tokens(words(64)).at(-1), 'w63');
  assert.strictEqual(tokens(words(64)).length, 64);
  assert.strictEqual(tokens(words(65)).length, 64);
  assert.strictEqual(tokens(`${words(65)} `).length, 64);
});
