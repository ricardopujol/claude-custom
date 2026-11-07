'use strict';
/**
 * BACKLOG #184: app/roster-morph.js's source text, kept OUT of test/roster-morph.test.js because that file is in Stryker's command
 * and roster-morph.js is mutated: a test in the command reading a mutated module as text can abort the dry run
 * (test/stryker-config.test.js). Repo-scanning, so deliberately NOT in Stryker's command; it requires nothing from the module.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const header = () => read('app/roster-morph.js').split('*/')[0];

test('renderer.html loads roster-morph.js before renderer.js, and the module is wrapped against the shared global scope', () => {
  const html = read('app/renderer.html');
  const at = html.indexOf('<script src="./roster-morph.js"></script>');
  assert.ok(at > 0 && at < html.indexOf('<script src="./renderer.js"></script>'));
  const src = read('app/roster-morph.js');
  assert.match(src, /^\(function \(root\) \{$/m);
  assert.match(src, /root\.rosterMorph = api;/);
});

test('PR #244 Miguel Y2: the header says a child the fresh markup lacks is removed, the speech bubble being the known case', () => {
  assert.match(header(), /speech bubble/);
  assert.match(header(), /is removed, whoever put it there/);
});

test('PR #244 Dexter 3: the header names the body-press residual (the rule applies to every element, not only controls)', () => {
  assert.match(header(), /known residual/);
});

test('PR #244 Dexter 1: the header says a control whose action depends on state carries that state itself', () => {
  assert.match(header(), /data-portrait-state/);
});
