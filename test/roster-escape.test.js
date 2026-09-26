'use strict';
/**
 * The roster row interpolated the agent's name into both `title="…"` and the
 * row text without escapeHtml (Miguel, PR #34 review, S3). An agent name is a
 * file name or a hook payload's `agent_type` -- neither is ours -- so a `"` in
 * it closed the attribute and a `<` in it opened a tag.
 *
 * renderer.js needs a real DOM and no test can load it (see
 * renderer-scope.test.js), so this reads the source, as that file does.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');

// faceHtml, EXECUTED rather than pattern-matched: a pattern test for
// `${r.agent}` passed while the same name reached the row raw through the
// portrait's initials (Miguel, #49 review). Lifted out of the source with
// escapeHtml, which it needs, so the real function runs.
function lift(start, end) {
  const i = src.indexOf(start);
  assert.ok(i !== -1, `renderer.js must contain ${start}`);
  const j = src.indexOf(end, i);
  return src.slice(i, j + end.length);
}
const faceHtml = new Function(
  lift('const escapeHtml = ', '[c]));') + '\n' +
  lift('function faceHtml(', '\n}') + '\nreturn faceHtml;')();

const HOSTILE = '"><img src=x onerror=alert(1)>';

test('a placeholder face escapes initials built from a hostile agent name', () => {
  const { placeholderFor } = require('../host/portraits');
  // The initials are the first letters of the name's words -- here `"S`.
  const html = faceHtml(placeholderFor(HOSTILE));
  const text = (html.match(/<span[^>]*>([\s\S]*)<\/span>$/) || [])[1];
  assert.ok(text !== undefined, `unexpected face markup: ${html}`);
  assert.ok(!/[<>"]/.test(text), `raw markup characters reached the face text: ${text}`);

  // And a name whose initials ARE a tag opener.
  const tag = faceHtml(placeholderFor('<b'));
  assert.ok(!tag.includes('<B'), `a tag reached the markup: ${tag}`);
});

test('a file face escapes its path inside src="…"', () => {
  const html = faceHtml({ kind: 'file', path: 'C:\\p\\a"onerror="x.png' });
  assert.ok(!html.includes('"onerror="'), `the path closed the attribute: ${html}`);
});

test('the roster never interpolates an agent name raw into markup', () => {
  const raw = src.match(/\$\{r\.agent\}/g) || [];
  assert.deepStrictEqual(raw, [],
    'every ${r.agent} in renderer.js must go through escapeHtml');
});
