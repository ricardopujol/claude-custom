'use strict';
/**
 * Layout presets (D3) with floating panels (D2): floats are part of a layout, so a preset carries them untouched
 * (lane brief, decision 1) and the byte caps still hold with every module floating at the largest values.
 */
const test = require('node:test');
const assert = require('node:assert');

const P = require('../app/dock-presets');
const T = require('../app/dock-tree');
const { MAX_LAYOUT_BYTES } = require('../app/layout-bridge');
const { TABS } = require('../app/side-tabs');

const IDS = TABS.map(t => t.id);
const floating = () => T.dock(T.defaultLayout(IDS), IDS[1], { float: { x: 120, y: 80, w: 400, h: 300 } });
// What the store does to a list on its way to disk and back.
const viaDisk = list => JSON.parse(JSON.stringify(list));

test('a preset saved with a floating panel brings the float back exactly when applied', () => {
  const live = floating();
  assert.strictEqual(live.floats.length, 1, 'the layout has a float to save');
  const saved = P.applyOp([], { op: 'save', name: 'Floaty', layout: live });
  assert.strictEqual(saved.ok, true);
  const stored = viaDisk(saved.list);
  assert.deepStrictEqual(stored[0].layout.floats, live.floats, 'the float is in the stored preset as it was');
  // Apply it on a different current layout: the preset's placement wins, float included.
  const applied = P.presetLayout(stored[0].layout, IDS, T.readAny);
  assert.strictEqual(applied.ok, true);
  assert.deepStrictEqual(applied.layout.floats, live.floats, 'same id, tabs, x, y, w and h');
  assert.deepStrictEqual(applied.layout, T.normalize(live, IDS), 'the whole placement is the saved one');
});

test('a float survives save, a disk round trip and apply for several floats with a hidden panel', () => {
  let live = T.defaultLayout(IDS);
  live = T.dock(live, IDS[0], { float: { x: 10, y: 20, w: 300, h: 200 } });
  live = T.dock(live, IDS[1], { float: { x: 500, y: 90, w: 250, h: 400 } });
  live = T.hide(live, IDS[2]);
  const saved = P.applyOp([], { op: 'save', name: 'Many', layout: live });
  const applied = P.presetLayout(viaDisk(saved.list)[0].layout, IDS, T.readAny);
  assert.deepStrictEqual(applied.layout, T.normalize(live, IDS));
  assert.strictEqual(applied.layout.floats.length, 2);
});

test('the thumbnail of a preset with a float still draws (the float is left out of the boxes)', () => {
  const fit = (layout, ids, vp) => T.fit(T.normalize(layout, ids), null, vp);
  const boxes = P.thumbBoxes(floating(), IDS, fit);
  assert.ok(boxes.length >= 1, 'at least the terminal');
});

test('every module floating at the largest values is a preset under the per-preset cap, and 32 of them fit the list cap', () => {
  let l = T.defaultLayout(IDS);
  for (const id of IDS) l = T.dock(l, id, { float: { x: 10000, y: 10000, w: 10000, h: 10000 } });
  assert.strictEqual(l.floats.length, IDS.length);
  const bytes = Buffer.byteLength(JSON.stringify(l), 'utf8');
  assert.ok(bytes < MAX_LAYOUT_BYTES, `the layout fits the bridge's own cap: ${bytes}`);
  assert.ok(bytes <= P.MAX_PRESET_BYTES, 'and the preset cap');
  let list = [];
  for (let i = 0; i < P.MAX_PRESETS; i++) {
    const r = P.applyOp(list, { op: 'save', name: `Preset ${String(i).padStart(2, '0')} ${'é'.repeat(30)}`.slice(0, P.NAME_MAX), layout: l });
    assert.strictEqual(r.ok, true, `save ${i}: ${r.reason}`);
    list = r.list;
  }
  assert.strictEqual(list.length, P.MAX_PRESETS);
  assert.ok(Buffer.byteLength(JSON.stringify(list), 'utf8') <= P.MAX_LIST_BYTES, 'the list cap holds with floats in every preset');
});
