'use strict';
/**
 * The strip page and "From an issue" (BACKLOG #119 A6): the row in the branch form, the list panel, the pick that
 * fills the branch field and carries the issue's number into Create, the dim line when gh can't list, and the
 * tab's hover line. The strip decides nothing: every row and every branch name here is main's answer.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { paint, issuesView, issueLine } = require('../app/tab-strip');

function node(tag) {
  const n = {
    tag, className: '', textContent: '', title: '', hidden: false, type: '', dataset: {},
    value: '', disabled: false, focused: 0, focus() { n.focused++; },
    onsubmit: null, onkeydown: null, oninput: null, children: [], listeners: {}, onclick: null,
    appendChild(c) { n.children.push(c); return c; },
    replaceChildren(...cs) { n.children = cs; },
    addEventListener(name, fn) { n.listeners[name] = fn; },
  };
  return n;
}
function pageDoc() {
  const byId = { tabs: node('div'), pane: node('div'), 'pane-text': node('div'), 'pane-retry': node('button') };
  for (const id of ['strip-alert', 'plus', 'create', 'create-branch', 'create-cancel', 'create-issues', 'issues-panel',
    'issues-filter', 'issues-close', 'issues-list', 'issues-note']) byId[id] = node(id === 'create' ? 'form' : 'div');
  return { byId, createElement: node, getElementById: (id) => byId[id] };
}
const entry = (o) => ({ key: 'k', label: 'feat/a', isDev: false, selected: false, started: true, closable: true, working: false, needsInput: false,
  lockGlyph: null, health: null, phase: 'live', error: null, starting: false, startError: null, ...o });
const settle = () => new Promise(r => setImmediate(r));

const ROWS = [
  { number: 12, title: 'Crash on start', labels: ['bug'], branch: 'fix/12-crash-on-start' },
  { number: 7, title: 'Add the widget', labels: ['enhancement'], branch: 'feat/7-add-the-widget' },
];
const OK = { ok: true, rows: ROWS, total: 2 };

function rig(replyFor = () => OK) {
  const doc = pageDoc();
  const calls = [];
  const resolvers = [];
  const bridge = {
    select() {}, close() {}, contextMenu() {},
    plus: () => calls.push(['plus']),
    create: (...a) => calls.push(['create', ...a]),
    cancelCreate: () => calls.push(['cancel']),
    pickerOpen: () => calls.push(['pickerOpen']),
    pickerClose: () => calls.push(['pickerClose']),
    issues: (req) => { calls.push(['issues', req]); const r = replyFor(req); return r instanceof Promise ? r : Promise.resolve(r); },
  };
  const show = (create) => paint(doc, { model: [entry()], mode: 'tabs', create }, bridge);
  return { doc, calls, bridge, show, resolvers };
}

test('a fresh form reads the issues once (refreshed), and the row says what it found', async () => {
  const r = rig();
  r.show(null);
  r.show({ phase: 'input' });
  await settle();
  assert.deepStrictEqual(r.calls.filter(c => c[0] === 'issues'), [['issues', { query: '', refresh: true }]]);
  const btn = r.doc.byId['create-issues'];
  assert.strictEqual(btn.textContent, 'From an issue ▾');
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.title, '2 open issues');
  r.show({ phase: 'input' });                     // a poll repaints: no second read
  await settle();
  assert.strictEqual(r.calls.filter(c => c[0] === 'issues').length, 1);
});

test('when gh cannot list, the row is one dim line and the typed path still works', async () => {
  const r = rig(() => ({ ok: false, text: 'Sign in to gh to pick an issue' }));
  r.show({ phase: 'input' });
  await settle();
  const btn = r.doc.byId['create-issues'];
  assert.strictEqual(btn.textContent, 'Sign in to gh to pick an issue');
  assert.strictEqual(btn.disabled, true);
  assert.strictEqual(btn.className, 'dim');
  r.doc.byId['create-branch'].value = 'feat/typed';
  r.doc.byId.create.onsubmit({ preventDefault() {} });
  assert.deepStrictEqual(r.calls.at(-1), ['create', 'feat/typed']);
});

test('a read that rejects is the same dim line, never an exception', async () => {
  const r = rig(() => Promise.reject(new Error('ipc gone')));
  r.show({ phase: 'input' });
  await settle();
  assert.strictEqual(r.doc.byId['create-issues'].disabled, true);
  assert.match(r.doc.byId['create-issues'].textContent, /read issues/);
});

test('the row asks main to open the list; the list shows only while the shell says picker', async () => {
  const r = rig();
  r.show({ phase: 'input' });
  await settle();
  r.doc.byId['create-issues'].onclick();
  assert.deepStrictEqual(r.calls.at(-1), ['pickerOpen']);
  assert.strictEqual(r.doc.byId['issues-panel'].hidden, true);
  r.show({ phase: 'input', picker: true });
  assert.strictEqual(r.doc.byId['issues-panel'].hidden, false);
  assert.strictEqual(r.doc.byId['issues-filter'].focused, 1, 'the filter takes the keyboard');
  assert.deepStrictEqual(r.calls.filter(c => c[0] === 'issues').at(-1), ['issues', { query: '', refresh: false }]);
  await settle();
  const rows = r.doc.byId['issues-list'].children;
  assert.strictEqual(rows.length, 2);
  assert.match(rows[0].className, /\bissue-row\b/);
  assert.strictEqual(rows[0].children[0].textContent, '#12');
  assert.strictEqual(rows[0].children[1].textContent, 'Crash on start');
  assert.ok(rows[0].children.some(c => c.className === 'issue-label' && c.textContent === 'bug'));
  assert.ok(rows[0].children.some(c => c.className === 'issue-branch' && c.textContent === 'fix/12-crash-on-start'));
  r.show({ phase: 'input' });
  assert.strictEqual(r.doc.byId['issues-panel'].hidden, true);
});

test('picking a row fills the branch field, closes the list, and Create carries the issue number', async () => {
  const r = rig();
  r.show({ phase: 'input' });
  r.show({ phase: 'input', picker: true });
  await settle();
  r.doc.byId['issues-list'].children[0].onclick();
  assert.strictEqual(r.doc.byId['create-branch'].value, 'fix/12-crash-on-start');
  assert.deepStrictEqual(r.calls.at(-1), ['pickerClose']);
  r.doc.byId['create-branch'].value = 'fix/12-crash-on-start-v2';      // editable before Create
  r.doc.byId.create.onsubmit({ preventDefault() {} });
  assert.deepStrictEqual(r.calls.at(-1), ['create', 'fix/12-crash-on-start-v2', 12]);
});

test('emptying the field forgets the pick, and a new form starts with none', async () => {
  const r = rig();
  r.show({ phase: 'input' });
  r.show({ phase: 'input', picker: true });
  await settle();
  r.doc.byId['issues-list'].children[1].onclick();
  const input = r.doc.byId['create-branch'];
  input.value = '';
  input.oninput();
  input.value = 'feat/other';
  r.doc.byId.create.onsubmit({ preventDefault() {} });
  assert.deepStrictEqual(r.calls.at(-1), ['create', 'feat/other']);
  // pick again, cancel, open a fresh form
  r.show({ phase: 'input', picker: true });
  await settle();
  r.doc.byId['issues-list'].children[0].onclick();
  r.show(null);
  r.show({ phase: 'input' });
  input.value = 'feat/again';
  r.doc.byId.create.onsubmit({ preventDefault() {} });
  assert.deepStrictEqual(r.calls.at(-1), ['create', 'feat/again']);
});

test('a refusal keeps the field and the pick, so the person can fix the name and retry', async () => {
  const r = rig();
  r.show({ phase: 'input' });
  r.show({ phase: 'input', picker: true });
  await settle();
  r.doc.byId['issues-list'].children[0].onclick();
  r.show({ phase: 'running', branch: 'fix/12-crash-on-start' });
  r.show({ phase: 'failed', branch: 'fix/12-crash-on-start', error: 'nope' });
  r.doc.byId.create.onsubmit({ preventDefault() {} });
  assert.deepStrictEqual(r.calls.at(-1), ['create', 'fix/12-crash-on-start', 12]);
});

test('typing in the filter asks main with the query (no refresh); an older answer never replaces a newer one', async () => {
  const pending = [];
  const r = rig((req) => (req.query === '' ? OK : new Promise((res) => { pending.push([req.query, res]); })));
  r.show({ phase: 'input' });
  r.show({ phase: 'input', picker: true });
  await settle();
  const filter = r.doc.byId['issues-filter'];
  filter.value = 'wid';
  filter.oninput();
  filter.value = 'widget';
  filter.oninput();
  assert.deepStrictEqual(r.calls.filter(c => c[0] === 'issues').slice(-2).map(c => c[1]),
    [{ query: 'wid', refresh: false }, { query: 'widget', refresh: false }]);
  pending[1][1]({ ok: true, rows: [ROWS[1]], total: 2 });          // the newer answer arrives first
  await settle();
  pending[0][1]({ ok: true, rows: ROWS, total: 2 });               // the older one limps in
  await settle();
  assert.deepStrictEqual(r.doc.byId['issues-list'].children.map(c => c.children[0].textContent), ['#7']);
});

test('the note says what an empty answer means: no issues at all, or none that match', async () => {
  assert.strictEqual(issuesView({ ok: true, rows: [], total: 0 }).note, 'No open issues.');
  assert.strictEqual(issuesView({ ok: true, rows: [], total: 5 }).note, 'No issue matches.');
  assert.strictEqual(issuesView({ ok: true, rows: ROWS, total: 2 }).note, '');
  assert.strictEqual(issuesView(null).note, 'Loading issues…');
  assert.deepStrictEqual(issuesView({ ok: false, text: 'x' }).button, { text: 'x', enabled: false, dim: true, title: 'x' });
  assert.strictEqual(issuesView({ ok: false }).button.text, 'Couldn’t read issues');
  assert.strictEqual(issuesView({ ok: true, rows: ROWS, total: 1 }).button.title, '1 open issue');
});

test('Esc in the filter and the x close the list and give the keyboard back to the branch field', async () => {
  const r = rig();
  r.show({ phase: 'input' });
  r.show({ phase: 'input', picker: true });
  await settle();
  const before = r.doc.byId['create-branch'].focused;
  let prevented = false;
  r.doc.byId['issues-filter'].onkeydown({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  r.doc.byId['issues-close'].onclick();
  assert.deepStrictEqual(r.calls.filter(c => c[0] === 'pickerClose').length, 2);
  assert.strictEqual(r.doc.byId['create-branch'].focused, before + 2);
  r.doc.byId['issues-filter'].onkeydown({ key: 'a', preventDefault: () => assert.fail('only Escape is taken') });
});

test('a repaint does not rebuild the rows under a click: the same answer is drawn once', async () => {
  const r = rig();
  r.show({ phase: 'input' });
  r.show({ phase: 'input', picker: true });
  await settle();
  const first = r.doc.byId['issues-list'].children[0];
  r.show({ phase: 'input', picker: true });
  r.show({ phase: 'input', picker: true });
  assert.strictEqual(r.doc.byId['issues-list'].children[0], first);
});

test('a page without the issue elements, or a bridge without the issue calls, paints as before', () => {
  const doc = pageDoc();
  for (const id of ['create-issues', 'issues-panel']) delete doc.byId[id];
  assert.doesNotThrow(() => paint(doc, { model: [entry()], mode: 'tabs', create: { phase: 'input' } },
    { select() {}, close() {}, contextMenu() {}, plus() {}, create() {}, cancelCreate() {} }));
  const old = pageDoc();
  assert.doesNotThrow(() => paint(old, { model: [entry()], mode: 'tabs', create: { phase: 'input', picker: true } },
    { select() {}, close() {}, contextMenu() {}, plus() {}, create() {}, cancelCreate() {} }));
});

// --- the tab's hover ----------------------------------------------------------------------------

test('issueLine: "#12 title", "#12" with no title, and nothing for a malformed record', () => {
  assert.strictEqual(issueLine({ number: 12, title: 'Fix it', url: null }), '#12 Fix it');
  assert.strictEqual(issueLine({ number: 12, title: null }), '#12');
  for (const bad of [null, undefined, 5, 'x', [], {}, { number: '12', title: 'x' }, { number: 0 }, { number: 1.5 }]) {
    assert.strictEqual(issueLine(bad), null, JSON.stringify(bad));
  }
});

test('paint: a tab made from an issue shows #n and its title on hover, under the other lines', () => {
  const doc = pageDoc();
  paint(doc, { model: [entry({ key: 'a', issue: { number: 12, title: 'Crash on start', url: null } }), entry({ key: 'b', issue: null }), entry({ key: 'c' })] }, {});
  const [a, b, c] = doc.byId.tabs.children;
  assert.strictEqual(a.title, 'feat/a\n#12 Crash on start');
  assert.strictEqual(b.title, 'feat/a');
  assert.strictEqual(c.title, 'feat/a');
});

test('tab-strip.html: the row is inside the form; the list panel is outside #tabs and starts hidden', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  const formAt = html.indexOf('id="create"');
  const formEnd = html.indexOf('</form>', formAt);
  const rowAt = html.indexOf('id="create-issues"');
  assert.ok(rowAt > formAt && rowAt < formEnd, 'the row sits in the branch form');
  const tabsEnd = html.indexOf('</div>', html.indexOf('id="tabs"'));
  for (const id of ['create-issues', 'issues-panel', 'issues-filter', 'issues-close', 'issues-list', 'issues-note']) {
    assert.ok(html.indexOf(`id="${id}"`) > tabsEnd, `${id} is outside #tabs (a repaint rebuilds #tabs)`);
  }
  assert.match(html, /id="issues-panel"[^>]*\bhidden\b/);
});
