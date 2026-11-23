'use strict';
/**
 * app/view-closer.js: a closed window closes every page it made (PR #256 Miguel B1). Electron never destroys the webContents of a
 * WebContentsView when its window closes, so without this a closed window of several keeps its tabs, panels and a lean night alive.
 */
const test = require('node:test');
const assert = require('node:assert');
const { closeViews, closeOverlayViews } = require('../app/view-closer');

function fakeView(id, { leanOwnerId, closeThrows = false, destroyed = false } = {}) {
  const calls = [];
  const wc = {
    id,
    isDestroyed: () => destroyed,
    close: () => { calls.push('close'); if (closeThrows) throw new Error('already gone'); destroyed = true; },
  };
  return { webContents: wc, leanOwnerId, calls };
}

test('every live view is closed, its panels and previews are destroyed, its lean night is dropped, and the set is emptied', () => {
  const a = fakeView(1, { leanOwnerId: 'a' });
  const b = fakeView(2, { leanOwnerId: 'b' });
  const views = new Set([a, b]);
  const seen = { canvas: [], preview: [], owners: [] };
  closeViews(views, {
    canvasViews: { destroyFor: (wc) => seen.canvas.push(wc.id) },
    previewViews: { destroyFor: (wc) => seen.preview.push(wc.id) },
    dropOwner: (id) => seen.owners.push(id),
  });
  assert.deepStrictEqual(a.calls, ['close']);
  assert.deepStrictEqual(b.calls, ['close']);
  assert.deepStrictEqual(seen.canvas, [1, 2]);
  assert.deepStrictEqual(seen.preview, [1, 2]);
  assert.deepStrictEqual(seen.owners, ['a', 'b']);
  assert.strictEqual(views.size, 0);
});

test('a view that throws on close does not stop the others; a view already destroyed is not closed twice; a missing lean unit is fine', () => {
  const bad = fakeView(1, { closeThrows: true });
  const gone = fakeView(2, { destroyed: true });
  const ok = fakeView(3);
  const views = new Set([bad, gone, ok]);
  closeViews(views, { canvasViews: { destroyFor() { throw new Error('boom'); } }, previewViews: { destroyFor() {} }, dropOwner: null });
  assert.deepStrictEqual(ok.calls, ['close']);
  assert.deepStrictEqual(gone.calls, []);
  assert.strictEqual(views.size, 0);
});

test('closing twice is harmless (dispose() is idempotent)', () => {
  const v = fakeView(1);
  const views = new Set([v]);
  const deps = { canvasViews: { destroyFor() {} }, previewViews: { destroyFor() {} }, dropOwner() {} };
  closeViews(views, deps);
  closeViews(views, deps);
  assert.deepStrictEqual(v.calls, ['close']);
});

test('closeOverlayViews removes each overlay view from its window and closes its page, tolerating a window already gone', () => {
  const removed = [];
  const mk = (n, throws) => ({ webContents: { isDestroyed: () => false, close: () => { removed.push('close' + n); } }, n, throws });
  const toast = mk(1); const list = mk(2);
  const views = { toast, list: null };
  closeOverlayViews(views, { removeChild: (v) => { removed.push('rm' + v.n); throw new Error('window gone'); } });
  assert.deepStrictEqual(removed, ['rm1', 'close1']);
  assert.deepStrictEqual(views, { toast: null, list: null });
  void list;
});
