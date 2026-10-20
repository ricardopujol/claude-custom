'use strict';
// The tray's effects (app/tray-controller.js) with Electron faked: the Tray is made once, the image and tooltip follow the
// cues, a click goes to the oldest cue, the menu is built fresh at the moment it opens.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createTrayController } = require('../app/tray-controller');

class FakeTray extends EventEmitter {
  constructor(image) {
    super();
    FakeTray.made.push(this);
    this.images = [image];
    this.tooltips = [];
    this.destroyed = false;
    this.popups = [];
  }
  setImage(i) { this.images.push(i); }
  setToolTip(t) { this.tooltips.push(t); }
  destroy() { this.destroyed = true; }
  popUpContextMenu(menu) { this.popups.push(menu); }
}
FakeTray.made = [];

function setup(over = {}) {
  FakeTray.made = [];
  const log = [];
  const state = { tabs: [], settings: { trayIcon: true, minimiseOnClose: false, startMinimised: false }, hidden: false, time: 1000, background: { items: [], footer: null } };
  const rendered = [];
  const built = [];
  const deps = {
    Tray: FakeTray,
    Menu: { buildFromTemplate: (t) => { built.push(t); return { template: t }; } },
    nativeImage: { createFromBitmap: (buf, o) => ({ buf, o }) },
    renderIcon: (text) => { rendered.push(text); return { width: 32, height: 32, bgra: Buffer.from(text || '-') }; },
    getSettings: () => state.settings,
    tabs: () => state.tabs,
    windowLabel: () => 'claude-custom',
    isHidden: () => state.hidden,
    background: async () => state.background,
    now: () => state.time,
    actions: {
      focusWindow: () => log.push(['focus']), selectTab: k => log.push(['select', k]), openBackground: o => log.push(['open', o]),
      stopBackground: r => log.push(['stop', r]), hideAll: () => log.push(['hide']), showAll: () => log.push(['show']),
      setStartMinimised: on => log.push(['start', on]), quit: () => log.push(['quit']),
    },
    log: () => {},
    ...over,
  };
  const c = createTrayController(deps);
  return { c, state, log, rendered, built };
}
const tab = (key, status) => ({ key, status });

test('the Tray is created once, however many times it is synced', () => {
  const { c } = setup();
  c.sync(); c.sync(); c.sync();
  assert.strictEqual(FakeTray.made.length, 1);
  assert.strictEqual(c.state().exists, true);
});

test('with the tray icon switched off no Tray is made, and switching it off later destroys it', () => {
  const { c, state } = setup();
  state.settings = { ...state.settings, trayIcon: false };
  c.sync();
  assert.strictEqual(FakeTray.made.length, 0);
  state.settings = { ...state.settings, trayIcon: true };
  c.sync();
  assert.strictEqual(FakeTray.made.length, 1);
  state.settings = { ...state.settings, trayIcon: false };
  c.sync();
  assert.strictEqual(FakeTray.made[0].destroyed, true);
  assert.strictEqual(c.state().exists, false);
  state.settings = { ...state.settings, trayIcon: true };
  c.sync();
  assert.strictEqual(FakeTray.made.length, 2, 'switched back on: a new one');
});

test('a Tray that cannot be made (no tray area) leaves the app running and says why', () => {
  const lines = [];
  const { c } = setup({ Tray: class { constructor() { throw new Error('no tray here'); } }, log: m => lines.push(m) });
  assert.doesNotThrow(() => c.sync());
  assert.strictEqual(c.state().exists, false);
  assert.ok(lines.some(l => /no tray here/.test(l)));
});

test('the tooltip and image follow the count; an unchanged count touches nothing', () => {
  const { c, state, rendered } = setup();
  state.tabs = [tab('a', null), tab('b', null), tab('c', null)];
  c.sync();
  const t = FakeTray.made[0];
  assert.strictEqual(c.state().tooltip, 'claude-custom · 3 sessions');
  assert.strictEqual(c.state().badge, '');
  state.tabs = [tab('a', null), tab('b', { needsInput: true }), tab('c', null)];
  c.sync();
  assert.strictEqual(c.state().tooltip, 'claude-custom · 3 sessions · 1 needs you');
  assert.strictEqual(c.state().badge, '1');
  const images = t.images.length;
  const tips = t.tooltips.length;
  c.sync(); c.sync();
  assert.strictEqual(t.images.length, images);
  assert.strictEqual(t.tooltips.length, tips);
  state.tabs = [tab('a', { finished: true }), tab('b', { needsInput: true }), tab('c', null)];
  c.sync();
  assert.strictEqual(c.state().badge, '2');
  state.tabs = [tab('a', null), tab('b', null), tab('c', null)];
  c.sync();
  assert.strictEqual(c.state().badge, '', 'plain icon at 0');
});

test('the tooltip carries the window label, so two project windows are told apart', () => {
  const { c, state } = setup({ windowLabel: () => 'alpha' });
  state.tabs = [tab('a', null)];
  c.sync();
  assert.strictEqual(c.state().tooltip, 'claude-custom · alpha · 1 session');
});

test('the badge is 9+ beyond nine', () => {
  const { c, state } = setup();
  state.tabs = Array.from({ length: 12 }, (_, i) => tab('k' + i, { finished: true }));
  c.sync();
  assert.strictEqual(c.state().badge, '9+');
  assert.match(c.state().tooltip, /12 need you$/);
});

test('an image is drawn once per badge text and reused', () => {
  const { c, state, rendered } = setup();
  for (let i = 0; i < 3; i++) {
    state.tabs = [tab('a', { finished: true })]; c.sync();
    state.tabs = [tab('a', null)]; c.sync();
  }
  assert.deepStrictEqual(rendered, ['', '1']);
});

test('the image is handed to Electron as a 2x bitmap of the size drawn', () => {
  const { c } = setup();
  c.sync();
  const img = FakeTray.made[0].images[0];
  assert.strictEqual(img.o.width, 32);
  assert.strictEqual(img.o.height, 32);
  assert.strictEqual(img.o.scaleFactor, 2);
});

test('left click: the tab that has waited longest, then the window; with no cue, just the window', () => {
  const { c, state, log } = setup();
  state.tabs = [tab('a', null), tab('b', null)];
  c.sync();
  FakeTray.made[0].emit('click');
  assert.deepStrictEqual(log.splice(0), [['focus']]);
  state.time = 2000; state.tabs = [tab('a', null), tab('b', { finished: true })]; c.sync();
  state.time = 3000; state.tabs = [tab('a', { needsInput: true }), tab('b', { finished: true })]; c.sync();
  FakeTray.made[0].emit('click');
  assert.deepStrictEqual(log.splice(0), [['select', 'b'], ['focus']], 'b was first');
});

test('a cue that cleared and came back is young again', () => {
  const { c, state, log } = setup();
  state.time = 1; state.tabs = [tab('a', { finished: true }), tab('b', { finished: true })]; c.sync();
  state.time = 2; state.tabs = [tab('b', { finished: true })]; c.sync();
  state.time = 3; state.tabs = [tab('a', { finished: true }), tab('b', { finished: true })]; c.sync();
  FakeTray.made[0].emit('click');
  assert.deepStrictEqual(log.splice(0), [['select', 'b'], ['focus']]);
});

test('right click: the menu is built at that moment from the live state, and popped up', async () => {
  const { c, state, built } = setup();
  state.tabs = [tab('a', { needsInput: true })];
  c.sync();
  state.hidden = true;
  state.background = { items: [{ label: 'x', open: null, stop: true, row: { windows: 0, port: 9 } }], footer: null };
  FakeTray.made[0].emit('right-click');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(built.length, 1);
  const labels = built[0].filter(x => x.type !== 'separator').map(x => x.label);
  assert.deepStrictEqual(labels, ['claude-custom  ·  1 tab  ·  needs you', 'x', 'Show all windows', 'Start minimised to tray', 'Quit claude-custom']);
  assert.strictEqual(FakeTray.made[0].popups.length, 1);
});

test('right click: a background list that fails still opens the menu, without the windowless rows', async () => {
  const { c, built } = setup({ background: async () => { throw new Error('ps failed'); } });
  c.sync();
  FakeTray.made[0].emit('right-click');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(built.length, 1);
  assert.strictEqual(FakeTray.made[0].popups.length, 1);
});

test('the menu rows reach the actions', async () => {
  const { c, state, built, log } = setup();
  state.settings = { ...state.settings, startMinimised: true };
  c.sync();
  FakeTray.made[0].emit('right-click');
  await new Promise(r => setImmediate(r));
  const t = built[0];
  t.find(x => x.label === 'Hide all windows').click();
  t.find(x => x.label === 'Start minimised to tray').click({ checked: false });
  t.find(x => x.label === 'Quit claude-custom').click();
  assert.deepStrictEqual(log, [['hide'], ['start', false], ['quit']]);
  assert.strictEqual(t.find(x => x.label === 'Start minimised to tray').checked, true, 'it shows what the file says');
});

test('destroy: the Tray goes, and a later sync after destroy does not bring it back', () => {
  const { c } = setup();
  c.sync();
  c.destroy();
  assert.strictEqual(FakeTray.made[0].destroyed, true);
  c.sync();
  assert.strictEqual(FakeTray.made.length, 1);
});

test('state().image tells a probe what the Tray shows: a digest of the pixels that changes with the badge', () => {
  const imgs = (buf, o) => ({ buf, o, toBitmap: () => buf, getSize: () => ({ width: o.width, height: o.height }) });
  const { c, state } = setup({ nativeImage: { createFromBitmap: imgs } });
  c.sync();
  const plain = c.state().image;
  assert.deepStrictEqual(plain.size, { width: 32, height: 32 });
  assert.match(plain.sha1, /^[0-9a-f]{40}$/);
  state.tabs = [tab('a', { finished: true })];
  c.sync();
  assert.notStrictEqual(c.state().image.sha1, plain.sha1);
  assert.strictEqual(c.image().buf.toString(), '1');
  state.tabs = [];
  c.sync();
  assert.strictEqual(c.state().image.sha1, plain.sha1, 'back to the plain icon at 0');
});

test('state().image is null where the image cannot be read, and with no Tray', () => {
  const { c, state } = setup();
  assert.strictEqual(c.state().image, null);
  c.sync();
  assert.strictEqual(c.state().image, null, 'a fake image with no toBitmap');
  state.settings = { ...state.settings, trayIcon: false };
  c.sync();
  assert.strictEqual(c.image(), null);
});
