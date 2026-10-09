'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const d = require('../app/docs-drift-display');

const NOW = 10_000_000;
const note = (o = {}) => ({ id: 'n1', doc: 'DESIGN_X.md', sentence: 'The index refreshes first.', why: 'It moved.', commit: 'abcdef123456', subject: 'Merge pull request #7', at: NOW - 5 * 60_000, dismissed: false, ...o });

test('nothing to say is no section at all', () => {
  assert.strictEqual(d.view({ notes: [], off: null }, NOW), null);
  assert.strictEqual(d.view(null, NOW), null);
  assert.strictEqual(d.view({}, NOW), null);
});

test('a note shows the doc, the sentence, the commit, why, and its age', () => {
  const v = d.view({ notes: [note()], off: null }, NOW);
  assert.strictEqual(v.title, 'Docs that may be out of date');
  assert.deepStrictEqual(v.rows[0], { id: 'n1', doc: 'DESIGN_X.md', sentence: 'The index refreshes first.', why: 'It moved.', commit: 'abcdef123456', subject: 'Merge pull request #7', age: '5 min ago' });
  assert.match(v.label, /local model/);
  assert.match(v.label, /may be wrong/);
});

test('ages: minutes, hours, days; a missing or backwards time is "time unknown", never zero', () => {
  const age = (at) => d.view({ notes: [note({ at })], off: null }, NOW).rows[0].age;
  assert.strictEqual(age(NOW - 30_000), 'just now');
  assert.strictEqual(age(NOW - 3 * 3_600_000), '3 h ago');
  assert.strictEqual(age(NOW - 2 * 86_400_000), '2 d ago');
  assert.strictEqual(age(NOW + 10 * 60_000), 'time unknown');
  assert.strictEqual(age(null), 'time unknown');
});

test('every reason Ollama or the check is off is said in words, beside the notes if there are any', () => {
  const note1 = (off) => d.view({ notes: [], off }, NOW).note;
  assert.match(note1({ reason: 'ollama-down', model: 'qwen3.5:4b' }), /Ollama isn't running/);
  assert.match(note1({ reason: 'model-missing', model: 'qwen3.5:4b' }), /ollama pull qwen3\.5:4b/);
  assert.match(note1({ reason: 'failed', detail: 'timeout' }), /timeout/);
  assert.match(note1({ reason: 'no-develop' }), /develop/);
  assert.match(note1({ reason: 'no-docs' }), /documentation/);
  const both = d.view({ notes: [note()], off: { reason: 'ollama-down', model: 'm' } }, NOW);
  assert.strictEqual(both.rows.length, 1);
  assert.match(both.note, /Ollama isn't running/);
});

test('an unknown reason is still said, not dropped', () => {
  assert.match(d.view({ notes: [], off: { reason: 'weird' } }, NOW).note, /weird|couldn't/i);
});

test('html: the model words are escaped; a dismiss button carries the note id', () => {
  const v = d.view({ notes: [note({ sentence: '<img src=x onerror=alert(1)>', why: '"><script>x</script>', id: 'a"b' })], off: null }, NOW);
  const html = d.html(v);
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img/);
  assert.match(html, /data-drift-dismiss="a&quot;b"/);
});

test('html: the doc name and Dismiss share the first line; the commit and age have a line of their own (they were squeezed to nothing beside the button)', () => {
  const html = d.html(d.view({ notes: [note()], off: null }, NOW));
  const doc = /<div class="drift-doc">(.*?)<\/div>/.exec(html)[1];
  assert.match(doc, /DESIGN_X\.md/);
  assert.match(doc, /data-drift-dismiss/);
  assert.doesNotMatch(doc, /drift-meta/);
  assert.match(html, /<div class="drift-meta">abcdef123 Merge pull request #7 · 5 min ago<\/div>/);
});

test('html: a view with only a note (no rows) still renders the note', () => {
  const html = d.html(d.view({ notes: [], off: { reason: 'ollama-down', model: 'm' } }, NOW));
  assert.match(html, /Ollama isn&#39;t running|Ollama isn't running/);
  assert.doesNotMatch(html, /data-drift-dismiss/);
});

test('render: empty snapshot clears and hides the element; a dismiss click reports the id once', () => {
  const clicks = [];
  const handlers = {};
  const el = { hidden: false, innerHTML: 'old', addEventListener: (t, f) => { handlers[t] = f; } };
  d.render(el, { notes: [], off: null }, NOW, { onDismiss: (id) => clicks.push(id) });
  assert.strictEqual(el.hidden, true);
  assert.strictEqual(el.innerHTML, '');
  d.render(el, { notes: [note()], off: null }, NOW, { onDismiss: (id) => clicks.push(id) });
  assert.strictEqual(el.hidden, false);
  assert.match(el.innerHTML, /DESIGN_X\.md/);
  const btn = { getAttribute: (n) => (n === 'data-drift-dismiss' ? 'n1' : null) };
  handlers.click({ target: { closest: (sel) => (sel === '[data-drift-dismiss]' ? btn : null) } });
  handlers.click({ target: { closest: () => null } });
  assert.deepStrictEqual(clicks, ['n1']);
});

test('property: any snapshot renders without throwing and never leaves a raw angle bracket from the model', () => {
  fc.assert(fc.property(fc.array(fc.record({ id: fc.string(), doc: fc.string(), sentence: fc.string(), why: fc.string(), commit: fc.string(), subject: fc.string(), at: fc.oneof(fc.integer(), fc.constant(null)) }), { maxLength: 6 }), (notes) => {
    const html = d.html(d.view({ notes, off: null }, NOW));
    const body = html === '' ? '' : html.replace(/<\/?(?:section|h3|div|span|button|ul|li|p|small|b|i|code|em)\b[^<>]*>/g, '');
    return !/[<>]/.test(body);
  }), { numRuns: 100 });
});
