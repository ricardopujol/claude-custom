'use strict';
/**
 * PROPERTIES of the inbox (host/indexing-doc.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Revised 2026-10-05
 * (evening)"):
 *
 *   P1  undo(apply(ensure(doc), note)) === ensure(doc), for any doc and any note: Undo removes exactly that entry.
 *   P2  ensureInbox only inserts (every character of the doc is kept, in order), and apply only inserts at its offset.
 *   P3  a note never forges structure (Dexter F7 / Miguel I1, PR #121): after filing it, the doc's column-0 headings,
 *       fences and `## N.` lines are the ones it had, plus none; and the inbox holds exactly one more entry.
 *   P4  a session's edit outside the inbox doesn't block Undo, and survives it.
 *   P5  two notes: undoing the first leaves the second, undoing the second leaves the first.
 *
 * Docs are backlog-shaped lines plus hostile ones (fences of either kind and length, indented headings, an existing
 * inbox, CRLF, no final newline); notes carry what pasted Markdown does (`## 9. x`, fences, `# y`, lone \r).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const d = require('../host/indexing-doc');

const wordArb = fc.oneof(fc.string({ maxLength: 10 }), fc.constantFrom('héllo', '日本語', 'emoji 😀', '"quoted"', '**b**', '#66', '·'));
const docLineArb = fc.oneof(
  fc.tuple(fc.integer({ min: 1, max: 99 }), wordArb).map(([n, w]) => `## ${n}. ${w}`),
  wordArb.map(w => `# ${w}`), wordArb.map(w => `## ${w}`), wordArb.map(w => `   ## ${w}`), wordArb.map(w => `### ${w}`),
  wordArb.map(w => `- ${w}`), wordArb.map(w => `  ${w}`),
  fc.constantFrom('', '', '```', '````', '~~~', '## Inbox', '## inbox', '- 2026-01-01 00:00 · old', '**Status (x):**'),
  wordArb,
);
const docArb = fc.tuple(fc.array(docLineArb, { maxLength: 25 }), fc.constantFrom('\n', '\r\n'), fc.boolean())
  .map(([lines, nl, finalNl]) => lines.join(nl) + (finalNl && lines.length ? nl : ''));
const noteLineArb = fc.oneof(wordArb, fc.constantFrom('## 9. forged', '# y', '```', '~~~', '  ## z', '## Inbox', '- 2026-01-01 00:00 · fake', ''));
const noteArb = fc.tuple(fc.array(noteLineArb, { minLength: 1, maxLength: 4 }), fc.constantFrom('\n', '\r\n', '\r'))
  .map(([ls, nl]) => ls.join(nl))
  .filter(t => t.trim() !== '');
const STAMP = '2026-10-05 09:07';
const RUNS = { numRuns: 300 };

function file(doc, note) {
  const base = d.ensureInbox(doc).text;
  const entry = d.entryText(STAMP, note, d.newlineOf(base));
  const plan = d.planAppend(base, entry);
  assert.strictEqual(plan.ok, true);
  return { base, entry, plan, after: d.applyInsert(base, plan), record: d.recordOf(plan, entry) };
}

/** The doc's structure as anything reading column 0 sees it. */
const col0 = (text) => text.split(/\r\n|\r|\n/).filter(l => /^(#|```|~~~)/.test(l));
const entriesIn = (text) => {
  const box = d.inboxOf(text);
  return box.found ? text.slice(box.bodyStart, box.end).split(/\r?\n/).filter(l => /^- /.test(l)).length : -1;
};

test('P1: undo(apply(ensure(doc), note)) === ensure(doc)', () => {
  fc.assert(fc.property(docArb, noteArb, (doc, note) => {
    const f = file(doc, note);
    assert.deepStrictEqual(d.removeEntry(f.after, f.record), { ok: true, text: f.base });
  }), RUNS);
});

test('P2: ensureInbox and apply only ever insert', () => {
  const isInsertion = (from, to) => {
    let i = 0;
    while (i < from.length && from[i] === to[i]) i++;
    return to.slice(to.length - (from.length - i)) === from.slice(i);
  };
  fc.assert(fc.property(docArb, noteArb, (doc, note) => {
    const f = file(doc, note);
    assert.ok(isInsertion(doc, f.base), 'ensureInbox removed or changed something');
    assert.strictEqual(f.after.slice(0, f.plan.offset), f.base.slice(0, f.plan.offset));
    assert.strictEqual(f.after.slice(f.plan.offset + f.plan.inserted.length), f.base.slice(f.plan.offset));
  }), RUNS);
});

test('P3: a note never forges a heading, a fence or a ## N. line, and adds exactly one inbox entry', () => {
  fc.assert(fc.property(docArb, noteArb, (doc, note) => {
    const f = file(doc, note);
    assert.deepStrictEqual(col0(f.after), col0(f.base));
    assert.strictEqual(entriesIn(f.after), entriesIn(f.base) + 1);
  }), RUNS);
});

test('P4: a session\'s edit above the inbox doesn\'t block Undo, and is kept', () => {
  fc.assert(fc.property(docArb, noteArb, fc.string({ minLength: 1, maxLength: 4 }).filter(s => !/[\r\n#`~ -]/.test(s)), (doc, note, junk) => {
    const f = file(doc, note);
    const box = d.inboxOf(f.after);
    fc.pre(box.headingStart > 0);
    // A session adds a line at the top (a whole line: glued onto a fence line, it would change the doc's structure).
    const line = junk + d.newlineOf(f.after);
    const r = d.removeEntry(line + f.after, { ...f.record, offset: f.record.offset + line.length });
    assert.deepStrictEqual(r, { ok: true, text: line + f.base });
  }), RUNS);
});

test('P5: two notes, undone in either order, each leaves the other', () => {
  fc.assert(fc.property(docArb, noteArb, noteArb, (doc, n1, n2) => {
    const a = file(doc, n1);
    const nl = d.newlineOf(a.after);
    const e2 = d.entryText('2026-10-05 09:08', n2, nl);
    const p2 = d.planAppend(a.after, e2);
    const both = d.applyInsert(a.after, p2);
    const r2 = d.recordOf(p2, e2);
    assert.deepStrictEqual(d.removeEntry(both, r2), { ok: true, text: a.after });
    const firstOut = d.removeEntry(both, a.record);
    assert.strictEqual(firstOut.ok, true);
    assert.strictEqual(entriesIn(firstOut.text), entriesIn(a.base) + 1);
    assert.ok(firstOut.text.includes(e2));
  }), RUNS);
});
