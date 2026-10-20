'use strict';
/**
 * The reader's Changes Compare (BACKLOG #119 A3, app/repo-reader.js openChange): a file from the Changes panel shown as its base
 * version beside what is on disk now, with "comment on a line" typed into the prompt and NEVER submitted. Same stub-element harness
 * as test/repo-reader-edit.test.js: a requester the test answers by hand, no window.
 */
const test = require('node:test');
const assert = require('node:assert');

globalThis.addEventListener = globalThis.addEventListener || (() => {});

class El {
  constructor(id) {
    this.id = id; this.hidden = false; this.textContent = ''; this.title = ''; this.style = {}; this.dataset = {};
    this.children = []; this.className = ''; this.disabled = false; this.attrs = {}; this.handlers = {}; this.value = '';
  }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getBoundingClientRect() { return { left: 0, right: 0, width: 0, top: 0, bottom: 0 }; }
  replaceChildren(...c) { this.children = c; }
  append(...c) { this.children.push(...c); }
  remove() { this.removed = true; }
  querySelector() { return null; }
  setPointerCapture() {}
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  get classList() { return { add() {}, remove() {}, toggle() {}, contains: () => false }; }
  fire(type, init = {}) {
    const e = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
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
  for (const id of ['reader', 'reader-split', 'reader-bar', 'reader-note', 'reader-conflict', 'reader-compare', 'reader-dirty', 'reader-compare-queue']) doc.getElementById(id).hidden = true;
  return { doc, el: (id) => doc.getElementById(id) };
}

function fakeCodeMirror() {
  const made = [];
  return {
    made,
    create(parent, opts) {
      const ed = {
        txt: '', show({ text }) { this.txt = text; }, text() { return this.txt; }, lines() { return this.txt.split('\n').length; },
        selection: () => ({ fromLine: 1, toLine: 1, empty: true, toCol0: false }), setEditable() {}, editable: () => false, focus() {},
      };
      made.push(ed);
      return ed;
    },
  };
}

function manual() {
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

const DASH = String.fromCharCode(0x2014);
const NOW = 'one\nTWO\nthree\nfour\n';
const BASE = 'one\ntwo\nthree\n';

function setup() {
  const cm = fakeCodeMirror();
  globalThis.repoCodeMirror = cm;
  const { doc, el } = fakeDoc();
  doc.head.append = () => {};
  const requester = manual();
  const changes = manual();
  const typed = [];
  let typeAnswer = { ok: true };
  const { create } = require('../app/repo-reader');
  const rd = create({
    doc, requester, changes, harness: {}, storage: null, typeMention: () => {}, onClose: () => {},
    typeComment: (text, done) => { typed.push(text); done(typeAnswer); },
    confirmDiscard: async () => true,
  });
  return { rd, requester, changes, el, typed, setTypeAnswer: (a) => { typeAnswer = a; } };
}

async function openIt(s, info = {}) {
  const p = s.rd.openChange({ path: 'src/a.js', status: 'M', scope: 'working', base: 'develop', ...info });
  await tick();
  return p;
}
async function openAnswered(s, { now = NOW, base = BASE, info } = {}) {
  const p = openIt(s, info);
  await tick();
  s.requester.last('read').resolve({ ok: true, path: 'src/a.js', text: now, size: now.length, mtimeMs: 5, hash: 'h', editable: true });
  s.changes.last('base').resolve(base === null ? { ok: false, why: 'new' } : { ok: true, text: base, base: 'HEAD' });
  await p;
  await settle();
}
const rowsText = (s) => s.rd.probe('state').compareRows;

test.afterEach(() => { delete globalThis.repoCodeMirror; });

test('opening a change reads the file NOW and asks the host for the BASE (the scope, the path), then shows the two side by side', async () => {
  const s = setup();
  await openAnswered(s);
  assert.deepStrictEqual(s.changes.last('base').body, { scope: 'working', path: 'src/a.js' });
  assert.deepStrictEqual(s.requester.last('read').body, { path: 'src/a.js' });
  const st = s.rd.probe('state');
  assert.strictEqual(st.compareShown, true);
  assert.strictEqual(st.bodyHidden, true);
  assert.strictEqual(st.mode, 'changes');
  assert.strictEqual(st.path, 'src/a.js');
  assert.ok(rowsText(s).some(r => r.startsWith('sbs-row change|')), rowsText(s).join('\n'));
  assert.match(st.meta, /HEAD/);
  assert.strictEqual(st.diffLabel, 'File');
  assert.strictEqual(st.diffVisible, true);
  assert.strictEqual(st.editShown, false, 'a comparison is not an editor');
});

test('a renamed file asks for the OLD path at the base', async () => {
  const s = setup();
  await openAnswered(s, { info: { status: 'R', oldPath: 'src/old.js' } });
  assert.deepStrictEqual(s.changes.last('base').body, { scope: 'working', path: 'src/a.js', oldPath: 'src/old.js' });
});

test('a NEW file has no base to ask for: every line is an addition, and the host is not asked', async () => {
  const s = setup();
  const p = openIt(s, { status: 'A' });
  await tick();
  s.requester.last('read').resolve({ ok: true, path: 'src/a.js', text: 'x\ny\n', size: 4, mtimeMs: 1, hash: 'h' });
  await p; await settle();
  assert.strictEqual(s.changes.all('base').length, 0);
  assert.ok(rowsText(s).every(r => r.startsWith('sbs-row add|')), rowsText(s).join('\n'));
});

test('a DELETED file is not read; its base is shown against nothing, every line removed', async () => {
  const s = setup();
  const p = openIt(s, { status: 'D' });
  await tick();
  assert.strictEqual(s.requester.all('read').length, 0);
  s.changes.last('base').resolve({ ok: true, text: 'was\nhere\n', base: 'HEAD' });
  await p; await settle();
  assert.ok(rowsText(s).every(r => r.startsWith('sbs-row del|')), rowsText(s).join('\n'));
});

test('files the compare cannot show say why instead of drawing something wrong', async () => {
  for (const [base, expect] of [
    [{ ok: false, why: 'too-large' }, /too large to compare/i],
    [{ ok: false, why: 'binary' }, /binary/i],
    [{ ok: false, why: 'no base', error: 'no develop, main or master branch to compare with' }, /no develop, main or master/],
    [{ ok: false, error: 'the host did not answer in time' }, /did not answer/],
  ]) {
    const s = setup();
    const p = openIt(s);
    await tick();
    s.requester.last('read').resolve({ ok: true, text: 'x\n', size: 2, mtimeMs: 1 });
    s.changes.last('base').resolve(base);
    await p; await settle();
    const st = s.rd.probe('state');
    assert.strictEqual(st.noteShown, true);
    assert.match(st.noteText, expect);
    assert.strictEqual(st.compareShown, false);
  }
  const s = setup();
  const p = openIt(s);
  await tick();
  s.requester.last('read').resolve({ ok: true, text: 'x'.repeat(10), size: 2 * 1024 * 1024, mtimeMs: 1 });
  s.changes.last('base').resolve({ ok: true, text: 'y' });
  await p; await settle();
  assert.match(s.rd.probe('state').noteText, /too large to compare/i, 'a big file NOW is refused too');
});

test('the File button leaves the comparison for the plain file view', async () => {
  const s = setup();
  await openAnswered(s);
  s.el('reader-diff').click();
  await tick();
  s.requester.last('read').resolve({ ok: true, path: 'src/a.js', text: NOW, size: 5, mtimeMs: 6, hash: 'h2', editable: true });
  await settle();
  const st = s.rd.probe('state');
  assert.strictEqual(st.mode, 'file');
  assert.strictEqual(st.compareShown, false);
  assert.strictEqual(st.bodyHidden, false);
});

test('without a `changes` seam (an older wiring) the reader says so and does not throw', async () => {
  const cm = fakeCodeMirror(); globalThis.repoCodeMirror = cm;
  const { doc, el } = fakeDoc();
  doc.head.append = () => {};
  const { create } = require('../app/repo-reader');
  const rd = create({ doc, requester: manual(), harness: {}, storage: null, typeMention: () => {}, onClose: () => {} });
  await rd.openChange({ path: 'a.js', status: 'M', scope: 'working' });
  assert.match(rd.probe('state').noteText, /not available/i);
  assert.ok(el);
});

// ---- comments ----

async function openAndComment(s, line, text, { shift = false } = {}) {
  await openAnswered(s);
  const rowsEl = s.el('reader-compare-rows');
  const row = rowsEl.children.find(r => r.dataset && r.dataset.line === String(line));
  assert.ok(row, `a row for line ${line}`);
  const btn = row.children[4].children[0];
  rowsEl.fire('click', { target: { closest: (sel) => (sel === '[data-act="comment"]' ? btn : null), dataset: btn.dataset } });
  const input = row.children[row.children.length - 1].children.find(c => c.tag === 'input' || c.className === 'sbs-input');
  assert.ok(input, 'a composer with a field appeared under the row');
  input.value = text;
  const e = input.fire('keydown', { key: 'Enter', shiftKey: shift });
  await settle();
  return { e, input, row };
}

test('Enter in the comment field TYPES `In <path>:<line> — <comment>` into the prompt through the typing seam, and nothing else', async () => {
  const s = setup();
  const { e } = await openAndComment(s, 2, 'why not  a guard here?');
  assert.deepStrictEqual(s.typed, [`In src/a.js:2 ${DASH} why not a guard here?`]);
  assert.strictEqual(e.defaultPrevented, true);
  assert.match(s.rd.probe('state').meta, /typed 1 comment; press Enter in the terminal/);
});

test('Shift+Enter ADDS to the stack without typing; the queue bar shows the count; Send types the whole stack on one line', async () => {
  const s = setup();
  await openAndComment(s, 2, 'first', { shift: true });
  assert.deepStrictEqual(s.typed, []);
  assert.strictEqual(s.el('reader-compare-queue').hidden, false);
  assert.match(s.el('reader-compare-queue-text').textContent, /1 comment queued/);
  // a second comment, on another line of the same file, then Enter
  const rowsEl = s.el('reader-compare-rows');
  const row = rowsEl.children.find(r => r.dataset && r.dataset.line === '4');
  const btn = row.children[4].children[0];
  rowsEl.fire('click', { target: { closest: (sel) => (sel === '[data-act="comment"]' ? btn : null), dataset: btn.dataset } });
  const input = row.children[row.children.length - 1].children.find(c => c.className === 'sbs-input');
  input.value = 'second';
  input.fire('keydown', { key: 'Enter', shiftKey: false });
  await settle();
  assert.deepStrictEqual(s.typed, [`In src/a.js:2 ${DASH} first; In src/a.js:4 ${DASH} second`]);
  assert.strictEqual(s.el('reader-compare-queue').hidden, true, 'a typed stack is cleared');
});

test('a refused typing keeps the stack (nothing is lost) and says why', async () => {
  const s = setup();
  s.setTypeAnswer({ ok: false, reason: 'a dialog is open in the terminal; answer it or press Esc first' });
  await openAndComment(s, 2, 'keep me');
  assert.match(s.rd.probe('state').meta, /not typed: a dialog is open/);
  assert.strictEqual(s.el('reader-compare-queue').hidden, false);
  s.setTypeAnswer({ ok: true });
  s.el('reader-compare-send').click();
  await settle();
  assert.strictEqual(s.typed.length, 2);
  assert.strictEqual(s.el('reader-compare-queue').hidden, true);
});

test('Clear drops the stack; an empty comment is refused with a reason and typed nowhere', async () => {
  const s = setup();
  await openAndComment(s, 2, 'one', { shift: true });
  s.el('reader-compare-clear').click();
  assert.strictEqual(s.el('reader-compare-queue').hidden, true);
  assert.deepStrictEqual(s.typed, []);
  const s2 = setup();
  await openAndComment(s2, 2, '   ');
  assert.deepStrictEqual(s2.typed, []);
  assert.match(s2.rd.probe('state').meta, /not added: the comment is empty/);
});

test('Escape in the field closes the field and does NOT close the reader', async () => {
  const s = setup();
  await openAnswered(s);
  const rowsEl = s.el('reader-compare-rows');
  const row = rowsEl.children.find(r => r.dataset && r.dataset.line === '2');
  const btn = row.children[4].children[0];
  rowsEl.fire('click', { target: { closest: () => btn, dataset: btn.dataset } });
  const field = row.children[row.children.length - 1];
  const input = field.children.find(c => c.className === 'sbs-input');
  const e = input.fire('keydown', { key: 'Escape' });
  assert.strictEqual(e.defaultPrevented, true, 'the pane\'s Esc handler sees a handled key');
  assert.strictEqual(field.removed, true);
  assert.strictEqual(s.rd.isOpen(), true);
});

test('NOTHING is ever submitted: the typing seam is the only thing a comment can reach, and it is handed text, not keystrokes', async () => {
  const s = setup();
  await openAndComment(s, 2, 'a comment');
  for (const t of s.typed) assert.ok(!/[\r\n]/.test(t));
});

// ---- hunks ----

test('j and k move through the hunks, wrapping, and mark the current row', async () => {
  const s = setup();
  const now = Array.from({ length: 40 }, (_, i) => (i === 5 ? 'CHANGED5' : i === 30 ? 'CHANGED30' : `l${i}`)).join('\n') + '\n';
  const base = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n') + '\n';
  await openAnswered(s, { now, base });
  const rowsEl = s.el('reader-compare-rows');
  const key = (k) => rowsEl.fire('keydown', { key: k, target: { tagName: 'DIV' } });
  const cur = () => rowsEl.children.findIndex(r => / cur\b/.test(r.className));
  key('j'); const first = cur();
  key('j'); const second = cur();
  assert.ok(first >= 0 && second > first);
  key('j'); assert.strictEqual(cur(), first, 'wraps to the first hunk');
  key('k'); assert.strictEqual(cur(), second, 'k from the first wraps to the last');
  const e = key('x');
  assert.strictEqual(e.defaultPrevented, false);
});

test('j and k typed in the comment field are text, not navigation', async () => {
  const s = setup();
  await openAnswered(s);
  const rowsEl = s.el('reader-compare-rows');
  const e = rowsEl.fire('keydown', { key: 'j', target: { tagName: 'INPUT' } });
  assert.strictEqual(e.defaultPrevented, false);
});
