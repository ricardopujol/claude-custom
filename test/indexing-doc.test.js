'use strict';
/**
 * The indexing assistant's inbox (host/indexing-doc.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Revised 2026-10-05
 * (evening)"): a note becomes one `- YYYY-MM-DD HH:MM · <verbatim>` entry at the end of the backlog's `## Inbox`
 * section, which is created right after the status block when it's missing; continuation lines are indented two
 * spaces; Undo removes exactly that entry while it's still in the inbox unchanged. Pure: strings in, strings out.
 */
const test = require('node:test');
const assert = require('node:assert');

const d = require('../host/indexing-doc');

const BACKLOG = [
  '# proj — Backlog',
  '',
  'Intro line.',
  '',
  '**Status (2026-09-29):**',
  '- merged: a',
  '',
  '## Suggested groupings',
  '- x',
  '',
  '## 1. First',
  'body',
  '',
].join('\n');

// --- the entry -------------------------------------------------------------------------------------------------------

test('stampOf: local YYYY-MM-DD HH:MM', () => {
  assert.strictEqual(d.stampOf(new Date(2026, 9, 5, 9, 7).getTime()), '2026-10-05 09:07');
  assert.strictEqual(d.stampOf(new Date(2026, 0, 1, 23, 59).getTime()), '2026-01-01 23:59');
});

test('entryText: "- STAMP · text", the note verbatim, the whole note trimmed', () => {
  assert.strictEqual(d.entryText('2026-10-05 09:07', '  tabs should "glow" **now**  ', '\n'), '- 2026-10-05 09:07 · tabs should "glow" **now**\n');
});

test('entryText: continuation lines are indented two spaces (a blank one too), in the file\'s line break', () => {
  assert.strictEqual(d.entryText('S', 'one\ntwo\r\n\nthree', '\r\n'), '- S · one\r\n  two\r\n  \r\n  three\r\n');
});

test('entryText: a lone \\r is a line break too, so no line can start at column 0', () => {
  assert.strictEqual(d.entryText('S', 'a\rb', '\n'), '- S · a\n  b\n');
});

test('newlineOf: the file\'s FIRST line break decides (add-history.ps1\'s rule); none is LF', () => {
  assert.strictEqual(d.newlineOf('a\r\nb\nc'), '\r\n');
  assert.strictEqual(d.newlineOf('a\nb\r\nc'), '\n');
  assert.strictEqual(d.newlineOf('abc'), '\n');
});

// --- the section -----------------------------------------------------------------------------------------------------

test('ensureInbox: a missing inbox is created right after the status block, before the first ## heading', () => {
  const r = d.ensureInbox(BACKLOG);
  assert.strictEqual(r.added, true);
  assert.ok(r.text.includes('- merged: a\n\n## Inbox\n\n## Suggested groupings'), JSON.stringify(r.text));
  assert.strictEqual(r.text.replace('## Inbox\n\n', ''), BACKLOG, 'nothing else changes');
});

test('ensureInbox: an inbox already there is left alone', () => {
  const t = BACKLOG.replace('## Suggested', '## Inbox\n- old\n\n## Suggested');
  assert.deepStrictEqual(d.ensureInbox(t), { text: t, added: false });
});

test('ensureInbox: no ## heading at all puts it at the end; a file with no final newline gets one first', () => {
  assert.strictEqual(d.ensureInbox('# T\nbody').text, '# T\nbody\n\n## Inbox\n');
  assert.strictEqual(d.ensureInbox('# T\n\n').text, '# T\n\n## Inbox\n');
  assert.strictEqual(d.ensureInbox('').text, '## Inbox\n');
});

test('ensureInbox: a line before the first ## heading that is not blank gets a blank line after the inbox too', () => {
  assert.strictEqual(d.ensureInbox('# T\ntext\n## A\n').text, '# T\ntext\n\n## Inbox\n\n## A\n');
});

test('ensureInbox: a ## heading inside a fence is not the first heading', () => {
  const t = '# T\n```\n## not a heading\n```\n## A\n';
  assert.strictEqual(d.ensureInbox(t).text, '# T\n```\n## not a heading\n```\n\n## Inbox\n\n## A\n');
});

test('ensureInbox: a fence never closed would swallow an inbox put after it, so the inbox goes before it', () => {
  assert.strictEqual(d.ensureInbox('# T\nbody\n```\ncode').text, '# T\nbody\n\n## Inbox\n\n```\ncode');
  assert.strictEqual(d.ensureInbox('```').text, '## Inbox\n\n```');
  const t = d.ensureInbox('# T\n~~~\n').text;
  assert.strictEqual(d.inboxOf(t).found, true);
});

test('ensureInbox: a heading with up to three leading spaces counts (Dexter F6b); four is not a heading', () => {
  assert.strictEqual(d.ensureInbox('# T\n   ## A\n').text, '# T\n\n## Inbox\n\n   ## A\n');
  assert.strictEqual(d.ensureInbox('# T\n    ## not\n').text, '# T\n    ## not\n\n## Inbox\n');
});

test('ensureInbox: "## Inbox" is found with any case and leading spaces up to three, outside fences only', () => {
  assert.strictEqual(d.ensureInbox('# T\n  ## inbox\n').added, false);
  assert.strictEqual(d.ensureInbox('# T\n```\n## Inbox\n```\n').added, true);
});

// --- appending -------------------------------------------------------------------------------------------------------

test('planAppend: the entry goes after the inbox\'s last non-blank line, so entries stay in typed order', () => {
  const t = '# T\n\n## Inbox\n- 1\n- 2\n\n## A\n';
  const p = d.planAppend(t, '- 3\n');
  assert.deepStrictEqual(p, { ok: true, offset: t.indexOf('- 2\n') + 4, inserted: '- 3\n' });
  assert.strictEqual(d.applyInsert(t, p), '# T\n\n## Inbox\n- 1\n- 2\n- 3\n\n## A\n');
});

test('planAppend: an empty inbox gets its first entry under the heading', () => {
  const t = '# T\n\n## Inbox\n\n## A\n';
  assert.strictEqual(d.applyInsert(t, d.planAppend(t, '- 1\n')), '# T\n\n## Inbox\n- 1\n\n## A\n');
});

test('planAppend: an inbox at the end of a file with no final newline', () => {
  const t = '## Inbox\n- 1';
  const p = d.planAppend(t, '- 2\n');
  assert.deepStrictEqual(p, { ok: true, offset: t.length, inserted: '\n- 2\n' });
});

test('planAppend: a previous note\'s continuation lines (even "  ## x" or a fence) stay inside the inbox', () => {
  const t = '## Inbox\n- S · a\n  ## 9. forged\n  ```\n- S · b\n\n## A\n';
  assert.strictEqual(d.applyInsert(t, d.planAppend(t, '- c\n')), '## Inbox\n- S · a\n  ## 9. forged\n  ```\n- S · b\n- c\n\n## A\n');
});

test('planAppend: a line after the inbox that starts with two spaces (an indented heading) is never read as the new entry\'s continuation', () => {
  const t = '## Inbox\n   ## A\n';
  const entry = '- S · n\n';
  const p = d.planAppend(t, entry);
  assert.deepStrictEqual(p, { ok: true, offset: 9, inserted: '- S · n\n\n' });
  const after = d.applyInsert(t, p);
  assert.strictEqual(d.inboxOf(after).end, after.indexOf('   ## A'), 'the heading still ends the inbox');
  assert.deepStrictEqual(d.removeEntry(after, d.recordOf(p, entry)), { ok: true, text: t });
});

test('planAppend: a fence still open at the end of the inbox: the entry goes before it, never inside it', () => {
  const t = '## Inbox\n- 1\n\n~~~\ncode';
  const p = d.planAppend(t, '- 2\n');
  assert.strictEqual(d.applyInsert(t, p), '## Inbox\n- 1\n- 2\n\n~~~\ncode');
  assert.strictEqual(d.applyInsert('## Inbox\n\n```', d.planAppend('## Inbox\n\n```', '- 1\n')), '## Inbox\n- 1\n\n```');
});

test('planAppend: no inbox is refused (ensureInbox comes first)', () => {
  assert.deepStrictEqual(d.planAppend('# T\n', '- x\n'), { ok: false, reason: 'no-inbox' });
});

// --- undo ------------------------------------------------------------------------------------------------------------

test('removeEntry: the entry comes out exactly; the inbox heading it may have created stays', () => {
  const base = d.ensureInbox(BACKLOG).text;
  const entry = d.entryText('S', 'note', '\n');
  const p = d.planAppend(base, entry);
  const filed = d.applyInsert(base, p);
  assert.deepStrictEqual(d.removeEntry(filed, d.recordOf(p, entry)), { ok: true, text: base });
});

test('removeEntry: edits elsewhere in the backlog (above or below the inbox) don\'t block it, and are kept', () => {
  const base = d.ensureInbox(BACKLOG).text;
  const entry = d.entryText('S', 'note', '\n');
  const p = d.planAppend(base, entry);
  const edited = d.applyInsert(base, p).replace('Intro line.', 'Intro line, edited by a session.') + '## 2. New\n';
  const r = d.removeEntry(edited, d.recordOf(p, entry));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, base.replace('Intro line.', 'Intro line, edited by a session.') + '## 2. New\n');
});

test('removeEntry: an entry that was edited, moved out of the inbox, or filed away is refused, nothing removed', () => {
  const base = '## Inbox\n\n## A\n';
  const entry = d.entryText('S', 'note', '\n');
  const p = d.planAppend(base, entry);
  const rec = d.recordOf(p, entry);
  const filed = d.applyInsert(base, p);
  assert.deepStrictEqual(d.removeEntry(filed.replace('· note', '· note!'), rec), { ok: false, reason: 'changed' });
  assert.deepStrictEqual(d.removeEntry(base + entry, rec), { ok: false, reason: 'changed' }, 'below ## A is outside the inbox');
  assert.deepStrictEqual(d.removeEntry(base, rec), { ok: false, reason: 'changed' });
});

test('removeEntry: only a whole entry at a line start counts (a longer entry that starts the same is not it)', () => {
  const entry = '- S · note\n';
  const t = '## Inbox\n- S · note and more\n';
  assert.deepStrictEqual(d.removeEntry(t, { entry, offset: 9, lead: '' }), { ok: false, reason: 'changed' });
  const t2 = '## Inbox\nx- S · note\n';
  assert.deepStrictEqual(d.removeEntry(t2, { entry, offset: 10, lead: '' }), { ok: false, reason: 'changed' });
});

test('removeEntry: two identical entries (the same note in the same minute) take the one nearest where it was put', () => {
  const t = '## Inbox\n- S · same\n- S · other\n- S · same\n';
  const r = d.removeEntry(t, { entry: '- S · same\n', offset: t.lastIndexOf('- S · same'), lead: '' });
  assert.strictEqual(r.text, '## Inbox\n- S · same\n- S · other\n');
});

test('removeEntry: the line break added in front of an entry at an unterminated end goes back out with it', () => {
  const t = '## Inbox\n- 1';
  const entry = '- 2\n';
  const p = d.planAppend(t, entry);
  assert.deepStrictEqual(d.removeEntry(d.applyInsert(t, p), d.recordOf(p, entry)), { ok: true, text: t });
});

test('removeEntry: a record that is not one is refused', () => {
  for (const bad of [null, {}, { entry: '', offset: 0, lead: '' }, { entry: 'x', offset: -1, lead: '' }, { entry: 'x', offset: 1.5, lead: '' }, { entry: 'x', offset: 0, lead: 'y' }]) {
    assert.deepStrictEqual(d.removeEntry('## Inbox\nx', bad), { ok: false, reason: 'bad-record' }, JSON.stringify(bad));
  }
});
