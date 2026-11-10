'use strict';
/**
 * The pin glyph on the strip page (BACKLOG #167, Ricardo's pick P4 "A": a pin glyph before the status dot) and the menu's wiring.
 * The page draws what main sends (`entry.pinned`) and decides nothing. Against a minimal fake DOM, as test/tab-strip-lanes.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { paint } = require('../app/tab-strip');

function node(tag) {
  const n = {
    tag, className: '', textContent: '', title: '', hidden: false, type: '', dataset: {}, draggable: false, parentNode: null,
    value: '', disabled: false, onclick: null, children: [], listeners: {}, offsetWidth: 0, clientWidth: 0, id: '', attrs: {},
    appendChild(c) { n.children.push(c); c.parentNode = n; return c; },
    replaceChildren(...cs) { n.children = cs; for (const c of cs) c.parentNode = n; },
    addEventListener(name, fn) { n.listeners[name] = fn; },
    setAttribute(k, v) { n.attrs[k] = v; },
    getBoundingClientRect() { return { left: 0, width: 100 }; },
    classList: {
      add(c) { if (!n.className.split(' ').includes(c)) n.className = `${n.className} ${c}`.trim(); },
      remove(c) { n.className = n.className.split(' ').filter(x => x !== c).join(' '); },
      contains(c) { return n.className.split(' ').includes(c); },
    },
  };
  return n;
}
function fakeDoc() {
  const byId = { tabs: node('div'), pane: node('div'), 'pane-text': node('div'), 'pane-retry': node('button'), lanes: node('button') };
  return {
    byId, createElement: node, createElementNS: (ns, tag) => node(tag), getElementById: (id) => byId[id],
    defaultView: { matchMedia: () => ({ matches: false }), getComputedStyle: () => ({ minWidth: '0px', marginLeft: '0px', marginRight: '0px' }) },
  };
}
const entry = (o) => ({
  key: 'k', label: 'feat/a', isDev: false, selected: false, started: true, closable: true,
  working: false, needsInput: false, lockGlyph: null, health: null, phase: 'live', error: null, starting: false, startError: null, ...o,
});
const spy = () => ({ select: () => {}, close: () => {}, contextMenu: () => {}, lanes: () => {}, reorder: () => {} });
const tabsOf = (model) => { const doc = fakeDoc(); paint(doc, { model, strip: model, mode: 'tabs', lanes: { notStarted: [], merged: [] } }, spy()); return doc.byId.tabs.children; };
const pinOf = (tab) => tab.children.find(c => /\bpin\b/.test(c.className));

test('a pinned lane\'s tab has a pin glyph with the hover text, before the status dot', () => {
  const [dev, a] = tabsOf([entry({ key: 'dev', isDev: true, label: 'develop', closable: false }), entry({ key: 'a', pinned: true, working: true })]);
  assert.strictEqual(pinOf(dev), undefined);
  const pin = pinOf(a);
  assert.ok(pin, 'the pin glyph is there');
  assert.strictEqual(pin.title, 'Pinned · resumes at launch · right-click to unpin');
  const dotAt = a.children.findIndex(c => /\bdot\b/.test(c.className));
  assert.ok(dotAt > a.children.indexOf(pin), 'the glyph comes before the dot');
  assert.strictEqual(a.children.indexOf(pin), 0, 'and first of all in the tab');
});

test('a tab that is not pinned draws no glyph, and only a real true draws one', () => {
  for (const pinned of [false, undefined, null, 'yes', 1, {}]) {
    const [a] = tabsOf([entry({ key: 'a', pinned })]);
    assert.strictEqual(pinOf(a), undefined, String(pinned));
  }
});

test('a side or shell tab never wears the glyph, whatever its entry says', () => {
  const tabs = tabsOf([entry({ key: 'a', pinned: true }), entry({ key: 'a|side', side: true, parentKey: 'a', pinned: true }), entry({ key: 'a|shell', shell: true, parentKey: 'a', pinned: true })]);
  assert.ok(pinOf(tabs[0]));
  assert.strictEqual(pinOf(tabs[1]), undefined);
  assert.strictEqual(pinOf(tabs[2]), undefined);
});

test('the glyph is a drawn pin, 11 px, tinted by --pin (the page defines it); not text', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  assert.match(html, /--pin\s*:/, 'the page defines --pin');
  assert.match(html, /\.pin\s*\{[^}]*width:\s*11px[^}]*height:\s*11px[^}]*color:\s*var\(--pin\)/, 'an 11 px pin in the --pin tint');
  const [a] = tabsOf([entry({ key: 'a', pinned: true })]);
  const pin = pinOf(a);
  assert.strictEqual(pin.textContent, '', 'the glyph carries no text: it is a drawing');
  assert.ok(pin.children.length > 0, 'an svg child');
});
