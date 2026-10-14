'use strict';
/**
 * host/ask-explain.js (BACKLOG #33): the explainer prompt. The wording of BASE and the two measured level rules is what the
 * 2026-10-13 measurement graded (reports/2026-10-13-ask-explain-measure.md, prompt v1); a change to them is a new measurement, so
 * the test pins the sentences that carry the honesty.
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildExplain, LEVELS, DEFAULT_LEVEL, levelOf, SELECTION_MAX_LINES, SELECTION_MAX_CHARS, clipSelection } = require('../host/ask-explain');

const sel = { file: 'host/a.js', start: 10, end: 11, lines: ['const x = 1;', 'return x;'] };

test('the four levels, comfortable by default', () => {
  assert.deepStrictEqual(LEVELS.map(l => l.id), ['new', 'learning', 'comfortable', 'expert']);
  assert.deepStrictEqual(LEVELS.map(l => l.label), ['New to coding', 'Learning this language', 'Comfortable', 'Expert']);
  assert.strictEqual(DEFAULT_LEVEL, 'comfortable');
  assert.strictEqual(levelOf('new').id, 'new');
  assert.strictEqual(levelOf('nonsense').id, 'comfortable');
  assert.strictEqual(levelOf(undefined).id, 'comfortable');
});

test('the system prompt keeps the measured honesty rules', () => {
  const { system } = buildExplain({ ...sel, excerpts: '### x:1-2\n1: y', level: 'comfortable' });
  assert.match(system, /ONLY the selected code and the numbered excerpts/);
  assert.match(system, /Never claim anything about the code that the selected code or the excerpts do not show/);
  assert.match(system, /Where it shows up/);
  assert.match(system, /Reader level: Comfortable\./);
});

test('each level has its own rule', () => {
  const rule = (l) => buildExplain({ ...sel, excerpts: 'e', level: l }).system;
  assert.match(rule('new'), /never programmed/);
  assert.match(rule('comfortable'), /codes comfortably in general but does not know this codebase/);
  assert.match(rule('learning'), /learning this language/i);
  assert.match(rule('expert'), /only what is non-obvious|non-obvious/i);
  assert.notStrictEqual(rule('new'), rule('expert'));
});

test('the prompt shows the selected lines with their real numbers, then the excerpts, then asks', () => {
  const { prompt } = buildExplain({ ...sel, excerpts: '### host/b.js:1-3\n1: foo' });
  assert.match(prompt, /^Selected code \(host\/a\.js, lines 10-11\):\n10: const x = 1;\n11: return x;/);
  assert.match(prompt, /Excerpts from elsewhere in the repository:\n\n### host\/b\.js:1-3\n1: foo/);
  assert.match(prompt, /Explain what the selected code is doing\.$/);
});

test('no excerpts is said plainly, not left as an empty section', () => {
  const { prompt } = buildExplain({ ...sel, excerpts: '' });
  assert.match(prompt, /\(no other excerpt was found\)/);
});

test('About me feeds comparisons, and an empty one adds nothing', () => {
  const withMe = buildExplain({ ...sel, excerpts: 'e', aboutMe: 'Learning Python, background in C# audio.' }).system;
  assert.match(withMe, /About the reader/);
  assert.match(withMe, /Learning Python, background in C# audio\./);
  assert.match(withMe, /comparison/i);
  const without = buildExplain({ ...sel, excerpts: 'e', aboutMe: '   ' }).system;
  assert.doesNotMatch(without, /About the reader/);
});

test('About me is cut to a sane length and cannot carry a new instruction block past it', () => {
  const long = 'x'.repeat(5000);
  const s = buildExplain({ ...sel, excerpts: 'e', aboutMe: long }).system;
  assert.ok(s.length < 3000);
});

test('Simpler and Deeper change the ask; anything else is the plain ask', () => {
  const base = buildExplain({ ...sel, excerpts: 'e' }).system;
  const simpler = buildExplain({ ...sel, excerpts: 'e', direction: 'simpler' }).system;
  const deeper = buildExplain({ ...sel, excerpts: 'e', direction: 'deeper' }).system;
  assert.match(simpler, /simpler/i);
  assert.match(deeper, /deeper/i);
  assert.strictEqual(buildExplain({ ...sel, excerpts: 'e', direction: 'sideways' }).system, base);
});

test('a drill-down names the highlighted words and the answer they came from', () => {
  const { prompt } = buildExplain({ ...sel, excerpts: 'e', term: 'HTTP request', answer: 'It sends an HTTP request to Ollama.' });
  assert.match(prompt, /highlighted "HTTP request"/);
  assert.match(prompt, /It sends an HTTP request to Ollama\./);
  assert.match(prompt, /Explain what "HTTP request" is/);
});

test('a drill-down term is cut and its quotes cannot break out of the sentence', () => {
  const { prompt } = buildExplain({ ...sel, excerpts: 'e', term: 'a"b\n' + 'z'.repeat(500), answer: 'ans' });
  const line = prompt.split('\n').find(l => l.startsWith('The reader highlighted'));
  assert.ok(line.length < 400);
  assert.doesNotMatch(line, /a"b/);
});

test('clipSelection: a long selection is cut by lines and by characters, and says so', () => {
  const many = Array.from({ length: SELECTION_MAX_LINES + 20 }, (_, i) => `line ${i}`);
  const r = clipSelection({ file: 'f', start: 1, end: many.length, lines: many });
  assert.strictEqual(r.lines.length, SELECTION_MAX_LINES);
  assert.strictEqual(r.end, SELECTION_MAX_LINES);
  assert.strictEqual(r.clipped, true);
  const wide = clipSelection({ file: 'f', start: 5, end: 5, lines: ['y'.repeat(SELECTION_MAX_CHARS + 50)] });
  assert.ok(wide.lines[0].length <= SELECTION_MAX_CHARS + 20);
  assert.strictEqual(wide.clipped, true);
  assert.strictEqual(clipSelection(sel).clipped, false);
});
