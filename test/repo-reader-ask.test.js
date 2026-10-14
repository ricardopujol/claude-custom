'use strict';
/**
 * The reader's two hooks for "Ask the repo" (BACKLOG #33): What's this? (the selected lines go to the panel) and open-at-line (a card or
 * a citation lands on its line). Same stub elements as test/repo-reader-edit.test.js.
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
  fire(type, init = {}) {
    const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const fn of this.handlers[type] || []) fn(e);
    return e;
  }
  click() { if (!this.disabled && !this.hidden) this.fire('click'); }
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

function fakeCodeMirror() {
  const made = [];
  return {
    made,
    create(_parent, opts) {
      const ed = {
        editableNow: false, setEditable(on) { this.editableNow = on === true; }, editable() { return this.editableNow; }, type(t) { this.txt = t; opts.onChange(); },
        txt: '', sel: { fromLine: 1, toLine: 1, empty: true, toCol0: false }, picked: [],
        show({ text }) { this.txt = text; },
        text() { return this.txt; },
        lines() { return this.txt.split('\n').length; },
        selection() { return this.sel; },
        setSelection(a, b) { this.picked.push([a, b]); },
        focus() {},
      };
      made.push(ed);
      return ed;
    },
  };
}

const tick = () => new Promise(r => setImmediate(r));
function setup({ onAsk } = {}) {
  const cm = fakeCodeMirror();
  globalThis.repoCodeMirror = cm;
  const { doc, el } = fakeDoc();
  doc.head.append = () => {};
  const asks = [];
  const requester = { request(action, body) { return new Promise((resolve) => { asks.push({ action, body, resolve }); }); } };
  const { create } = require('../app/repo-reader');
  const rd = create({ doc, requester, harness: {}, storage: null, typeMention: () => {}, onClose: () => {}, confirmDiscard: async () => true, onAsk });
  const last = (action) => [...asks].reverse().find(a => a.action === action);
  return { rd, el, cm, last };
}
async function openFile(s, path = 'src/a.js') {
  const p = s.rd.open(path);
  await tick();
  s.last('read').resolve({ ok: true, path, text: 'one\ntwo\nthree\nfour\n', size: 18, mtimeMs: 1, hash: 'H', bom: false, eol: 'lf', editable: true });
  await p;
}

test.afterEach(() => { delete globalThis.repoCodeMirror; });

test('What\'s this? is offered only when the page can take the question', () => {
  assert.strictEqual(setup({ onAsk: () => {} }).el('reader-ask').hidden, false);
  assert.strictEqual(setup({}).el('reader-ask').hidden, true);
});

test('selectionInfo: the file and the selected lines; a bare cursor is none; a selection ending at column 0 leaves that line out', async () => {
  const s = setup({ onAsk: () => {} });
  assert.strictEqual(s.rd.selectionInfo(), null, 'nothing open');
  await openFile(s);
  assert.strictEqual(s.rd.selectionInfo(), null, 'a bare cursor');
  s.cm.made[0].sel = { fromLine: 2, toLine: 4, empty: false, toCol0: false };
  assert.deepStrictEqual(s.rd.selectionInfo(), { file: 'src/a.js', start: 2, end: 4 });
  s.cm.made[0].sel = { fromLine: 2, toLine: 4, empty: false, toCol0: true };
  assert.deepStrictEqual(s.rd.selectionInfo(), { file: 'src/a.js', start: 2, end: 3 });
});

test('clicking What\'s this? sends the selection to the panel, and says what to do when nothing is selected', async () => {
  const asked = [];
  const s = setup({ onAsk: (sel) => asked.push(sel) });
  await openFile(s);
  s.el('reader-ask').click();
  assert.deepStrictEqual(asked, [], 'no selection, no question');
  assert.match(s.el('reader-meta').textContent, /select some code first/);
  s.cm.made[0].sel = { fromLine: 1, toLine: 2, empty: false, toCol0: false };
  s.el('reader-ask').click();
  assert.deepStrictEqual(asked, [{ file: 'src/a.js', start: 1, end: 2 }]);
});

test('PR #169 Miguel Y3: with unsaved edits What\'s this? refuses plainly instead of explaining lines of the buffer that the disk does not have', async () => {
  const asked = [];
  const s = setup({ onAsk: (sel) => asked.push(sel) });
  await openFile(s);
  s.el('reader-edit').click();
  for (let i = 0; i < 6; i += 1) await tick();
  const ed = s.cm.made[0];
  ed.sel = { fromLine: 1, toLine: 2, empty: false, toCol0: false };
  s.el('reader-ask').click();
  assert.strictEqual(asked.length, 1, 'edit mode with nothing typed is still the saved file');
  ed.type('one\ntwo\nchanged\n');
  s.el('reader-ask').click();
  assert.strictEqual(asked.length, 1, 'with unsaved edits nothing is asked');
  assert.match(s.el('reader-meta').textContent, /save the file first/);
});

test('openAt: opens the file, then selects the line (and the range when given)', async () => {
  const s = setup({ onAsk: () => {} });
  const p = s.rd.openAt('src/a.js', 3);
  await tick();
  s.last('read').resolve({ ok: true, path: 'src/a.js', text: 'one\ntwo\nthree\nfour\n', size: 18, mtimeMs: 1, hash: 'H', bom: false, eol: 'lf', editable: true });
  await p;
  assert.deepStrictEqual(s.cm.made[0].picked, [[3, 3]]);
  const q = s.rd.openAt('src/a.js', 2, 4);
  await tick();
  s.last('read').resolve({ ok: true, path: 'src/a.js', text: 'one\ntwo\nthree\nfour\n', size: 18, mtimeMs: 1, hash: 'H', bom: false, eol: 'lf', editable: true });
  await q;
  assert.deepStrictEqual(s.cm.made[0].picked.at(-1), [2, 4]);
});

test('openAt with no usable line just opens the file; a bad range end is the line itself', async () => {
  const s = setup({ onAsk: () => {} });
  for (const line of [undefined, 0, -3, 2.5, '4']) {
    const p = s.rd.openAt('src/a.js', line);
    await tick();
    s.last('read').resolve({ ok: true, path: 'src/a.js', text: 'one\n', size: 4, mtimeMs: 1, hash: 'H', bom: false, eol: 'lf', editable: true });
    await p;
  }
  assert.deepStrictEqual(s.cm.made[0] ? s.cm.made[0].picked : [], []);
  const p = s.rd.openAt('src/a.js', 3, 1);
  await tick();
  s.last('read').resolve({ ok: true, path: 'src/a.js', text: 'one\n', size: 4, mtimeMs: 1, hash: 'H', bom: false, eol: 'lf', editable: true });
  await p;
  assert.deepStrictEqual(s.cm.made[0].picked.at(-1), [3, 3]);
});
