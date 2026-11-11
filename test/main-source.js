'use strict';
/**
 * The main process's source as the wiring tests read it.
 *
 * Since the per-project state moved out of app/main.js into app/project-window.js, a test that pins a fact about "the main
 * process" has to read BOTH files, or it silently tests less. This is the one place that says which two. Flat in test/ (no
 * subfolders: test/renderer-scope.test.js walks it), and not a *.test.js file, so the runner doesn't run it.
 *
 *   mainProcessSource()              main.js + project-window.js, CRLF-normalised
 *   mainProcessSource({ strip: 1 })  the same with block and whole-line comments removed (what main-shell-wiring reads)
 *   mainOnly() / windowOnly()        one file, for a fact that is about that file's own top level
 *   bodyAt(src, at)                  the braced body that starts at/after `at`, string-aware; a missing end FAILS
 */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const APP = path.join(__dirname, '..', 'app');
const read = (name) => fs.readFileSync(path.join(APP, name), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

const mainOnly = ({ strip = false } = {}) => (strip ? stripComments(read('main.js')) : read('main.js'));
const windowOnly = ({ strip = false } = {}) => (strip ? stripComments(read('project-window.js')) : read('project-window.js'));

/** main.js then project-window.js, joined by a newline. */
function mainProcessSource({ strip = false } = {}) {
  return `${mainOnly({ strip })}\n${windowOnly({ strip })}`;
}

/**
 * The text from `at` through the `}` that closes the first top-level `{` at or after it. Skips strings, template literals and
 * comments, so a brace inside one doesn't end the body early. Fails (instead of reading to EOF) when there's no start or no end.
 */
function bodyAt(src, at) {
  assert.ok(Number.isInteger(at) && at >= 0, 'bodyAt: the body must start somewhere');
  let parens = 0;
  let depth = 0;
  let opened = false;
  for (let i = at; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') { const nl = src.indexOf('\n', i); if (nl === -1) break; i = nl; continue; }
    if (ch === '/' && next === '*') { const end = src.indexOf('*/', i + 2); if (end === -1) break; i = end + 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (!opened) {
      if (ch === '(') parens++;
      else if (ch === ')') parens--;
      else if (ch === '{' && parens <= 0) { opened = true; depth = 1; }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  assert.fail(`bodyAt: no closing brace for the body at ${at}`);
}

module.exports = { mainProcessSource, mainOnly, windowOnly, bodyAt, stripComments };
