'use strict';
/**
 * BACKLOG #156 (agent cues, part 2): the envelope badge on the tab. The count rides the tab's status from the page to the shell
 * (app/tab-status.js), onto the strip's model (app/tab-model.js) and is drawn by the strip (app/tab-strip.js). A look at the tab
 * clears it (afterSelected), like the urgent dot. Absence is never a number: no count is 0, drawn as nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tabStatus, afterSelected, sameStatus } = require('../app/tab-status');
const { stripModel } = require('../app/tab-model');
const { paint } = require('../app/tab-strip');

test('the page\'s count becomes the status\'s messages: a whole number 0..99, else 0', () => {
  assert.strictEqual(tabStatus({ pendingMessages: 3 }).messages, 3);
  assert.strictEqual(tabStatus({ pendingMessages: 99 }).messages, 99);
  for (const bad of [undefined, null, -1, 1.5, NaN, '2', true, 100, 1e9]) assert.strictEqual(tabStatus({ pendingMessages: bad }).messages, 0, String(bad));
});

test('a look clears the count with the urgent dot, and a different count is a different status', () => {
  const s = tabStatus({ pendingUrgent: true, pendingMessages: 2 });
  assert.strictEqual(afterSelected(s).messages, 0);
  assert.strictEqual(afterSelected(s).needsInput, false);
  assert.strictEqual(sameStatus(s, { ...s, messages: 3 }), false);
  assert.strictEqual(sameStatus(s, { ...s }), true);
  assert.strictEqual(sameStatus({ ...s, messages: undefined }, { ...s, messages: 0 }), true, 'a status from before this field is zero');
});

const state = { tabs: [{ path: 'C:\\p\\dev', branch: 'develop', isDev: true }, { path: 'C:\\p\\feat-a', branch: 'feat/a' }] };

test('the strip\'s model carries the count of each tab, 0 for a tab nobody heard from', () => {
  const runtime = new Map([['c:/p/feat-a', { started: true, status: { messages: 2, needsInput: true } }]]);
  const keyOf = p => p.replace(/\\/g, '/').toLowerCase();
  const model = stripModel(state, runtime, 'c:/p/dev', { keyOf });
  assert.deepStrictEqual(model.map(e => e.messages), [0, 2]);
});

function node(tag) {
  const n = {
    tag, className: '', textContent: '', title: '', hidden: false, type: '', dataset: {}, children: [], listeners: {},
    appendChild(c) { n.children.push(c); return c; }, replaceChildren(...cs) { n.children = cs; }, addEventListener(name, fn) { n.listeners[name] = fn; },
  };
  return n;
}
const doc = () => { const byId = { tabs: node('div'), pane: node('div'), 'pane-text': node('div'), 'pane-retry': node('button') }; return { byId, createElement: node, getElementById: id => byId[id] }; };
const entry = o => ({ key: 'k', label: 'feat/a', isDev: false, selected: false, started: true, closable: true, working: false, needsInput: false, lockGlyph: null, health: null, phase: 'live', error: null, ...o });
const bridge = { select() {}, close() {}, contextMenu() {} };
const part = (tab, cls) => tab.children.find(c => c.className.split(' ')[0] === cls);

test('the strip draws an envelope with the count right of the label, only when there is one', () => {
  const d = doc();
  paint(d, { model: [entry({ key: 'a', messages: 2 }), entry({ key: 'b', messages: 0 }), entry({ key: 'c' }), entry({ key: 'd', messages: 'many' })] }, bridge);
  const [a, b, c, e] = d.byId.tabs.children;
  const env = part(a, 'envelope');
  assert.ok(env, 'an envelope');
  assert.strictEqual(env.textContent, '\u2709 2');
  assert.match(env.title, /2 messages? from other sessions? .*approval/i);
  assert.ok(a.children.indexOf(env) > a.children.indexOf(part(a, 'label')), 'after the label');
  for (const t of [b, c, e]) assert.strictEqual(part(t, 'envelope'), undefined);
});

test('one message reads in the singular', () => {
  const d = doc();
  paint(d, { model: [entry({ messages: 1 })] }, bridge);
  const env = part(d.byId.tabs.children[0], 'envelope');
  assert.strictEqual(env.textContent, '\u2709 1');
  assert.match(env.title, /^1 message from another session/);
});

test('the shell cuts a renderer\'s count down to the same whole number, and the strip page styles the envelope', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-shell.js'), 'utf8');
  assert.match(shell, /messages: tabStatusLib\.cleanCount\(o\.messages\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  assert.match(html, /\.envelope\s*\{/);
});
