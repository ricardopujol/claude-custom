'use strict';
// *Stop* from the ▾ list: a host that may hold no lock (a non-repo folder),
// proven by the OS start time the list read (host/background-hosts.js). The
// rules are PR 1's (host/stop-holder.js), shared rather than rebuilt.
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { stopHost } = require('../host/stop-holder');
const { OLDER_HOST } = require('../host/host-client');

const INSTALL = 'C:\\inst-b';
const ROW = { install: INSTALL, port: 7718, pid: 37508, processStartedAt: '500', exact: true, cwd: 'C:\\x', startedAt: 9, windows: 0 };
// An older build's row: proven by the wall clock only (Dexter, PR 2 F1).
const WALL = { ...ROW, exact: false };
const ALL = ['raise', 'stop', 'stop-if-idle'];

function world(over = {}) {
  const procs = new Map([[37508, '500']]);
  const calls = { control: [], kill: [], count: [] };
  const w = {
    procs, calls,
    identity: { port: 7718, cwd: 'C:\\x', pid: 37508, startedAt: 9 },
    token: 'tok',
    controls: ALL,
    windows: 0,
    hung: false,
    osCount: undefined,
    ...over,
  };
  const end = () => procs.delete(37508);
  const deps = {
    isAlive: pid => procs.has(pid),
    startTimes: async pids => new Map(pids.filter(p => procs.has(p)).map(p => [p, procs.get(p)])),
    readIdentity: ({ install, port }) => (install === INSTALL && port === 7718 ? w.identity : null),
    readToken: () => w.token,
    sendControl: async ({ port, msg }) => {
      calls.control.push([port, msg.type]);
      if (w.hung) return { ok: false, error: 'timed out after 3000ms' };
      if (!w.controls.includes(msg.type)) return { ok: false, error: OLDER_HOST(msg.type) };
      if (msg.type === 'raise') return { ok: true, reply: { type: 'raised', windows: w.windows } };
      if (msg.type === 'stop') { end(); return { ok: true, reply: null }; }
      if (w.windows > 0) return { ok: true, reply: { type: 'stop-if-idle', stopped: false, windows: w.windows, recent: false } };
      end();
      return { ok: true, reply: { type: 'stop-if-idle', stopped: true } };
    },
    windowCount: async (pid, port) => { calls.count.push([pid, port]); return w.osCount === undefined ? w.windows : w.osCount; },
    killPidTree: (pid) => { calls.kill.push(pid); procs.delete(pid); },
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 100); })(),
    selfPid: 1,
    parentPid: 2,
  };
  return { w, deps };
}

const run = (deps, row = ROW) => stopHost({ row }, deps);

test('an idle proven host is stopped by its own stop-if-idle', async () => {
  const { w, deps } = world();
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'stopped');
  assert.strictEqual(r.how, 'stop-if-idle');
  assert.deepStrictEqual(w.calls.control, [[7718, 'stop-if-idle']]);
  assert.deepStrictEqual(w.calls.kill, []);
});

// Dexter, PR #83 F1 (High): the host can exit while its claude is still
// closing in the folder; "stopped" must mean both are gone.
test('a row naming its claude waits for that claude too, not just the host', async () => {
  const { w, deps } = world();
  w.procs.set(37600, '1');                              // the claude, still closing
  let polls = 0;
  const realSleep = deps.sleep;
  deps.sleep = async () => { polls += 1; if (polls === 3) w.procs.delete(37600); return realSleep(); };
  const r = await run(deps, { ...ROW, claudePid: 37600 });
  assert.strictEqual(r.outcome, 'stopped');
  assert.ok(polls >= 3, `waited for the claude (${polls} polls)`);
});

test('a claude that outlives the wait is not "stopped"', async () => {
  const { w, deps } = world();
  w.procs.set(37600, '1');                              // never ends
  const r = await run(deps, { ...ROW, claudePid: 37600 });
  assert.strictEqual(r.outcome, 'failed');
  assert.match(r.text, /37600/);
});

test('a host with a window is not stopped', async () => {
  const { w, deps } = world({ windows: 1 });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'has-window');
  assert.ok(w.procs.has(37508));
  assert.deepStrictEqual(w.calls.kill, []);
});

test('a host that already ended is gone, and nothing is asked', async () => {
  const { w, deps } = world();
  w.procs.delete(37508);
  assert.strictEqual((await run(deps)).outcome, 'gone');
  assert.deepStrictEqual(w.calls.control, []);
});

test('a reused pid (another start time) is gone: never asked, never killed', async () => {
  const { w, deps } = world({ hung: true });
  w.procs.set(37508, '777');
  assert.strictEqual((await run(deps)).outcome, 'gone');
  assert.deepStrictEqual(w.calls.control, []);
  assert.deepStrictEqual(w.calls.kill, []);
});

test('nothing is stopped that is not proven', async () => {
  const cases = [
    ['the OS could not be asked', (d) => { d.startTimes = async () => null; }, ROW],
    ['start time unreadable', (d, w) => { w.procs.set(37508, null); }, ROW],
    ['no start time on the row', () => {}, { ...ROW, processStartedAt: undefined }],
    ['start time not a string', () => {}, { ...ROW, processStartedAt: 500 }],
    ['this host', (d) => { d.selfPid = 37508; }, ROW],
    ['the window that started it', (d) => { d.parentPid = 37508; }, ROW],
    ['a bad pid', () => {}, { ...ROW, pid: 0 }],
    ['no row', () => {}, null],
  ];
  for (const [name, tweak, row] of cases) {
    const { w, deps } = world({ hung: true });
    tweak(deps, w);
    const r = await run(deps, row);
    assert.strictEqual(r.outcome, 'unproven', name);
    assert.deepStrictEqual(w.calls.kill, [], name);
    assert.deepStrictEqual(w.calls.control, [], name);
  }
});

test("an older build without stop-if-idle: the OS's 0 lets its own stop end it", async () => {
  const { w, deps } = world({ controls: ['raise', 'stop'] });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'stopped');
  assert.strictEqual(r.how, 'stop');
  assert.deepStrictEqual(w.calls.count, [[37508, 7718]]);
});

test("a host that can't be reached and the OS can't count is not stopped", async () => {
  const { w, deps } = world({ hung: true, osCount: null });
  assert.strictEqual((await run(deps)).outcome, 'unsure');
  assert.deepStrictEqual(w.calls.kill, []);
});

test('a hung host with no window on the OS count is killed only after its start is re-proven', async () => {
  const { w, deps } = world({ hung: true, osCount: 0 });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'stopped');
  assert.strictEqual(r.how, 'kill');
  assert.deepStrictEqual(w.calls.kill, [37508]);
});

test('another host on its port now: never asked with that token, the OS decides', async () => {
  const { w, deps } = world({ osCount: 1 });
  w.identity = { ...w.identity, pid: 4444 };
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'has-window');
  assert.deepStrictEqual(w.calls.control, []);
  assert.deepStrictEqual(w.calls.kill, []);
});

// The rule, over every world: a host with a window, or not proven by its start
// time, is never killed and never ends.
test('property: never stops a host with a window, never acts on an unproven pid', async () => {
  await fc.assert(fc.asyncProperty(
    fc.record({
      windows: fc.integer({ min: 0, max: 2 }),
      osCount: fc.option(fc.constantFrom(null, 0, 1, 2), { nil: undefined }),
      hung: fc.boolean(),
      controls: fc.constantFrom(ALL, ['raise', 'stop'], ['raise']),
      start: fc.constantFrom('500', '777', null),
      tokenMissing: fc.boolean(),
      otherOnPort: fc.boolean(),
    }),
    async (s) => {
      // The OS count is honest when it answers a number: it may be unknown, never wrong.
      const osCount = s.osCount === undefined || s.osCount === null ? s.osCount : s.windows;
      const { w, deps } = world({ windows: s.windows, osCount, hung: s.hung, controls: s.controls });
      if (s.start === null) w.procs.set(37508, null); else w.procs.set(37508, s.start);
      if (s.tokenMissing) w.token = null;
      if (s.otherOnPort) w.identity = { ...w.identity, pid: 4444 };
      const before = w.procs.get(37508);
      const r = await run(deps);
      if (s.windows > 0 && before === '500') {
        assert.ok(w.procs.has(37508), 'a host with a window was stopped');
        assert.notStrictEqual(r.outcome, 'stopped');
      }
      if (before !== '500') {
        assert.deepStrictEqual(w.calls.kill, [], 'acted on an unproven pid');
        assert.ok(['gone', 'unproven'].includes(r.outcome), r.outcome);
      }
    }), { numRuns: 400 });
});

// --- Dexter, PR 2 F1 (High): a row proven by the wall clock is never killed --
// Its "proof" can be faked by a clock stepped back, so its pid may be anyone's.
// Only its own token-checked controls may end it: an impostor can't answer.
test('a wall-proven row that cannot be asked is NOT killed, even with no window', async () => {
  const { w, deps } = world({ hung: true, osCount: 0 });
  const r = await run(deps, WALL);
  assert.strictEqual(r.outcome, 'unproven');
  assert.match(r.text, /wasn't stopped/);
  assert.deepStrictEqual(w.calls.kill, []);
  assert.ok(w.procs.has(37508));
});

test('a row with no `exact` at all is treated as wall-proven: never killed', async () => {
  const { w, deps } = world({ hung: true, osCount: 0 });
  const { exact, ...row } = ROW;
  void exact;
  assert.strictEqual((await run(deps, row)).outcome, 'unproven');
  assert.deepStrictEqual(w.calls.kill, []);
});

test('a wall-proven row still stops through its own controls', async () => {
  const idle = world();
  const r1 = await run(idle.deps, WALL);
  assert.deepStrictEqual([r1.outcome, r1.how], ['stopped', 'stop-if-idle']);
  const older = world({ controls: ['raise', 'stop'] });
  const r2 = await run(older.deps, WALL);
  assert.deepStrictEqual([r2.outcome, r2.how], ['stopped', 'stop']);
  assert.deepStrictEqual(older.w.calls.kill, []);
});

test('property: a wall-proven row is never killed, in any world', async () => {
  await fc.assert(fc.asyncProperty(
    fc.record({
      windows: fc.integer({ min: 0, max: 2 }),
      osCount: fc.constantFrom(undefined, null, 0, 1),
      hung: fc.boolean(),
      controls: fc.constantFrom(ALL, ['raise', 'stop'], ['raise']),
      tokenMissing: fc.boolean(),
      otherOnPort: fc.boolean(),
    }),
    async (s) => {
      const { w, deps } = world({ windows: s.windows, osCount: s.osCount, hung: s.hung, controls: s.controls });
      if (s.tokenMissing) w.token = null;
      if (s.otherOnPort) w.identity = { ...w.identity, pid: 4444 };
      await run(deps, WALL);
      assert.deepStrictEqual(w.calls.kill, []);
    }), { numRuns: 300 });
});
