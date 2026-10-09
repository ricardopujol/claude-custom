'use strict';
/**
 * #50: edit mode in the code reader. The reader runs against stub elements, a requester the test answers by hand
 * and a fake CodeMirror handle, so every behaviour is pinned without a window: the Edit toggle, the unsaved dot,
 * Ctrl+S, the stale check before a save, the three conflict actions, and the guards on leaving with unsaved text.
 */
const test = require('node:test');
const assert = require('node:assert');

globalThis.addEventListener = globalThis.addEventListener || (() => {});

class El {
  constructor(id) {
    this.id = id; this.hidden = false; this.textContent = ''; this.title = ''; this.style = {}; this.dataset = {};
    this.children = []; this.className = ''; this.disabled = false; this.attrs = {}; this.handlers = {};
  }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getBoundingClientRect() { return { left: 0, right: 0, width: 0, top: 0, bottom: 0 }; }
  replaceChildren(...c) { this.children = c; }
  append(...c) { this.children.push(...c); }
  querySelector() { return null; }
  setPointerCapture() {}
  focus() {}
  get classList() { return { add() {}, remove() {}, toggle() {}, contains: () => false }; }
  // fire this element's listeners, as the browser would; returns the event
  fire(type, init = {}) {
    const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const fn of this.handlers[type] || []) fn(e);
    return e;
  }
  click() { if (!this.disabled && !this.hidden) this.fire('click'); }
  dispatchEvent(e) { return this.fire(e.type, e); }
}
function fakeDoc() {
  const els = new Map();
  const doc = {
    getElementById: (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); },
    createElement: (tag) => new El(tag),
    head: new El('head'), body: new El('body'), querySelector: () => null,
  };
  for (const id of ['reader', 'reader-split', 'reader-bar', 'reader-note', 'reader-conflict', 'reader-compare', 'reader-dirty']) doc.getElementById(id).hidden = true;
  return { doc, el: (id) => doc.getElementById(id) };
}

// A fake CodeMirror whose editors the test can type into.
function fakeCodeMirror() {
  const made = [];
  return {
    made,
    create(parent, opts) {
      const ed = {
        txt: '', editableNow: false, history: 0,
        show({ text }) { this.txt = text; },
        text() { return this.txt; },
        lines() { return this.txt.split('\n').length; },
        selection: () => ({ fromLine: 1, toLine: 1, empty: true, toCol0: false }),
        setEditable(on) { this.editableNow = on === true; },
        editable() { return this.editableNow; },
        focus() {},
        type(t) { this.txt = t; opts.onChange(); },
      };
      made.push(ed);
      return ed;
    },
  };
}

function manualRequester() {
  const asks = [];
  return {
    asks,
    request(action, body) { return new Promise((resolve) => { asks.push({ action, body, resolve }); }); },
    last: (action) => [...asks].reverse().find(a => a.action === action),
    all: (action) => asks.filter(a => a.action === action),
  };
}
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

const fileReply = (over = {}) => ({
  ok: true, path: 'src/a.js', text: 'one\n', size: 4, mtimeMs: 100, hash: 'H1', bom: false, eol: 'lf', editable: true, ...over,
});

function setup({ answers = [], withCm = true } = {}) {
  const cm = fakeCodeMirror();
  if (withCm) globalThis.repoCodeMirror = cm; else delete globalThis.repoCodeMirror;
  const { doc, el } = fakeDoc();
  if (!withCm) doc.createElement = (tag) => { const e = new El(tag); if (tag === 'script') setImmediate(() => e.onerror && e.onerror()); return e; };
  doc.head.append = () => {};
  const requester = manualRequester();
  const confirms = [];
  const dirtyReports = [];
  const { create } = require('../app/repo-reader');
  const rd = create({
    doc, requester, harness: {}, storage: null, typeMention: () => {}, onClose: () => {},
    confirmDiscard: async (msg) => { confirms.push(msg); return answers.length ? answers.shift() : true; },
    onDirty: (p) => dirtyReports.push(p),
  });
  return { rd, requester, el, cm, confirms, dirtyReports };
}

async function openFile(s, over) {
  const p = s.rd.open('src/a.js');
  await tick();
  s.requester.last('read').resolve(fileReply(over));
  await p;
}
async function startEditing(s, over) {
  await openFile(s, over);
  s.el('reader-edit').click();
  await settle();
  return s.cm.made[0];
}
const ctrlS = (s) => s.el('reader').fire('keydown', { key: 's', ctrlKey: true });

test.afterEach(() => { delete globalThis.repoCodeMirror; });

// ---- the toggle ----

test('an editable file shows Edit; clicking it makes the editor editable and the button reads Done', async () => {
  const s = setup();
  await openFile(s);
  assert.strictEqual(s.el('reader-edit').hidden, false);
  assert.strictEqual(s.el('reader-edit').disabled, false);
  assert.strictEqual(s.el('reader-edit').textContent, 'Edit');
  s.el('reader-edit').click();
  await settle();
  assert.strictEqual(s.cm.made[0].editable(), true);
  assert.strictEqual(s.el('reader-edit').textContent, 'Done');
  assert.strictEqual(s.el('reader-edit').attrs['aria-pressed'], 'true');
});

test('Done returns to read-only; with nothing unsaved it does not ask', async () => {
  const s = setup();
  const ed = await startEditing(s);
  s.el('reader-edit').click();
  await settle();
  assert.strictEqual(ed.editable(), false);
  assert.strictEqual(s.el('reader-edit').textContent, 'Edit');
  assert.deepStrictEqual(s.confirms, []);
});

test('a file the reader could not write back faithfully shows Edit disabled, with the reason as its title', async () => {
  const s = setup();
  await openFile(s, { editable: false, editableWhy: 'This file mixes line endings.' });
  assert.strictEqual(s.el('reader-edit').disabled, true);
  assert.strictEqual(s.el('reader-edit').title, 'This file mixes line endings.');
  s.el('reader-edit').click();
  await settle();
  assert.strictEqual(s.cm.made[0].editable(), false);
});

test('the plain-text fallback (CodeMirror could not load) offers no Edit', async () => {
  const s = setup({ withCm: false });
  const p = s.rd.open('src/a.js');
  await tick();
  s.requester.last('read').resolve(fileReply());
  await p;
  assert.strictEqual(s.el('reader-edit').hidden, true);
});

test('while editing the Diff toggle is hidden, so a diff never replaces the text being edited', async () => {
  const s = setup();
  await openFile(s);
  s.rd.setOverlay({ files: [{ path: 'src/a.js', tier: 'edited' }] });
  assert.strictEqual(s.el('reader-diff').hidden, false);
  s.el('reader-edit').click();
  await settle();
  assert.strictEqual(s.el('reader-diff').hidden, true);
});

test('Edit is not offered on a diff view', async () => {
  const s = setup();
  await openFile(s);
  s.rd.setOverlay({ files: [{ path: 'src/a.js', tier: 'edited' }] });
  const t = s.rd.probe('toggleDiff');
  await tick();
  s.requester.last('diff').resolve({ ok: true, source: 'git', text: '+x\n', path: 'src/a.js' });
  await t;
  assert.strictEqual(s.el('reader-edit').hidden, true);
});

// ---- the unsaved dot ----

test('typing shows the dot and enables Save; typing back to the original text clears both', async () => {
  const s = setup();
  const ed = await startEditing(s);
  assert.strictEqual(s.el('reader-dirty').hidden, true);
  assert.strictEqual(s.el('reader-save').disabled, true);
  ed.type('one!\n');
  assert.strictEqual(s.el('reader-dirty').hidden, false);
  assert.strictEqual(s.el('reader-save').disabled, false);
  ed.type('one\n');
  assert.strictEqual(s.el('reader-dirty').hidden, true);
  assert.strictEqual(s.el('reader-save').disabled, true);
});

test('the dot is reported to the page (so closing the tab can ask), and cleared when it goes', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('x\n');
  ed.type('one\n');
  assert.deepStrictEqual(s.dirtyReports, ["src/a.js", null]);
});

// ---- saving ----

test('Ctrl+S saves what was typed, with the hash read, and the file\'s own line endings and BOM', async () => {
  const s = setup();
  const ed = await startEditing(s, { eol: 'crlf', bom: true });
  ed.type('two\n');
  const ev = ctrlS(s);
  assert.strictEqual(ev.defaultPrevented, true, 'the browser\'s own Ctrl+S is not left to run');
  await tick();
  const w = s.requester.last('write');
  assert.deepStrictEqual(w.body, { path: 'src/a.js', text: 'two\n', eol: 'crlf', bom: true, expectHash: 'H1' });
  w.resolve({ ok: true, path: 'src/a.js', size: 4, mtimeMs: 200, hash: 'H2' });
  await settle();
  assert.strictEqual(s.el('reader-dirty').hidden, true);
  assert.match(s.el('reader-meta').textContent, /saved/i);
});

test('after a save the next save is checked against the SAVED version\'s hash, and the stamp is the new one', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('two\n');
  ctrlS(s);
  await tick();
  s.requester.last('write').resolve({ ok: true, path: 'src/a.js', size: 4, mtimeMs: 200, hash: 'H2' });
  await settle();
  ed.type('three\n');
  ctrlS(s);
  await tick();
  assert.strictEqual(s.requester.all('write')[1].body.expectHash, 'H2');
  s.requester.all('write')[1].resolve({ ok: true, path: 'src/a.js', size: 6, mtimeMs: 300, hash: 'H3' });
  await settle();
  // the watcher reports our own write: the stat now matches, so no bar rises
  const c = s.rd.onRepoChanged();
  await tick();
  s.requester.last('stat').resolve({ ok: true, size: 6, mtimeMs: 300 });
  await c;
  assert.strictEqual(s.el('reader-bar').hidden, true);
  assert.strictEqual(s.el('reader-conflict').hidden, true);
});

test('Ctrl+S with nothing to save, or when not editing, writes nothing and leaves the key alone', async () => {
  const s = setup();
  await openFile(s);
  const notEditing = ctrlS(s);
  assert.strictEqual(notEditing.defaultPrevented, false);
  s.el('reader-edit').click();
  await settle();
  ctrlS(s);
  await tick();
  assert.strictEqual(s.requester.all('write').length, 0);
});

test('Ctrl+S twice while a save is in flight sends one write', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('two\n');
  ctrlS(s);
  ctrlS(s);
  await tick();
  assert.strictEqual(s.requester.all('write').length, 1);
});

test('text typed while a save is in flight stays unsaved: the dot is still there after the reply', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('two\n');
  ctrlS(s);
  await tick();
  ed.type('two and more\n');
  s.requester.last('write').resolve({ ok: true, path: 'src/a.js', size: 4, mtimeMs: 200, hash: 'H2' });
  await settle();
  assert.strictEqual(s.el('reader-dirty').hidden, false);
});

test('a save that fails for any other reason keeps the text, keeps the dot, and says why', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('two\n');
  ctrlS(s);
  await tick();
  s.requester.last('write').resolve({ ok: false, why: 'unwritable', error: 'EPERM: operation not permitted' });
  await settle();
  assert.strictEqual(s.el('reader-dirty').hidden, false);
  assert.strictEqual(ed.text(), 'two\n');
  assert.match(s.el('reader-meta').textContent, /not saved/i);
  assert.match(s.el('reader-meta').textContent, /EPERM/);
  assert.strictEqual(s.el('reader-conflict').hidden, true);
});

test('a save the host does not answer (timeout, socket gone) is "not saved", never "saved"', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('two\n');
  ctrlS(s);
  await tick();
  s.requester.last('write').resolve({ ok: false, error: 'the host did not answer in time' });
  await settle();
  assert.strictEqual(s.el('reader-dirty').hidden, false);
  assert.match(s.el('reader-meta').textContent, /not saved: the host did not answer/i);
});

// ---- the conflict ----

async function conflict(s, ed, disk = fileReply({ text: 'one by Claude\n', hash: 'HD', size: 14, mtimeMs: 300 })) {
  ed.type('mine\n');
  ctrlS(s);
  await tick();
  s.requester.last('write').resolve({ ok: false, why: 'stale', hash: 'HD', size: 14 });
  await tick();
  s.requester.last('read').resolve(disk);
  await settle();
}

test('a save that finds the file changed raises the banner with its three actions, and writes nothing more', async () => {
  const s = setup();
  const ed = await startEditing(s);
  await conflict(s, ed);
  assert.strictEqual(s.el('reader-conflict').hidden, false);
  assert.strictEqual(s.el('reader-conflict-text').textContent, 'Claude changed this file while you were editing.');
  assert.strictEqual(s.el('reader-conflict-reload').hidden, false);
  assert.strictEqual(s.el('reader-conflict-keep').hidden, false);
  assert.strictEqual(s.el('reader-conflict-compare').hidden, false);
  assert.strictEqual(s.requester.all('write').length, 1, 'no second, forced write');
  assert.strictEqual(ed.text(), 'mine\n', 'your text is untouched');
  assert.strictEqual(s.el('reader-dirty').hidden, false);
});

test('Reload drops your change and shows the disk version, still in edit mode, banner gone', async () => {
  const s = setup();
  const ed = await startEditing(s);
  await conflict(s, ed);
  s.el('reader-conflict-reload').click();
  await tick();
  s.requester.last('read').resolve(fileReply({ text: 'one by Claude\n', hash: 'HD', size: 14, mtimeMs: 300 }));
  await settle();
  assert.strictEqual(ed.text(), 'one by Claude\n');
  assert.strictEqual(s.el('reader-conflict').hidden, true);
  assert.strictEqual(s.el('reader-dirty').hidden, true);
  assert.strictEqual(ed.editable(), true, 'still editing');
  assert.deepStrictEqual(s.confirms, [], 'the person just chose Reload: no second question');
});

test('Keep mine hides the banner, keeps your text, and the next save replaces the disk version (its hash is expected)', async () => {
  const s = setup();
  const ed = await startEditing(s);
  await conflict(s, ed);
  s.el('reader-conflict-keep').click();
  await settle();
  assert.strictEqual(s.el('reader-conflict').hidden, true);
  assert.strictEqual(ed.text(), 'mine\n');
  assert.strictEqual(s.el('reader-dirty').hidden, false, 'still unsaved');
  ctrlS(s);
  await tick();
  const w = s.requester.all('write')[1];
  assert.strictEqual(w.body.expectHash, 'HD', 'checked against the disk version the person chose to replace, not the stale one');
  assert.strictEqual(w.body.text, 'mine\n');
  w.resolve({ ok: true, path: 'src/a.js', size: 5, mtimeMs: 400, hash: 'HM' });
  await settle();
  assert.strictEqual(s.el('reader-dirty').hidden, true);
});

test('Keep mine is not a blank cheque: if the file changes again before the save, the banner comes back', async () => {
  const s = setup();
  const ed = await startEditing(s);
  await conflict(s, ed);
  s.el('reader-conflict-keep').click();
  await settle();
  ctrlS(s);
  await tick();
  s.requester.all('write')[1].resolve({ ok: false, why: 'stale', hash: 'HD2', size: 20 });
  await tick();
  s.requester.all('read').slice(-1)[0].resolve(fileReply({ text: 'second change\n', hash: 'HD2', size: 14, mtimeMs: 500 }));
  await settle();
  assert.strictEqual(s.el('reader-conflict').hidden, false);
  assert.strictEqual(ed.text(), 'mine\n');
});

test('Keep mine when your text equals the disk\'s: nothing left to save, so the dot clears', async () => {
  const s = setup();
  const ed = await startEditing(s);
  await conflict(s, ed, fileReply({ text: 'mine\n', hash: 'HD', size: 5, mtimeMs: 300 }));
  // an identical rewrite is still a different hash from the one read at the start: the banner is shown, and Keep mine ends it
  if (s.el('reader-conflict').hidden === false) {
    s.el('reader-conflict-keep').click();
    await settle();
  }
  assert.strictEqual(s.el('reader-dirty').hidden, true);
});

test('Compare shows the two versions line by line (disk left rows as del, yours as add) and Back returns to editing', async () => {
  const s = setup();
  const ed = await startEditing(s);
  await conflict(s, ed, fileReply({ text: 'keep\nold line\n', hash: 'HD', size: 14, mtimeMs: 300 }));
  ed.type('keep\nnew line\n');
  s.el('reader-conflict-compare').click();
  await settle();
  assert.strictEqual(s.el('reader-compare').hidden, false);
  assert.strictEqual(s.el('reader-body').hidden, true);
  const rows = s.el('reader-compare-rows').children.map(r => `${r.className}|${r.textContent}`);
  assert.strictEqual(rows.length, 3);
  assert.match(rows[0], /same/);
  assert.match(rows[1], /del.*old line/);
  assert.match(rows[2], /add.*new line/);
  assert.strictEqual(s.el('reader-conflict').hidden, false, 'the three choices stay available while comparing');
  s.el('reader-compare-back').click();
  await settle();
  assert.strictEqual(s.el('reader-compare').hidden, true);
  assert.strictEqual(s.el('reader-body').hidden, false);
  assert.strictEqual(ed.text(), 'keep\nnew line\n');
});

test('the watcher: a file touched but not changed (same hash) raises no banner and the stamp is refreshed', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('mine\n');
  const c = s.rd.onRepoChanged();
  await tick();
  s.requester.last('stat').resolve({ ok: true, size: 4, mtimeMs: 999 });
  await tick();
  s.requester.last('read').resolve(fileReply({ mtimeMs: 999 }));       // same hash H1
  await c;
  await settle();
  assert.strictEqual(s.el('reader-conflict').hidden, true);
  const again = s.rd.onRepoChanged();
  await tick();
  s.requester.all('stat').slice(-1)[0].resolve({ ok: true, size: 4, mtimeMs: 999 });
  await again;
  assert.strictEqual(s.requester.all('read').length, 2, 'the new stamp is remembered: the same stat is not looked into again');
});

test('the file deleted while editing: the banner says so, offers only Keep mine, and Keep mine saves it back as a new file', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('mine\n');
  ctrlS(s);
  await tick();
  s.requester.last('write').resolve({ ok: false, why: 'stale', gone: true });
  await tick();
  s.requester.last('read').resolve({ ok: false, why: 'gone' });
  await settle();
  assert.strictEqual(s.el('reader-conflict').hidden, false);
  assert.match(s.el('reader-conflict-text').textContent, /deleted/i);
  assert.strictEqual(s.el('reader-conflict-reload').hidden, true);
  assert.strictEqual(s.el('reader-conflict-compare').hidden, true);
  s.el('reader-conflict-keep').click();
  await settle();
  ctrlS(s);
  await tick();
  assert.strictEqual(s.requester.all('write')[1].body.expectHash, null);
});

test('the watcher: a file that changed on disk while you have unsaved edits raises the conflict banner, not the plain Reload bar', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('mine\n');
  const c = s.rd.onRepoChanged();
  await tick();
  s.requester.last('stat').resolve({ ok: true, size: 14, mtimeMs: 300 });
  await tick();
  s.requester.last('read').resolve(fileReply({ text: 'one by Claude\n', hash: 'HD', size: 14, mtimeMs: 300 }));
  await c;
  await settle();
  assert.strictEqual(s.el('reader-conflict').hidden, false);
  assert.strictEqual(s.el('reader-bar').hidden, true);
  assert.strictEqual(ed.text(), 'mine\n');
});

test('the watcher: a change while in edit mode with NOTHING typed is the ordinary Reload bar', async () => {
  const s = setup();
  await startEditing(s);
  const c = s.rd.onRepoChanged();
  await tick();
  s.requester.last('stat').resolve({ ok: true, size: 14, mtimeMs: 300 });
  await c;
  assert.strictEqual(s.el('reader-bar').hidden, false);
  assert.strictEqual(s.el('reader-conflict').hidden, true);
});

test('the watcher is told nothing while our own save is in flight (its stat would describe the half-way file)', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('two\n');
  ctrlS(s);
  await tick();
  const c = s.rd.onRepoChanged();
  await c;
  assert.strictEqual(s.requester.all('stat').length, 0);
  s.requester.last('write').resolve({ ok: true, path: 'src/a.js', size: 4, mtimeMs: 200, hash: 'H2' });
  await settle();
});

test('the watcher: a file deleted while you have unsaved edits raises the deleted banner', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('mine\n');
  const c = s.rd.onRepoChanged();
  await tick();
  s.requester.last('stat').resolve({ ok: false, why: 'gone' });
  await c;
  await settle();
  assert.strictEqual(s.el('reader-conflict').hidden, false);
  assert.match(s.el('reader-conflict-text').textContent, /deleted/i);
});

// ---- the guards ----

test('opening another file with unsaved changes asks first; No stays on the file and reads nothing', async () => {
  const s = setup({ answers: [false] });
  const ed = await startEditing(s);
  ed.type('mine\n');
  await s.rd.open('src/b.js');
  assert.strictEqual(s.confirms.length, 1);
  assert.match(s.confirms[0], /src\/a\.js/);
  assert.strictEqual(s.rd.path(), 'src/a.js');
  assert.strictEqual(s.requester.all('read').length, 1);
  assert.strictEqual(ed.text(), 'mine\n');
});

test('opening another file with unsaved changes: Yes discards them and opens it read-only', async () => {
  const s = setup({ answers: [true] });
  const ed = await startEditing(s);
  ed.type('mine\n');
  const o = s.rd.open('src/b.js');
  await settle();
  s.requester.last('read').resolve(fileReply({ path: 'src/b.js', text: 'bee\n', hash: 'HB' }));
  await o;
  assert.strictEqual(s.rd.path(), 'src/b.js');
  assert.strictEqual(ed.text(), 'bee\n');
  assert.strictEqual(ed.editable(), false, 'a new file opens read-only');
  assert.strictEqual(s.el('reader-dirty').hidden, true);
  assert.strictEqual(s.el('reader-edit').textContent, 'Edit');
});

test('opening another file when editing but clean does not ask, and leaves edit mode', async () => {
  const s = setup();
  const ed = await startEditing(s);
  const o = s.rd.open('src/b.js');
  await settle();
  s.requester.last('read').resolve(fileReply({ path: 'src/b.js', text: 'bee\n', hash: 'HB' }));
  await o;
  assert.deepStrictEqual(s.confirms, []);
  assert.strictEqual(ed.editable(), false);
});

test('clicking the same file again with unsaved changes asks too: a re-read would drop them', async () => {
  const s = setup({ answers: [false] });
  const ed = await startEditing(s);
  ed.type('mine\n');
  await s.rd.open('src/a.js');
  assert.strictEqual(s.confirms.length, 1);
  assert.strictEqual(s.requester.all('read').length, 1);
});

test('closing the panel with unsaved changes asks; No keeps it open, Yes closes it', async () => {
  const s = setup({ answers: [false, true] });
  const ed = await startEditing(s);
  ed.type('mine\n');
  s.el('reader-close').click();
  await settle();
  assert.strictEqual(s.rd.isOpen(), true);
  s.el('reader-close').click();
  await settle();
  assert.strictEqual(s.rd.isOpen(), false);
  assert.strictEqual(s.confirms.length, 2);
  assert.strictEqual(s.dirtyReports[s.dirtyReports.length - 1], null, 'closing clears the unsaved report');
});

test('Esc closes through the same guard', async () => {
  const s = setup({ answers: [false] });
  const ed = await startEditing(s);
  ed.type('mine\n');
  s.el('reader').fire('keydown', { key: 'Escape' });
  await settle();
  assert.strictEqual(s.confirms.length, 1);
  assert.strictEqual(s.rd.isOpen(), true);
});

test('closing with nothing unsaved does not ask', async () => {
  const s = setup();
  await startEditing(s);
  s.el('reader-close').click();
  await settle();
  assert.deepStrictEqual(s.confirms, []);
  assert.strictEqual(s.rd.isOpen(), false);
});

test('Done with unsaved changes asks; No keeps editing, Yes drops the edits and goes read-only on the disk text', async () => {
  const s = setup({ answers: [false, true] });
  const ed = await startEditing(s);
  ed.type('mine\n');
  s.el('reader-edit').click();
  await settle();
  assert.strictEqual(ed.editable(), true);
  assert.strictEqual(ed.text(), 'mine\n');
  s.el('reader-edit').click();
  await settle();
  assert.strictEqual(ed.editable(), false);
  assert.strictEqual(ed.text(), 'one\n', 'the discarded edits are gone from the screen too');
  assert.strictEqual(s.el('reader-dirty').hidden, true);
});

test('hasUnsaved() is what the page reports to the tab-close question', async () => {
  const s = setup();
  const ed = await startEditing(s);
  assert.strictEqual(s.rd.hasUnsaved(), false);
  ed.type('mine\n');
  assert.strictEqual(s.rd.hasUnsaved(), true);
});

test('Reload (the plain bar) from a clean file still works exactly as before', async () => {
  const s = setup();
  await openFile(s);
  const c = s.rd.onRepoChanged();
  await tick();
  s.requester.last('stat').resolve({ ok: true, size: 9, mtimeMs: 200 });
  await c;
  assert.strictEqual(s.el('reader-bar').hidden, false);
  s.el('reader-reload').click();
  await tick();
  s.requester.last('read').resolve(fileReply({ text: 'two!\n', size: 9, mtimeMs: 200, hash: 'H9' }));
  await settle();
  assert.strictEqual(s.cm.made[0].text(), 'two!\n');
  assert.strictEqual(s.el('reader-bar').hidden, true);
});

test('Reload while editing lands read-only when the disk version can no longer be written back faithfully', async () => {
  const s = setup();
  const ed = await startEditing(s);
  await conflict(s, ed);
  s.el('reader-conflict-reload').click();
  await tick();
  s.requester.last('read').resolve(fileReply({ text: 'x\r\ny\nz', hash: 'HX', eol: 'mixed', editable: false, editableWhy: 'mixed' }));
  await settle();
  assert.strictEqual(ed.editable(), false);
  assert.strictEqual(s.el('reader-edit').disabled, true);
});

test('an older host that sends no hash is shown read-only with the reason: it could not check a save', async () => {
  const s = setup();
  await openFile(s, { hash: undefined, editable: undefined });
  assert.strictEqual(s.el('reader-edit').disabled, true);
  assert.match(s.el('reader-edit').title, /older than this window/);
});

// ---- PR #155 review fixes ----

test('Dexter 4: the plain Reload bar re-checks at CLICK time: edits typed after it rose are asked about, and survive a "no"', async () => {
  const s = setup({ answers: [false, true] });
  await openFile(s);
  const c = s.rd.onRepoChanged();
  await tick();
  s.requester.last('stat').resolve({ ok: true, size: 9, mtimeMs: 200 });
  await c;
  assert.strictEqual(s.el('reader-bar').hidden, false);
  s.el('reader-edit').click();
  await settle();
  const ed = s.cm.made[0];
  ed.type('three new lines\n');
  s.el('reader-reload').click();
  await settle();
  assert.strictEqual(s.confirms.length, 1);
  assert.strictEqual(ed.text(), 'three new lines\n', 'a "no" keeps the text');
  assert.strictEqual(s.requester.all('read').length, 1, 'and reads nothing');
  s.el('reader-reload').click();
  await tick(); await tick();
  s.requester.last('read').resolve(fileReply({ text: 'fresh\n', size: 9, mtimeMs: 200, hash: 'H9' }));
  await settle();
  assert.strictEqual(ed.text(), 'fresh\n', 'a "yes" drops them and loads the file');
});

test('Dexter 7: a save whose answer never came, then a save that finds the disk holding exactly our text, is "saved", not a conflict', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('two\n');
  ctrlS(s);
  await tick();
  s.requester.last('write').resolve({ ok: false, error: 'the host did not answer in time' });
  await settle();
  assert.match(s.el('reader-meta').textContent, /not saved/i);
  assert.match(s.el('reader-meta').textContent, /may have/i);
  ctrlS(s);
  await tick();
  s.requester.all('write')[1].resolve({ ok: false, why: 'stale', hash: 'H2' });
  await tick();
  s.requester.last('read').resolve(fileReply({ text: 'two\n', hash: 'H2', size: 4, mtimeMs: 400 }));
  await settle();
  assert.strictEqual(s.el('reader-conflict').hidden, true, 'no accusation');
  assert.strictEqual(s.el('reader-dirty').hidden, true);
  assert.match(s.el('reader-meta').textContent, /saved/i);
  // and the next save is checked against what is on disk now
  ed.type('three\n');
  ctrlS(s);
  await tick();
  assert.strictEqual(s.requester.all('write')[2].body.expectHash, 'H2');
});

test('a stale save whose disk text equals yours is never a conflict, whatever happened before', async () => {
  const s = setup();
  const ed = await startEditing(s);
  await conflict(s, ed, fileReply({ text: 'mine\n', hash: 'HD', size: 5, mtimeMs: 300 }));
  assert.strictEqual(s.el('reader-conflict').hidden, true);
  assert.strictEqual(s.el('reader-dirty').hidden, true);
});

test('Miguel S2: a save refused as gone (its folder is gone) says so in words, not "not saved: gone"', async () => {
  const s = setup();
  const ed = await startEditing(s);
  ed.type('x\n');
  ctrlS(s);
  await tick();
  s.requester.last('write').resolve({ ok: false, why: 'gone' });
  await settle();
  assert.doesNotMatch(s.el('reader-meta').textContent, /: gone$/);
  assert.match(s.el('reader-meta').textContent, /folder/i);
});

test('Miguel I2: open() says whether it opened: false when the person kept editing, so the Files panel can re-sync its highlight', async () => {
  const s = setup({ answers: [false] });
  const ed = await startEditing(s);
  ed.type('mine\n');
  assert.strictEqual(await s.rd.open('src/b.js'), false);
  const o = s.rd.open('src/a.js', { discard: true });
  await tick(); await tick();
  s.requester.last('read').resolve(fileReply());
  assert.notStrictEqual(await o, false);
});
