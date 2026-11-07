'use strict';
// BACKLOG #179: verify/lib/electron-main-lock.js, the heavy lock for a verify/ script that is itself an Electron main. Every
// lock here is a fake handed in: no test touches the machine's real lock.
const test = require('node:test');
const assert = require('node:assert');
const { takeMainLock } = require('../verify/lib/electron-main-lock');
const { HeavyLockError, NOT_RUN_EXIT } = require('../host/heavy-lock');

function fakeApp({ ready = true } = {}) {
  const calls = [];
  const handlers = {};
  return { calls, handlers, isReady: () => ready, exit: (c) => calls.push(['app.exit', c]), on: (ev, fn) => { handlers[ev] = fn; } };
}

test('takes the lock once, labelled with the script, and exit() releases BEFORE app.exit', () => {
  const calls = [];
  const app = fakeApp();
  app.exit = (c) => calls.push(['app.exit', c]);
  const seen = [];
  const createLock = (opts) => { seen.push(opts); return { ensure: () => { calls.push(['ensure']); return { state: 'held', release: () => calls.push(['release']) }; } }; };
  const m = takeMainLock({ app, label: 'shoot.js', createLock, exitNow: (c) => calls.push(['process.exit', c]) });
  assert.deepStrictEqual(seen, [{ label: 'shoot.js' }]);
  m.exit(3);
  assert.deepStrictEqual(calls, [['ensure'], ['release'], ['app.exit', 3]]);
});

test('before the app is ready, exit() releases and then exits the process', () => {
  const calls = [];
  const app = fakeApp({ ready: false });
  const createLock = () => ({ ensure: () => ({ release: () => calls.push(['release']) }) });
  takeMainLock({ app, label: 'shoot-full.js', createLock, exitNow: (c) => calls.push(['process.exit', c]) }).exit(2);
  assert.deepStrictEqual(calls, [['release'], ['process.exit', 2]]);
});

test('will-quit releases too (a main that quits the ordinary way)', () => {
  let released = 0;
  const app = fakeApp();
  takeMainLock({ app, label: 'x.js', createLock: () => ({ ensure: () => ({ release: () => { released++; } }) }) });
  assert.strictEqual(typeof app.handlers['will-quit'], 'function');
  app.handlers['will-quit']();
  assert.strictEqual(released, 1);
});

test('a busy slot: the reason, the NOT RUN line last, exit 75, and no lock handle', () => {
  const said = [];
  const exits = [];
  const err = new HeavyLockError('busy', 'held by lane-x (pid 1 start 2)', { holder: 'lane-x (pid 1 start 2)', waitedMs: 60000 });
  const m = takeMainLock({ app: fakeApp(), label: 'probe-atomic-sleep.js', createLock: () => ({ ensure: () => { throw err; } }), say: (s) => said.push(s), exitNow: (c) => exits.push(c) });
  assert.strictEqual(m, null);
  assert.deepStrictEqual(exits, [NOT_RUN_EXIT]);
  assert.match(said[0], /probe-atomic-sleep\.js did not run/);
  assert.match(said[said.length - 1], /^\[heavy-lock\].*NOT RUN$/);
});

test('any other throw from the lock code is a bug and is thrown as it is', () => {
  const exits = [];
  assert.throws(() => takeMainLock({ app: fakeApp(), label: 'x.js', createLock: () => ({ ensure: () => { throw new TypeError('boom'); } }), exitNow: (c) => exits.push(c) }), /boom/);
  assert.deepStrictEqual(exits, []);
});

test('a lock that was not taken (reentrant or missing) is released harmlessly', () => {
  const app = fakeApp();
  const m = takeMainLock({ app, label: 'x.js', createLock: () => ({ ensure: () => ({ state: 'reentrant', release: () => false }) }) });
  m.exit(0);
  assert.deepStrictEqual(app.calls, [['app.exit', 0]]);
});
