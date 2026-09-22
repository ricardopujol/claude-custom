// @ts-nocheck
'use strict';
/**
 * Every source file parses, and none contains a merge conflict marker.
 *
 * WHY THIS EXISTS. `app/renderer.js` sat in the repo with `<<<<<<< HEAD` in the
 * middle of the control-message dispatcher, COMMITTED, through five commits and
 * four green test runs. A `git add -A` staged it while it was still in `UU`
 * state, and nothing noticed -- because no test requires the renderer, and the
 * suite cannot fail over a file it never loads.
 *
 * The app was unstartable that whole time and the suite said 478 pass.
 *
 * That is the coverage-is-a-liar pattern at the crudest possible level: not a
 * weak assertion, not an untested branch, but an entire file that is never
 * loaded by anything the gate runs. Tests can only speak about code they
 * execute, and a browser-side script is exactly the code a Node test suite
 * never executes.
 *
 * So this walks the tree instead of trusting the import graph. It is deliberately
 * dumb: no mocking, no DOM, no behaviour -- it only asserts that each file is
 * something JavaScript can read, which is the property that was silently false.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const DIRS = ['app', 'host', 'verify', 'test'];
const SKIP = new Set(['node_modules', '.git', '.harness', 'backgrounds', 'portraits']);

function jsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const ALL = DIRS.flatMap(d => jsFiles(path.join(REPO, d)));

test('there are files to check, or this test is vacuous', () => {
  // A walk that finds nothing passes every assertion below. That failure mode
  // is precisely what let the broken renderer through, so it is asserted here
  // rather than assumed.
  assert.ok(ALL.length > 30, `only found ${ALL.length} source files`);
  assert.ok(ALL.some(f => f.endsWith(`app${path.sep}renderer.js`)), 'renderer.js must be in scope');
});

test('no source file contains a merge conflict marker', () => {
  // Checked on the FILE, not on the parse: a conflict inside a comment or a
  // string parses fine and is still a mistake nobody meant to commit.
  const markers = /^(<{7}|={7}|>{7})(\s|$)/m;
  const bad = [];
  for (const f of ALL) {
    const text = fs.readFileSync(f, 'utf8');
    if (markers.test(text)) bad.push(path.relative(REPO, f));
  }
  assert.deepStrictEqual(bad, [], `conflict markers committed in: ${bad.join(', ')}`);
});

test('every source file parses as JavaScript', () => {
  // `node --check` rather than require(): these files have side effects -- they
  // boot a pty, open sockets, touch the DOM -- so loading them is not an option
  // and is not the point. Syntactic validity is the property that was false.
  const broken = [];
  for (const f of ALL) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (err) {
      const detail = String((err && err.stderr) || err).split('\n').slice(0, 3).join(' ');
      broken.push(`${path.relative(REPO, f)}: ${detail}`);
    }
  }
  assert.deepStrictEqual(broken, [], `unparseable:\n${broken.join('\n')}`);
});
