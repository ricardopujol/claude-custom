'use strict';
/**
 * PR #95 Dexter D14: the Reload bar must not survive the reload it asked for. A `stat` reply that was in flight
 * when Reload was clicked used to land AFTER the read began and raise "This file changed on disk" over the fresh
 * text. The reader runs here against stub elements and a requester the test controls (CodeMirror's script
 * "fails to load", so the plain-text view is used).
 */
const test = require('node:test');
const assert = require('node:assert');

globalThis.addEventListener = globalThis.addEventListener || (() => {});     // the reader listens for window focus

class El {
  constructor(id) { this.id = id; this.hidden = false; this.textContent = ''; this.title = ''; this.style = {}; this.dataset = {}; this.children = []; this.className = ''; }
  addEventListener() {}
  setAttribute() {}
  getBoundingClientRect() { return { left: 0, right: 0, width: 0, top: 0, bottom: 0 }; }
  replaceChildren(...c) { this.children = c; }
  append(...c) { this.children.push(...c); }
  querySelector() { return null; }
  setPointerCapture() {}
  focus() {}
  dispatchEvent() {}
  get classList() { return { add() {}, remove() {}, toggle() {}, contains: () => false }; }
}
function fakeDoc() {
  const els = new Map();
  const doc = {
    getElementById: (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); },
    createElement: (tag) => {
      const e = new El(tag);
      if (tag === 'script') setImmediate(() => e.onerror && e.onerror());      // CodeMirror "can't load": plain text
      return e;
    },
    head: new El('head'), body: new El('body'), querySelector: () => null,
  };
  doc.head.append = () => {};
  ['reader-bar', 'reader-note', 'reader-pane'].forEach(id => doc.getElementById(id));
  doc.getElementById('reader').hidden = true;
  doc.getElementById('reader-split').hidden = true;
  doc.getElementById('reader-bar').hidden = true;
  doc.getElementById('reader-note').hidden = true;
  return { doc, el: (id) => doc.getElementById(id) };
}

// A requester whose replies the test releases by hand.
function manualRequester() {
  const asks = [];
  return {
    asks,
    request(action, body) { return new Promise((resolve) => { asks.push({ action, body, resolve }); }); },
    last: (action) => [...asks].reverse().find(a => a.action === action),
  };
}
const tick = () => new Promise(r => setImmediate(r));

function reader() {
  const { create } = require('../app/repo-reader');
  const { doc, el } = fakeDoc();
  const requester = manualRequester();
  const rd = create({ doc, requester, harness: {}, storage: null, typeMention: () => {}, onClose: () => {} });
  return { rd, requester, el };
}

async function openFile(rd, requester, stamp) {
  const p = rd.open('src/a.js');
  requester.last('read').resolve({ ok: true, path: 'src/a.js', text: 'one\n', size: stamp.size, mtimeMs: stamp.mtimeMs });
  await p;
}

test('D14: a stat that was in flight when Reload began does not raise the bar over the fresh text', async () => {
  const { rd, requester, el } = reader();
  await openFile(rd, requester, { size: 4, mtimeMs: 100 });
  const stale = rd.onRepoChanged();                       // asks stat: held
  await tick();
  const statAsk = requester.last('stat');
  const reload = rd.open('src/a.js', { keepMode: true });  // the person clicked Reload: read begins
  statAsk.resolve({ ok: true, size: 9, mtimeMs: 200 });   // the stat answer lands while the read is out
  await stale;
  assert.strictEqual(el('reader-bar').hidden, true, 'the late stat is nobody\'s: no bar while the reload is reading');
  requester.last('read').resolve({ ok: true, path: 'src/a.js', text: 'two!\n', size: 9, mtimeMs: 200 });
  await reload;
  assert.strictEqual(el('reader-bar').hidden, true, 'and none over the fresh text after it');
});

test('D14: a stat that shows a REAL change while nothing is being reloaded still raises the bar', async () => {
  const { rd, requester, el } = reader();
  await openFile(rd, requester, { size: 4, mtimeMs: 100 });
  const p = rd.onRepoChanged();
  await tick();
  requester.last('stat').resolve({ ok: true, size: 9, mtimeMs: 200 });
  await p;
  assert.strictEqual(el('reader-bar').hidden, false);
  assert.match(el('reader-bar-text').textContent, /changed on disk/);
});

test('D14: after the reload lands, the stamp is the new one, so the same stat no longer differs and the bar stays down', async () => {
  const { rd, requester, el } = reader();
  await openFile(rd, requester, { size: 4, mtimeMs: 100 });
  const reload = rd.open('src/a.js', { keepMode: true });
  requester.last('read').resolve({ ok: true, path: 'src/a.js', text: 'two!\n', size: 9, mtimeMs: 200 });
  await reload;
  const p = rd.onRepoChanged();
  await tick();
  requester.last('stat').resolve({ ok: true, size: 9, mtimeMs: 200 });
  await p;
  assert.strictEqual(el('reader-bar').hidden, true);
});

test('D14: a stat answer for a file the person has since left is dropped', async () => {
  const { rd, requester, el } = reader();
  await openFile(rd, requester, { size: 4, mtimeMs: 100 });
  const p = rd.onRepoChanged();
  await tick();
  const other = rd.open('src/b.js');
  requester.last('stat').resolve({ ok: true, size: 99, mtimeMs: 999 });
  await p;
  assert.strictEqual(el('reader-bar').hidden, true);
  requester.last('read').resolve({ ok: true, path: 'src/b.js', text: 'b\n', size: 2, mtimeMs: 5 });
  await other;
});
