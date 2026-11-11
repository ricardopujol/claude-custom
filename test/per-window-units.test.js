'use strict';
/**
 * The per-window units behind app-wide channels (single-instance PR 2, step 5): playback, lean and the indexing overlay. Each channel is
 * registered once; each message goes to the unit of the window it came from (P2: no cross-talk). The old single forms keep their own
 * test files (playback-bridge, lean-bridge, indexing-bridge) green unchanged.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { registerPlaybackHandlers, PUSH_CHANNEL: PLAYBACK_PUSH } = require('../app/playback-bridge');
const { registerLeanHandlers, createLeanUnit } = require('../app/lean-bridge');
const { createIndexingOverlay, registerIndexingHandlers } = require('../app/indexing-bridge');

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function fakeIpc() {
  const on = new Map(); const handle = new Map();
  return {
    on: (ch, fn) => on.set(ch, fn), handle: (ch, fn) => handle.set(ch, fn),
    emit: (ch, sender, ...args) => on.get(ch)({ sender }, ...args),
    invoke: (ch, sender, ...args) => handle.get(ch)({ sender }, ...args),
  };
}

// --- playback ---------------------------------------------------------------------------------

class FakeWin extends EventEmitter {
  constructor() { super(); this.min = false; this.vis = true; }
  isDestroyed() { return false; }
  isMinimized() { return this.min; }
  isVisible() { return this.vis; }
}

test('playback: a minimise in A pushes to A\'s views only; B is untouched', () => {
  const ipcMain = fakeIpc();
  const a = new FakeWin(); const b = new FakeWin();
  const sentA = []; const sentB = [];
  const mon = Object.assign(new EventEmitter(), { onBattery: false, isOnBatteryPower() { return this.onBattery; } });
  const playback = registerPlaybackHandlers({ ipcMain, powerMonitor: mon, isSender: () => true, winOf: (s) => (s === 'sa' ? a : b) });
  playback.watch(a, (ch, v) => sentA.push([ch, v]));
  playback.watch(b, (ch, v) => sentB.push([ch, v]));
  a.min = true; a.emit('minimize');
  assert.strictEqual(sentA.length, 1);
  assert.strictEqual(sentA[0][0], PLAYBACK_PUSH);
  assert.strictEqual(sentA[0][1].minimised, true);
  assert.deepStrictEqual(sentB, []);
});

test('playback: a battery change re-checks every watched window, each against its own last state', () => {
  const ipcMain = fakeIpc();
  const a = new FakeWin(); const b = new FakeWin();
  const sentA = []; const sentB = [];
  const mon = Object.assign(new EventEmitter(), { onBattery: false, isOnBatteryPower() { return this.onBattery; } });
  const playback = registerPlaybackHandlers({ ipcMain, powerMonitor: mon, isSender: () => true, winOf: () => a });
  playback.watch(a, (ch, v) => sentA.push(v)); playback.watch(b, (ch, v) => sentB.push(v));
  mon.onBattery = true; mon.emit('on-battery');
  assert.strictEqual(sentA.length, 1); assert.strictEqual(sentB.length, 1);
  mon.emit('on-battery');
  assert.strictEqual(sentA.length, 1, 'nothing changed since: no second push');
});

test('playback: the channel answers the asking page\'s own window, and nobody else', async () => {
  const ipcMain = fakeIpc();
  const a = new FakeWin(); const b = new FakeWin(); b.min = true;
  registerPlaybackHandlers({ ipcMain, powerMonitor: null, isSender: (s) => s === 'sa' || s === 'sb', winOf: (s) => (s === 'sa' ? a : b) });
  assert.strictEqual((await ipcMain.invoke('playback:get', 'sa')).minimised, false);
  assert.strictEqual((await ipcMain.invoke('playback:get', 'sb')).minimised, true);
  assert.strictEqual(await ipcMain.invoke('playback:get', 'stranger'), null);
});

test('playback: an unwatched (closed) window is no longer re-checked', () => {
  const ipcMain = fakeIpc();
  const a = new FakeWin(); const sent = [];
  const mon = Object.assign(new EventEmitter(), { onBattery: false, isOnBatteryPower() { return this.onBattery; } });
  const playback = registerPlaybackHandlers({ ipcMain, powerMonitor: mon, isSender: () => true, winOf: () => a });
  const unwatch = playback.watch(a, (ch, v) => sent.push(v));
  unwatch();
  assert.strictEqual(playback.watchedCount(), 0);
  mon.onBattery = true; mon.emit('on-battery'); a.min = true; a.emit('minimize');
  assert.deepStrictEqual(sent, []);
});

// --- lean -------------------------------------------------------------------------------------

function leanRig() {
  const ipcMain = fakeIpc();
  const pushes = { A: [], B: [] }; const faces = { A: [], B: [] };
  const unitA = createLeanUnit({ push: (s) => pushes.A.push(s), pushFaces: (l) => faces.A.push(l) });
  const unitB = createLeanUnit({ push: (s) => pushes.B.push(s), pushFaces: (l) => faces.B.push(l) });
  const owners = { va: { id: 1 }, sa: { id: 2 }, vb: { id: 3 }, sb: { id: 4 } };
  const unitOf = (s) => (s === owners.va ? { unit: unitA, isView: true } : s === owners.sa ? { unit: unitA, isView: false }
    : s === owners.vb ? { unit: unitB, isView: true } : s === owners.sb ? { unit: unitB, isView: false } : null);
  registerLeanHandlers({ ipcMain, unitOf });
  return { ipcMain, pushes, faces, unitA, unitB, owners };
}

test('lean: a night reported from A\'s view makes only A lean; the lean button in B\'s strip makes only B lean', () => {
  const t = leanRig();
  t.ipcMain.emit('lean:night', t.owners.va, Date.now());
  assert.strictEqual(t.unitA.view().on, true);
  assert.strictEqual(t.unitB.view().on, false);
  assert.strictEqual(t.pushes.B.length, 0);
  t.ipcMain.emit('lean:set', t.owners.sb, true);
  assert.strictEqual(t.unitB.view().on, true);
  assert.strictEqual(t.pushes.A.length, 1, 'A heard only its own change');
});

test('lean: faces reported by B\'s view reach only B\'s strip; the strip can\'t report a night or faces', () => {
  const t = leanRig();
  t.ipcMain.emit('lean:faces', t.owners.vb, [{ id: 'x', name: 'x' }]);
  assert.strictEqual(t.faces.A.length, 0);
  t.ipcMain.emit('lean:night', t.owners.sa, Date.now());
  t.ipcMain.emit('lean:faces', t.owners.sa, [{ id: 'y' }]);
  assert.strictEqual(t.unitA.view().on, false, 'a night is a tab view\'s word, not the strip\'s');
  assert.strictEqual(t.faces.A.length, 0);
});

test('lean: get answers the asking page\'s own window; an unknown page gets null', async () => {
  const t = leanRig();
  t.ipcMain.emit('lean:set', t.owners.va, true);
  assert.strictEqual((await t.ipcMain.invoke('lean:get', t.owners.va)).on, true);
  assert.strictEqual((await t.ipcMain.invoke('lean:get', t.owners.vb)).on, false);
  assert.strictEqual(await t.ipcMain.invoke('lean:get', { id: 99 }), null);
  assert.strictEqual(await t.ipcMain.invoke('lean:get', null), null);
});

test('P2 (lean): random messages from A\'s and B\'s pages change a unit only on its own messages', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const rand = rng(seed);
    const t = leanRig();
    let aMoved = 0; let bMoved = 0;
    for (let i = 0; i < 20; i++) {
      const fromA = rand() < 0.5;
      const before = [t.pushes.A.length, t.pushes.B.length];
      t.ipcMain.emit('lean:set', fromA ? t.owners.sa : t.owners.vb, rand() < 0.5);
      const after = [t.pushes.A.length, t.pushes.B.length];
      if (fromA) { assert.strictEqual(after[1], before[1]); aMoved += after[0] - before[0]; } else { assert.strictEqual(after[0], before[0]); bMoved += after[1] - before[1]; }
    }
    assert.ok(aMoved + bMoved >= 0);
  }
});

// --- indexing ---------------------------------------------------------------------------------

function fakeView() {
  const sent = [];
  return {
    bounds: null, visible: false, loaded: null,
    webContents: { sent, isDestroyed: () => false, send: (ch, p) => sent.push([ch, p]), loadFile(f, o) { this.owner.loaded = { f, o }; }, on() {}, focus() {} },
    setBounds(b) { this.bounds = b; }, setVisible(v) { this.visible = v; }, setBackgroundColor() {},
  };
}

function overlayRig(root) {
  const stripSent = []; const views = []; const submits = [];
  const strip = { send: (ch, p) => stripSent.push([ch, p]), isDestroyed: () => false, focus() {} };
  const win = { webContents: strip, isDestroyed: () => false, getContentSize: () => [1200, 800], contentView: { addChildView() {}, removeChildView() {} } };
  const service = {
    submit: (r, text) => { submits.push([r, text]); return { ok: true, id: `n-${root}`, filed: true }; },
    undo: () => ({ ok: true }), tick: async () => {}, snapshot: () => ({ counts: { filed: 0, unfiled: 0 }, list: [] }),
  };
  const overlay = createIndexingOverlay({
    Menu: { buildFromTemplate: () => ({ popup() {} }) }, shell: { openPath: async () => '' }, copyText() {},
    makeView: () => { const v = fakeView(); v.webContents.owner = v; views.push(v); return v; },
    overlayFile: 'overlay.html', getWin: () => win, service, project: { root, label: root },
    docsFor: () => ({ ok: false }), projects: async () => [], viewTop: () => 34,
  });
  return { overlay, strip, stripSent, views, submits };
}

function indexingWorld() {
  const A = overlayRig('A'); const B = overlayRig('B');
  const ipcMain = fakeIpc();
  registerIndexingHandlers({
    ipcMain,
    overlayOfStrip: (s) => (s === A.strip ? A.overlay : s === B.strip ? B.overlay : null),
    overlayOfPage: (s) => { for (const w of [A, B]) if (w.overlay.partOf({ sender: s }) !== null) return w.overlay; return null; },
  });
  return { A, B, ipcMain };
}

test('indexing: the twelve channels are registered once, over both overlays', () => {
  const ipcMain = fakeIpc(); const names = [];
  registerIndexingHandlers({ ipcMain: { on: (c) => names.push(c), handle: (c) => names.push(c) }, overlayOfStrip: () => null, overlayOfPage: () => null });
  assert.strictEqual(names.length, 12);
  assert.strictEqual(new Set(names).size, 12);
  assert.ok(ipcMain);
});

test('indexing: a submit from A\'s strip files in A\'s project and toasts in A only', async () => {
  const w = indexingWorld();
  const r = await w.ipcMain.invoke('strip:indexSubmit', w.A.strip, 'tabs glow');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(w.A.submits, [['A', 'tabs glow']]);
  assert.deepStrictEqual(w.B.submits, []);
  assert.ok(w.A.views.length >= 1, 'A made its toast view');
  assert.strictEqual(w.B.views.length, 0);
  assert.deepStrictEqual(w.B.stripSent.filter(([ch]) => ch === 'strip-index'), []);
});

test('indexing: indexing:size from B\'s page resizes B only, and a page of neither window is ignored', async () => {
  const w = indexingWorld();
  await w.ipcMain.invoke('strip:indexSubmit', w.A.strip, 'a');
  await w.ipcMain.invoke('strip:indexSubmit', w.B.strip, 'b');
  const toastA = w.A.views.find((v) => v.loaded && v.loaded.o.query.part === 'toast');
  const toastB = w.B.views.find((v) => v.loaded && v.loaded.o.query.part === 'toast');
  const boundsA = JSON.stringify(toastA.bounds);
  w.ipcMain.emit('indexing:size', toastB.webContents, 'toast', 120);
  assert.ok(toastB.bounds && toastB.bounds.height === 120);
  assert.strictEqual(JSON.stringify(toastA.bounds), boundsA, 'A\'s overlay did not move');
  assert.doesNotThrow(() => w.ipcMain.emit('indexing:size', { id: 'stranger' }, 'toast', 50));
});

test('indexing: one service tick reaches both overlays, each with its own lastStamp (a change the first saw is still news to the second)', () => {
  const A = overlayRig('A'); const B = overlayRig('B');
  const pushedA = []; const pushedB = [];
  A.strip.send = (ch, p) => pushedA.push([ch, p]); B.strip.send = (ch, p) => pushedB.push([ch, p]);
  A.overlay.tick('s1');
  assert.ok(pushedA.length >= 1, 'A saw the new stamp');
  assert.strictEqual(pushedB.length, 0);
  B.overlay.tick('s1');
  assert.ok(pushedB.length >= 1, 'B still sees s1 as news: its lastStamp is its own');
  const nA = pushedA.length; const nB = pushedB.length;
  A.overlay.tick('s1'); B.overlay.tick('s1');
  assert.strictEqual(pushedA.length, nA, 'the same stamp again is not news');
  assert.strictEqual(pushedB.length, nB);
});

test('P2 (indexing): random submits from A\'s and B\'s strips file only in their own projects', async () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rand = rng(seed);
    const w = indexingWorld();
    let a = 0; let b = 0;
    for (let i = 0; i < 10; i++) {
      if (rand() < 0.5) { a++; await w.ipcMain.invoke('strip:indexSubmit', w.A.strip, `n${i}`); } else { b++; await w.ipcMain.invoke('strip:indexSubmit', w.B.strip, `n${i}`); }
    }
    assert.strictEqual(w.A.submits.length, a);
    assert.strictEqual(w.B.submits.length, b);
    assert.ok(w.A.submits.every(([root]) => root === 'A') && w.B.submits.every(([root]) => root === 'B'));
  }
});
