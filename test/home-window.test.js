'use strict';
/**
 * app/home-window.js: the ONE Home window of the process, with Electron faked (plan documentation/PLAN_PROJECT_HUB.md H-PR2; H4, H5).
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createHomeWindow, STORE_KEY } = require('../app/home-window');

class FakeWin extends EventEmitter {
  constructor(opts) {
    super();
    FakeWin.made.push(this);
    this.opts = opts;
    this.visible = opts.show !== false;
    this.destroyed = false;
    this.focused = 0;
    this.bounds = { x: opts.x === undefined ? 50 : opts.x, y: opts.y === undefined ? 50 : opts.y, width: opts.width, height: opts.height };
    this.loaded = null;
    this.sent = [];
    this.minimized = false;
    const wc = new EventEmitter();
    wc.id = 7;
    wc.send = (ch, p) => this.sent.push([ch, p]);
    wc.isDestroyed = () => this.destroyed;
    wc.openHandler = null;
    wc.setWindowOpenHandler = (fn) => { wc.openHandler = fn; };
    this.webContents = wc;
  }
  loadFile(f) { this.loaded = f; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() { this.focused++; }
  getBounds() { return { ...this.bounds }; }
  close() {
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit('close', e);
    if (e.defaultPrevented) return;
    this.destroyed = true;
    this.emit('closed');
  }
}
FakeWin.made = [];

function rig(over = {}) {
  FakeWin.made = [];
  const saved = {};
  const store = { read: (k, d) => (k in saved ? saved[k] : d), update: (k, d, fn) => { saved[k] = fn(k in saved ? saved[k] : d); return saved[k]; } };
  const changes = [];
  const settings = { hides: false };
  const hw = createHomeWindow({
    BrowserWindow: FakeWin,
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] },
    store, preload: 'P:\\preload-home.js', page: 'P:\\home.html', forProbe: (o) => o,
    hidesOnClose: () => settings.hides, onChanged: () => changes.push('changed'), log: () => {},
    ...over,
  });
  return { hw, saved, changes, settings };
}

test('show makes the window once, secure, loads home.html; a second show brings the same window forward', () => {
  const t = rig();
  assert.strictEqual(t.hw.isOpen(), false);
  t.hw.show();
  assert.strictEqual(FakeWin.made.length, 1);
  const w = FakeWin.made[0];
  assert.deepStrictEqual(w.opts.webPreferences, { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: 'P:\\preload-home.js' });
  assert.strictEqual(w.loaded, 'P:\\home.html');
  assert.strictEqual(w.opts.title, 'Jiandu Home');
  w.minimized = true;
  t.hw.show();
  assert.strictEqual(FakeWin.made.length, 1, 'one Home per Jiandu');
  assert.strictEqual(w.minimized, false);
  assert.ok(w.focused >= 2);
  assert.strictEqual(t.hw.isOpen(), true);
  assert.deepStrictEqual(t.changes, ['changed', 'changed']);
});

test('show({ hidden: true }) makes it hidden (Start minimised to tray), and a later show shows it', () => {
  const t = rig();
  t.hw.show({ hidden: true });
  assert.strictEqual(FakeWin.made[0].visible, false);
  assert.strictEqual(t.hw.isOpen(), true);
  t.hw.show();
  assert.strictEqual(FakeWin.made[0].visible, true);
});

test('the size and place are kept: saved on close, used at the next show (the brief\'s default)', () => {
  const t = rig();
  t.hw.show();
  FakeWin.made[0].bounds = { x: 200, y: 100, width: 1000, height: 700 };
  FakeWin.made[0].close();
  assert.deepStrictEqual(t.saved[STORE_KEY], { bounds: { x: 200, y: 100, width: 1000, height: 700 } });
  t.hw.show();
  const o = FakeWin.made[1].opts;
  assert.deepStrictEqual([o.x, o.y, o.width, o.height], [200, 100, 1000, 700]);
});

test('saved bounds off every screen are not used: the default size, centred by Electron', () => {
  const t = rig();
  t.saved[STORE_KEY] = { bounds: { x: 4000, y: 100, width: 1000, height: 700 } };
  t.hw.show();
  const o = FakeWin.made[0].opts;
  assert.deepStrictEqual([o.x, o.y, o.width, o.height], [undefined, undefined, 980, 680]);
});

test('H5: closing Home closes it (the process rule is window-all-closed\'s); with minimise-on-close it hides instead', () => {
  const t = rig();
  t.hw.show();
  t.settings.hides = true;
  FakeWin.made[0].close();
  assert.strictEqual(FakeWin.made[0].destroyed, false);
  assert.strictEqual(FakeWin.made[0].visible, false);
  assert.strictEqual(t.hw.isOpen(), true, 'hidden to the tray: still open');
  t.settings.hides = false;
  FakeWin.made[0].close();
  assert.strictEqual(FakeWin.made[0].destroyed, true);
  assert.strictEqual(t.hw.isOpen(), false);
  assert.strictEqual(t.changes[t.changes.length - 1], 'changed');
});

test('send pushes the payload to the page, and to nothing when Home is closed', () => {
  const t = rig();
  t.hw.send({ cards: [] });
  t.hw.show();
  t.hw.send({ cards: [1] });
  assert.deepStrictEqual(FakeWin.made[0].sent, [['home:model', { cards: [1] }]]);
  FakeWin.made[0].close();
  t.hw.send({ cards: [2] });
  assert.strictEqual(FakeWin.made[0].sent.length, 1);
});

test('isSender: only the Home window\'s own webContents', () => {
  const t = rig();
  assert.strictEqual(t.hw.isSender({ id: 7 }), false, 'no window yet');
  t.hw.show();
  assert.strictEqual(t.hw.isSender(FakeWin.made[0].webContents), true);
  assert.strictEqual(t.hw.isSender({ id: 7 }), false, 'the same id is not the same page');
  assert.strictEqual(t.hw.isSender(null), false);
});

test('Miguel B1: Home never navigates (a dropped link or file is refused) and never opens a window', () => {
  const t = rig();
  t.hw.show();
  const wc = FakeWin.made[0].webContents;
  for (const ev of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    assert.ok(wc.listenerCount(ev) >= 1, `${ev} is guarded`);
    let prevented = false;
    wc.emit(ev, { preventDefault: () => { prevented = true; } }, 'https://example.com/');
    assert.strictEqual(prevented, true, `${ev} is refused`);
  }
  assert.strictEqual(typeof wc.openHandler, 'function', 'a window-open handler is set');
  assert.deepStrictEqual(wc.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
});

test('isVisible: open, shown and not minimised', () => {
  const t = rig();
  assert.strictEqual(t.hw.isVisible(), false);
  t.hw.show();
  assert.strictEqual(t.hw.isVisible(), true);
  FakeWin.made[0].hide();
  assert.strictEqual(t.hw.isVisible(), false);
});
