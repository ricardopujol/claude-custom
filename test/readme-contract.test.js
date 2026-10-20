'use strict';
/**
 * The README can't drift silently from the code it describes. Source-contract tests, in the style of
 * test/renderer-canvas-wiring.test.js: each pins one claim the README makes to the file that makes it true.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { TABS } = require('../app/side-tabs');

test('the panels are described in bold where they are introduced, so a reader can scan for them', () => {
  for (const t of TABS) assert.ok(README.includes(`**${t.label}**`), `"${t.label}" has no bold mention in README.md`);
});

test('every npm script the README tells a reader to run exists', () => {
  // only commands in code (a span or a block line): "the npm global folder" in prose is not a script
  const named = [...README.matchAll(/(?:`|^)npm (?:run )?([a-z:]+)/gm)].map(m => m[1]);
  const builtins = new Set(['ci', 'install', 'test', 'start', 'link']);
  for (const n of named) {
    assert.ok(builtins.has(n) || PKG.scripts[n], `README.md runs "npm ${n}", which package.json doesn't define`);
  }
  for (const must of ['build:helper', 'dist']) assert.ok(named.includes(must), `README.md should mention npm run ${must}`);
});

test('every image and link to a file in the repo points at a file that exists', () => {
  const targets = [...README.matchAll(/\]\((?!https?:)([^)#\s]+)\)/g)].map(m => m[1]);
  assert.ok(targets.length >= 3);
  for (const t of targets) assert.ok(fs.existsSync(path.join(ROOT, t)), `README.md links ${t}, which isn't in the repo`);
});

test('the screenshots are under 400 KB each, and not ignored by git', () => {
  const dir = path.join(ROOT, 'docs', 'screenshots');
  const pngs = fs.readdirSync(dir).filter(f => f.endsWith('.png'));
  assert.ok(pngs.length >= 2);
  for (const f of pngs) assert.ok(fs.statSync(path.join(dir, f)).size < 400 * 1024, `${f} is 400 KB or more`);
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.ok(!/^\/?docs\/?\*?\s*$/m.test(ignore), 'docs/ must not be gitignored');
});

test('the checks the README lists are the ones host/first-run.js runs, in that order', () => {
  const { runChecks } = require('../host/first-run');
  return runChecks({}).then((rs) => {
    assert.deepStrictEqual(rs.map(r => r.id), ['claude', 'helper', 'signin', 'ollama']);
    assert.match(README, /1\. `claude` runs[\s\S]*2\. The hook helper[\s\S]*3\. Claude Code is signed in[\s\S]*4\. Ollama/);
    assert.match(README, new RegExp(`version ${require('../host/first-run').MIN_CLAUDE_VERSION.replace(/\./g, '\\.')} or newer`));
  });
});

test('the platform the README promises is the one the package builds for', () => {
  assert.match(README, /Windows 10 and 11 only/);
  assert.match(fs.readFileSync(path.join(ROOT, 'build', 'electron-builder.yml'), 'utf8'), /^win:/m);
});
