'use strict';
/**
 * Kill tests for Mortimer's release-gate survivors S21 (2026-10-09), host/indexing-doc.js (76 survivors): the stamp's
 * zero-padding and month offset, the line-break rule, the section's edges (heading spellings, where it ends, the
 * fence tracker's same-character / at-least-as-long rule), planAppend's lead and sep, recordOf, findEntries' bounds
 * and removeEntry's record validation. Each assertion states the document a person would see.
 */
const test = require('node:test');
const assert = require('node:assert');

const d = require('../host/indexing-doc');

const E = (s, text = 'note') => d.entryText(s, text, '\n');
const STAMP = '2026-10-05 09:07';

// ---- stampOf / newlineOf / entryText ---------------------------------------------------------------------------------------

test('S21 doc: stampOf pads every field to two digits and counts months from 1', () => {
  assert.strictEqual(d.stampOf(new Date(2026, 0, 5, 3, 4).getTime()), '2026-01-05 03:04');
  assert.strictEqual(d.stampOf(new Date(2026, 11, 31, 23, 59).getTime()), '2026-12-31 23:59');
  assert.strictEqual(d.stampOf(new Date(2026, 8, 9, 0, 0).getTime()), '2026-09-09 00:00');
  assert.strictEqual(d.stampOf(new Date(2026, 9, 10, 10, 10).getTime()), '2026-10-10 10:10');
});

test('S21 doc: newlineOf is CRLF only when the FIRST line break is one; a break at offset 0 or a non-string is LF', () => {
  assert.strictEqual(d.newlineOf('a\r\nb\n'), '\r\n');
  assert.strictEqual(d.newlineOf('a\nb\r\n'), '\n');
  assert.strictEqual(d.newlineOf('\r\nb'), '\r\n', 'a CRLF at the very start');
  assert.strictEqual(d.newlineOf('\nb\r\n'), '\n', 'an LF at the very start');
  assert.strictEqual(d.newlineOf('no break'), '\n');
  assert.strictEqual(d.newlineOf(''), '\n');
  for (const bad of [null, undefined, 5, [], {}]) assert.strictEqual(d.newlineOf(bad), '\n');
});

test('S21 doc: entryText trims the note, splits on CRLF / CR / LF, indents each further line by exactly two spaces, ends every line with the given break', () => {
  assert.strictEqual(d.entryText(STAMP, '  a\r\nb\rc\nd  ', '\r\n'), `- ${STAMP} · a\r\n  b\r\n  c\r\n  d\r\n`);
  assert.strictEqual(d.entryText(STAMP, 'one', '\n'), `- ${STAMP} · one\n`);
  assert.strictEqual(d.entryText(STAMP, 'a\n\nb', '\n'), `- ${STAMP} · a\n  \n  b\n`);
  assert.strictEqual(d.entryText(STAMP, 42, '\n'), `- ${STAMP} · 42\n`);
});

// ---- inboxOf ---------------------------------------------------------------------------------------------------------------------

test('S21 doc: inboxOf finds the heading in its accepted spellings only', () => {
  for (const h of ['## Inbox', '## inbox', '## INBOX', '   ## Inbox', '##\tInbox', '##   Inbox', '## Inbox  ', '## Inbox ##', '## Inbox#', '## Inbox \t']) {
    assert.strictEqual(d.inboxOf(`# T\n\n${h}\n- x\n`).found, true, JSON.stringify(h));
  }
  for (const h of ['### Inbox', '# Inbox', '##Inbox', '    ## Inbox', '## Inbox2', '## My Inbox', '## Inbox now', '##', '## Inboxes']) {
    assert.strictEqual(d.inboxOf(`# T\n\n${h}\n- x\n`).found, false, JSON.stringify(h));
  }
  for (const bad of [null, undefined, 5, '']) assert.deepStrictEqual(d.inboxOf(bad), { found: false });
});

test('S21 doc: inboxOf reports where the heading, the body and the section end are', () => {
  const text = '# T\n\n## Inbox\n- a\n- b\n\n## Next\nx\n';
  const box = d.inboxOf(text);
  assert.strictEqual(box.headingStart, text.indexOf('## Inbox'));
  assert.strictEqual(box.bodyStart, text.indexOf('- a'));
  assert.strictEqual(box.end, text.indexOf('## Next'));
  assert.strictEqual(box.after.text, '- b', 'the last non-blank line');
  assert.strictEqual(box.after.next, text.indexOf('\n\n## Next') + 1);
  const toEof = d.inboxOf('## Inbox\n- a\n');
  assert.strictEqual(toEof.end, '## Inbox\n- a\n'.length);
});

test('S21 doc: the section ends at a level 1 or level 2 heading (up to three spaces in), not at a deeper one or an indented four', () => {
  for (const [h, endsHere] of [['# Top', true], ['## Two', true], ['   ## Two', true], ['### Three', false], ['#### Four', false], ['    ## Code', false], ['#nospace', false], ['##', true], ['#\tTab', true]]) {
    const text = `## Inbox\n${h}\n- later\n`;
    const box = d.inboxOf(text);
    assert.strictEqual(box.end === text.indexOf(`\n${h}\n`) + 1, endsHere, JSON.stringify(h));
  }
  // Right after an entry, a heading indented two or three spaces reads as that entry's continuation.
  const afterEntry = '## Inbox\n- a\n   ## Two\n';
  assert.strictEqual(d.inboxOf(afterEntry).end, afterEntry.length);
});

test('S21 doc: a two-space line after an entry continues it, even if it looks like a heading or a fence; a column-0 line after a note is not part of it', () => {
  const text = '## Inbox\n- a\n  ## not a heading\n  ```\n  more\n- b\n';
  const box = d.inboxOf(text);
  assert.strictEqual(box.end, text.length);
  assert.strictEqual(box.after.text, '- b');
  const after = d.inboxOf('## Inbox\n- a\nplain line\n');
  assert.strictEqual(after.after.text, 'plain line', 'a column-0 line still counts as the last non-blank line');
});

test('S21 doc: a blank line inside an entry (an editor trimmed the two spaces) stays inside only when the next non-blank line is indented and not a heading', () => {
  const inside = '## Inbox\n- a\n\n  still a\n- b\n';
  assert.strictEqual(d.inboxOf(inside).after.text, '- b');
  const text = '## Inbox\n- a\n\n  still a\n';
  assert.strictEqual(d.inboxOf(text).after.text, '  still a', 'the continuation after the trimmed blank belongs to the entry');
  const heading = '## Inbox\n- a\n\n  ## indented heading\n';
  assert.strictEqual(d.inboxOf(heading).end, heading.indexOf('  ## indented'), 'an indented heading still ends the section');
  const blankThenCol0 = '## Inbox\n- a\n\n- b\n';
  assert.strictEqual(d.inboxOf(blankThenCol0).after.text, '- b');
});

test('S21 doc: a fence closes only on the same character and at least as long a run; a longer or equal one closes, a shorter or other one does not', () => {
  const closes = (open, close) => {
    const text = `## Inbox\n${open}\n## inside\n${close}\n## After\n`;
    const box = d.inboxOf(text);
    return box.end === text.indexOf('## After');
  };
  assert.strictEqual(closes('```', '```'), true);
  assert.strictEqual(closes('```', '````'), true);
  assert.strictEqual(closes('````', '```'), false, 'shorter does not close');
  assert.strictEqual(closes('```', '~~~'), false, 'another character does not close');
  assert.strictEqual(closes('~~~', '~~~'), true);
  assert.strictEqual(closes('~~~', '```'), false);
  assert.strictEqual(closes('```', '``` text'), false, 'a closing fence has nothing after it');
  assert.strictEqual(closes('```', '```   '), true, 'trailing blanks are fine');
  assert.strictEqual(closes('   ```', '   ```'), true, 'up to three spaces in');
});

test('S21 doc: an inbox heading inside a fence is not the inbox', () => {
  assert.strictEqual(d.inboxOf('```\n## Inbox\n```\n').found, false);
  assert.strictEqual(d.inboxOf('~~~\n## Inbox\n~~~\n## Inbox\n').found, true);
  assert.strictEqual(d.inboxOf('```\n## Inbox\n~~~\n## Inbox\n').found, false, 'a ~~~ line does not close a ``` fence');
});

test('S21 doc: a fence left open at the end of the inbox keeps new entries before it; one that closed does not', () => {
  const open = '## Inbox\n- a\n```\ncode\n';
  assert.strictEqual(d.inboxOf(open).after.text, '- a');
  const closed = '## Inbox\n- a\n```\ncode\n```\n';
  assert.strictEqual(d.inboxOf(closed).after.text, '```');
});

// ---- ensureInbox ---------------------------------------------------------------------------------------------------------------

test('S21 doc: ensureInbox on an empty or non-string text is just the heading; an existing inbox is untouched', () => {
  assert.deepStrictEqual(d.ensureInbox(''), { text: '## Inbox\n', added: true });
  assert.deepStrictEqual(d.ensureInbox(null), { text: '## Inbox\n', added: true });
  assert.deepStrictEqual(d.ensureInbox('## Inbox\n- a\n'), { text: '## Inbox\n- a\n', added: false });
});

test('S21 doc: ensureInbox goes before the first ## heading with a blank line ahead of it only when one is missing, and uses the file\'s line break', () => {
  assert.strictEqual(d.ensureInbox('# T\n\n## One\n').text, '# T\n\n## Inbox\n\n## One\n');
  assert.strictEqual(d.ensureInbox('# T\nstatus\n## One\n').text, '# T\nstatus\n\n## Inbox\n\n## One\n');
  assert.strictEqual(d.ensureInbox('## One\n').text, '## Inbox\n\n## One\n', 'a heading on line 0 needs no blank ahead');
  assert.strictEqual(d.ensureInbox('# T\r\n\r\n## One\r\n').text, '# T\r\n\r\n## Inbox\r\n\r\n## One\r\n');
  assert.strictEqual(d.ensureInbox('# T\r\nstatus\r\n## One\r\n').text, '# T\r\nstatus\r\n\r\n## Inbox\r\n\r\n## One\r\n');
});

test('S21 doc: ensureInbox with no ## heading goes at the end, after a blank line, finishing an unterminated last line first', () => {
  assert.strictEqual(d.ensureInbox('# T\nbody').text, '# T\nbody\n\n## Inbox\n');
  assert.strictEqual(d.ensureInbox('# T\nbody\n').text, '# T\nbody\n\n## Inbox\n');
  assert.strictEqual(d.ensureInbox('# T\nbody\n\n').text, '# T\nbody\n\n## Inbox\n');
  assert.strictEqual(d.ensureInbox('# T\r\nbody').text, '# T\r\nbody\r\n\r\n## Inbox\r\n');
  assert.strictEqual(d.ensureInbox('# T\n').text, '# T\n\n## Inbox\n');
});

test('S21 doc: ensureInbox ignores ## headings in fences, and puts the inbox before a fence that never closes', () => {
  assert.strictEqual(d.ensureInbox('# T\n```\n## fake\n```\n## Real\n').text, '# T\n```\n## fake\n```\n\n## Inbox\n\n## Real\n');
  assert.strictEqual(d.ensureInbox('# T\ntext\n```\ncode\n').text, '# T\ntext\n\n## Inbox\n\n```\ncode\n');
  assert.strictEqual(d.ensureInbox('# T\n\n```\ncode\n').text, '# T\n\n## Inbox\n\n```\ncode\n');
  assert.strictEqual(d.ensureInbox('# T\n~~~\n## fake\n```\n').text, '# T\n\n## Inbox\n\n~~~\n## fake\n```\n', 'a ``` line does not close a ~~~ fence');
  assert.strictEqual(d.ensureInbox('# T\n```\nfirst\n```\n```\nsecond\n').text, '# T\n```\nfirst\n```\n\n## Inbox\n\n```\nsecond\n', 'the opener of the LAST open fence');
});

// ---- planAppend / applyInsert / recordOf ----------------------------------------------------------------------------------------

test('S21 doc: planAppend inserts after the last non-blank line of the inbox; a missing final line break is added in front (lead)', () => {
  const entry = E(STAMP, 'new');
  const text = '## Inbox\n- a\n\n## Next\n';
  const plan = d.planAppend(text, entry);
  assert.deepStrictEqual(plan, { ok: true, offset: text.indexOf('\n\n## Next') + 1, inserted: entry });
  assert.strictEqual(d.applyInsert(text, plan), `## Inbox\n- a\n${entry}\n## Next\n`);

  const unterminated = '## Inbox\n- a';
  const p2 = d.planAppend(unterminated, entry);
  assert.deepStrictEqual(p2, { ok: true, offset: unterminated.length, inserted: `\n${entry}` });
  const crlf = '## Inbox\r\n- a';
  assert.strictEqual(d.planAppend(crlf, d.entryText(STAMP, 'n', '\r\n')).inserted.startsWith('\r\n- '), true, 'lead uses the file\'s break');
  assert.deepStrictEqual(d.planAppend('# T\n', entry), { ok: false, reason: 'no-inbox' });
  assert.deepStrictEqual(d.planAppend(null, entry), { ok: false, reason: 'no-inbox' });
});

test('S21 doc: planAppend adds a blank line (sep) after the entry only when the next line starts with two spaces', () => {
  const entry = E(STAMP, 'new');
  // An empty inbox directly followed by an indented heading (which ends the section): the new entry needs a blank line after it.
  assert.strictEqual(d.planAppend('## Inbox\n  ## Next\n', entry).inserted, entry + '\n');
  assert.strictEqual(d.planAppend('## Inbox\n   ## Next\n', entry).inserted, entry + '\n');
  assert.strictEqual(d.planAppend('## Inbox\n ## Next\n', entry).inserted, entry, 'one space is not two');
  assert.strictEqual(d.planAppend('## Inbox\n## Next\n', entry).inserted, entry);
  assert.strictEqual(d.planAppend('## Inbox\n- a\n\n## Plain\n', entry).inserted, entry);
  assert.strictEqual(d.planAppend('## Inbox\r\n  ## Next\r\n', d.entryText(STAMP, 'n', '\r\n')).inserted.endsWith('\r\n\r\n'), true, 'sep uses the file\'s break');
});

test('S21 doc: recordOf splits what was inserted into lead, entry and sep with the offset of the entry itself', () => {
  const entry = E(STAMP, 'x');
  const rec = d.recordOf({ offset: 40, inserted: `\n${entry}\n` }, entry);
  assert.deepStrictEqual(rec, { entry, offset: 41, lead: '\n', sep: '\n' });
  assert.deepStrictEqual(d.recordOf({ offset: 40, inserted: entry }, entry), { entry, offset: 40, lead: '', sep: '' });
});

// ---- findEntries / findEntry -----------------------------------------------------------------------------------------------------

test('S21 doc: findEntries lists only whole entries at a line start INSIDE the inbox', () => {
  const entry = E(STAMP, 'dup');
  const text = `${entry}## Inbox\n${entry}  more\n${entry}x ${entry}${entry}## Next\n${entry}`;
  const inside = d.findEntries(text, entry);
  const box = d.inboxOf(text);
  assert.ok(inside.every(i => i >= box.bodyStart && i + entry.length <= box.end), JSON.stringify(inside));
  assert.ok(!inside.includes(text.indexOf(entry)), 'the copy above the heading is not in the inbox');
  assert.ok(!inside.includes(text.lastIndexOf(entry)), 'the copy under the next heading is not in the inbox');
  assert.strictEqual(inside.length, 2, 'the one with "  more" after it is a longer entry; the one mid-line is not at a line start');
});

test('S21 doc: findEntries answers nothing for an empty or non-string entry, no inbox, or a non-string text', () => {
  const entry = E(STAMP, 'a');
  assert.deepStrictEqual(d.findEntries(`## Inbox\n${entry}`, ''), []);
  assert.deepStrictEqual(d.findEntries(`## Inbox\n${entry}`, null), []);
  assert.deepStrictEqual(d.findEntries(`## Inbox\n${entry}`, 5), []);
  assert.deepStrictEqual(d.findEntries(`# T\n${entry}`, entry), []);
  assert.deepStrictEqual(d.findEntries(null, entry), []);
});

test('S21 doc: an entry that ends exactly at the end of the section is found; one that would run past it is not', () => {
  const entry = E(STAMP, 'a');
  const text = `## Inbox\n${entry}## Next\n`;
  assert.deepStrictEqual(d.findEntries(text, entry), [text.indexOf(entry)]);
  const spans = `## Inbox\n- ${STAMP} · a\n## Next\n  tail\n`;
  assert.deepStrictEqual(d.findEntries(spans, `- ${STAMP} · a\n## Next\n`), [], 'it would cross the heading');
});

test('S21 doc: findEntry takes the occurrence nearest to where it was put (ties go to the earlier), -1 when there is none', () => {
  const entry = E(STAMP, 'same');
  const text = `## Inbox\n${entry}- middle\n${entry}- other\n${entry}`;
  const at = d.findEntries(text, entry);
  assert.strictEqual(at.length, 3);
  assert.strictEqual(d.findEntry(text, entry, at[0]), at[0]);
  assert.strictEqual(d.findEntry(text, entry, at[1] + 1), at[1]);
  assert.strictEqual(d.findEntry(text, entry, at[2] + 1000), at[2]);
  assert.strictEqual(d.findEntry(text, entry), at[0], 'near defaults to the start');
  assert.strictEqual(d.findEntry(text, 'nope\n'), -1);
});

// ---- removeEntry -----------------------------------------------------------------------------------------------------------------

test('S21 doc: removeEntry refuses a record unless it has an entry string, a non-negative integer offset, and a lead and sep that are empty or a line break', () => {
  const entry = E(STAMP, 'a');
  const text = `## Inbox\n${entry}`;
  const good = { entry, offset: 9, lead: '', sep: '' };
  assert.strictEqual(d.removeEntry(text, good).ok, true);
  assert.strictEqual(d.removeEntry(text, { ...good, sep: undefined }).ok, true, 'sep may be absent');
  assert.strictEqual(d.removeEntry(text, { ...good, lead: '\r\n' }).ok, true);
  assert.strictEqual(d.removeEntry(text, { ...good, offset: 0 }).ok, true, 'offset 0 is a number');
  for (const bad of [
    null, undefined, 'x', 5, [], {},
    { ...good, entry: '' }, { ...good, entry: 5 }, { ...good, entry: undefined },
    { ...good, offset: -1 }, { ...good, offset: 1.5 }, { ...good, offset: '9' }, { ...good, offset: NaN }, { ...good, offset: undefined },
    { ...good, lead: 'x' }, { ...good, lead: ' ' }, { ...good, lead: undefined }, { ...good, lead: null },
    { ...good, sep: 'x' }, { ...good, sep: ' ' }, { ...good, sep: null },
  ]) {
    assert.deepStrictEqual(d.removeEntry(text, bad), { ok: false, reason: 'bad-record' }, JSON.stringify(bad));
  }
  assert.deepStrictEqual(d.removeEntry(text, { ...good, entry: E(STAMP, 'not there') }), { ok: false, reason: 'changed' });
  assert.deepStrictEqual(d.removeEntry(null, good), { ok: false, reason: 'changed' });
});

test('S21 doc: removeEntry takes the separating blank line out only while it still follows the entry, and the lead only at the very end of the file', () => {
  const entry = E(STAMP, 'a');
  // sep still follows: it goes too.
  const withSep = `## Inbox\n- x\n${entry}\n  ## indented\n`;
  const offset = withSep.indexOf(entry);
  assert.strictEqual(d.removeEntry(withSep, { entry, offset, lead: '', sep: '\n' }).text, '## Inbox\n- x\n  ## indented\n');
  // sep no longer follows (a later entry sits there): it stays.
  const later = `## Inbox\n${entry}- later\n`;
  assert.strictEqual(d.removeEntry(later, { entry, offset: 9, lead: '', sep: '\n' }).text, '## Inbox\n- later\n');
  // lead goes only when the entry is at the very end and the lead is right before it.
  const tail = `## Inbox\n- x\n${entry}`;
  assert.strictEqual(d.removeEntry(tail, { entry, offset: tail.indexOf(entry), lead: '\n', sep: '' }).text, '## Inbox\n- x');
  const notTail = `## Inbox\n- x\n${entry}- y\n`;
  assert.strictEqual(d.removeEntry(notTail, { entry, offset: notTail.indexOf(entry), lead: '\n', sep: '' }).text, '## Inbox\n- x\n- y\n', 'not at the end: the lead stays');
  const noLeadThere = `## Inbox\n${entry}`;
  assert.strictEqual(d.removeEntry(noLeadThere, { entry, offset: 9, lead: '\n', sep: '' }).text, '## Inbox', 'a lead that is right before an entry at the end of the file goes with it');
});
