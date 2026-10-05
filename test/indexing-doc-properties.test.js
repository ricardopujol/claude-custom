'use strict';
/**
 * PROPERTIES of the indexing assistant's document side (host/indexing-doc.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md
 * "Testing"):
 *
 *   P1  undo(apply(doc, note)) === doc, for any doc and any note, to any target that accepts it.
 *   P2  apply never changes a character outside the inserted range.
 *   P3  nextItemNumber is greater than every `## N.` in the doc, and a new item gets exactly that number.
 *   P4  a filed new item is found by parseBacklog with that number, and the note text is in the file verbatim
 *       (its line breaks aside); a note on #N lands inside item #N.
 *   P5  anything changed before the insertion makes Undo refuse rather than remove the wrong text.
 *
 * Docs are drawn from backlog-shaped lines plus hostile ones: fences, duplicate numbers, CRLF, no final newline,
 * blank runs, multi-byte text and lines that look like headings but aren't.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const d = require('../host/indexing-doc');

const wordArb = fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom('héllo', '日本語', 'emoji 😀', '"quoted"', '**bold**', '#66'));
const lineArb = fc.oneof(
  fc.tuple(fc.integer({ min: 1, max: 120 }), wordArb).map(([n, w]) => `## ${n}. ${w}`),
  wordArb.map(w => `# ${w}`),
  wordArb.map(w => `## ${w}`),
  wordArb.map(w => `### ${w}`),
  wordArb.map(w => `- ${w}`),
  fc.constantFrom('', '', '```', '~~~', '## 7 no dot', '##7. tight', '   '),
  wordArb,
);
const docArb = fc.tuple(fc.array(lineArb, { maxLength: 30 }), fc.constantFrom('\n', '\r\n'), fc.boolean())
  .map(([lines, nl, finalNl]) => lines.join(nl) + (finalNl && lines.length ? nl : ''));
const noteArb = fc.tuple(fc.array(wordArb, { minLength: 1, maxLength: 3 }), fc.constantFrom('\n', '\r\n'))
  .map(([ws, nl]) => ws.join(nl))
  .filter(t => t.trim() !== '');
const titleArb = wordArb.filter(t => t.trim() !== '');

/** Every spec this doc accepts: a new item, a note on each unique item, a history entry. */
function specsFor(doc, text, title) {
  const specs = [
    { target: 'new', title, text, date: '2026-10-05' },
    { target: 'history', kind: 'decision', text, date: '2026-10-05' },
    { target: 'history', kind: 'learning', text, date: '2026-10-05' },
  ];
  for (const it of d.parseBacklog(doc).items) if (!it.dup) specs.push({ target: it.n, text, date: '2026-10-05' });
  return specs;
}

const RUNS = { numRuns: 300 };

test('P1 + P2: undo(apply(doc, note)) is the doc, and apply touches nothing outside its range', () => {
  fc.assert(fc.property(docArb, noteArb, titleArb, (doc, text, title) => {
    for (const spec of specsFor(doc, text, title)) {
      const plan = d.planInsert(doc, spec);
      assert.strictEqual(plan.ok, true, JSON.stringify(spec));
      const after = d.applyInsert(doc, plan);
      assert.strictEqual(after.slice(0, plan.offset), doc.slice(0, plan.offset));
      assert.strictEqual(after.slice(plan.offset + plan.inserted.length), doc.slice(plan.offset));
      assert.strictEqual(after.length, doc.length + plan.inserted.length);
      assert.deepStrictEqual(d.undoInsert(after, d.recordOf(doc, plan)), { ok: true, text: doc });
    }
  }), RUNS);
});

test('P3: the next number is above every ## N. line, and a new item takes exactly it', () => {
  fc.assert(fc.property(docArb, noteArb, titleArb, (doc, text, title) => {
    const next = d.nextItemNumber(doc);
    for (const m of doc.matchAll(/^##\s+(\d+)\./gm)) assert.ok(next > Number(m[1]));
    const plan = d.planInsert(doc, { target: 'new', title, text, date: 'D' });
    assert.strictEqual(plan.n, next);
  }), RUNS);
});

test('P4: a new item parses back with its number; a note on #N lands inside #N; the words are kept', () => {
  fc.assert(fc.property(docArb, noteArb, titleArb, (doc, text, title) => {
    const plan = d.planInsert(doc, { target: 'new', title, text, date: 'D' });
    const after = d.applyInsert(doc, plan);
    // A new item opened inside an unclosed fence is not visible as an item: that's the doc's own state, not ours.
    const fenceOpen = (doc.match(/^\s{0,3}(?:```|~~~)/gm) || []).length % 2 === 1;
    if (!fenceOpen) assert.ok(d.parseBacklog(after).items.some(i => i.n === plan.n && !i.dup));
    const words = text.trim().split(/\r\n|\r|\n/);
    for (const w of words) assert.ok(plan.inserted.includes(w));
    for (const it of d.parseBacklog(doc).items) {
      if (it.dup) continue;
      const p = d.planInsert(doc, { target: it.n, text, date: 'D' });
      assert.ok(p.offset > it.start && p.offset <= it.end, `note for #${it.n} at ${p.offset} outside ${it.start}..${it.end}`);
    }
  }), RUNS);
});

test('P5: a change anywhere before the insertion makes Undo refuse, an insertion or a same-length substitution', () => {
  fc.assert(fc.property(docArb, noteArb, fc.string({ minLength: 1, maxLength: 3 }), fc.nat(), fc.boolean(), (doc, text, junk, at, substitute) => {
    const plan = d.planInsert(doc, { target: 'history', kind: 'learning', text, date: 'D' });
    fc.pre(plan.offset > 0);
    const after = d.applyInsert(doc, plan);
    const where = at % plan.offset;
    // A substitution keeps every offset where it was, so only the prefix's hash can see it.
    const swap = after[where] === 'x' ? 'y' : 'x';
    const edited = substitute
      ? after.slice(0, where) + swap + after.slice(where + 1)
      : after.slice(0, where) + junk + after.slice(where);
    assert.deepStrictEqual(d.undoInsert(edited, d.recordOf(doc, plan)), { ok: false, reason: 'changed' });
  }), RUNS);
});
