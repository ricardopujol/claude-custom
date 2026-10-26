'use strict';
/**
 * BACKLOG #119 A9: the code reader shows Markdown as a page. The reader runs against stub elements, a requester the
 * test answers by hand, a fake CodeMirror and a fake Markdown bundle, so every behaviour is pinned without a window:
 * the Rendered | Source segment appears only for Markdown, defaults to Rendered, is remembered; Edit, Diff and a
 * failing bundle all fall back to the source; a late render for a file the person has left is dropped; and a link in
 * the page opens in the reader (file) or the browser (http) through the reader's own paths.
 */
const test = require('node:test');
const assert = require('node:assert');

globalThis.addEventListener = globalThis.addEventListener || (() => {});

class El {
  constructor(id) {
    this.id = id; this.hidden = false; this.textContent = ''; this.title = ''; this.style = {}; this.dataset = {};
    this.children = []; this.className = ''; this.disabled = false; this.attrs = {}; this.handlers = {}; this.scrollTop = 0;
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
  dispatchEvent(e) { return this.fire(e.type, e); }
}
function fakeDoc() {
  const els = new Map();
  const doc = {
    getElementById: (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); },
    createElement: (tag) => new El(tag),
    head: new El('head'), body: new El('body'), querySelector: () => null,
  };
  for (const id of ['reader', 'reader-split', 'reader-bar', 'reader-note', 'reader-conflict', 'reader-compare', 'reader-dirty', 'reader-md', 'reader-view']) doc.getElementById(id).hidden = true;
  return { doc, el: (id) => doc.getElementById(id) };
}

function fakeCodeMirror() {
  const made = [];
  return {
    made,
    create(parent, opts) {
      const ed = {
        txt: '', editableNow: false,
        show({ text }) { this.txt = text; },
        text() { return this.txt; },
        lines() { return this.txt.split('\n').length; },
        selection: () => ({ fromLine: 2, toLine: 4, empty: false, toCol0: false }),
        setEditable(on) { this.editableNow = on === true; },
        focus() {},
        type(t) { this.txt = t; opts.onChange(); },
      };
      made.push(ed);
      return ed;
    },
  };
}

// A Markdown bundle whose renders the test can hold back and fail.
function fakeMarkdown() {
  const m = { calls: [], pending: [], mode: 'now', failWith: null };
  m.render = (text, opts) => {
    const node = new El('md-page');
    node.fromText = text;
    const call = { text, opts, node };
    m.calls.push(call);
    if (m.failWith) return Promise.reject(new Error(m.failWith));
    if (m.mode === 'hold') return new Promise((resolve) => { m.pending.push(() => resolve({ node, diagrams: { ok: 0, failed: 0 } })); });
    return Promise.resolve({ node, diagrams: { ok: 0, failed: 0 } });
  };
  return m;
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
const settle = async () => { for (let i = 0; i < 8; i += 1) await tick(); };

const reply = (path, text, over = {}) => ({ ok: true, path, text, size: text.length, mtimeMs: 100, hash: 'H1', bom: false, eol: 'lf', editable: true, ...over });

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}

function setup({ storage = memoryStorage(), withMarkdown = true, openExternal } = {}) {
  const cm = fakeCodeMirror();
  globalThis.repoCodeMirror = cm;
  const md = fakeMarkdown();
  if (withMarkdown) globalThis.repoMarkdown = md; else delete globalThis.repoMarkdown;
  const { doc, el } = fakeDoc();
  if (!withMarkdown) doc.createElement = (tag) => { const e = new El(tag); if (tag === 'script') setImmediate(() => e.onerror && e.onerror()); return e; };
  doc.head.append = () => {};
  const requester = manualRequester();
  const external = [];
  const { create } = require('../app/repo-reader');
  const rd = create({
    doc, requester, harness: {}, onOpenUrl: openExternal || ((u) => { external.push(u); return Promise.resolve(true); }),
    storage, typeMention: () => {}, onClose: () => {}, confirmDiscard: async () => true,
  });
  return { rd, requester, el, cm, md, storage, external };
}

async function openFile(s, path, text, over) {
  const p = s.rd.open(path);
  await tick();
  s.requester.last('read').resolve(reply(path, text, over));
  await p;
  await settle();
}

test.afterEach(() => { delete globalThis.repoCodeMirror; delete globalThis.repoMarkdown; });

// ---- the segment ----

test('a Markdown file opens Rendered by default, with the Rendered | Source segment showing', async () => {
  const s = setup();
  await openFile(s, 'documentation/BUILD.md', '# Title\n');
  assert.strictEqual(s.md.calls.length, 1);
  assert.strictEqual(s.md.calls[0].text, '# Title\n');
  assert.strictEqual(s.md.calls[0].opts.fromFile, 'documentation/BUILD.md', 'relative links resolve against this file');
  assert.strictEqual(s.el('reader-view').hidden, false);
  assert.strictEqual(s.el('reader-view-rendered').attrs['aria-pressed'], 'true');
  assert.strictEqual(s.el('reader-view-source').attrs['aria-pressed'], 'false');
  assert.strictEqual(s.el('reader-md').hidden, false);
  assert.strictEqual(s.el('reader-body').hidden, true);
  assert.strictEqual(s.el('reader-md').children[0], s.md.calls[0].node);
});

test('.markdown and any letter case count; a file that merely contains "md" does not', async () => {
  for (const [name, expect] of [['a.markdown', 1], ['A.MD', 1], ['notes.md.txt', 0], ['md', 0], ['x.mdx', 0]]) {
    const s = setup();
    await openFile(s, name, 'text');
    assert.strictEqual(s.md.calls.length, expect, name);
    assert.strictEqual(s.el('reader-view').hidden, expect === 0, name);
  }
});

test('any other file shows no segment and never loads or calls the Markdown bundle', async () => {
  const s = setup();
  await openFile(s, 'src/app.js', 'const a = 1;\n');
  assert.strictEqual(s.md.calls.length, 0);
  assert.strictEqual(s.el('reader-view').hidden, true);
  assert.strictEqual(s.el('reader-md').hidden, true);
  assert.strictEqual(s.el('reader-body').hidden, false);
});

test('Source shows the code view and is remembered for this install; the next Markdown file opens in it', async () => {
  const s = setup();
  await openFile(s, 'a.md', 'one');
  s.el('reader-view-source').click();
  await settle();
  assert.strictEqual(s.el('reader-md').hidden, true);
  assert.strictEqual(s.el('reader-body').hidden, false);
  assert.strictEqual(s.el('reader-view-source').attrs['aria-pressed'], 'true');
  assert.strictEqual(s.storage.data.readerMarkdownView, 'source');
  const before = s.md.calls.length;
  await openFile(s, 'b.md', 'two');
  assert.strictEqual(s.md.calls.length, before, 'no render in Source');
  assert.strictEqual(s.el('reader-body').hidden, false);
  assert.strictEqual(s.el('reader-view').hidden, false, 'the segment is still there to go back');
  s.el('reader-view-rendered').click();
  await settle();
  assert.strictEqual(s.md.calls[s.md.calls.length - 1].text, 'two');
  assert.strictEqual(s.el('reader-md').hidden, false);
  assert.strictEqual(s.storage.data.readerMarkdownView, 'rendered');
});

test('a stored choice of Source is honoured at startup; junk in storage means Rendered', async () => {
  const a = setup({ storage: memoryStorage({ readerMarkdownView: 'source' }) });
  await openFile(a, 'a.md', 'x');
  assert.strictEqual(a.md.calls.length, 0);
  const b = setup({ storage: memoryStorage({ readerMarkdownView: 'banana' }) });
  await openFile(b, 'a.md', 'x');
  assert.strictEqual(b.md.calls.length, 1);
  const c = setup({ storage: { getItem() { throw new Error('refused'); }, setItem() { throw new Error('refused'); } } });
  await openFile(c, 'a.md', 'x');
  assert.strictEqual(c.md.calls.length, 1, 'storage refusing is not an error');
  c.el('reader-view-source').click();
  await settle();
  assert.strictEqual(c.el('reader-md').hidden, true);
});

// ---- Edit, Diff and failures fall back to the source ----

test('Edit forces Source (the segment goes), and Done brings the page back with the text as it is', async () => {
  const s = setup();
  await openFile(s, 'a.md', 'one\n');
  assert.strictEqual(s.el('reader-edit').hidden, false, 'Edit is offered from the rendered page');
  s.el('reader-edit').click();
  await settle();
  assert.strictEqual(s.el('reader-md').hidden, true);
  assert.strictEqual(s.el('reader-body').hidden, false);
  assert.strictEqual(s.el('reader-view').hidden, true, 'no segment while editing');
  s.cm.made[0].type('one\ntwo\n');
  await settle();
  s.el('reader-save').click();
  await tick();
  s.requester.last('write').resolve({ ok: true, hash: 'H2', size: 8, mtimeMs: 200 });
  await settle();
  s.el('reader-edit').click();                       // Done, clean after the save
  await settle();
  assert.strictEqual(s.el('reader-view').hidden, false);
  assert.strictEqual(s.el('reader-md').hidden, false);
  assert.strictEqual(s.md.calls[s.md.calls.length - 1].text, 'one\ntwo\n', 'the page shows the saved text');
});

test('Done after discarding edits renders the version started from', async () => {
  const s = setup();
  await openFile(s, 'a.md', 'orig\n');
  s.el('reader-edit').click();
  await settle();
  s.cm.made[0].type('changed\n');
  await settle();
  s.el('reader-edit').click();                       // Done: asks, the test says yes
  await settle();
  assert.strictEqual(s.md.calls[s.md.calls.length - 1].text, 'orig\n');
  assert.strictEqual(s.el('reader-md').hidden, false);
});

test('Diff shows the diff as code; File comes back to the page', async () => {
  const s = setup();
  await openFile(s, 'a.md', 'one\n', { modified: true });
  assert.strictEqual(s.el('reader-diff').hidden, false);
  s.el('reader-diff').click();
  await tick();
  s.requester.last('diff').resolve({ ok: true, source: 'git', text: '@@ -1 +1 @@\n-a\n+b\n', path: 'a.md' });
  await settle();
  assert.strictEqual(s.el('reader-md').hidden, true);
  assert.strictEqual(s.el('reader-body').hidden, false);
  assert.strictEqual(s.el('reader-view').hidden, true, 'no segment over a diff');
  s.el('reader-diff').click();                       // File
  await tick();
  s.requester.last('read').resolve(reply('a.md', 'one\n', { modified: true }));
  await settle();
  assert.strictEqual(s.el('reader-md').hidden, false);
});

test('a bundle that cannot load shows the source and says why, never an empty pane', async () => {
  const s = setup({ withMarkdown: false });
  await openFile(s, 'a.md', 'text');
  assert.strictEqual(s.el('reader-md').hidden, true);
  assert.strictEqual(s.el('reader-body').hidden, false);
  assert.match(s.el('reader-meta').textContent, /couldn.t render/);
  assert.match(s.el('reader-meta').textContent, /showing the source/);
});

test('a render that throws falls back the same way, and a later file tries again', async () => {
  const s = setup();
  s.md.failWith = 'boom';
  await openFile(s, 'a.md', 'text');
  assert.strictEqual(s.el('reader-body').hidden, false);
  assert.match(s.el('reader-meta').textContent, /boom/);
  s.md.failWith = null;
  await openFile(s, 'b.md', 'text2');
  assert.strictEqual(s.el('reader-md').hidden, false);
  assert.doesNotMatch(s.el('reader-meta').textContent, /boom/);
});

test('a render that finishes after the person moved to another file is dropped', async () => {
  const s = setup();
  s.md.mode = 'hold';
  await openFile(s, 'a.md', 'AAA');
  assert.strictEqual(s.el('reader-md').hidden, true, 'nothing shown while rendering');
  assert.strictEqual(s.el('reader-body').hidden, true, 'and no flash of source either');
  const p = s.rd.open('src/b.js');
  await tick();
  s.requester.last('read').resolve(reply('src/b.js', 'b();\n'));
  await p;
  await settle();
  s.md.pending.forEach((release) => release());
  await settle();
  assert.strictEqual(s.el('reader-md').hidden, true, 'a.md must not paint over b.js');
  assert.strictEqual(s.el('reader-body').hidden, false);
  assert.strictEqual(s.el('reader-md').children.length, 0);
});

test('switching to Source while a render is pending drops that render', async () => {
  const s = setup();
  s.md.mode = 'hold';
  await openFile(s, 'a.md', 'AAA');
  s.el('reader-view-source').click();
  await settle();
  s.md.pending.forEach((release) => release());
  await settle();
  assert.strictEqual(s.el('reader-md').hidden, true);
  assert.strictEqual(s.el('reader-body').hidden, false);
});

test('a refusal note hides the page; the next readable file shows it again; closing empties it', async () => {
  const s = setup();
  await openFile(s, 'a.md', 'x');
  const p = s.rd.open('big.md');
  await tick();
  s.requester.last('read').resolve({ ok: false, why: 'too-large', size: 9e6, limit: 2e6 });
  await p;
  assert.strictEqual(s.el('reader-md').hidden, true);
  assert.strictEqual(s.el('reader-note').hidden, false);
  await openFile(s, 'c.md', 'y');
  assert.strictEqual(s.el('reader-md').hidden, false);
  assert.strictEqual(s.el('reader-note').hidden, true);
  await s.rd.close();
  assert.strictEqual(s.el('reader-md').children.length, 0, 'the rendered DOM is released');
});

// ---- selections and the prompt ----

test('@ in prompt from the rendered page mentions the whole file, not a stale selection in the hidden source', async () => {
  const s = setup();
  await openFile(s, 'docs/a.md', 'x');
  assert.strictEqual(s.rd.selectionInfo(), null, 'no line selection is reported while the page is showing');
  s.el('reader-view-source').click();
  await settle();
  assert.deepStrictEqual(s.rd.selectionInfo(), { file: 'docs/a.md', start: 2, end: 4 });
});

// ---- links ----

test('a file link opens that file in the reader; an http link goes to the browser; nothing else is passed on', async () => {
  const s = setup();
  await openFile(s, 'documentation/BUILD.md', 'x');
  const { onLink } = s.md.calls[0].opts;
  onLink({ kind: 'http', target: 'https://example.com/' });
  assert.deepStrictEqual(s.external, ['https://example.com/']);
  onLink({ kind: 'file', target: 'app/main.js', fragment: '' });
  await tick();
  assert.deepStrictEqual(s.requester.last('read').body, { path: 'app/main.js' });
  const reads = s.requester.all('read').length;
  for (const bad of [{ kind: 'inert', target: null }, { kind: 'anchor', target: 'x' }, { kind: 'mailto', target: 'a@b.c' }, { kind: 'file', target: '' }, { kind: 'file', target: 5 }, { kind: 'http', target: 'javascript:alert(1)' }, { kind: 'http', target: 'file:///C:/x' }, null, 'x']) {
    onLink(bad);
  }
  await tick();
  assert.strictEqual(s.requester.all('read').length, reads);
  assert.deepStrictEqual(s.external, ['https://example.com/']);
});

test('an http link the bridge refuses or throws on is reported in the meta line, not thrown', async () => {
  const s = setup({ openExternal: () => { throw new Error('no browser'); } });
  await openFile(s, 'a.md', 'x');
  s.md.calls[0].opts.onLink({ kind: 'http', target: 'https://example.com/' });
  await settle();
  assert.match(s.el('reader-meta').textContent, /could not open/);
});

test('the same file changed on disk re-renders in place', async () => {
  const s = setup();
  await openFile(s, 'a.md', 'v1');
  s.el('reader-md').scrollTop = 120;
  const p = s.rd.open('a.md', { keepMode: true, discard: true });
  await tick();
  s.requester.last('read').resolve(reply('a.md', 'v2', { hash: 'H2' }));
  await p;
  await settle();
  assert.strictEqual(s.md.calls[s.md.calls.length - 1].text, 'v2');
  assert.strictEqual(s.el('reader-md').scrollTop, 120, 'the reading place is kept for the same file');
});

// ---- source contracts: what no behaviour test can see ----

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('the Markdown bundle is loaded lazily: renderer.html has the elements but never lists the script', () => {
  const html = read('app', 'renderer.html');
  assert.ok(!/<script[^>]*markdown/i.test(html), 'a <script> for the 5 MB bundle would load it at startup and move the tab page\'s start cost');
  for (const id of ['reader-md', 'reader-view', 'reader-view-rendered', 'reader-view-source']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(read('app', 'repo-reader.js'), /MD_SCRIPT = '\.\/markdown-reader\.js'/);
  const startup = html.match(/<script src="[^"]+"><\/script>/g) || [];
  assert.ok(startup.length > 50 && startup.every((t) => !/markdown/.test(t)));
});

test('the bundle exposes one global, repoMarkdown, and the entry never builds DOM from a string by hand', () => {
  const bundle = read('app', 'markdown-reader.js');
  assert.match(bundle, /window\.repoMarkdown=/);
  const entry = read('build', 'markdown-entry.mjs');
  const render = read('build', 'markdown-render.mjs');
  for (const [name, src] of [['entry', entry], ['render', render]]) {
    assert.doesNotMatch(src, /\binnerHTML\b|\binsertAdjacentHTML\b|\bouterHTML\b|document\.write|\beval\(|new Function/, `${name}: every byte of HTML reaches the DOM through DOMPurify's fragment`);
  }
  assert.match(entry, /securityLevel: 'strict'/);
  assert.match(entry, /startOnLoad: false/);
  assert.match(entry, /layout: 'dagre'/);
  assert.match(entry, /diagramFragment\(svg/, 'a diagram goes through the sanitizer again');
  assert.doesNotMatch(entry, /from 'dompurify'|DOMPurify\./, 'the entry never touches the shared DOMPurify: Mermaid hooks it (PR #204 Y2)');
  assert.match(render, /createDOMPurify\(win\)/,'the page has its own DOMPurify instance');
  assert.strictEqual((render.match(/RETURN_DOM_FRAGMENT: true/g) || []).length, 2, 'the page and a diagram both mount the sanitized tree, never a re-parsed string');
  assert.strictEqual((render.match(/purify\.sanitize\(/g) || []).length, 2);
});

test('an http link reaches the browser through the page: renderer.js hands repoBrowser an onOpenUrl, which passes it to the reader', () => {
  const page = read('app', 'renderer.js');
  const block = page.slice(page.indexOf('window.repoBrowser.create({'), page.indexOf('window.repoBrowser.create({') + 3000);
  assert.match(block, /onOpenUrl: \(url\) => .*harness\.openExternal\(url\)/);
  assert.match(read('app', 'repo-browser.js'), /Reader\.create\(\{[^}]*onOpenUrl/);
});
