'use strict';
/** The reader picks a highlighting language from the file name alone (#32). null = plain text. */
const test = require('node:test');
const assert = require('node:assert');
const { languageFor } = require('../app/repo-language');

test('common extensions map to a language id', () => {
  const cases = {
    'a.js': 'javascript', 'a.mjs': 'javascript', 'a.cjs': 'javascript', 'a.jsx': 'jsx',
    'a.ts': 'typescript', 'a.mts': 'typescript', 'a.tsx': 'tsx',
    'a.json': 'json', 'a.jsonc': 'json', 'a.css': 'css', 'a.scss': 'css', 'a.html': 'html', 'a.htm': 'html',
    'a.md': 'markdown', 'a.markdown': 'markdown', 'a.py': 'python', 'a.yml': 'yaml', 'a.yaml': 'yaml',
    'a.xml': 'xml', 'a.svg': 'xml', 'a.sh': 'shell', 'a.bash': 'shell', 'a.ps1': 'powershell', 'a.psm1': 'powershell', 'a.toml': 'toml',
  };
  for (const [name, id] of Object.entries(cases)) assert.strictEqual(languageFor(name), id, name);
});

test('only the last extension counts, in any case, and the folders in the path do not', () => {
  assert.strictEqual(languageFor('src/deep/App.TSX'), 'tsx');
  assert.strictEqual(languageFor('a.test.js'), 'javascript');
  assert.strictEqual(languageFor('C:\\x.js\\readme.md'), 'markdown');
  assert.strictEqual(languageFor('dir.js/README'), null);
});

test('no extension, a dotfile, an unknown extension and a trailing dot are plain text', () => {
  for (const n of ['Makefile', 'LICENSE', '.gitignore', '.env', 'a.unknownext', 'a.', 'a.jsonl', '']) assert.strictEqual(languageFor(n), null, n);
});

test('a non-string is plain text, not a crash', () => {
  for (const n of [null, undefined, 5, {}]) assert.strictEqual(languageFor(n), null);
});

test('a name that is an Object.prototype member is not a language', () => {
  for (const n of ['a.constructor', 'a.__proto__', 'a.toString', 'a.hasOwnProperty']) assert.strictEqual(languageFor(n), null, n);
});
