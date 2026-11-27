'use strict';
// BACKLOG #179: verify/lib/electron-main-lock.js, the heavy lock for a verify/ script that is itself an Electron main. Every
// lock and every process here is a fake handed in: no test touches the machine's real lock or this runner's own handlers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { takeMainLock } = require('../verify/lib/electron-main-lock');
const { HeavyLockError, NOT_RUN_EXIT, createProcessLock } = require('../host/heavy-lock');

function fakeApp({ ready = true } = {}) {
  const calls = [];
  const handlers = {};
  return { calls, handlers, isReady: () => ready, exit: (c) => calls.push(['app.exit', c]), on: (ev, fn) => { handlers[ev] = fn; } };
}
const fakeProc = () => Object.assign(new EventEmitter(), { pid: 4242 });
const quiet = () => {};

test('takes the lock once, labelled with the script, and exit() releases BEFORE app.exit', () => {
  const calls = [];
  const app = fakeApp();
  app.exit = (c) => calls.push(['app.exit', c]);
  const seen = [];
  const createLock = (opts) => { seen.push(opts); return { ensure: () => { calls.push(['ensure']); return { state: 'held', release: () => calls.push(['release']) }; } }; };
  const m = takeMainLock({ app, label: 'shoot.js', createLock, exitNow: (c) => calls.push(['process.exit', c]), proc: fakeProc() });
  assert.deepStrictEqual(seen, [{ label: 'shoot.js' }]);
  m.exit(3);
  assert.deepStrictEqual(calls, [['ensure'], ['release'], ['app.exit', 3]]);
});

test('before the app is ready, exit() releases and then exits the process', () => {
  const calls = [];
  const app = fakeApp({ ready: false });
  const createLock = () => ({ ensure: () => ({ release: () => calls.push(['release']) }) });
  takeMainLock({ app, label: 'shoot-full.js', createLock, exitNow: (c) => calls.push(['process.exit', c]), proc: fakeProc() }).exit(2);
  assert.deepStrictEqual(calls, [['release'], ['process.exit', 2]]);
});

test('#243 S5: an app with no isReady exits the process, after the release', () => {
  const calls = [];
  const app = { on: () => {}, exit: () => calls.push(['app.exit']) };
  const createLock = () => ({ ensure: () => ({ release: () => calls.push(['release']) }) });
  takeMainLock({ app, label: 'x.js', createLock, exitNow: (c) => calls.push(['process.exit', c]), proc: fakeProc() }).exit(0);
  assert.deepStrictEqual(calls, [['release'], ['process.exit', 0]]);
});

test('will-quit releases too (a main that quits the ordinary way)', () => {
  let released = 0;
  const app = fakeApp();
  takeMainLock({ app, label: 'x.js', createLock: () => ({ ensure: () => ({ release: () => { released++; } }) }), proc: fakeProc() });
  assert.strictEqual(typeof app.handlers['will-quit'], 'function');
  app.handlers['will-quit']();
  assert.strictEqual(released, 1);
});

test('#243 S5: exit() then will-quit releases ONCE', () => {
  let released = 0;
  const app = fakeApp();
  const m = takeMainLock({ app, label: 'x.js', createLock: () => ({ ensure: () => ({ release: () => { released++; } }) }), proc: fakeProc() });
  m.exit(0);
  app.handlers['will-quit']();
  assert.strictEqual(released, 1);
  assert.deepStrictEqual(app.calls, [['app.exit', 0]]);
});

test('#243 S5: a release that throws still lets the exit happen', () => {
  const app = fakeApp();
  const m = takeMainLock({ app, label: 'x.js', createLock: () => ({ ensure: () => ({ release: () => { throw new Error('script gone'); } }) }), proc: fakeProc() });
  assert.doesNotThrow(() => m.exit(1));
  assert.deepStrictEqual(app.calls, [['app.exit', 1]]);
});

test('#243 I3: an unhandled rejection or an uncaught exception says so, releases, and exits 1', () => {
  for (const ev of ['unhandledRejection', 'uncaughtException']) {
    const calls = [];
    const said = [];
    const proc = fakeProc();
    const app = fakeApp();
    app.exit = (c) => calls.push(['app.exit', c]);
    takeMainLock({ app, label: 'shoot.js', proc, say: (s) => said.push(s), createLock: () => ({ ensure: () => ({ release: () => calls.push(['release']) }) }) });
    assert.strictEqual(proc.listenerCount(ev), 1, ev);
    proc.emit(ev, new Error('ENOENT: no such file, open input.html'));
    assert.deepStrictEqual(calls, [['release'], ['app.exit', 1]], ev);
    assert.match(said.join('\n'), /shoot\.js.*ENOENT/, ev);
  }
});

test('#243 I3: the crash handlers are there under an outer holder too (re-entrant: nothing to release, the exit still happens)', () => {
  const proc = fakeProc();
  const app = fakeApp();
  takeMainLock({ app, label: 'x.js', proc, say: quiet, createLock: () => ({ ensure: () => ({ state: 'reentrant', release: () => false }) }) });
  proc.emit('unhandledRejection', new Error('boom'));
  assert.deepStrictEqual(app.calls, [['app.exit', 1]]);
});

test('a busy slot: the reason, the NOT RUN line last, exit 75, and no lock handle', () => {
  const said = [];
  const exits = [];
  const err = new HeavyLockError('busy', 'held by lane-x (pid 1 start 2)', { holder: 'lane-x (pid 1 start 2)', waitedMs: 60000 });
  const m = takeMainLock({ app: fakeApp(), label: 'probe-atomic-sleep.js', createLock: () => ({ ensure: () => { throw err; } }), say: (s) => said.push(s), exitNow: (c) => exits.push(c), proc: fakeProc() });
  assert.strictEqual(m, null);
  assert.deepStrictEqual(exits, [NOT_RUN_EXIT]);
  assert.match(said[0], /probe-atomic-sleep\.js did not run/);
  assert.match(said[said.length - 1], /^\[heavy-lock\].*NOT RUN$/);
});

test('any other throw from the lock code is a bug and is thrown as it is', () => {
  const exits = [];
  assert.throws(() => takeMainLock({ app: fakeApp(), label: 'x.js', createLock: () => ({ ensure: () => { throw new TypeError('boom'); } }), exitNow: (c) => exits.push(c), proc: fakeProc() }), /boom/);
  assert.deepStrictEqual(exits, []);
});

test('#243 S5: under an outer holder the REAL process lock acquires nothing, installs nothing, and the exit releases nothing', () => {
  const outer = 'npm test (pid 7 start 9)';
  const runs = [];
  const run = (args) => { runs.push(args); return args.length ? { status: 0, stdout: '' } : { status: 0, stdout: `held: ${outer}\n` }; };
  const work = { file: 'fake', read: () => [], add: () => {}, remove: () => {}, clear: () => {} };
  const lockProc = fakeProc();
  const createLock = (o) => createProcessLock({ ...o, proc: lockProc, env: { HEAVY_LOCK_HELD: outer }, run, exists: () => true,
    startsOf: (pids) => new Map(pids.map(p => [p, '9'])), work, watch: null, log: quiet });
  const app = fakeApp();
  const m = takeMainLock({ app, label: 'shoot.js', createLock, proc: fakeProc() });
  assert.strictEqual(m.held.state, 'reentrant');
  m.exit(0);
  assert.deepStrictEqual(runs.filter(a => a.includes('-Acquire') || a.includes('-Release')), [], 'no acquire and no release');
  assert.strictEqual(lockProc.listenerCount('exit'), 0, 'no release handler installed for a lock it never took');
  assert.deepStrictEqual(app.calls, [['app.exit', 0]]);
});

test('#243 S1: in the three mains, no exit inside a catch falls through to the code after it', () => {
  for (const f of ['shoot.js', 'shoot-full.js', 'probe-atomic-sleep.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'verify', f), 'utf8');
    assert.doesNotMatch(src, /catch\s*\([^)]*\)\s*\{[^{}]*mainLock\.exit\([^)]*\);\s*\}/, `${f}: add a return after mainLock.exit in its catch`);
  }
});
