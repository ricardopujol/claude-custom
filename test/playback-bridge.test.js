'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const {
  readPlayback, registerPlaybackHandlers, GET_CHANNEL, PUSH_CHANNEL,
} = require('../app/playback-bridge');

function fakeWin({ minimised = false, visible = true } = {}) {
  const w = new EventEmitter();
  w.minimised = minimised;
  w.visible = visible;
  w.isMinimized = () => w.minimised;
  w.isVisible = () => w.visible;
  w.isDestroyed = () => false;
  return w;
}
function fakePower({ battery = false } = {}) {
  const p = new EventEmitter();
  p.battery = battery;
  p.isOnBatteryPower = () => p.battery;
  return p;
}
function fakeIpc() {
  const handlers = {};
  return { handlers, handle: (ch, fn) => { handlers[ch] = fn; } };
}

test('the channels are pinned', () => {
  assert.strictEqual(GET_CHANNEL, 'playback:get');
  assert.strictEqual(PUSH_CHANNEL, 'playback-state');
});

test('readPlayback reports the window and the power, and a hidden window counts as not visible', () => {
  assert.deepStrictEqual(readPlayback({ win: fakeWin(), powerMonitor: fakePower() }),
    { minimised: false, hidden: false, onBattery: false });
  assert.deepStrictEqual(readPlayback({ win: fakeWin({ minimised: true }), powerMonitor: fakePower({ battery: true }) }),
    { minimised: true, hidden: false, onBattery: true });
  assert.strictEqual(readPlayback({ win: fakeWin({ visible: false }), powerMonitor: fakePower() }).hidden, true);
});

test('readPlayback says unknown, not false, when it cannot tell', () => {
  const broken = { isOnBatteryPower: () => { throw new Error('no power api'); } };
  assert.strictEqual(readPlayback({ win: fakeWin(), powerMonitor: broken }).onBattery, null);
  assert.strictEqual(readPlayback({ win: fakeWin(), powerMonitor: { isOnBatteryPower: () => 'yes' } }).onBattery, null,
    'only a real boolean is an answer');
  assert.strictEqual(readPlayback({ win: fakeWin(), powerMonitor: null }).onBattery, null);
  const noWin = readPlayback({ win: null, powerMonitor: fakePower() });
  assert.strictEqual(noWin.minimised, null);
  assert.strictEqual(noWin.hidden, null);
  const tornDown = { isDestroyed: () => true, isMinimized: () => { throw new Error('destroyed'); } };
  assert.strictEqual(readPlayback({ win: tornDown, powerMonitor: fakePower() }).minimised, null);
});

test('the page can ask for the state, and only a tab view of this window is answered', () => {
  const ipc = fakeIpc();
  registerPlaybackHandlers({
    ipcMain: ipc, win: fakeWin({ minimised: true }), powerMonitor: fakePower(),
    isSender: (s) => s === 'mine', send: () => {},
  });
  assert.deepStrictEqual(ipc.handlers[GET_CHANNEL]({ sender: 'mine' }), { minimised: true, hidden: false, onBattery: false });
  assert.strictEqual(ipc.handlers[GET_CHANNEL]({ sender: 'someone else' }), null);
  assert.strictEqual(ipc.handlers[GET_CHANNEL](null), null);
});

test('minimise, restore, hide, show and the power source each push the new state to every view', () => {
  const win = fakeWin();
  const power = fakePower();
  const sent = [];
  registerPlaybackHandlers({ ipcMain: fakeIpc(), win, powerMonitor: power, isSender: () => true, send: (ch, v) => sent.push([ch, v]) });

  win.minimised = true; win.emit('minimize');
  assert.deepStrictEqual(sent.pop(), [PUSH_CHANNEL, { minimised: true, hidden: false, onBattery: false }]);
  win.minimised = false; win.emit('restore');
  assert.deepStrictEqual(sent.pop(), [PUSH_CHANNEL, { minimised: false, hidden: false, onBattery: false }]);
  win.visible = false; win.emit('hide');
  assert.strictEqual(sent.pop()[1].hidden, true);
  win.visible = true; win.emit('show');
  assert.strictEqual(sent.pop()[1].hidden, false);
  power.battery = true; power.emit('on-battery');
  assert.strictEqual(sent.pop()[1].onBattery, true);
  power.battery = false; power.emit('on-ac');
  assert.strictEqual(sent.pop()[1].onBattery, false);
  assert.strictEqual(sent.length, 0);
});

test('an unchanged state is not pushed again', () => {
  const win = fakeWin();
  const sent = [];
  registerPlaybackHandlers({ ipcMain: fakeIpc(), win, powerMonitor: fakePower(), isSender: () => true, send: (ch, v) => sent.push(v) });
  win.emit('restore');
  win.emit('show');
  assert.strictEqual(sent.length, 0, 'nothing changed since registration');
});

test('a send that throws (the window is going away) does not escape the listener', () => {
  const win = fakeWin();
  registerPlaybackHandlers({ ipcMain: fakeIpc(), win, powerMonitor: fakePower(), isSender: () => true, send: () => { throw new Error('gone'); } });
  win.minimised = true;
  assert.doesNotThrow(() => win.emit('minimize'));
});

test('a missing power monitor still registers the window events', () => {
  const win = fakeWin();
  const sent = [];
  registerPlaybackHandlers({ ipcMain: fakeIpc(), win, powerMonitor: null, isSender: () => true, send: (ch, v) => sent.push(v) });
  win.minimised = true; win.emit('minimize');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].onBattery, null);
});
