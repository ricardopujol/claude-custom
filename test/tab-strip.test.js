'use strict';
/**
 * The strip page's painter (app/tab-strip.js) against a minimal fake DOM, and
 * the shape of its bridge (app/preload-strip.js). The strip decides nothing:
 * these pin that it DRAWS what the model says -- the close x only when the tab
 * is closable, dim when not started, a glyph only when there is one -- and
 * that it writes text with textContent (a branch name is somebody else's
 * string).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { paneFor, paint, GLYPHS } = require('../app/tab-strip');

// --- a fake DOM, just enough for paint() ---------------------------------------
function node(tag) {
  const n = {
    tag, className: '', textContent: '', title: '', hidden: false, type: '', dataset: {},
    children: [], listeners: {}, onclick: null,
    appendChild(c) { n.children.push(c); return c; },
    replaceChildren(...cs) { n.children = cs; },
    addEventListener(name, fn) { n.listeners[name] = fn; },
  };
  return n;
}
function fakeDoc() {
  const byId = { tabs: node('div'), pane: node('div'), 'pane-text': node('div'), 'pane-retry': node('button') };
  return { byId, createElement: node, getElementById: (id) => byId[id] };
}
const entry = (o) => ({
  key: 'k', label: 'feat/a', isDev: false, selected: false, started: true, closable: true,
  working: false, needsInput: false, lockGlyph: null, health: null, phase: 'live', error: null,
  starting: false, startError: null, ...o,
});
const bridgeSpy = () => {
  const calls = [];
  return { calls, select: (k) => calls.push(['select', k]), close: (k) => calls.push(['close', k]), contextMenu: (k) => calls.push(['menu', k]) };
};
const child = (tab, cls) => tab.children.find(c => c.className.split(' ').includes(cls));

test('paneFor: null when the selected tab has its own page; words while it does not', () => {
  assert.strictEqual(paneFor({ model: [entry({ selected: true })] }), null);
  assert.deepStrictEqual(paneFor({ model: [entry({ selected: true, started: false, starting: true })] }),
    { text: 'Starting feat/a…', retry: null });
  assert.deepStrictEqual(paneFor({ model: [entry({ selected: true, started: false, startError: 'no port' })] }),
    { text: "Couldn't start feat/a: no port", retry: 'k' });
  assert.deepStrictEqual(paneFor({ model: [entry({ selected: true, started: false })] }),
    { text: 'feat/a is not started yet.', retry: 'k' });
});

test('paneFor with nothing selected says why, from the notice when there is one', () => {
  assert.deepStrictEqual(paneFor({ model: [] }), { text: 'No worktrees yet.', retry: null });
  assert.deepStrictEqual(paneFor({ model: [], notice: "can't list worktrees: x" }), { text: "can't list worktrees: x", retry: null });
  assert.deepStrictEqual(paneFor(null), { text: 'No worktrees yet.', retry: null });
  assert.deepStrictEqual(paneFor({ model: 'nope', notice: 5 }), { text: 'No worktrees yet.', retry: null });
});

test('paint: one .tab per entry, in order, selected and dim classes from the model', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ key: 'a', label: 'develop', isDev: true, selected: true }),
    entry({ key: 'b', label: 'feat/b', started: false })] }, bridgeSpy());
  const tabs = doc.byId.tabs.children;
  assert.deepStrictEqual(tabs.map(t => t.dataset.key), ['a', 'b']);
  assert.match(tabs[0].className, /\bselected\b/);
  assert.match(tabs[0].className, /\bdev\b/);
  assert.doesNotMatch(tabs[0].className, /\bdim\b/);
  assert.match(tabs[1].className, /\bdim\b/, 'not started: dimmed');
  assert.deepStrictEqual(tabs.map(t => child(t, 'label').textContent), ['develop', 'feat/b']);
});

test('paint: dots, glyph and health appear only when the model says so', () => {
  const doc = fakeDoc();
  paint(doc, { model: [
    entry({ key: 'plain' }),
    entry({ key: 'busy', working: true, needsInput: true, lockGlyph: 'blocked', health: '↓3' }),
  ] }, bridgeSpy());
  const [plain, busy] = doc.byId.tabs.children;
  for (const c of ['working', 'needs', 'glyph', 'health']) assert.strictEqual(child(plain, c), undefined, c);
  assert.ok(child(busy, 'working') && child(busy, 'needs'));
  assert.strictEqual(child(busy, 'glyph').textContent, GLYPHS.blocked);
  assert.strictEqual(child(busy, 'health').textContent, '↓3');
});

test('paint: an unknown lock glyph draws nothing rather than a guess', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ lockGlyph: 'mystery' })] }, bridgeSpy());
  assert.strictEqual(child(doc.byId.tabs.children[0], 'glyph'), undefined);
});

test('paint: the close x exists only for a closable tab, and closing does not also select', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: [entry({ key: 'dev', isDev: true, closable: false }), entry({ key: 'a' })] }, b);
  const [dev, a] = doc.byId.tabs.children;
  assert.strictEqual(child(dev, 'x'), undefined, 'dev has no close (criterion 6)');
  const x = child(a, 'x');
  assert.ok(x);
  let stopped = false;
  x.listeners.click({ stopPropagation: () => { stopped = true; } });
  assert.strictEqual(stopped, true);
  assert.deepStrictEqual(b.calls, [['close', 'a']]);
});

test('paint: click selects, right-click asks main for the menu (and stops the browser\'s own)', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: [entry({ key: 'a' })] }, b);
  const tab = doc.byId.tabs.children[0];
  tab.listeners.click();
  let prevented = false;
  tab.listeners.contextmenu({ preventDefault: () => { prevented = true; } });
  assert.deepStrictEqual(b.calls, [['select', 'a'], ['menu', 'a']]);
  assert.strictEqual(prevented, true);
});

test('paint: the pane shows while the tab has no page; Retry re-selects the failed tab', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: [entry({ key: 'a', selected: true, started: false, startError: 'boom' })] }, b);
  assert.strictEqual(doc.byId.pane.hidden, false);
  assert.strictEqual(doc.byId['pane-text'].textContent, "Couldn't start feat/a: boom");
  assert.strictEqual(doc.byId['pane-retry'].hidden, false);
  doc.byId['pane-retry'].onclick();
  assert.deepStrictEqual(b.calls, [['select', 'a']]);
  paint(doc, { model: [entry({ key: 'a', selected: true })] }, b);
  assert.strictEqual(doc.byId.pane.hidden, true);
  assert.strictEqual(doc.byId['pane-retry'].hidden, true);
  assert.strictEqual(doc.byId['pane-retry'].onclick, null);
});

test('paint never uses innerHTML: a branch name is text, not markup', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('the strip bridge exposes select, close, contextMenu and onModel -- and nothing else', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'preload-strip.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  const block = src.slice(src.indexOf("exposeInMainWorld('strip', {"));
  const members = [...block.matchAll(/^  ([A-Za-z]+):/gm)].map(m => m[1]);
  assert.deepStrictEqual(members, ['select', 'close', 'contextMenu', 'onModel']);
  assert.match(src, /'strip:select'/);
  assert.match(src, /'strip:close'/);
  assert.match(src, /'strip:contextMenu'/);
  assert.match(src, /removeAllListeners\('strip-model'\)/);
});

test('tab-strip.html loads only its own script and starts with the pane hidden', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  assert.deepStrictEqual([...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]), ['./tab-strip.js']);
  assert.match(html, /id="pane"[^>]*\bhidden\b/);
  assert.match(html, /id="tabs"/);
  assert.match(html, /height: 34px/);
});

test('F3 (Dexter, PR #75): a failed stop is drawn IN the strip, as text, and cleared when gone', () => {
  const doc = fakeDoc();
  doc.byId['strip-alert'] = node('div');
  const model = [entry({ selected: true })];
  paint(doc, { model, closeNotice: "Couldn't end the session in feat/a: handshake refused (HTTP 403). It may still be running." }, bridgeSpy());
  assert.strictEqual(doc.byId['strip-alert'].hidden, false);
  assert.match(doc.byId['strip-alert'].textContent, /feat\/a.*403.*may still be running/);
  paint(doc, { model, closeNotice: null }, bridgeSpy());
  assert.strictEqual(doc.byId['strip-alert'].hidden, true);
  assert.strictEqual(doc.byId['strip-alert'].textContent, '');
});
