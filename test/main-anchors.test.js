'use strict';
/**
 * Guard: a wiring test that anchors on `src.indexOf('literal')` silently reads the FIRST occurrence. Once the per-project code
 * lives in app/project-window.js and several windows are built by one startProject in app/main.js, a literal can occur in both
 * files (or twice in one), and the test would then pin the wrong one without failing. So every string needle passed to
 * `.indexOf(` in a test that reads the main-process source must occur at most once in the combined source (counted both with and
 * without comments), unless it's listed in ALLOWED with a reason. A needle that occurs zero times belongs to some other source
 * (tab-shell.js, a renderer file) and isn't this guard's business.
 *
 * Fix a violator with uniqueAt(src, needle) (fails on a second occurrence), bodyAt(src, src.indexOf('function name(')), or
 * mainOnly() / windowOnly() when the fact belongs to one file.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mainProcessSource, uniqueAt } = require('./main-source');

const TEST_DIR = __dirname;
/** "<file>::<needle>" -> why a repeated needle is safe there. */
const ALLOWED = {
  'bridge-contract.test.js::});': 'a terminator searched inside one call text it already sliced, not in the whole source',
  'main-shell-wiring.test.js::registerLayoutHandlers({': 'three registrations by design; the tests pick the 1st/2nd/3rd with a from-index (rewritten with the per-project layout in step 4)',
  'main-shell-wiring.test.js::watchLayout({': 'four records by design; the tests pick the nth with a from-index (rewritten in step 4)',
  'occupancy-wiring.test.js::occupancyService = ': 'the `let` and the assignment; the test uses it only as the from-index of the createOccupancyService search',
  'occupancy-wiring.test.js::transcriptOccupancy = ': 'the `let` and the assignment; the test uses it only as the from-index of the createTranscriptScanner search',
  'preview-main-wiring.test.js::webPreferences: {': 'reads the VIEWS source (preview-views.js), not the main-process source; the count here is incidental',
  'source-contracts.test.js::*/': 'the header comment of a single file read on its own, not the combined source',
  'source-contracts.test.js::};': 'a terminator inside an already-sliced close() body',
  'tab-shell-pins.test.js::pinItem': 'searched inside one menu function slice of tab-shell.js',
  'window-owner-wiring.test.js::EXPLICIT_PORT.bad': 'searched inside the sliced whenReady body',
  'window-owner-wiring.test.js::focusWindow()': 'searched inside one sliced function body',
};

function countOf(src, needle) {
  let n = 0;
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + needle.length)) n++;
  return n;
}

function needlesOf(text) {
  const out = [];
  // Only the one-argument form: indexOf(needle, from) searches forward from an earlier anchor and is relative to it.
  const re = /\.indexOf\(\s*(['"])((?:\\.|(?!\1)[^\\\n])+)\1\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[2].replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n'));
  return out;
}

const files = fs.readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js') && f !== 'main-anchors.test.js')
  .filter((f) => /require\(['"]\.\/main-source['"]\)/.test(fs.readFileSync(path.join(TEST_DIR, f), 'utf8')));

test('the guard sees the wiring tests', () => {
  assert.ok(files.length >= 10, `expected a dozen files that read the main-process source, found ${files.length}`);
});

test('every .indexOf anchor on the main-process source is unique there', () => {
  const plain = mainProcessSource().replace(/\r\n/g, '\n');
  const stripped = mainProcessSource({ strip: true });
  const bad = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    for (const needle of new Set(needlesOf(text))) {
      const n = Math.max(countOf(plain, needle), countOf(stripped, needle));
      if (n > 1 && !ALLOWED[`${f}::${needle}`]) bad.push(`${f}: ${JSON.stringify(needle)} occurs ${n} times`);
    }
  }
  assert.deepStrictEqual(bad, [], `ambiguous anchors (use uniqueAt / bodyAt / mainOnly / windowOnly):\n${bad.join('\n')}`);
});

test('uniqueAt returns the one occurrence and refuses a second or a missing one', () => {
  assert.strictEqual(uniqueAt('a b c', 'b'), 2);
  assert.throws(() => uniqueAt('a b b', 'b'), /twice|more than once|2 times/);
  assert.throws(() => uniqueAt('a b', 'z'), /not found|missing/);
});

test('countOf and needlesOf read what the guard says they read', () => {
  assert.strictEqual(countOf('xaxax', 'x'), 3);
  assert.deepStrictEqual(needlesOf(`s.indexOf('foo'); s.indexOf("b'ar")`), ['foo', "b'ar"]);
  assert.deepStrictEqual(needlesOf(`s.indexOf('}', at)`), [], 'a from-index search is relative to an anchor');
});
