'use strict';
/**
 * app/repo-language.js at its edges (backlog #60, Mortimer's release-#101 part 2): every extension in the
 * table, and dotfiles that are named like an extension.
 * (not covered: the CommonJS/window load guard, which needs the module's source text evaluated in a vm and
 * so can't be in the mutation command, see test/stryker-config.test.js).
 */
const test = require('node:test');
const assert = require('node:assert');

const { languageFor } = require('../app/repo-language');

const TABLE = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json', webmanifest: 'json',
  css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown', py: 'python', pyw: 'python',
  yml: 'yaml', yaml: 'yaml', xml: 'xml', svg: 'xml', xaml: 'xml', csproj: 'xml', props: 'xml',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', toml: 'toml',
};

test('every extension in the table maps to its language, in lower and upper case', () => {
  for (const [ext, id] of Object.entries(TABLE)) {
    assert.strictEqual(languageFor(`file.${ext}`), id, ext);
    assert.strictEqual(languageFor(`dir/FILE.${ext.toUpperCase()}`), id, ext.toUpperCase());
  }
});

test('a dotfile named like an extension is plain text, not that language', () => {
  for (const ext of Object.keys(TABLE)) assert.strictEqual(languageFor(`.${ext}`), null, `.${ext}`);
  assert.strictEqual(languageFor('src/.json'), null);
  assert.strictEqual(languageFor('C:\\w\\.yml'), null);
});

test('a dotfile with a real extension after it still counts; a trailing dot does not', () => {
  assert.strictEqual(languageFor('.eslintrc.json'), 'json');
  assert.strictEqual(languageFor('.a.sh'), 'shell');
  assert.strictEqual(languageFor('a.'), null);
  assert.strictEqual(languageFor('x.json.'), null);
  assert.strictEqual(languageFor('Makefile'), null);
  assert.strictEqual(languageFor('a.b.unknown'), null);
});
