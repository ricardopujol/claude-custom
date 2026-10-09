'use strict';
/**
 * The indexing assistant's doc writer (host/indexing-writer.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Revised
 * 2026-10-05 (evening)"). Temp fixture docs only: never the real documentation/ folder.
 *   - a note goes into the backlog's `## Inbox` (created after the status block when missing), safely: re-read just
 *     before, temp file + rename, never truncated; a backlog edited in between makes it start over once, then give up
 *   - a project with no backlog file gets none: nothing is created
 *   - Undo removes exactly the entry, or refuses
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const w = require('../host/indexing-writer');

const BACKLOG = '# P — Backlog\n\n**Status:** fine\n\n## 1. First\nbody\n';
const STAMP = '2026-10-05 09:07';

const makeGit = (dir) => { fs.mkdirSync(path.join(dir, '.git')); fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n'); };

function project({ backlog = BACKLOG, buildLog = true, name = 'PROJ', git = true } = {}) {
  const dev = tmpDir('cc-iw-');
  const docs = path.join(dev, 'documentation');
  fs.mkdirSync(docs);
  if (git) makeGit(dev);
  if (buildLog) fs.writeFileSync(path.join(docs, `${name}_BUILD_LOG.md`), '# log\n');
  if (backlog !== null) fs.writeFileSync(path.join(docs, `${name}_BACKLOG.md`), backlog);
  return { root: dev, dev, docs };
}
const read = (f) => fs.readFileSync(f, 'utf8');
const tempsIn = (dir) => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
const WITH_INBOX = (entries) => BACKLOG.replace('## 1. First', `## Inbox\n${entries}\n## 1. First`);

// --- where the docs are ----------------------------------------------------------------------------------------------

test('docsOf: <dev>\\documentation, the name from the one *_BUILD_LOG.md', () => {
  const p = project({ name: 'LYDIA' });
  assert.deepStrictEqual(w.docsOf(p), { ok: true, dir: p.docs, name: 'LYDIA', title: path.basename(p.dev), backlog: path.join(p.docs, 'LYDIA_BACKLOG.md'), canCreate: true });
});

test('docsOf: no build log falls back to the project folder\'s name, upper case, separators removed (sync-docs\' rule)', () => {
  const dev = path.join(tmpDir('cc-iw-'), 'my-proj_x');
  fs.mkdirSync(path.join(dev, 'documentation'), { recursive: true });
  assert.strictEqual(w.docsOf({ root: dev, dev }).name, 'MYPROJX');
});

test('docsOf: no project folder, or two build logs, says so', () => {
  const dev = path.join(tmpDir('cc-iw-'), 'missing');
  assert.deepStrictEqual(w.docsOf({ root: dev, dev }), { ok: false, reason: 'no-docs' });
  const p = project();
  fs.writeFileSync(path.join(p.docs, 'OTHER_BUILD_LOG.md'), '');
  assert.deepStrictEqual(w.docsOf(p), { ok: false, reason: 'many-build-logs' });
  assert.deepStrictEqual(w.docsOf(null), { ok: false, reason: 'no-docs' });
});

// --- filing ----------------------------------------------------------------------------------------------------------

test('the first note creates the inbox after the status block, with the note verbatim; no temp file is left', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'tabs should "glow"' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.where, { file: docs.backlog });
  assert.strictEqual(read(docs.backlog), WITH_INBOX('- 2026-10-05 09:07 · tabs should "glow"\n'));
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('the next note goes after the last one', () => {
  const p = project({ backlog: WITH_INBOX('- 2026-10-05 09:00 · one\n') });
  const docs = w.docsOf(p);
  w.fileNote({ docs, stamp: STAMP, text: 'two' });
  assert.strictEqual(read(docs.backlog), WITH_INBOX('- 2026-10-05 09:00 · one\n- 2026-10-05 09:07 · two\n'));
});

test('a CRLF backlog stays CRLF, and a multi-line note is indented', () => {
  const p = project({ backlog: BACKLOG.replace(/\n/g, '\r\n') });
  const docs = w.docsOf(p);
  w.fileNote({ docs, stamp: STAMP, text: 'a\n## 9. b' });
  const text = read(docs.backlog);
  assert.ok(!/[^\r]\n/.test(text), 'no bare LF');
  assert.ok(text.includes('- 2026-10-05 09:07 · a\r\n  ## 9. b\r\n'));
});

test('undoNote removes exactly the entry; the inbox heading stays', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'note' });
  assert.deepStrictEqual(w.undoNote(docs.backlog, r.record), { ok: true });
  assert.strictEqual(read(docs.backlog), WITH_INBOX(''));
});

test('undoNote still works after a session edited the backlog elsewhere, and keeps that edit', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'note' });
  fs.writeFileSync(docs.backlog, read(docs.backlog).replace('fine', 'fine, edited') + '## 2. New\n');
  assert.deepStrictEqual(w.undoNote(docs.backlog, r.record), { ok: true });
  assert.strictEqual(read(docs.backlog), WITH_INBOX('').replace('fine', 'fine, edited') + '## 2. New\n');
});

test('undoNote refuses an entry that was edited or filed away, and removes nothing', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'note' });
  const edited = read(docs.backlog).replace('· note', '· note, edited');
  fs.writeFileSync(docs.backlog, edited);
  assert.deepStrictEqual(w.undoNote(docs.backlog, r.record), { ok: false, reason: 'changed' });
  assert.strictEqual(read(docs.backlog), edited);
});

test('findNote: an entry already in the inbox is found with the record Undo needs; one that isn\'t, isn\'t', () => {
  const p = project();
  const docs = w.docsOf(p);
  assert.deepStrictEqual(w.findNote({ docs, stamp: STAMP, text: 'note' }), { ok: true, record: null });
  w.fileNote({ docs, stamp: STAMP, text: 'note' });
  const f = w.findNote({ docs, stamp: STAMP, text: 'note' });
  assert.strictEqual(f.ok, true);
  assert.deepStrictEqual(w.undoNote(docs.backlog, f.record), { ok: true });
  assert.strictEqual(read(docs.backlog), WITH_INBOX(''));
  assert.deepStrictEqual(w.findNote({ docs: w.docsOf(project({ backlog: null })), stamp: STAMP, text: 'x' }), { ok: false, reason: 'no-backlog' });
});

test('fileNote without a backlog file: findNote still says no-backlog (a look never creates)', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  assert.deepStrictEqual(w.findNote({ docs, stamp: STAMP, text: 'x' }), { ok: false, reason: 'no-backlog' });
  assert.strictEqual(fs.existsSync(docs.backlog), false);
});

// --- #79: a note to a project with no backlog creates it, then files -------------------------------------------------

const CREATED = (title, entries) => `# ${title} — Feature & Bug Backlog\n\n## Inbox\n${entries}`;

test('#79: no backlog file: it is created with a title and an Inbox, and the note filed; no temp file is left', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'first idea' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result, 'created-backlog');
  assert.deepStrictEqual(r.where, { file: docs.backlog });
  assert.strictEqual(read(docs.backlog), CREATED(docs.title, '- 2026-10-05 09:07 · first idea\n'));
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

// --- #79 (Dexter F2/F3, Miguel 4, PR #138): where a backlog may be created, and which name it gets ----------------------

test('#79: a git root with no documentation folder is "no-docs", and none is made', () => {
  const dev = tmpDir('cc-iw-');
  makeGit(dev);
  assert.deepStrictEqual(w.docsOf({ root: dev, dev }), { ok: false, reason: 'no-docs' });
  assert.strictEqual(fs.existsSync(path.join(dev, 'documentation')), false);
});

test('#79: a home-like folder (no git, no documentation) is "no-docs", and nothing is made in it', () => {
  const dev = tmpDir('cc-iw-');
  assert.deepStrictEqual(w.docsOf({ root: dev, dev }), { ok: false, reason: 'no-docs' });
  assert.deepStrictEqual(fs.readdirSync(dev), []);
});

test('#79: a drive root is "no-docs"', () => {
  const root = path.parse(tmpDir('cc-iw-')).root;
  if (fs.existsSync(path.join(root, 'documentation'))) return;       // someone's real folder: not ours to test
  assert.deepStrictEqual(w.docsOf({ root, dev: root }), { ok: false, reason: 'no-docs' });
});

test('#79: a folder with a documentation folder but no git root can be read, never created into', () => {
  const p = project({ backlog: null, git: false });
  const docs = w.docsOf(p);
  assert.strictEqual(docs.ok, true);
  assert.strictEqual(docs.canCreate, false);
  assert.deepStrictEqual(w.fileNote({ docs, stamp: STAMP, text: 'x' }), { ok: false, reason: 'no-backlog' });
  assert.strictEqual(fs.existsSync(docs.backlog), false);
  assert.deepStrictEqual(w.ensureBacklog(docs), { ok: false, reason: 'no-backlog' });
});

test('#79: a linked worktree files into the main checkout\'s documentation, as sync-docs does', () => {
  const main = project({ backlog: null });
  const wt = tmpDir('cc-iw-');
  fs.mkdirSync(path.join(main.dev, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main.dev, '.git', 'worktrees', 'wt').replace(/\\/g, '/')}\n`);
  fs.mkdirSync(path.join(wt, 'documentation'));                      // tracked docs only (a README): no build log
  const docs = w.docsOf({ root: wt, dev: wt });
  assert.strictEqual(docs.dir, main.docs);
  assert.strictEqual(w.fileNote({ docs, stamp: STAMP, text: 'from a worktree' }).result, 'created-backlog');
  assert.ok(read(path.join(main.docs, 'PROJ_BACKLOG.md')).includes('· from a worktree'));
  assert.deepStrictEqual(fs.readdirSync(path.join(wt, 'documentation')), []);
});

test('#79: a worktree with a build log of its own keeps its own documentation', () => {
  const main = project();
  const wt = tmpDir('cc-iw-');
  fs.mkdirSync(path.join(main.dev, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main.dev, '.git', 'worktrees', 'wt')}\n`);
  fs.mkdirSync(path.join(wt, 'documentation'));
  fs.writeFileSync(path.join(wt, 'documentation', 'WT_BUILD_LOG.md'), '');
  assert.strictEqual(w.docsOf({ root: wt, dev: wt }).dir, path.join(wt, 'documentation'));
});

test('#79: never a second backlog: a build log LYDIA_BUILD_LOG.md beside BACKLOG.md files into BACKLOG.md', () => {
  const p = project({ name: 'LYDIA', backlog: null });
  fs.writeFileSync(path.join(p.docs, 'BACKLOG.md'), BACKLOG);
  const docs = w.docsOf(p);
  assert.strictEqual(docs.backlog, path.join(p.docs, 'BACKLOG.md'));
  const r = w.fileNote({ docs, stamp: STAMP, text: 'x' });
  assert.strictEqual(r.result, undefined);
  assert.deepStrictEqual(fs.readdirSync(p.docs).sort(), ['BACKLOG.md', 'LYDIA_BUILD_LOG.md']);
});

test('#79: a single backlog with another stem is the backlog; several, none of them <NAME>_BACKLOG.md, are ambiguous; one of them named so wins', () => {
  const p = project({ name: 'LYDIA', backlog: null });
  fs.writeFileSync(path.join(p.docs, 'OLD_BACKLOG.md'), BACKLOG);
  assert.strictEqual(w.docsOf(p).backlog, path.join(p.docs, 'OLD_BACKLOG.md'));
  fs.writeFileSync(path.join(p.docs, 'BACKLOG.md'), BACKLOG);
  assert.deepStrictEqual(w.docsOf(p), { ok: false, reason: 'no-backlog-ambiguous' });
  fs.writeFileSync(path.join(p.docs, 'LYDIA_BACKLOG.md'), BACKLOG);
  assert.strictEqual(w.docsOf(p).backlog, path.join(p.docs, 'LYDIA_BACKLOG.md'));
});

test('#79: the name follows Get-DocsName: a dev folder is named after its container; ß stays ß (ToUpperInvariant)', () => {
  const container = path.join(tmpDir('cc-iw-'), 'my-straße_x');
  const dev = path.join(container, 'dev');
  fs.mkdirSync(path.join(dev, 'documentation'), { recursive: true });
  makeGit(dev);
  const docs = w.docsOf({ root: container, dev });
  assert.strictEqual(docs.name, 'MYSTRAßEX');
  assert.strictEqual(docs.title, 'my-straße_x');
  assert.strictEqual(path.basename(docs.backlog), 'MYSTRAßEX_BACKLOG.md');
  // and the name it would derive once the build log named by that rule exists is the same one
  fs.writeFileSync(path.join(docs.dir, 'MYSTRAßEX_BUILD_LOG.md'), '');
  assert.strictEqual(path.basename(w.docsOf({ root: container, dev }).backlog), 'MYSTRAßEX_BACKLOG.md');
});

// --- #79: creating without hard links never replaces (Dexter F5, Miguel 3) ----------------------------------------------

const noLinks = (code) => () => { throw Object.assign(new Error(code), { code }); };

test('#79: where hard links are not supported the backlog is created exclusively', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'x', link: noLinks('EPERM') });
  assert.strictEqual(r.result, 'created-backlog');
  assert.strictEqual(read(docs.backlog), CREATED(docs.title, '- 2026-10-05 09:07 · x\n'));
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('#79: no hard links, and a session\'s backlog appears first: it is kept, byte for byte (Dexter F5)', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  const theirs = '# theirs\n\n## Inbox\n- old\n';
  const r = w.fileNote({ docs, stamp: STAMP, text: 'mine', link: noLinks('EPERM'), beforeCreate: () => fs.writeFileSync(docs.backlog, theirs) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result, undefined, 'it did not create the file');
  assert.strictEqual(read(docs.backlog), theirs.replace('- old\n', '- old\n- 2026-10-05 09:07 · mine\n'));
});

test('#79: a link failure that is not "no hard links" (EACCES) is write-failed: nothing is written another way (Miguel 3)', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  assert.deepStrictEqual(w.fileNote({ docs, stamp: STAMP, text: 'x', link: noLinks('EACCES') }), { ok: false, reason: 'write-failed' });
  assert.strictEqual(fs.existsSync(docs.backlog), false);
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

// --- #79: Undo's delete moves the file aside first (Dexter F6, Miguel 2) -----------------------------------------------

test('#79: an edit that lands as Undo deletes is kept: the file is put back and only the entry is taken out', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'only' });
  const done = w.undoNote(docs.backlog, r.record, { beforeDelete: () => fs.appendFileSync(docs.backlog, '\n## 1. A session\'s edit\n') });
  assert.deepStrictEqual(done, { ok: true });
  assert.ok(fs.existsSync(docs.backlog));
  assert.ok(read(docs.backlog).includes('## 1. A session\'s edit'));
  assert.ok(!read(docs.backlog).includes('· only'));
  assert.deepStrictEqual(fs.readdirSync(p.docs).filter(f => f.endsWith('.undo')), []);
});

test('#79: the file edited after the first check but before it is moved aside is checked again on the moved copy', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'only' });
  let first = true;
  const readFile = (f, enc) => { const t = fs.readFileSync(f, enc); if (first) { first = false; fs.appendFileSync(docs.backlog, 'late edit\n'); } return t; };
  const done = w.undoNote(docs.backlog, r.record, { readFile });
  assert.deepStrictEqual(done, { ok: true });
  assert.ok(read(docs.backlog).includes('late edit'), 'the late edit survived');
});

test('#79: an unlink that fails is write-failed and the file is back as it was', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'only' });
  const before = read(docs.backlog);
  const done = w.undoNote(docs.backlog, r.record, { unlink: () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } });
  assert.deepStrictEqual(done, { ok: false, reason: 'write-failed' });
  assert.strictEqual(read(docs.backlog), before);
  assert.deepStrictEqual(fs.readdirSync(p.docs).filter(f => f.endsWith('.undo')), []);
});

test('#79: a project folder that does not exist gets nothing made', () => {
  const dev = path.join(tmpDir('cc-iw-'), 'nope');
  assert.deepStrictEqual(w.docsOf({ root: dev, dev }), { ok: false, reason: 'no-docs' });
  assert.strictEqual(fs.existsSync(dev), false);
});

test('#79: the next note finds the backlog and just files (one file, one title)', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  const a = w.fileNote({ docs, stamp: STAMP, text: 'one' });
  const b = w.fileNote({ docs, stamp: STAMP, text: 'two' });
  assert.strictEqual(a.result, 'created-backlog');
  assert.strictEqual(b.result, undefined);
  assert.strictEqual(read(docs.backlog), CREATED(docs.title, '- 2026-10-05 09:07 · one\n- 2026-10-05 09:07 · two\n'));
});

test('#79: two notes at once create one file: the one that lost the race files into the winner\'s, which is not replaced', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  const winner = (file) => fs.writeFileSync(file, CREATED(docs.title, '- 2026-10-05 09:00 · theirs\n'));
  const r = w.fileNote({ docs, stamp: STAMP, text: 'mine', beforeCreate: () => winner(docs.backlog) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result, undefined, 'it did not create the file');
  assert.strictEqual(read(docs.backlog), CREATED(docs.title, '- 2026-10-05 09:00 · theirs\n- 2026-10-05 09:07 · mine\n'));
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('#79: a creation that cannot be written is "write-failed" and leaves nothing behind', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'x', beforeCreate: () => { throw new Error('disk'); } });
  assert.deepStrictEqual(r, { ok: false, reason: 'write-failed' });
  assert.strictEqual(fs.existsSync(docs.backlog), false);
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('#79: Undo of the only entry removes the file it created', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'only' });
  assert.deepStrictEqual(w.undoNote(docs.backlog, r.record), { ok: true });
  assert.strictEqual(fs.existsSync(docs.backlog), false);
});

test('#79: Undo leaves the file when anything else is in it (another note, or an edit)', () => {
  const p = project({ backlog: null });
  const docs = w.docsOf(p);
  const a = w.fileNote({ docs, stamp: STAMP, text: 'one' });
  w.fileNote({ docs, stamp: STAMP, text: 'two' });
  assert.deepStrictEqual(w.undoNote(docs.backlog, a.record), { ok: true });
  assert.strictEqual(read(docs.backlog), CREATED(docs.title, '- 2026-10-05 09:07 · two\n'));

  const q = project({ backlog: null });
  const d2 = w.docsOf(q);
  const b = w.fileNote({ docs: d2, stamp: STAMP, text: 'solo' });
  fs.appendFileSync(d2.backlog, '\n## 1. Added by a session\n');
  assert.deepStrictEqual(w.undoNote(d2.backlog, b.record), { ok: true });
  assert.ok(fs.existsSync(d2.backlog));
  assert.ok(read(d2.backlog).includes('## 1. Added by a session'));
});

test('#79: Undo never deletes a backlog it did not create (an existing one emptied back to its start stays)', () => {
  const p = project({ backlog: '# P\n\n## Inbox\n' });
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'n' });
  assert.strictEqual(r.result, undefined);
  assert.deepStrictEqual(w.undoNote(docs.backlog, r.record), { ok: true });
  assert.strictEqual(read(docs.backlog), '# P\n\n## Inbox\n');
});

test('an empty note is refused', () => {
  const docs = w.docsOf(project());
  assert.deepStrictEqual(w.fileNote({ docs, stamp: STAMP, text: '  \n ' }), { ok: false, reason: 'empty' });
});

// --- concurrent writers ----------------------------------------------------------------------------------------------

test('the backlog changed between the read and the rename: it starts over once and the other writer\'s edit is kept', () => {
  const p = project();
  const docs = w.docsOf(p);
  let calls = 0;
  const beforeRename = () => { if (calls++ === 0) fs.appendFileSync(docs.backlog, '## 2. A session wrote this\n'); };
  const r = w.fileNote({ docs, stamp: STAMP, text: 'mine', beforeRename });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls, 2);
  const text = read(docs.backlog);
  assert.ok(text.includes('## 2. A session wrote this'));
  assert.ok(text.includes('· mine'));
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('it changed again on the second try: nothing is written and it says conflict', () => {
  const p = project();
  const docs = w.docsOf(p);
  let k = 0;
  const beforeRename = () => fs.appendFileSync(docs.backlog, `edit ${k++}\n`);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'x', beforeRename });
  assert.deepStrictEqual(r, { ok: false, reason: 'conflict' });
  assert.strictEqual(read(docs.backlog), BACKLOG + 'edit 0\nedit 1\n', 'only the other writer\'s edits');
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('the backlog is re-checked before EVERY rename retry: a session\'s edit during the backoff is never replaced (Dexter F5, PR #121)', () => {
  const p = project();
  const docs = w.docsOf(p);
  let throws = 0;
  const rename = (from, to) => {
    if (throws === 0) {
      throws += 1;
      // The rename is refused (the scanner, or the session's own writer holding the file)...
      // ...and meanwhile the session's write lands.
      fs.writeFileSync(docs.backlog, BACKLOG + '## 2. Written during the backoff\n');
      const e = new Error('EPERM'); e.code = 'EPERM'; throw e;
    }
    fs.renameSync(from, to);
  };
  const r = w.fileNote({ docs, stamp: STAMP, text: 'mine', rename, sleep: () => {} });
  const text = read(docs.backlog);
  assert.ok(text.includes('## 2. Written during the backoff'), 'the session\'s edit survives');
  if (r.ok) assert.ok(text.includes('· mine'), 'filed on the fresh text');
  else assert.strictEqual(r.reason, 'conflict');
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('a rename refused twice in a row is retried, still re-checked each time, then lands', () => {
  const p = project();
  const docs = w.docsOf(p);
  let n = 0;
  const rename = (from, to) => { if (n++ < 2) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } fs.renameSync(from, to); };
  const r = w.fileNote({ docs, stamp: STAMP, text: 'mine', rename, sleep: () => {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(n, 3);
  assert.ok(read(docs.backlog).includes('· mine'));
});

test('a read refused for a moment (EBUSY) is retried, not taken for a missing or changed backlog (Dexter F8, PR #121)', () => {
  const p = project();
  const docs = w.docsOf(p);
  const r = w.fileNote({ docs, stamp: STAMP, text: 'note' });
  let n = 0;
  const readFile = (f, enc) => { if (n++ === 0) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } return fs.readFileSync(f, enc); };
  assert.deepStrictEqual(w.undoNote(docs.backlog, r.record, { readFile, sleep: () => {} }), { ok: true });
  assert.strictEqual(read(docs.backlog), WITH_INBOX(''));
});

test('a backlog that stays busy is "busy": never "no-backlog" (nothing created) and never "changed"', () => {
  const p = project();
  const docs = w.docsOf(p);
  const filed = w.fileNote({ docs, stamp: STAMP, text: 'note' });
  const readFile = () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; };
  assert.deepStrictEqual(w.fileNote({ docs, stamp: STAMP, text: 'x', readFile, sleep: () => {} }), { ok: false, reason: 'busy' });
  assert.deepStrictEqual(w.undoNote(docs.backlog, filed.record, { readFile, sleep: () => {} }), { ok: false, reason: 'busy' });
  assert.deepStrictEqual(w.findNote({ docs, stamp: STAMP, text: 'note', readFile, sleep: () => {} }), { ok: false, reason: 'busy' });
});

test('a write that fails leaves the backlog as it was and no temp file behind', () => {
  const p = project();
  const docs = w.docsOf(p);
  const rename = () => { const e = new Error('disk says no'); e.code = 'ENOSPC'; throw e; };
  const r = w.fileNote({ docs, stamp: STAMP, text: 'x', rename });
  assert.deepStrictEqual(r, { ok: false, reason: 'write-failed' });
  assert.strictEqual(read(docs.backlog), BACKLOG);
  assert.deepStrictEqual(tempsIn(p.docs), []);
});

test('a read that fails for any reason but ENOENT (EMFILE, EIO) is "busy", retried later: never "no-backlog" or "changed" (Dexter F4, PR #121)', () => {
  const p = project();
  const docs = w.docsOf(p);
  const filed = w.fileNote({ docs, stamp: STAMP, text: 'note' });
  for (const code of ['EMFILE', 'EIO', 'UNKNOWN']) {
    const readFile = () => { const e = new Error(code); e.code = code; throw e; };
    assert.deepStrictEqual(w.fileNote({ docs, stamp: STAMP, text: 'x', readFile, sleep: () => {} }), { ok: false, reason: 'busy' }, code);
    assert.deepStrictEqual(w.undoNote(docs.backlog, filed.record, { readFile, sleep: () => {} }), { ok: false, reason: 'busy' }, code);
    assert.deepStrictEqual(w.findNote({ docs, stamp: STAMP, text: 'note', readFile, sleep: () => {} }), { ok: false, reason: 'busy' }, code);
  }
  const gone = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  assert.deepStrictEqual(w.fileNote({ docs, stamp: STAMP, text: 'x', readFile: gone, sleep: () => {} }), { ok: false, reason: 'no-backlog' });
});
