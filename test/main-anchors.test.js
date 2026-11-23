'use strict';
/**
 * Guard: a wiring test that anchors on `src.indexOf('literal')` silently reads the FIRST occurrence. Once the per-project code
 * lives in app/project-window.js and several windows are built by one startProject in app/main.js, a literal can occur in both
 * files (or twice in one), and the test would then pin the wrong one without failing. So every string needle passed to
 * `.indexOf(` in a test that reads the main-process source must occur at most once in the combined source (counted both with and
 * without comments), unless it's listed in ALLOWED with a reason. A needle that occurs zero times belongs to some other source
 * (tab-shell.js, a renderer file) and isn't this guard's business.
 *
 * Fix a violator with uniqueAt(src, needle) (fails on a second occurrence), uniqueMatch(src, /regex/) for a pattern, bodyAt(src,
 * src.indexOf('function name(')), or mainOnly() / windowOnly() when the fact belongs to one file.
 *
 * WHAT THIS GUARD SEES: the one-argument `.indexOf('literal')` / `.indexOf("literal")` form (the escapes \' \" \\ \n \t \r decoded), and the
 * one-argument `.search(/regex/flags)` form with a regex LITERAL. Occurrences are counted overlapping (stepping by one).
 * WHAT IT CANNOT SEE (a reviewer must): a needle held in a variable (`MAIN.indexOf(startMarker)`), a template literal, `lastIndexOf`,
 * `split(x)[1]`, a `new RegExp(...)`, or a from-index search. Those stay first-match reads: pass them through uniqueAt / uniqueMatch.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mainProcessSource, uniqueAt, uniqueMatch } = require('./main-source');

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
  'project-window-wiring.test.js::/setTimeout\\(\\(\\) => \\{/': 'searched inside the sliced vault-probe block of registerIpc (PR #256 B2), not in the whole source',
  'tab-shell-pins.test.js::pinItem': 'searched inside one menu function slice of tab-shell.js',
  'window-owner-wiring.test.js::EXPLICIT_PORT.bad': 'searched inside the sliced whenReady body',
  'window-owner-wiring.test.js::focusWindow()': 'searched inside one sliced function body',
};

function countOf(src, needle) {
  let n = 0;
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) n++;     // by one: overlapping occurrences count
  return n;
}

/** How many times `regex` matches `src` (overlapping starts count). */
function countMatches(src, regex) {
  const re = new RegExp(regex.source, regex.flags.replace(/[gy]/g, '') + 'g');
  let n = 0;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) { n++; re.lastIndex = m.index + 1; }
  return n;
}

/** The regex LITERALS passed to `.search(` with one argument, as RegExp objects (one that does not compile is skipped). */
function searchRegexesOf(text) {
  const out = [];
  const re = /\.search\(\s*\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^\/\\\n\[])+)\/([a-z]*)\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try { out.push(new RegExp(m[1], m[2])); } catch { /* not a regex this guard can run */ }
  }
  return out;
}

function needlesOf(text) {
  const out = [];
  // Only the one-argument form: indexOf(needle, from) searches forward from an earlier anchor and is relative to it.
  const re = /\.indexOf\(\s*(['"])((?:\\.|(?!\1)[^\\\n])+)\1\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[2].replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r'));
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

test('every .search(/regex/) anchor on the main-process source matches there once', () => {
  const plain = mainProcessSource().replace(/\r\n/g, '\n');
  const stripped = mainProcessSource({ strip: true });
  const bad = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    for (const re of new Set(searchRegexesOf(text).map(String))) {
      const rx = new RegExp(re.slice(1, re.lastIndexOf('/')), re.slice(re.lastIndexOf('/') + 1));
      const n = Math.max(countMatches(plain, rx), countMatches(stripped, rx));
      if (n > 1 && !ALLOWED[`${f}::${re}`]) bad.push(`${f}: ${re} matches ${n} times`);
    }
  }
  assert.deepStrictEqual(bad, [], `ambiguous patterns (use uniqueMatch / bodyAt / mainOnly / windowOnly):\n${bad.join('\n')}`);
});

test('overlapping occurrences count: uniqueAt and countOf step by one, and uniqueMatch refuses a second match', () => {
  assert.strictEqual(countOf('\n}\n}\n', '\n}\n'), 2);
  assert.throws(() => uniqueAt('\n}\n}\n', '\n}\n'), /more than once/);
  assert.strictEqual(countMatches('aaa', /aa/), 2);
  assert.strictEqual(uniqueMatch('a b c', /b/), 2);
  assert.throws(() => uniqueMatch('a b b', /b/), /more than once/);
  assert.throws(() => uniqueMatch('a b', /z/), /not found/);
});

test('needlesOf decodes tab and carriage-return escapes, and searchRegexesOf reads a regex literal with a class holding a slash', () => {
  assert.deepStrictEqual(needlesOf(`s.indexOf('a\\tb')`), ['a\tb']);
  assert.deepStrictEqual(searchRegexesOf('s.search(/function foo\\(/); s.search(/[/]x/i)').map(String), ['/function foo\\(/', '/[/]x/i']);
  assert.deepStrictEqual(searchRegexesOf('s.search(re)'), [], 'a variable regex is not seen (stated in the header)');
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
