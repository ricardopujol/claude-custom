'use strict';
/**
 * Main's half of the indexing field (app/indexing-bridge.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Revised
 * 2026-10-05 (evening)"), with Electron faked: every channel gated on its own page, the toast follows the note just
 * typed, Undo is for the selected project, Copy puts a note that wasn't filed on the clipboard, the overlay views sit
 * over the tab views where the toast and the list go, and the chip switches project.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createIndexingBridge, overlayBounds } = require('../app/indexing-bridge');

function fakeIpc() {
  const on = new Map();
  const handle = new Map();
  return {
    on: (ch, fn) => on.set(ch, fn),
    handle: (ch, fn) => handle.set(ch, fn),
    emit: (ch, sender, ...args) => on.get(ch)({ sender }, ...args),
    invoke: (ch, sender, ...args) => handle.get(ch)({ sender }, ...args),
    has: (ch) => on.has(ch) || handle.has(ch),
    names: () => [...on.keys(), ...handle.keys()],
  };
}

function fakeView() {
  const sent = [];
  const listeners = new Map();
  return {
    bounds: null, visible: false, loaded: null,
    webContents: {
      sent, isDestroyed: () => false,
      send: (ch, p) => sent.push([ch, p]),
      loadFile: function (f, o) { this.owner.loaded = { f, o }; },
      on: (ev, fn) => listeners.set(ev, fn), fire: (ev) => listeners.get(ev) && listeners.get(ev)(),
      focus: () => {},
    },
    setBounds(b) { this.bounds = b; },
    setVisible(v) { this.visible = v; },
    setBackgroundColor() {},
  };
}

const ROW = (over) => ({ id: 'n1', text: 'x', at: 1, state: 'filed', reason: null, undoable: true, ...over });

function setup({ snapshot } = {}) {
  const ipcMain = fakeIpc();
  const strip = { sent: [], send(ch, p) { this.sent.push([ch, p]); }, isDestroyed: () => false, focus() {} };
  const views = [];
  const added = [];
  const win = {
    webContents: strip,
    isDestroyed: () => false,
    getContentSize: () => [1200, 800],
    contentView: { addChildView: (v) => added.push(v), removeChildView: () => {} },
  };
  const calls = { submit: [], undo: [], tick: 0, opened: [], copied: [], focused: 0, fieldFocus: [], menu: null };
  let snap = snapshot || { counts: { filed: 0, unfiled: 0 }, list: [] };
  const service = {
    submit: (root, text) => { calls.submit.push([root, text]); return text.trim() ? { ok: true, id: 'n1', filed: true } : { ok: false, reason: 'empty' }; },
    undo: (id, root) => { calls.undo.push([id, root]); return { ok: false, reason: 'changed', file: 'C:\\p\\dev\\documentation\\P_BACKLOG.md' }; },
    tick: async () => { calls.tick += 1; },
    snapshot: () => snap,
  };
  const bridge = createIndexingBridge({
    ipcMain,
    Menu: { buildFromTemplate: (t) => ({ popup: () => { calls.menu = t; } }) },
    shell: { openPath: async (f) => { calls.opened.push(f); return ''; } },
    copyText: (s) => calls.copied.push(s),
    makeView: () => { const v = fakeView(); v.webContents.owner = v; views.push(v); return v; },
    overlayFile: 'overlay.html',
    getWin: () => win,
    isStrip: (sender) => sender === strip,
    service,
    project: { root: 'C:\\p', label: 'p' },
    docsFor: () => ({ ok: true, backlog: 'C:\\p\\dev\\documentation\\P_BACKLOG.md' }),
    projects: async () => [{ root: 'C:\\p', label: 'p', current: true }, { root: 'C:\\q', label: 'q', current: false }],
    viewTop: () => 34,
    focusSelected: () => { calls.focused += 1; },
    setFieldFocused: (b) => calls.fieldFocus.push(b),
  });
  const setSnap = (s) => { snap = s; };
  return { bridge, ipcMain, strip, views, added, calls, setSnap, win };
}

const lastStrip = (t) => t.strip.sent.filter(([ch]) => ch === 'strip-index').pop()[1];
const overlayOf = (t, part) => t.views.find(v => v.loaded && v.loaded.o.query.part === part);
const lastOverlay = (v) => v.webContents.sent.filter(([ch]) => ch === 'indexing-state').pop()[1];

test('the channels are exactly these, and each answers only its own page', async () => {
  const t = setup();
  assert.deepStrictEqual(t.ipcMain.names().sort(), ['indexing:closeList', 'indexing:copy', 'indexing:dismiss', 'indexing:open',
    'indexing:ready', 'indexing:size', 'indexing:undo', 'strip:indexChip', 'strip:indexFocus', 'strip:indexLeave', 'strip:indexList',
    'strip:indexSubmit'].sort());
  assert.strictEqual(await t.ipcMain.invoke('strip:indexSubmit', { not: 'the strip' }, 'x'), null);
  assert.deepStrictEqual(t.calls.submit, []);
  assert.strictEqual(await t.ipcMain.invoke('indexing:undo', t.strip, 'n1'), null, 'the strip is not the overlay');
  assert.deepStrictEqual(t.calls.undo, []);
});

test('submit adds to this window\'s project, shows the toast for that note, and kicks a tick', async () => {
  const t = setup();
  const r = await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'tabs glow');
  assert.deepStrictEqual(r, { ok: true, id: 'n1', filed: true });
  assert.deepStrictEqual(t.calls.submit, [['C:\\p', 'tabs glow']]);
  assert.ok(t.calls.tick >= 1);
  const toast = overlayOf(t, 'toast');
  assert.ok(toast && t.added.includes(toast), 'the toast view was made and stacked on the window');
  assert.strictEqual(lastOverlay(toast).toast.id, 'n1');
});

test('submit refuses a note that is not a string or is over 10,000 characters, before the service sees it', async () => {
  const t = setup();
  assert.deepStrictEqual(await t.ipcMain.invoke('strip:indexSubmit', t.strip, 42), { ok: false, reason: 'bad-note' });
  assert.deepStrictEqual(await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x'.repeat(10_001)), { ok: false, reason: 'too-long' });
  assert.deepStrictEqual(t.calls.submit, []);
});

test('the strip is told the project, the counts and whether the list is open', () => {
  const t = setup({ snapshot: { counts: { filed: 2, unfiled: 1 }, list: [] } });
  t.bridge.push(true);
  assert.deepStrictEqual(lastStrip(t), { label: 'p', counts: { filed: 2, unfiled: 1 }, listOpen: false });
});

test('Undo is asked for the selected project, and one that could not happen is shown in the toast', async () => {
  const t = setup();
  t.ipcMain.emit('strip:indexList', t.strip);
  const list = overlayOf(t, 'list');
  const r = await t.ipcMain.invoke('indexing:undo', list.webContents, 'n1');
  assert.strictEqual(r.reason, 'changed');
  assert.deepStrictEqual(t.calls.undo, [['n1', 'C:\\p']]);
  assert.deepStrictEqual(lastOverlay(overlayOf(t, 'toast')).toast.result, r);
  assert.deepStrictEqual(await t.ipcMain.invoke('indexing:undo', list.webContents, 42), { ok: false, reason: 'bad-id' });
});

test('Open is allowed for the project\'s own backlog only', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast');
  t.ipcMain.emit('indexing:open', toast.webContents, 'C:\\p\\dev\\documentation\\P_BACKLOG.md');
  t.ipcMain.emit('indexing:open', toast.webContents, 'C:\\Windows\\system32\\calc.exe');
  assert.deepStrictEqual(t.calls.opened, ['C:\\p\\dev\\documentation\\P_BACKLOG.md']);
});

test('Copy puts a note\'s own words on the clipboard, for a note of this project only', async () => {
  const t = setup({ snapshot: { counts: {}, list: [ROW({ state: 'unfiled', reason: 'no-backlog', text: 'my idea\nline two' })] } });
  t.ipcMain.emit('strip:indexList', t.strip);
  const list = overlayOf(t, 'list');
  t.ipcMain.emit('indexing:copy', list.webContents, 'n1');
  t.ipcMain.emit('indexing:copy', list.webContents, 'not-in-the-list');
  t.ipcMain.emit('indexing:copy', t.strip, 'n1');
  assert.deepStrictEqual(t.calls.copied, ['my idea\nline two']);
});

test('dismiss ends the toast only for the toast it was shown for (a newer one stays)', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'one');
  const toast = overlayOf(t, 'toast');
  const seq1 = lastOverlay(toast).toast.seq;
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'two');
  t.ipcMain.emit('indexing:dismiss', toast.webContents, seq1);
  assert.notStrictEqual(lastOverlay(toast).toast, null);
  t.ipcMain.emit('indexing:dismiss', toast.webContents, lastOverlay(toast).toast.seq);
  assert.strictEqual(lastOverlay(toast).toast, null);
  assert.strictEqual(toast.visible, false);
});

test('a "not filed yet" toast that timed out comes back, with a new seq, once its note is filed', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast');
  t.setSnap({ counts: {}, list: [ROW({ state: 'unfiled', reason: 'busy', undoable: false })] });
  t.bridge.push(true);
  const seq = lastOverlay(toast).toast.seq;
  t.ipcMain.emit('indexing:dismiss', toast.webContents, seq);
  assert.strictEqual(lastOverlay(toast).toast, null, 'hidden while it isn\'t filed');
  t.setSnap({ counts: {}, list: [ROW()] });
  t.bridge.push();
  const back = lastOverlay(toast).toast;
  assert.ok(back && back.id === 'n1' && back.seq > seq, JSON.stringify(back));
});

test('a dismissed "added" toast stays gone', async () => {
  const t = setup({ snapshot: { counts: {}, list: [ROW()] } });
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast');
  t.ipcMain.emit('indexing:dismiss', toast.webContents, lastOverlay(toast).toast.seq);
  t.setSnap({ counts: {}, list: [ROW({ state: 'undone' })] });
  t.bridge.push(true);
  assert.strictEqual(lastOverlay(toast).toast, null);
});

test('the overlay views size to what they show: toast bottom right, list top right under the strip, hidden when empty', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast');
  t.ipcMain.emit('indexing:size', toast.webContents, 'toast', 96);
  assert.deepStrictEqual(toast.bounds, { x: 1200 - 420 - 12, y: 800 - 96 - 12, width: 420, height: 96 });
  assert.strictEqual(toast.visible, true);
  t.ipcMain.emit('indexing:size', toast.webContents, 'toast', 0);
  assert.strictEqual(toast.visible, false);
  t.ipcMain.emit('strip:indexList', t.strip);
  const list = overlayOf(t, 'list');
  t.ipcMain.emit('indexing:size', list.webContents, 'list', 300);
  assert.deepStrictEqual(list.bounds, { x: 1200 - 380 - 10, y: 34 + 6, width: 380, height: 300 });
  t.ipcMain.emit('strip:indexList', t.strip);
  assert.strictEqual(list.visible, false, 'the counter closes it again');
});

test('the list closes on a blur only after it was clicked into (opening it never takes the keyboard)', () => {
  const t = setup();
  t.ipcMain.emit('strip:indexList', t.strip);
  const list = overlayOf(t, 'list');
  list.webContents.fire('blur');
  assert.strictEqual(lastStrip(t).listOpen, true);
  list.webContents.fire('focus');
  list.webContents.fire('blur');
  assert.strictEqual(lastStrip(t).listOpen, false);
});

test('overlayBounds: a narrow window keeps a gutter; a tall report is capped to the space there is', () => {
  assert.deepStrictEqual(overlayBounds('toast', { width: 300, height: 400, top: 34 }, 2000),
    { x: 12, y: 34 + 12, width: 276, height: 400 - 34 - 24 });
  assert.deepStrictEqual(overlayBounds('list', { width: 1200, height: 800, top: 34 }, 5000), { x: 810, y: 40, width: 380, height: 800 - 40 - 20 });
  assert.strictEqual(overlayBounds('list', { width: 1200, height: 800, top: 34 }, -5), null);
  assert.strictEqual(overlayBounds('list', { width: 1200, height: 800, top: 34 }, 'x'), null);
});

test('raise() puts the visible overlays back on top after a tab view was added', async () => {
  const t = setup();
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  const toast = overlayOf(t, 'toast');
  t.ipcMain.emit('indexing:size', toast.webContents, 'toast', 90);
  const before = t.added.length;
  t.bridge.raise();
  assert.strictEqual(t.added.length, before + 1);
  assert.strictEqual(t.added[t.added.length - 1], toast);
});

test('the field\'s focus is passed to main (polls must not take the keyboard), and Esc hands it back to the tab', () => {
  const t = setup();
  t.ipcMain.emit('strip:indexFocus', t.strip, true);
  t.ipcMain.emit('strip:indexFocus', t.strip, false);
  t.ipcMain.emit('strip:indexFocus', t.strip, 'yes');
  assert.deepStrictEqual(t.calls.fieldFocus, [true, false]);
  t.ipcMain.emit('strip:indexLeave', t.strip);
  assert.strictEqual(t.calls.focused, 1);
});

test('focusField (Ctrl+Alt+N) tells the strip to focus the field', () => {
  const t = setup();
  t.bridge.focusField();
  assert.ok(t.strip.sent.some(([ch]) => ch === 'strip-index-focus'));
});

test('the chip pops the projects; picking one adds there from then on, and Undo is for that one', async () => {
  const t = setup();
  t.ipcMain.emit('strip:indexChip', t.strip);
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(t.calls.menu.map(m => [m.label, m.checked]), [['p', true], ['q', false]]);
  t.calls.menu[1].click();
  assert.strictEqual(lastStrip(t).label, 'q');
  await t.ipcMain.invoke('strip:indexSubmit', t.strip, 'x');
  assert.strictEqual(t.calls.submit[0][0], 'C:\\q');
  await t.ipcMain.invoke('indexing:undo', overlayOf(t, 'toast').webContents, 'n1');
  assert.strictEqual(t.calls.undo[0][1], 'C:\\q');
});
