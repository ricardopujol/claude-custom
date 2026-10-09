'use strict';
/**
 * BACKLOG #81: how the strip draws a side session's tab and a reader's occupancy mark (app/tab-strip.js,
 * app/tab-strip.html). The strip decides nothing: the shell's model says `side`, `role` and `readersOnly`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { paint } = require('../app/tab-strip');

function node(tag) {
  const n = {
    tag, className: '', textContent: '', title: '', hidden: false, type: '', dataset: {},
    value: '', disabled: false, focus() {}, onsubmit: null, onkeydown: null,
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
  return { calls, select: (k) => calls.push(['select', k]), close: (k, s) => calls.push(['close', k, s]), contextMenu: (k) => calls.push(['menu', k]) };
};
const child = (tab, cls) => tab.children.find(c => c.className.split(' ').includes(cls));
const classesOf = (t) => t.className.split(' ');
const SIDE = (o = {}) => entry({ key: 'k|side', label: 'feat/a · side', closable: false, side: true, parentKey: 'k', role: 'reader', ...o });

test('a side tab is drawn as a small tab: the "side" class, its label, and NO close button', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({}), SIDE()] }, bridgeSpy());
  const [, side] = doc.byId.tabs.children;
  assert.ok(classesOf(side).includes('side'));
  assert.strictEqual(child(side, 'label').textContent, 'feat/a · side');
  assert.strictEqual(child(side, 'x'), undefined, 'it ends with its branch tab, not by a click of its own');
  assert.match(side.title, /only Read, Grep, Glob, WebFetch, WebSearch and TodoWrite/, 'its hover says what it is, and only what is true');
  assert.match(side.title, /No Bash, PowerShell, Edit, Write or MCP/);
});

test('an ordinary tab carries no "side" class, whatever else it has', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ selected: true, side: false })] }, bridgeSpy());
  assert.ok(!classesOf(doc.byId.tabs.children[0]).includes('side'));
});

test('clicking a side tab selects it, and a Ctrl+click on it only selects: nothing closes it', () => {
  const doc = fakeDoc();
  const bridge = bridgeSpy();
  paint(doc, { model: [SIDE()] }, bridge);
  const tab = doc.byId.tabs.children[0];
  tab.listeners.click({});
  tab.listeners.click({ ctrlKey: true });
  assert.deepStrictEqual(bridge.calls, [['select', 'k|side'], ['select', 'k|side']]);
});

test('right-clicking a side tab asks main for its menu, by its own key', () => {
  const doc = fakeDoc();
  const bridge = bridgeSpy();
  paint(doc, { model: [SIDE()] }, bridge);
  doc.byId.tabs.children[0].listeners.contextmenu({ preventDefault() {} });
  assert.deepStrictEqual(bridge.calls, [['menu', 'k|side']]);
});

test('a reader\'s occupancy mark keeps the initials but not the hatched edge', () => {
  const doc = fakeDoc();
  const occ = { tags: ['EX'], more: 0, warn: false, lines: ['Explore · reading only'], count: 0, readersOnly: true };
  paint(doc, { model: [entry({ occupancy: occ })] }, bridgeSpy());
  const tab = doc.byId.tabs.children[0];
  assert.ok(!classesOf(tab).includes('occupied'), 'nobody is WORKING here');
  assert.ok(classesOf(tab).includes('reading'));
  assert.deepStrictEqual(child(tab, 'agent-tags').children.map(t => t.textContent), ['EX']);
  assert.match(tab.title, /reading only/);
});

test('a writer\'s mark is the hatched edge it always was, and only a real true means readers only', () => {
  const doc = fakeDoc();
  const occ = (readersOnly) => ({ tags: ['EP'], more: 0, warn: false, lines: ['x'], count: 1, readersOnly });
  paint(doc, { model: [entry({ key: 'a', occupancy: occ(false) }), entry({ key: 'b', occupancy: occ('yes') }), entry({ key: 'c', occupancy: occ(undefined) })] }, bridgeSpy());
  for (const t of doc.byId.tabs.children) {
    assert.ok(classesOf(t).includes('occupied'));
    assert.ok(!classesOf(t).includes('reading'));
  }
});

test('the page styles .side small and .reading without a hatched edge', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  assert.match(html, /\.tab\.side\s*\{[^}]*font-size/);
  assert.match(html, /\.tab\.side\s*\{[^}]*max-width/);
  assert.doesNotMatch(html, /\.tab\.reading::after/, 'a reader gets no hatched edge');
  assert.match(html, /\.tab\.reading \.agent-tag/);
});
