'use strict';
/**
 * BACKLOG #119 A5: how the strip draws a shell tab (app/tab-strip.js, app/tab-strip.html). The strip decides nothing: the shell's
 * model says `shell`, and the program's own state (OSC 7501) arrives as `program`.
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
const SHELL = (o = {}) => entry({ key: 'k|shell', label: 'feat/a · shell', closable: true, shell: true, parentKey: 'k', ...o });

test('a shell tab is drawn as a small tab: the "shell" class, its label, and a close button of its own', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({}), SHELL()] }, bridgeSpy());
  const [, tab] = doc.byId.tabs.children;
  assert.ok(classesOf(tab).includes('shell'));
  assert.ok(!classesOf(tab).includes('side'), 'it is not a side session, and says nothing of plan mode');
  assert.strictEqual(child(tab, 'label').textContent, 'feat/a · shell');
  const x = child(tab, 'x');
  assert.ok(x, 'Ricardo\'s look, 2026-10-26: a shell tab could not be closed');
  assert.match(x.title, /Close shell/);
  assert.doesNotMatch(x.title, /session/, 'a shell is not a session');
  assert.match(tab.title, /shell/i);
  assert.doesNotMatch(tab.title, /plan mode|Read, Grep/);
});

test('an ordinary tab and a side tab carry no "shell" class', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ selected: true }), entry({ key: 'k|side', side: true })] }, bridgeSpy());
  for (const t of doc.byId.tabs.children) assert.ok(!classesOf(t).includes('shell'));
});

test('clicking a shell tab selects it; its x and a Ctrl+click close it, by its own key', () => {
  const doc = fakeDoc();
  const bridge = bridgeSpy();
  paint(doc, { model: [SHELL()] }, bridge);
  const tab = doc.byId.tabs.children[0];
  tab.listeners.click({});
  child(tab, 'x').listeners.click({ stopPropagation() {} });
  tab.listeners.click({ ctrlKey: true });
  assert.deepStrictEqual(bridge.calls, [['select', 'k|shell'], ['close', 'k|shell', undefined], ['close', 'k|shell', true]]);
});

test('right-clicking a shell tab asks main for its menu, by its own key', () => {
  const doc = fakeDoc();
  const bridge = bridgeSpy();
  paint(doc, { model: [SHELL()] }, bridge);
  const tab = doc.byId.tabs.children[0];
  assert.strictEqual(typeof tab.listeners.contextmenu, 'function');
  tab.listeners.contextmenu({ preventDefault() {} });
  assert.deepStrictEqual(bridge.calls, [['menu', 'k|shell']]);
});

test('a shell whose program speaks OSC 7501 gets the dots an ordinary tab gets, with the program\'s words in the tooltip', () => {
  const doc = fakeDoc();
  paint(doc, {
    model: [SHELL({ needsInput: true, program: { state: 'blocked', kind: 'permission', msg: 'Allow cargo publish?', progress: null } })],
  }, bridgeSpy());
  const tab = doc.byId.tabs.children[0];
  const dot = tab.children.find(c => c.className.split(' ').includes('dot'));
  assert.ok(dot, 'a dot');
  assert.ok(classesOf(dot).includes('needs'));
  assert.match(dot.title, /Allow cargo publish\?/);
});

test('a shell whose program says nothing is a plain tab: no dot', () => {
  const doc = fakeDoc();
  paint(doc, { model: [SHELL({ program: null })] }, bridgeSpy());
  assert.strictEqual(doc.byId.tabs.children[0].children.some(c => c.className.split(' ').includes('dot')), false);
});

test('the strip page styles a shell tab like a side tab (small, dashed)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  assert.match(html, /\.tab\.shell \{[^}]*font-size: 11px[^}]*border-left: 1px dashed/);
});
