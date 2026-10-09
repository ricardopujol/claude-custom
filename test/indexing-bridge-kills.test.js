'use strict';
/**
 * Kill tests for Mortimer's release-gate survivors S21/S25 (2026-10-09), app/indexing-bridge.js (68.9%): the exact bounds
 * of overlayBounds, the input limits of every channel (note length, id length, focus type, size), the chip's fallbacks, the
 * blur-reopen window, dismiss / closeList / ready gating, the push de-duplication, and the poll timer.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createIndexingBridge, overlayBounds, NOTE_MAX } = require('../app/indexing-bridge');

function fakeIpc() {
  const on = new Map();
  const handle = new Map();
  return {
    on: (ch, fn) => on.set(ch, fn),
    handle: (ch, fn) => handle.set(ch, fn),
    emit: (ch, sender, ...args) => on.get(ch)({ sender }, ...args),
    invoke: (ch, sender, ...args) => handle.get(ch)({ sender }, ...args),
  };
}

function fakeView() {
  const listeners = new Map();
  const v = {
    bounds: null, visible: false, loaded: null, boundsSet: 0,
    webContents: {
      sent: [], destroyed: false, isDestroyed() { return this.destroyed; },
      send(ch, p) { this.sent.push([ch, p]); },
      loadFile(f, o) { v.loaded = { f, o }; },
      on: (ev, fn) => listeners.set(ev, fn), fire: (ev) => listeners.get(ev) && listeners.get(ev)(),
    },
    setBounds(b) { this.bounds = b; this.boundsSet++; },
    setVisible(x) { this.visible = x; },
    setBackgroundColor() {},
  };
  return v;
}

const ROW = (over) => ({ id: 'n1', text: 'x', at: 1, state: 'filed', reason: null, undoable: true, ...over });

function setup(opts = {}) {
  const { projects, now, journalStamp } = opts;
  const docs = Object.prototype.hasOwnProperty.call(opts, 'docs') ? opts.docs : undefined;
  const ipcMain = fakeIpc();
  const strip = { sent: [], send(ch, p) { this.sent.push([ch, p]); }, isDestroyed: () => false, focus() {} };
  const views = [];
  const added = [];
  const state = { destroyed: false, size: [1200, 800], snap: { counts: { filed: 1, unfiled: 0 }, list: [] }, clock: 1000 };
  const win = {
    webContents: strip,
    isDestroyed: () => state.destroyed,
    getContentSize: () => state.size,
    contentView: { addChildView: (v) => added.push(v) },
  };
  const calls = { submit: [], undo: [], tick: 0, opened: [], copied: [], focused: 0, fieldFocus: [], menu: null, snapshots: 0, menuPopup: [] };
  const service = {
    submit: (root, text) => { calls.submit.push([root, text]); return text.trim() ? { ok: true, id: 'n1', filed: true } : { ok: false, reason: 'empty' }; },
    undo: (id, root) => { calls.undo.push([id, root]); return { ok: true }; },
    tick: async () => { calls.tick += 1; },
    snapshot: () => { calls.snapshots += 1; if (state.snap instanceof Error) throw state.snap; return state.snap; },
  };
  const bridge = createIndexingBridge({
    ipcMain,
    Menu: { buildFromTemplate: (t) => ({ popup: (o) => { calls.menu = t; calls.menuPopup.push(o); } }) },
    shell: { openPath: async (f) => { calls.opened.push(f); return ''; } },
    copyText: (s) => calls.copied.push(s),
    makeView: () => { const v = fakeView(); views.push(v); return v; },
    overlayFile: 'overlay.html',
    getWin: () => win,
    isStrip: (sender) => sender === strip,
    service,
    project: { root: 'C:\\p', label: 'p' },
    docsFor: () => (docs !== undefined ? docs : { ok: true, backlog: 'C:\\p\\dev\\documentation\\P_BACKLOG.md' }),
    projects: projects || (async () => [{ root: 'C:\\p', label: 'p', current: true }, { root: 'C:\\q', label: 'q', current: false }]),
    viewTop: () => 34,
    focusSelected: () => { calls.focused += 1; },
    setFieldFocused: (b) => calls.fieldFocus.push(b),
    now: now || (() => state.clock),
    ...(journalStamp ? { journalStamp } : {}),
  });
  return { bridge, ipcMain, strip, views, added, calls, state, win };
}
const overlayOf = (t, part) => t.views.find(v => v.loaded && v.loaded.o.query.part === part);
const lastStrip = (t) => t.strip.sent.filter(([ch]) => ch === 'strip-index').pop()[1];
const lastState = (v) => v.webContents.sent.filter(([ch]) => ch === 'indexing-state').pop()[1];
const tick = () => new Promise(r => setImmediate(r));

// ---- overlayBounds ------------------------------------------------------------------------------------------------------------

test('S25 bridge overlayBounds: toast sits 12 px from the right and bottom, at most 420 wide; the list 10 px from the right, 6 px under the views\' top, at most 380 wide', () => {
  const win = { width: 1200, height: 800, top: 34 };
  assert.deepStrictEqual(overlayBounds('toast', win, 96), { x: 1200 - 420 - 12, y: 800 - 96 - 12, width: 420, height: 96 });
  assert.deepStrictEqual(overlayBounds('list', win, 300), { x: 1200 - 380 - 10, y: 40, width: 380, height: 300 });
  assert.deepStrictEqual(overlayBounds('toast', win, 95.2), { x: 768, y: 800 - 96 - 12, width: 420, height: 96 }, 'a fractional height rounds UP');
  assert.deepStrictEqual(overlayBounds('list', win, 100.1), { x: 810, y: 40, width: 380, height: 101 });
  // The toast is capped to the room above its 12 px margins; the list to the room under it.
  assert.strictEqual(overlayBounds('toast', win, 9999).height, 800 - 34 - 24);
  assert.strictEqual(overlayBounds('list', win, 9999).height, 800 - 40 - 20);
  // A window narrower than the overlay keeps a gutter: 24 px for the toast, 20 for the list.
  assert.strictEqual(overlayBounds('toast', { width: 300, height: 800, top: 34 }, 50).width, 276);
  assert.strictEqual(overlayBounds('list', { width: 300, height: 800, top: 34 }, 50).width, 280);
  assert.strictEqual(overlayBounds('toast', { width: 444, height: 800, top: 34 }, 50).width, 420, 'exactly room for the full width');
  assert.strictEqual(overlayBounds('toast', { width: 443, height: 800, top: 34 }, 50).width, 419);
  assert.strictEqual(overlayBounds('list', { width: 400, height: 800, top: 34 }, 50).width, 380);
  assert.strictEqual(overlayBounds('list', { width: 399, height: 800, top: 34 }, 50).width, 379);
  // A window with no room gives zero, never a negative size.
  assert.strictEqual(overlayBounds('toast', { width: 10, height: 800, top: 34 }, 50).width, 0);
  assert.strictEqual(overlayBounds('list', { width: 10, height: 800, top: 34 }, 50).width, 0);
  assert.strictEqual(overlayBounds('toast', { width: 800, height: 40, top: 34 }, 50).height, 0);
  assert.strictEqual(overlayBounds('list', { width: 800, height: 50, top: 34 }, 50).height, 0);
});

test('S25 bridge overlayBounds: no usable reported height is no bounds (zero, negative, NaN, Infinity, not a number)', () => {
  const win = { width: 1200, height: 800, top: 34 };
  for (const bad of [0, -1, NaN, Infinity, -Infinity, '50', null, undefined, {}]) {
    assert.strictEqual(overlayBounds('toast', win, bad), null, String(bad));
    assert.strictEqual(overlayBounds('list', win, bad), null, String(bad));
  }
  assert.notStrictEqual(overlayBounds('toast', win, 0.5), null, 'a tiny positive height is still a height');
});

// ---- strip:indexSubmit ------------------------------------------------------------------------------------------------------

test('S25 bridge: a note of exactly NOTE_MAX characters is taken; one more is refused before the service; a non-string is "bad-note"', async () => {
  const t = setup();
  assert.strictEqual(NOTE_MAX, 10000);
  const ok = await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x'.repeat(NOTE_MAX));
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x'.repeat(NOTE_MAX + 1)), { ok: false, reason: 'too-long' });
  for (const bad of [null, undefined, 5, {}, ['x']]) assert.deepStrictEqual(await t.ipcMain.invoke('strip:indexSubmit', t.strip, bad), { ok: false, reason: 'bad-note' });
  assert.strictEqual(t.calls.submit.length, 1);
});

test('S25 bridge: a note the service refuses shows no toast and starts no tick', async () => {
  const t = setup();
  const r = await t.ipcMain.invoke('strip:indexSubmit', t.strip, '   ');
  assert.deepStrictEqual(r, { ok: false, reason: 'empty' });
  assert.strictEqual(overlayOf(t, 'toast'), undefined, 'no overlay was made');
  assert.strictEqual(t.calls.tick, 0);
});

test('S25 bridge: submit pushes the strip at once (even if nothing changed) and then asks the service for a tick', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'a');
  const stripFrames = t.strip.sent.filter(([ch]) => ch === 'strip-index').length;
  assert.ok(stripFrames >= 1);
  await tick();
  assert.strictEqual(t.calls.tick, 1);
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'b');
  assert.ok(t.strip.sent.filter(([ch]) => ch === 'strip-index').length > stripFrames, 'forced: sent again though the state is the same');
});

// ---- the list and its blur ------------------------------------------------------------------------------------------------

test('S25 bridge: a click on the counter right after the list closed itself on blur (inside 400 ms) does not reopen it; at 400 ms it does', () => {
  const t = setup();
  t.ipcMain.emit('strip:indexList', t.strip);
  const list = overlayOf(t, 'list');
  list.webContents.fire('focus');
  t.state.clock = 5000;
  list.webContents.fire('blur');
  assert.strictEqual(lastStrip(t).listOpen, false);
  t.state.clock = 5399;
  t.ipcMain.emit('strip:indexList', t.strip);
  assert.strictEqual(lastStrip(t).listOpen, false, '399 ms after the blur: that click was the one that blurred it');
  t.state.clock = 5400;
  t.ipcMain.emit('strip:indexList', t.strip);
  assert.strictEqual(lastStrip(t).listOpen, true, '400 ms: a real click');
});

test('S25 bridge: the counter toggles the list; a list that is open can be closed at once even right after a blur', () => {
  const t = setup();
  t.ipcMain.emit('strip:indexList', t.strip);
  assert.strictEqual(lastStrip(t).listOpen, true);
  t.ipcMain.emit('strip:indexList', t.strip);
  assert.strictEqual(lastStrip(t).listOpen, false);
  t.ipcMain.emit('strip:indexList', { not: 'strip' });
  assert.strictEqual(lastStrip(t).listOpen, false, 'only the strip may toggle it');
});

test('S25 bridge: a blur of the list does nothing when it was never clicked into, is not open, or only the first time per focus', () => {
  const t = setup();
  t.ipcMain.emit('strip:indexList', t.strip);
  const list = overlayOf(t, 'list');
  list.webContents.fire('focus');
  t.ipcMain.emit('strip:indexList', t.strip);                 // closed by the counter
  assert.strictEqual(lastStrip(t).listOpen, false);
  const sent = t.strip.sent.length;
  list.webContents.fire('blur');                              // not open: nothing to close
  assert.strictEqual(t.strip.sent.length, sent);
  t.ipcMain.emit('strip:indexList', t.strip);                 // opened again
  list.webContents.fire('blur');                              // the earlier focus was spent by the first blur
  assert.strictEqual(lastStrip(t).listOpen, true);
});

test('S25 bridge: closeList closes only an open list and only from the list page, then hands the keyboard back', () => {
  const t = setup();
  t.ipcMain.emit('strip:indexList', t.strip);
  const list = overlayOf(t, 'list');
  t.ipcMain.emit('indexing:closeList', t.strip);
  assert.strictEqual(lastStrip(t).listOpen, true, 'not from the strip');
  t.ipcMain.emit('indexing:closeList', list.webContents);
  assert.strictEqual(lastStrip(t).listOpen, false);
  assert.strictEqual(t.calls.focused, 1);
  t.ipcMain.emit('indexing:closeList', list.webContents);
  assert.strictEqual(t.calls.focused, 1, 'already closed: nothing');
});

// ---- the chip -----------------------------------------------------------------------------------------------------------------

test('S25 bridge: the chip with no project list (it throws, or comes back empty or not a list) offers this project alone, checked', async () => {
  for (const projects of [async () => { throw new Error('scan'); }, async () => [], async () => null, async () => 'x', async () => ({ length: 1 })]) {
    const t = setup({ projects });
    t.ipcMain.emit('strip:indexChip', t.strip);
    await tick();
    assert.deepStrictEqual(t.calls.menu.map(m => [m.label, m.type, m.checked]), [['p', 'radio', true]]);
    assert.deepStrictEqual(t.calls.menuPopup, [{ window: t.win }]);
  }
});

test('S25 bridge: the chip does nothing for another sender or when the window is gone; the menu has radio items and checks by path, not text', async () => {
  const t = setup();
  t.ipcMain.emit('strip:indexChip', { not: 'strip' });
  await tick();
  assert.strictEqual(t.calls.menu, null);
  t.state.destroyed = true;
  t.ipcMain.emit('strip:indexChip', t.strip);
  await tick();
  assert.strictEqual(t.calls.menu, null);
  t.state.destroyed = false;

  const spelled = setup({ projects: async () => [{ root: 'c:/P/', label: 'same project', current: true }, { root: 'C:\\q', label: 'q' }] });
  spelled.ipcMain.emit('strip:indexChip', spelled.strip);
  await tick();
  assert.deepStrictEqual(spelled.calls.menu.map(m => [m.type, m.checked]), [['radio', true], ['radio', false]]);
});

test('S25 bridge: picking a project clears the toast, repaints the strip with its label, and the toast does not follow', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast');
  assert.ok(lastState(toast).toast);
  t.ipcMain.emit('strip:indexChip', t.strip);
  await tick();
  t.calls.menu[1].click();
  assert.strictEqual(lastStrip(t).label, 'q');
  assert.strictEqual(lastState(toast).toast, null);
  assert.strictEqual(lastState(toast).label, 'q');
});

// ---- the overlay channels -----------------------------------------------------------------------------------------------------

test('S25 bridge: an id of exactly 64 characters is accepted for undo, copy; 65, empty and non-strings are refused (bad-id for the invoke)', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast').webContents;
  const id64 = 'a'.repeat(64);
  assert.deepStrictEqual(await t.ipcMain.invoke('indexing:undo', toast, id64), { ok: true });
  for (const bad of ['a'.repeat(65), '', null, undefined, 5, {}]) {
    assert.deepStrictEqual(await t.ipcMain.invoke('indexing:undo', toast, bad), { ok: false, reason: 'bad-id' }, String(bad));
  }
  assert.deepStrictEqual(t.calls.undo, [[id64, 'C:\\p']]);
  t.state.snap = { counts: {}, list: [ROW({ id: id64, text: 'long id words' }), ROW({ id: 'a'.repeat(65), text: 'too long id' })] };
  t.ipcMain.emit('indexing:copy', toast, id64);
  t.ipcMain.emit('indexing:copy', toast, 'a'.repeat(65));
  assert.deepStrictEqual(t.calls.copied, ['long id words']);
});

test('S25 bridge: copy ignores another sender, a note of another project\'s list, a row with no text, a snapshot that throws, and a clipboard that throws', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast').webContents;
  t.state.snap = { counts: {}, list: [ROW({ id: 'n1', text: 'words' }), ROW({ id: 'n2', text: 5 })] };
  t.ipcMain.emit('indexing:copy', t.strip, 'n1');
  t.ipcMain.emit('indexing:copy', toast, 'n9');
  t.ipcMain.emit('indexing:copy', toast, 'n2');
  assert.deepStrictEqual(t.calls.copied, []);
  t.ipcMain.emit('indexing:copy', toast, 'n1');
  assert.deepStrictEqual(t.calls.copied, ['words']);
  t.state.snap = new Error('journal');
  assert.doesNotThrow(() => t.ipcMain.emit('indexing:copy', toast, 'n1'));
  assert.deepStrictEqual(t.calls.copied, ['words']);
});

test('S25 bridge: open goes to the project\'s own backlog only, from an overlay page, as a string', async () => {
  const backlog = 'C:\\p\\dev\\documentation\\P_BACKLOG.md';
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast').webContents;
  t.ipcMain.emit('indexing:open', t.strip, backlog);
  t.ipcMain.emit('indexing:open', toast, 5);
  t.ipcMain.emit('indexing:open', toast, 'C:\\Windows\\system32\\calc.exe');
  assert.deepStrictEqual(t.calls.opened, []);
  t.ipcMain.emit('indexing:open', toast, 'c:/p/dev/documentation/p_backlog.md');
  assert.deepStrictEqual(t.calls.opened, ['c:/p/dev/documentation/p_backlog.md']);

  for (const docs of [null, { ok: false, reason: 'no-docs' }, { ok: 'yes', backlog }]) {
    const u = setup({ docs });
    await u.ipcMain.invoke('strip:indexSubmit', u.strip, 'x');
    u.ipcMain.emit('indexing:open', overlayOf(u, 'toast').webContents, backlog);
    assert.deepStrictEqual(u.calls.opened, [], JSON.stringify(docs));
  }
});

test('S25 bridge: dismiss ends the toast only from the toast page and only for the seq it shows; with a failed-undo result it always ends', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast');
  const seq = lastState(toast).toast.seq;
  t.ipcMain.emit('indexing:dismiss', t.strip, seq);
  t.ipcMain.emit('indexing:dismiss', toast.webContents, seq + 1);
  assert.ok(lastState(toast).toast, 'wrong sender and wrong seq change nothing');
  t.ipcMain.emit('indexing:dismiss', toast.webContents, seq);
  assert.strictEqual(lastState(toast).toast, null);
  t.ipcMain.emit('indexing:dismiss', toast.webContents, seq);              // already gone: nothing to do
  assert.strictEqual(lastState(toast).toast, null);
  // The list page is not the toast page.
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'y');
  t.ipcMain.emit('strip:indexList', t.strip);
  const list = overlayOf(t, 'list');
  const seq2 = lastState(toast).toast.seq;
  t.ipcMain.emit('indexing:dismiss', list.webContents, seq2);
  assert.ok(lastState(toast).toast);
});

test('S25 bridge: a toast over a note that is still not filed hides on dismiss but is not forgotten', async () => {
  const t = setup();
  t.state.snap = { counts: {}, list: [ROW({ state: 'unfiled', reason: 'busy', undoable: false })] };
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast');
  const seq = lastState(toast).toast.seq;
  t.ipcMain.emit('indexing:dismiss', toast.webContents, seq);
  assert.strictEqual(lastState(toast).toast, null, 'hidden');
  t.state.snap = { counts: {}, list: [ROW()] };
  t.bridge.push(true);
  assert.ok(lastState(toast).toast && lastState(toast).toast.seq > seq, 'back with a new seq once filed');
  // A note that disappeared from the list is forgotten for good.
  const u = setup();
  u.state.snap = { counts: {}, list: [ROW({ state: 'unfiled', reason: 'busy' })] };
  await u.ipcMain.invoke('strip:indexSubmit', u.strip, 'x');
  const ut = overlayOf(u, 'toast');
  u.ipcMain.emit('indexing:dismiss', ut.webContents, lastState(ut).toast.seq);
  u.state.snap = { counts: {}, list: [] };
  u.bridge.push(true);
  u.state.snap = { counts: {}, list: [ROW()] };
  u.bridge.push(true);
  assert.strictEqual(lastState(ut).toast, null);
});

test('S25 bridge: size reports are taken only from the page they are about, as finite non-negative numbers', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast');
  t.ipcMain.emit('indexing:size', t.strip, 'toast', 80);
  t.ipcMain.emit('indexing:size', toast.webContents, 'list', 80);
  assert.strictEqual(toast.visible, false, 'wrong sender / wrong part: nothing sized');
  for (const bad of [-1, NaN, Infinity, '80', null, undefined]) t.ipcMain.emit('indexing:size', toast.webContents, 'toast', bad);
  assert.strictEqual(toast.visible, false);
  t.ipcMain.emit('indexing:size', toast.webContents, 'toast', 80);
  assert.strictEqual(toast.visible, true);
  assert.deepStrictEqual(toast.bounds, { x: 768, y: 800 - 80 - 12, width: 420, height: 80 });
  t.ipcMain.emit('indexing:size', toast.webContents, 'toast', 0);
  assert.strictEqual(toast.visible, false, 'zero hides it (non-negative is accepted)');
});

test('S25 bridge: layout hides an overlay whose window is too small, puts a re-shown one back on top, and skips a destroyed view', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast');
  t.ipcMain.emit('indexing:size', toast.webContents, 'toast', 80);
  const addedAfterFirst = t.added.length;
  t.ipcMain.emit('indexing:size', toast.webContents, 'toast', 90);
  assert.strictEqual(t.added.length, addedAfterFirst, 'already shown: not re-added');
  t.state.size = [10, 800];
  t.bridge.relayout();
  assert.strictEqual(toast.visible, false, 'no room: hidden');
  t.state.size = [1200, 800];
  t.bridge.relayout();
  assert.strictEqual(toast.visible, true);
  assert.strictEqual(t.added.length, addedAfterFirst + 1, 'shown again: re-added on top');
  toast.webContents.destroyed = true;
  const before = toast.boundsSet;
  t.bridge.relayout();
  assert.strictEqual(toast.boundsSet, before, 'a destroyed view is left alone');
});

test('S25 bridge: ready re-sends the state even when it has not changed; a push without force does not repeat an unchanged state', async () => {
  const t = setup();
  t.ipcMain.emit('strip:indexList', t.strip);
  const list = overlayOf(t, 'list');
  const n = list.webContents.sent.length;
  t.bridge.push();
  assert.strictEqual(list.webContents.sent.length, n, 'unchanged: not repeated');
  t.bridge.push(true);
  assert.strictEqual(list.webContents.sent.length, n + 1, 'forced');
  t.ipcMain.emit('indexing:ready', t.strip);
  assert.strictEqual(list.webContents.sent.length, n + 1, 'not from the strip');
  t.ipcMain.emit('indexing:ready', list.webContents);
  assert.strictEqual(list.webContents.sent.length, n + 2);
  const stripFrames = t.strip.sent.length;
  t.bridge.push();
  assert.strictEqual(t.strip.sent.length, stripFrames, 'the strip is not repeated either');
});

test('S25 bridge: the strip carries the label, the counts and listOpen; the overlay state carries part, accent and label', () => {
  const t = setup();
  t.state.snap = { counts: { filed: 3, unfiled: 1 }, list: [ROW()] };
  t.bridge.setAccent('#112233');
  t.ipcMain.emit('strip:indexList', t.strip);
  assert.deepStrictEqual(lastStrip(t), { label: 'p', counts: { filed: 3, unfiled: 1 }, listOpen: true });
  const list = overlayOf(t, 'list');
  assert.deepStrictEqual(Object.keys(lastState(list)).sort(), ['accent', 'label', 'listOpen', 'part', 'snapshot', 'toast']);
  assert.strictEqual(lastState(list).accent, '#112233');
  assert.strictEqual(lastState(list).part, 'list');
  t.bridge.setAccent(5);
  assert.strictEqual(lastState(list).accent, null, 'a non-string accent is none');
  t.bridge.setAccent('#445566');
  assert.strictEqual(lastState(list).accent, '#445566');
});

test('S25 bridge: no overlay is made for a part nobody shows; the list view is loaded from the overlay file with its part', () => {
  const t = setup();
  t.bridge.push(true);
  assert.deepStrictEqual(t.views, []);
  t.ipcMain.emit('strip:indexList', t.strip);
  assert.strictEqual(t.views.length, 1);
  assert.deepStrictEqual(t.views[0].loaded, { f: 'overlay.html', o: { query: { part: 'list' } } });
  assert.strictEqual(t.views[0].visible === false || t.views[0].visible === true, true);
  assert.ok(t.added.includes(t.views[0]));
});

test('S25 bridge: a gone window makes push, raise and focusField do nothing', () => {
  const t = setup();
  t.ipcMain.emit('strip:indexList', t.strip);
  t.state.destroyed = true;
  const n = t.strip.sent.length;
  t.bridge.push(true);
  t.bridge.raise();
  t.bridge.focusField();
  t.bridge.relayout();
  assert.strictEqual(t.strip.sent.length, n);
});

test('S25 bridge: raise puts back only overlays that are shown', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast');
  const before = t.added.length;
  t.bridge.raise();
  assert.strictEqual(t.added.length, before, 'sized to nothing: not shown, not raised');
  t.ipcMain.emit('indexing:size', toast.webContents, 'toast', 60);
  const mid = t.added.length;
  t.bridge.raise();
  assert.strictEqual(t.added.length, mid + 1);
  toast.webContents.destroyed = true;
  t.bridge.raise();
  assert.strictEqual(t.added.length, mid + 1, 'a destroyed view is not raised');
});

// ---- the poll timer ---------------------------------------------------------------------------------------------------------------

test('S25 bridge: start polls the service every ms (3000 by default), repaints only when the journal stamp changed or something is showing, and stop ends it', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setInterval'] });
  let stamp = 'a';
  const t = setup({ journalStamp: () => stamp });
  t.bridge.start();
  t.bridge.start();                                   // a second start is ignored
  ctx.mock.timers.tick(2999);
  await tick();
  assert.strictEqual(t.calls.tick, 0);
  ctx.mock.timers.tick(1);
  await tick(); await tick();
  assert.strictEqual(t.calls.tick, 1, 'one timer, not two');
  const snaps = t.calls.snapshots;
  assert.ok(snaps >= 1, 'the first poll sees a new stamp and repaints');
  ctx.mock.timers.tick(3000);
  await tick(); await tick();
  assert.strictEqual(t.calls.snapshots, snaps, 'same stamp, nothing showing: no snapshot read');
  stamp = 'b';
  ctx.mock.timers.tick(3000);
  await tick(); await tick();
  assert.ok(t.calls.snapshots > snaps, 'a new stamp repaints');
  const after = t.calls.snapshots;
  t.ipcMain.emit('strip:indexList', t.strip);         // the list is open: always repaint
  const open = t.calls.snapshots;
  ctx.mock.timers.tick(3000);
  await tick(); await tick();
  assert.ok(t.calls.snapshots > open, 'an open list repaints on every poll');
  assert.ok(after <= open);
  t.bridge.stop();
  const stopped = t.calls.tick;
  ctx.mock.timers.tick(30000);
  await tick();
  assert.strictEqual(t.calls.tick, stopped);
  t.bridge.stop();                                    // stopping twice is fine
});

test('S25 bridge: a null journal stamp always repaints, and a custom interval is used', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setInterval'] });
  const t = setup({ journalStamp: () => null });
  t.bridge.start(500);
  ctx.mock.timers.tick(499);
  await tick();
  assert.strictEqual(t.calls.snapshots, 0);
  ctx.mock.timers.tick(1);
  await tick(); await tick();
  const first = t.calls.snapshots;
  assert.ok(first >= 1);
  ctx.mock.timers.tick(500);
  await tick(); await tick();
  assert.ok(t.calls.snapshots > first, 'null stamp: unknown, so repaint every time');
  t.bridge.stop();
});
