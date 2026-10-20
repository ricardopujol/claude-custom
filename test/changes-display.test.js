'use strict';
/**
 * The Changes dock panel (BACKLOG #119 A3, app/changes-display.js): the state a list answer makes, what the rows say, the scope
 * switch, the keyboard, and the mounted panel driven with a fake root.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const D = require('../app/changes-display');

const FILES = [
  { path: 'app/a.js', status: 'M', add: 12, del: 3, binary: false },
  { path: 'docs/new file.md', status: 'A', add: 40, del: 0, binary: false, untracked: true },
  { path: 'img/logo.png', status: 'M', add: null, del: null, binary: true },
  { path: 'new/name.js', oldPath: 'old/name.js', status: 'R', add: 0, del: 0, binary: false },
  { path: 'gone.txt', status: 'D', add: 0, del: 7, binary: false },
];
const reply = (over) => ({ ok: true, type: 'changes', action: 'list', scope: 'working', base: 'develop', files: FILES, total: 5, more: 0, summary: { files: 5, add: 52, del: 10, unknown: 1 }, ...over });

test('a fresh state asks for `auto` and shows nothing yet', () => {
  const s = D.emptyState();
  assert.deepStrictEqual([s.asked, s.scope, s.files, s.loaded, s.error], ['auto', null, [], false, null]);
  const v = D.view(s, {});
  assert.deepStrictEqual(v.rows, []);
  assert.match(v.note, /Looking at the worktree/);
});

test('a list answer fills the state; the scope SHOWN is the one the host used, the one ASKED is unchanged', () => {
  const s = D.withReply(D.emptyState(), reply());
  assert.deepStrictEqual([s.asked, s.scope, s.base, s.loaded, s.total], ['auto', 'working', 'develop', true, 5]);
  assert.strictEqual(s.files.length, 5);
});

test('the selection survives a refresh while its file is still listed, and goes when the file does', () => {
  let s = D.withReply(D.emptyState(), reply());
  s = D.select(s, 'app/a.js');
  assert.strictEqual(D.withReply(s, reply()).selected, 'app/a.js');
  assert.strictEqual(D.withReply(s, reply({ files: FILES.slice(1) })).selected, null);
  assert.strictEqual(D.select(s, 'not listed').selected, 'app/a.js', 'selecting a path the list lacks changes nothing');
});

test('a failed answer keeps the last list on screen and says why, instead of blanking', () => {
  const ok = D.withReply(D.emptyState(), reply());
  const bad = D.withReply(ok, { ok: false, error: 'git diff failed: boom' });
  assert.strictEqual(bad.files.length, 5);
  assert.strictEqual(bad.error, 'git diff failed: boom');
  assert.strictEqual(D.withReply(bad, reply()).error, null);
  assert.strictEqual(D.withReply(ok, { ok: false, why: 'unknown action' }).error, 'unknown action');
  assert.strictEqual(D.withReply(ok, null).error, 'no answer from the session');
});

test('the scope switch: Working tree | vs <base>; the active one follows what the host used, a click asks explicitly', () => {
  let s = D.withReply(D.emptyState(), reply({ scope: 'branch', base: 'main' }));
  let v = D.view(s, {});
  assert.deepStrictEqual(v.scopes, [{ id: 'working', label: 'Working tree', on: false }, { id: 'branch', label: 'vs main', on: true }]);
  s = D.setAsked(s, 'working');
  assert.strictEqual(s.asked, 'working');
  assert.strictEqual(D.setAsked(s, 'nonsense').asked, 'working');
  assert.deepStrictEqual(D.view(D.emptyState(), {}).scopes.map(x => x.label), ['Working tree', 'vs develop']);
});

test('rows: path split for the left ellipsis, status, counts, a dot when Claude touched it, binary as bin, deleted shows its removals', () => {
  const s = D.withReply(D.emptyState(), reply());
  const v = D.view(s, { touched: (p) => p === 'app/a.js' });
  const by = Object.fromEntries(v.rows.map(r => [r.path, r]));
  assert.deepStrictEqual([by['app/a.js'].status, by['app/a.js'].add, by['app/a.js'].del, by['app/a.js'].touched], ['M', '+12', '−3', true]);
  assert.deepStrictEqual([by['img/logo.png'].add, by['img/logo.png'].del], ['bin', '']);
  assert.deepStrictEqual([by['gone.txt'].status, by['gone.txt'].add, by['gone.txt'].del], ['D', '+0', '−7']);
  assert.strictEqual(by['new/name.js'].title, 'new/name.js (was old/name.js)');
  assert.strictEqual(by['docs/new file.md'].touched, false);
  assert.strictEqual(by['docs/new file.md'].untracked, true);
  assert.deepStrictEqual([by['app/a.js'].dir, by['app/a.js'].name], ['app/', 'a.js']);
  assert.deepStrictEqual([by['gone.txt'].dir, by['gone.txt'].name], ['', 'gone.txt']);
});

test('an unread count (null, not binary) is a question mark, never a confident zero', () => {
  const s = D.withReply(D.emptyState(), reply({ files: [{ path: 'big.log', status: 'A', add: null, del: null, binary: false, untracked: true }] }));
  const r = D.view(s, {}).rows[0];
  assert.deepStrictEqual([r.add, r.del], ['?', '']);
});

test('the summary line is the host\'s numbers, and a capped list says how many more', () => {
  const s = D.withReply(D.emptyState(), reply({ total: 512, more: 12, summary: { files: 512, add: 340, del: 58, unknown: 0 } }));
  const v = D.view(s, {});
  assert.strictEqual(v.summary, '512 files · +340 −58');
  assert.deepStrictEqual(v.more, { n: 12, text: '+12 more files not listed' });
  assert.strictEqual(D.view(D.withReply(D.emptyState(), reply({ more: 1, total: 6 })), {}).more.text, '+1 more file not listed');
  assert.strictEqual(D.view(D.withReply(D.emptyState(), reply()), {}).more, null);
});

test('an empty answer says so in words: the working tree is clean, or the branch has nothing against its base', () => {
  const w = D.view(D.withReply(D.emptyState(), reply({ files: [], total: 0, summary: { files: 0, add: 0, del: 0, unknown: 0 } })), {});
  assert.strictEqual(w.note, 'The working tree matches HEAD: nothing to review.');
  const b = D.view(D.withReply(D.emptyState(), reply({ scope: 'branch', base: 'develop', files: [], total: 0, summary: { files: 0, add: 0, del: 0, unknown: 0 } })), {});
  assert.strictEqual(b.note, 'This branch has no changes against develop.');
});

test('an error with no list is the whole panel; with a list it is a line above it', () => {
  const none = D.view(D.withReply(D.emptyState(), { ok: false, error: 'no develop, main or master branch to compare with' }), {});
  assert.strictEqual(none.note, 'no develop, main or master branch to compare with');
  assert.deepStrictEqual(none.rows, []);
  const kept = D.view(D.withReply(D.withReply(D.emptyState(), reply()), { ok: false, error: 'timeout' }), {});
  assert.strictEqual(kept.rows.length, 5);
  assert.match(kept.note, /timeout/);
});

test('move: up and down within the list, stopping at the ends; from nothing, down is the first and up is the last', () => {
  let s = D.withReply(D.emptyState(), reply());
  s = D.move(s, 1); assert.strictEqual(s.selected, 'app/a.js');
  s = D.move(s, 1); assert.strictEqual(s.selected, 'docs/new file.md');
  s = D.move(s, -1); s = D.move(s, -1); assert.strictEqual(s.selected, 'app/a.js');
  const end = D.move(D.select(s, 'gone.txt'), 1);
  assert.strictEqual(end.selected, 'gone.txt');
  assert.strictEqual(D.move(D.withReply(D.emptyState(), reply()), -1).selected, 'gone.txt');
  assert.strictEqual(D.move(D.emptyState(), 1).selected, null);
});

test('keys: arrows move, Enter opens, anything with a modifier or another key is left alone', () => {
  assert.deepStrictEqual(D.keyAction({ key: 'ArrowDown' }), { type: 'move', delta: 1 });
  assert.deepStrictEqual(D.keyAction({ key: 'ArrowUp' }), { type: 'move', delta: -1 });
  assert.deepStrictEqual(D.keyAction({ key: 'Enter' }), { type: 'open' });
  for (const e of [{ key: 'ArrowDown', ctrlKey: true }, { key: 'Enter', altKey: true }, { key: 'Enter', metaKey: true }, { key: 'a' }, null, undefined, {}]) assert.strictEqual(D.keyAction(e), null);
});

test('actionOf: a button\'s data attributes become one action, or nothing', () => {
  assert.deepStrictEqual(D.actionOf({ act: 'scope', scope: 'branch' }), { type: 'scope', scope: 'branch' });
  assert.strictEqual(D.actionOf({ act: 'scope', scope: 'weird' }), null);
  assert.deepStrictEqual(D.actionOf({ act: 'refresh' }), { type: 'refresh' });
  assert.deepStrictEqual(D.actionOf({ act: 'open', path: 'a/b.js' }), { type: 'open', path: 'a/b.js' });
  assert.strictEqual(D.actionOf({ act: 'open' }), null);
  assert.strictEqual(D.actionOf({ act: 'open', path: '' }), null);
  assert.strictEqual(D.actionOf(null), null);
  assert.strictEqual(D.actionOf({ act: 'x' }), null);
});

test('html: a path with markup in it is text, in the page and in the attribute', () => {
  const evil = '"><img src=x onerror=alert(1)>.js';
  const s = D.withReply(D.emptyState(), reply({ files: [{ path: evil, status: 'M', add: 1, del: 1, binary: false }], total: 1 }));
  const html = D.html(D.view(s, {}));
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('data-path="&quot;&gt;&lt;img'));
});

test('html: the active scope button is pressed, the selected row is marked, a touched file has its dot', () => {
  let s = D.withReply(D.emptyState(), reply());
  s = D.select(s, 'app/a.js');
  const html = D.html(D.view(s, { touched: (p) => p === 'app/a.js' }));
  assert.match(html, /data-act="scope" data-scope="working" aria-pressed="true"/);
  assert.match(html, /data-act="scope" data-scope="branch" aria-pressed="false"/);
  assert.match(html, /class="chg-row sel"[^>]*data-path="app\/a\.js"/);
  assert.match(html, /class="chg-dot"/);
  assert.match(html, /data-act="refresh"/);
});

test('PROPERTY: the view never throws and lists at most the files it was given, for any reply shape', () => {
  fc.assert(fc.property(fc.anything(), (r) => {
    const s = D.withReply(D.emptyState(), r);
    const v = D.view(s, { touched: () => true });
    assert.ok(Array.isArray(v.rows) && v.rows.length <= (r && Array.isArray(r.files) ? r.files.length : 0));
    assert.strictEqual(typeof D.html(v), 'string');
  }));
});

// ---- mounted ----

function fakeRoot() {
  const handlers = {};
  const list = { scrollTop: 0, focus() { list.focused = true; }, focused: false };
  return {
    innerHTML: '', handlers, list,
    addEventListener(t, fn) { handlers[t] = fn; },
    querySelector(sel) { return sel === '.chg-list' ? list : null; },
    contains() { return false; },
    click(dataset) { handlers.click({ target: { closest: (s) => (s === '[data-act]' ? { dataset } : null) } }); },
    key(e) { let prevented = false; handlers.keydown({ ...e, preventDefault() { prevented = true; } }); return prevented; },
  };
}

function mount(over = {}) {
  const root = fakeRoot();
  const asked = [];
  const opened = [];
  const replies = [];
  const request = (action, body) => { asked.push({ action, body }); return new Promise((resolve) => replies.push(resolve)); };
  const p = D.mount({ doc: {}, root, request, isTouched: (p) => p === 'app/a.js', openChange: (o) => { opened.push(o); }, usage: () => {}, ...over });
  const answer = async (r) => { replies.shift()(r); await new Promise(res => setImmediate(res)); };
  return { root, p, asked, opened, answer, replies };
}

test('mounted: nothing is asked while the panel is hidden; showing it asks once, with the scope asked (auto at first)', async () => {
  const m = mount();
  assert.strictEqual(m.asked.length, 0);
  m.p.onChanged();
  assert.strictEqual(m.asked.length, 0, 'a change while hidden is remembered, not acted on');
  m.p.show();
  assert.deepStrictEqual(m.asked, [{ action: 'list', body: { scope: 'auto' } }]);
  await m.answer(reply());
  assert.match(m.root.innerHTML, /app\/a\.js/);
  assert.match(m.root.innerHTML, /12 files|5 files/);
});

test('mounted: a change push while showing refreshes; a push during a refresh coalesces into exactly one more', async () => {
  const m = mount();
  m.p.show();
  await m.answer(reply());
  m.p.onChanged();
  m.p.onChanged();
  m.p.onChanged();
  assert.strictEqual(m.asked.length, 2, 'one refresh in flight');
  await m.answer(reply());
  assert.strictEqual(m.asked.length, 3, 'and one more for what arrived meanwhile');
  await m.answer(reply());
  assert.strictEqual(m.asked.length, 3);
});

test('mounted: hiding stops refreshing; showing again refreshes', async () => {
  const m = mount();
  m.p.show(); await m.answer(reply());
  m.p.hide();
  m.p.onChanged();
  assert.strictEqual(m.asked.length, 1);
  m.p.show();
  assert.strictEqual(m.asked.length, 2);
});

test('mounted: clicking the other scope asks for it explicitly, and the explicit choice sticks through refreshes', async () => {
  const m = mount();
  m.p.show(); await m.answer(reply());
  m.root.click({ act: 'scope', scope: 'branch' });
  assert.deepStrictEqual(m.asked[1].body, { scope: 'branch' });
  await m.answer(reply({ scope: 'branch' }));
  m.p.onChanged();
  assert.deepStrictEqual(m.asked[2].body, { scope: 'branch' });
});

test('mounted: the refresh button asks again; a row click selects it and hands the reader the change', async () => {
  const m = mount();
  m.p.show(); await m.answer(reply());
  m.root.click({ act: 'refresh' });
  assert.strictEqual(m.asked.length, 2);
  await m.answer(reply());
  m.root.click({ act: 'open', path: 'new/name.js' });
  assert.deepStrictEqual(m.opened, [{ path: 'new/name.js', oldPath: 'old/name.js', status: 'R', scope: 'working', base: 'develop' }]);
  assert.strictEqual(m.p.state().selected, 'new/name.js');
});

test('mounted: Enter opens the selected row, arrows move it, and the keys are consumed only when they did something', async () => {
  const m = mount();
  m.p.show(); await m.answer(reply());
  assert.strictEqual(m.root.key({ key: 'ArrowDown' }), true);
  assert.strictEqual(m.p.state().selected, 'app/a.js');
  assert.strictEqual(m.root.key({ key: 'ArrowDown' }), true);
  assert.strictEqual(m.root.key({ key: 'Enter' }), true);
  assert.strictEqual(m.opened.length, 1);
  assert.strictEqual(m.opened[0].path, 'docs/new file.md');
  assert.strictEqual(m.root.key({ key: 'x' }), false);
  const empty = mount();
  empty.p.show(); await empty.answer(reply({ files: [], total: 0 }));
  assert.strictEqual(empty.root.key({ key: 'Enter' }), false, 'Enter with nothing selected does nothing');
});

test('DEXTER 7 / MIGUEL Y4: Enter and the arrows on a focused BUTTON belong to the button: the list does not open the selected file or swallow the key', async () => {
  const m = mount();
  m.p.show(); await m.answer(reply());
  m.root.key({ key: 'ArrowDown' });
  const onScope = { tagName: 'BUTTON', closest: (s) => (s === 'button' ? {} : null) };
  assert.strictEqual(m.root.key({ key: 'Enter', target: onScope }), false, 'not consumed, so the browser clicks the button');
  assert.strictEqual(m.root.key({ key: 'ArrowDown', target: { tagName: 'SPAN', closest: (s) => (s === 'button' ? {} : null) } }), false);
  assert.deepStrictEqual(m.opened, []);
  assert.strictEqual(m.p.state().selected, 'app/a.js');
  assert.strictEqual(m.root.key({ key: 'Enter', target: { tagName: 'DIV', closest: () => null } }), true, 'on the list it still opens');
  assert.strictEqual(m.opened.length, 1);
});

test('mounted: a request that fails is shown, not swallowed, and the next refresh recovers', async () => {
  const m = mount();
  m.p.show();
  await m.answer({ ok: false, error: 'the host did not answer in time' });
  assert.match(m.root.innerHTML, /the host did not answer in time/);
  m.p.onChanged();
  await m.answer(reply());
  assert.ok(!/did not answer/.test(m.root.innerHTML));
});

test('mounted: a rejected request is an error line too (the requester never rejects, but a seam might)', async () => {
  const root = fakeRoot();
  const p = D.mount({ doc: {}, root, request: () => Promise.reject(new Error('seam broke')), isTouched: () => false, openChange: () => {}, usage: () => {} });
  p.show();
  await new Promise(res => setImmediate(res));
  assert.match(root.innerHTML, /seam broke/);
});

test('mounted: the list keeps its scroll and its focus across a redraw', async () => {
  const m = mount();
  m.p.show(); await m.answer(reply());
  m.root.list.scrollTop = 120;
  m.root.list.focused = false;
  m.root.contains = () => true;            // the focus was inside the panel
  m.p.onChanged();
  await m.answer(reply());
  assert.strictEqual(m.root.list.scrollTop, 120);
});

test('mounted: opening a file and a scope change are counted for the usage page', async () => {
  const seen = [];
  const m = mount({ usage: (k) => seen.push(k) });
  m.p.show(); await m.answer(reply());
  m.root.click({ act: 'open', path: 'app/a.js' });
  m.root.click({ act: 'scope', scope: 'branch' });
  assert.deepStrictEqual(seen, ['changes:file-opened', 'changes:scope']);
});
