'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { stopHolder } = require('../host/stop-holder');
const { OLDER_HOST } = require('../host/host-client');

const INSTALL = 'C:\\inst-a';
const LOCK = { pid: 4242, processStartedAt: '1000', startedAt: 77, port: 5150, claudePid: 9, install: INSTALL };
// What the blocked pane was shown: host/session-lock.js holderOf(), no start time.
const SHOWN = { pid: 4242, startedAt: 77, port: 5150, claudePid: 9, install: INSTALL };
const ALL = ['raise', 'stop', 'stop-if-idle'];

// A world with GROUND TRUTH (Dexter, PR #76 F7): the lock on disk, the live
// processes (pid -> OS start time; 4242 the holder's host, 9 its claude), the
// holder's identity file and token, which controls its build knows, how many
// windows it REALLY has, and what the OS reports about them.
function world(over = {}) {
  const procs = new Map([[4242, '1000'], [9, 'c9']]);
  const calls = { control: [], kill: [], token: [], count: 0 };
  const w = {
    procs, calls,
    lock: { ...LOCK },
    identity: { port: 5150, cwd: 'x', pid: 4242, startedAt: 1 },
    token: 'tok',
    controls: ALL,          // what the holder's hello lists
    windows: 0,             // the truth
    recentLeft: false,      // a window left within the holder's grace
    hung: false,            // accepts, never answers
    stopEnds: true,         // a stop ends the holder
    claudeLingers: false,   // its claude outlives it
    osCount: undefined,     // what the OS reports; undefined = the truth
    ...over,
  };
  const end = () => {
    procs.delete(w.lock.pid);
    if (!w.claudeLingers) procs.delete(w.lock.claudePid);
  };
  const deps = {
    readLock: () => (w.lock === null ? { gone: true } : { raw: JSON.stringify(w.lock), st: null, parsed: w.lock }),
    isAlive: pid => procs.has(pid),
    startTimes: async pids => new Map(pids.filter(p => procs.has(p)).map(p => [p, procs.get(p)])),
    readIdentity: ({ install, port }) => (install === INSTALL && port === 5150 ? w.identity : null),
    readToken: (install, port) => { calls.token.push([install, port]); return w.token; },
    sendControl: async ({ msg }) => {
      calls.control.push(msg.type);
      if (w.hung) return { ok: false, error: 'timed out after 3000ms' };
      if (!w.controls.includes(msg.type)) return { ok: false, error: OLDER_HOST(msg.type) };
      if (msg.type === 'raise') return { ok: true, reply: { type: 'raised', windows: w.windows } };
      if (msg.type === 'stop') {
        if (w.stopEnds) end();
        return { ok: true, reply: null };
      }
      if (w.windows > 0 || w.recentLeft) {
        return { ok: true, reply: { type: 'stop-if-idle', stopped: false, windows: w.windows, recent: w.recentLeft } };
      }
      if (w.stopEnds) end();
      return { ok: true, reply: { type: 'stop-if-idle', stopped: true } };
    },
    windowCount: async () => { calls.count += 1; return w.osCount === undefined ? w.windows : w.osCount; },
    killPidTree: (pid) => { calls.kill.push(pid); procs.delete(pid); procs.delete(w.lock.claudePid); },
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 100); })(),
    selfPid: 1,
    parentPid: 2,
  };
  return { w, deps };
}

// `shown` passed explicitly -- even as undefined -- is used as given.
const run = (deps, ...shown) => stopHolder({ lockPath: 'L', shown: shown.length ? shown[0] : SHOWN }, deps);

// Every way a holder can't be asked whether it has a window (Dexter F1, Miguel B1).
const UNREACHABLE = {
  'a lock from before `install`': { lock: { ...LOCK, install: undefined } },
  'no identity file': { identity: null },
  'another host on its port': { identity: { port: 5150, cwd: 'y', pid: 7777, startedAt: 1 } },
  'no token file': { token: null },
  'a hung host': { hung: true },
  'a build with no controls': { controls: [] },
};

// --- through the holder's own controls ---------------------------------------

test('a windowless holder is stopped by ONE stop-if-idle frame: it decides, in one step', async () => {
  const { w, deps } = world();
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'stopped');
  assert.strictEqual(r.how, 'stop-if-idle');
  assert.deepStrictEqual(w.calls.control, ['stop-if-idle']);
  assert.deepStrictEqual(w.calls.kill, []);
});

test('a holder with a window open refuses: never stopped, nothing else sent', async () => {
  const { w, deps } = world({ windows: 2 });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'has-window');
  assert.deepStrictEqual(w.calls.control, ['stop-if-idle']);
  assert.deepStrictEqual(w.calls.kill, []);
  assert.ok(w.procs.has(4242));
});

test('a holder whose window just left (a reload) refuses too', async () => {
  const { w, deps } = world({ recentLeft: true });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'has-window');
  assert.match(r.text, /reload/);
  assert.ok(w.procs.has(4242));
});

test('an answer that is neither yes nor no stops nothing', async () => {
  for (const reply of [{ type: 'stop-if-idle' }, { type: 'stop-if-idle', stopped: 'yes' }, null]) {
    const { w, deps } = world();
    deps.sendControl = async ({ msg }) => { w.calls.control.push(msg.type); return { ok: true, reply }; };
    const r = await run(deps);
    assert.strictEqual(r.outcome, 'failed', JSON.stringify(reply));
    assert.deepStrictEqual(w.calls.kill, []);
    assert.deepStrictEqual(w.calls.control, ['stop-if-idle']);
  }
});

test('a holder that hung up after taking stop-if-idle and then ended counts as stopped', async () => {
  const { w, deps } = world();
  deps.sendControl = async ({ msg }) => { w.calls.control.push(msg.type); w.procs.delete(4242); w.procs.delete(9); return { ok: false, error: 'closed before reply' }; };
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'stopped');
  assert.deepStrictEqual(w.calls.kill, []);
});

// --- an older build: stop and raise, no stop-if-idle --------------------------

test('an older build with no window (by the OS) is stopped through its own stop', async () => {
  const { w, deps } = world({ controls: ['raise', 'stop'] });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'stopped');
  assert.strictEqual(r.how, 'stop');
  assert.deepStrictEqual(w.calls.control, ['stop-if-idle', 'stop']);
  assert.strictEqual(w.calls.count, 1, 'the OS was asked before the stop');
  assert.deepStrictEqual(w.calls.kill, []);
});

test('an older build with a window (by the OS) is brought forward, never stopped', async () => {
  const { w, deps } = world({ controls: ['raise', 'stop'], windows: 1 });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'has-window');
  assert.deepStrictEqual(w.calls.control, ['stop-if-idle', 'raise']);
  assert.deepStrictEqual(w.calls.kill, []);
});

test('an older build that refuses its stop is ended by its proven pid', async () => {
  const { w, deps } = world({ controls: ['raise', 'stop'], stopEnds: false });
  const send = deps.sendControl;
  deps.sendControl = async (a) => (a.msg.type === 'stop' ? (w.calls.control.push('stop'), { ok: false, error: 'closed before reply' }) : send(a));
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'stopped');
  assert.strictEqual(r.how, 'kill');
  assert.deepStrictEqual(w.calls.kill, [4242]);
});

// --- a holder that can't be asked: the OS decides whether it has a window -----

for (const [cause, over] of Object.entries(UNREACHABLE)) {
  test(`can't be asked (${cause}), window open by the OS: NOT stopped`, async () => {
    const { w, deps } = world({ ...over, windows: 1 });
    const r = await run(deps);
    assert.strictEqual(r.outcome, 'has-window');
    assert.deepStrictEqual(w.calls.kill, []);
    assert.ok(!w.calls.control.includes('stop'));
    assert.ok(w.procs.has(4242));
  });

  test(`can't be asked (${cause}), no window by the OS: its tree is ended by proven pid`, async () => {
    const { w, deps } = world({ ...over, windows: 0 });
    const r = await run(deps);
    assert.strictEqual(r.outcome, 'stopped');
    assert.strictEqual(r.how, 'kill');
    assert.ok(r.reason, 'the log says why the controls were skipped');
    assert.deepStrictEqual(w.calls.kill, [4242]);
  });

  test(`can't be asked (${cause}), the OS can't tell: NOT stopped`, async () => {
    const { w, deps } = world({ ...over, windows: 0, osCount: null });
    const r = await run(deps);
    assert.strictEqual(r.outcome, 'unsure');
    assert.deepStrictEqual(w.calls.kill, []);
    assert.ok(!w.calls.control.includes('stop'));
  });
}

test('the pane never claims a window was brought forward when nothing could raise it', async () => {
  const { deps } = world({ ...UNREACHABLE['a lock from before `install`'], windows: 1 });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'has-window');
  assert.strictEqual(r.text, "That session has a window open, so it wasn't stopped.");
  const reached = world({ controls: ['raise', 'stop'], windows: 1 });
  assert.match((await run(reached.deps)).text, /brought forward/);
});

test('another host on the holder\'s port: its token is never read', async () => {
  const { w, deps } = world(UNREACHABLE['another host on its port']);
  await run(deps);
  assert.deepStrictEqual(w.calls.token, []);
  assert.deepStrictEqual(w.calls.control, []);
});

test('the start time is proven again right before a kill: a pid reused during the ask is spared', async () => {
  const { w, deps } = world({ lock: { ...LOCK, install: undefined } });
  const count = deps.windowCount;
  deps.windowCount = async (...a) => { const n = await count(...a); w.procs.set(4242, '2000'); return n; };
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'gone');
  assert.deepStrictEqual(w.calls.kill, []);
});

test('a holder that cannot be re-proven before a kill is not killed', async () => {
  const { w, deps } = world({ lock: { ...LOCK, install: undefined } });
  let asked = 0;
  const real = deps.startTimes;
  deps.startTimes = async (pids) => (++asked === 2 ? null : real(pids));
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'unproven');
  assert.deepStrictEqual(w.calls.kill, []);
});

// --- the guards before anything is asked --------------------------------------

test('a lock that changed hands since the pane was drawn is left alone', async () => {
  for (const lock of [{ ...LOCK, pid: 5555 }, { ...LOCK, startedAt: 78 }]) {
    const { w, deps } = world({ lock });
    w.procs.set(5555, '1000');
    const r = await run(deps);
    assert.strictEqual(r.outcome, 'changed', JSON.stringify(lock));
    assert.deepStrictEqual(w.calls.control, []);
    assert.deepStrictEqual(w.calls.kill, []);
    assert.deepStrictEqual(w.calls.token, []);
  }
});

test('no pane holder to compare against is "changed", not a licence to stop', async () => {
  for (const shown of [null, undefined, {}, { pid: 4242 }, { startedAt: 77 }, { pid: '4242', startedAt: 77 }]) {
    const { w, deps } = world();
    const r = await run(deps, shown);
    assert.strictEqual(r.outcome, 'changed', JSON.stringify(shown));
    assert.deepStrictEqual(w.calls.control, []);
    assert.deepStrictEqual(w.calls.kill, []);
  }
});

test('a lock that is gone, unreadable or unparsable stops nothing', async () => {
  const { w, deps } = world({ lock: null });
  assert.strictEqual((await run(deps)).outcome, 'gone');
  for (const seen of [{ unreadable: true }, { raw: '', st: null, parsed: null }]) {
    assert.strictEqual((await run({ ...deps, readLock: () => seen })).outcome, 'changed');
  }
  assert.deepStrictEqual(w.calls.control, []);
  assert.deepStrictEqual(w.calls.kill, []);
});

test('a lock naming this host or its parent is never acted on (Miguel S1)', async () => {
  for (const pid of [1, 2]) {
    const { w, deps } = world({ lock: { ...LOCK, pid } });
    w.procs.set(pid, '1000');
    const r = await run(deps, { ...SHOWN, pid });
    assert.strictEqual(r.outcome, 'unproven', String(pid));
    assert.deepStrictEqual(w.calls.control, []);
    assert.deepStrictEqual(w.calls.kill, []);
  }
});

test('a holder whose pid now has another start time has already ended: nothing is stopped', async () => {
  const { w, deps } = world();
  w.procs.set(4242, '2000');
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'gone');
  assert.deepStrictEqual(w.calls.control, []);
  assert.deepStrictEqual(w.calls.kill, []);
  assert.ok(w.procs.has(4242));
});

test('a dead holder pid is "gone" without asking anything', async () => {
  const { w, deps } = world();
  w.procs.delete(4242);
  assert.strictEqual((await run(deps)).outcome, 'gone');
  assert.deepStrictEqual(w.calls.control, []);
});

test('a holder that cannot be proven is never stopped', async () => {
  const cases = [
    ['no start time in the lock', world({ lock: { ...LOCK, processStartedAt: undefined } })],
    ['start time not a string', world({ lock: { ...LOCK, processStartedAt: 1000 } })],
    ['the OS could not be asked', (() => { const x = world(); x.deps.startTimes = async () => null; return x; })()],
    ['start time unreadable', (() => { const x = world(); x.deps.startTimes = async () => new Map([[4242, null]]); return x; })()],
    ['liveness unknown', (() => { const x = world(); x.deps.isAlive = () => null; return x; })()],
  ];
  for (const [name, { w, deps }] of cases) {
    const r = await run(deps);
    assert.strictEqual(r.outcome, 'unproven', name);
    assert.deepStrictEqual(w.calls.control, [], name);
    assert.deepStrictEqual(w.calls.kill, [], name);
  }
});

// --- "stopped" means the session ended, claude included (Dexter F5) -----------

test('a holder still running after the wait is reported, word for word (Miguel S5)', async () => {
  const { w, deps } = world({ stopEnds: false });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'failed');
  assert.strictEqual(r.text, "Couldn't stop that session: it is still running.");
  assert.ok(w.procs.has(4242));
});

test('stopped waits for its claude too: a claude that outlives its host is reported', async () => {
  const { w, deps } = world({ claudeLingers: true });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'failed');
  assert.strictEqual(r.text, "Couldn't stop that session: its claude (pid 9) is still running.");
  assert.ok(!w.procs.has(4242));
});

test('a claude that ends a little after its host is waited for, not reported', async () => {
  const { w, deps } = world({ claudeLingers: true });
  let ticks = 0;
  deps.sleep = async () => { if (++ticks === 3) w.procs.delete(9); };
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'stopped');
});

// THE INVARIANTS, over arbitrary worlds -- whatever the lock, the pane, the
// processes, the holder's build, windows, answers and the OS's report:
//   1. a kill only ever targets the lock's own pid, only while its OS start time
//      equals the lock's processStartedAt, and only after the OS said 0 windows;
//   2. nothing is stopped -- by kill or by `stop` -- while the holder REALLY has
//      a window; and a `stop` frame only ever follows an OS count of 0;
//   3. a kill or a control is only ever aimed at the holder the pane showed;
//   4. a token is only read once the identity file names the holder's pid.
test('property: nothing is stopped that is not proven, windowless and the shown holder', async () => {
  const pid = fc.constantFrom(4242, 5555);
  const start = fc.option(fc.constantFrom('1000', '2000'), { nil: undefined });
  await fc.assert(fc.asyncProperty(
    fc.record({
      lockPid: pid, lockStart: fc.option(fc.constantFrom('1000', '2000', 1000), { nil: undefined }),
      lockStartedAt: fc.constantFrom(77, 78), install: fc.option(fc.constant(INSTALL), { nil: undefined }),
      lockGone: fc.boolean(),
      shownPid: pid, shownStartedAt: fc.constantFrom(77, 78),
      procs: fc.record({ a: start, b: start }),
      identityPid: pid, token: fc.option(fc.constant('tok'), { nil: null }),
      controls: fc.constantFrom(ALL, ['raise', 'stop'], []),
      windows: fc.constantFrom(0, 0, 1, 2), recentLeft: fc.boolean(),
      hung: fc.boolean(), stopEnds: fc.boolean(), osUnknown: fc.boolean(),
      // The holder dies and its pid is reused DURING the ask or the count --
      // independent of the proofs, so deleting a re-proof is caught.
      reuseDuring: fc.constantFrom('never', 'ask', 'count'),
    }),
    async (s) => {
      const lock = s.lockGone ? null : {
        pid: s.lockPid, processStartedAt: s.lockStart, startedAt: s.lockStartedAt, port: 5150, install: s.install, claudePid: 9,
      };
      const { w, deps } = world({
        lock, identity: { port: 5150, pid: s.identityPid }, token: s.token, controls: s.controls,
        windows: s.windows, recentLeft: s.recentLeft, hung: s.hung, stopEnds: s.stopEnds,
        osCount: s.osUnknown ? null : undefined,
      });
      w.procs.clear();
      if (s.procs.a !== undefined) w.procs.set(4242, s.procs.a);
      if (s.procs.b !== undefined) w.procs.set(5555, s.procs.b);
      const reuse = () => { if (lock && w.procs.has(lock.pid)) w.procs.set(lock.pid, '9999'); };

      let osSaidZero = false;
      const realCount = deps.windowCount;
      deps.windowCount = async (...a) => {
        const n = await realCount(...a);
        osSaidZero = n === 0;
        if (s.reuseDuring === 'count') reuse();
        return n;
      };
      const killed = [];
      deps.killPidTree = (p) => {
        killed.push({ p, osStart: w.procs.get(p), osSaidZero });
        w.procs.delete(p);
      };
      const sent = [];
      const realSend = deps.sendControl;
      deps.sendControl = async (a) => {
        sent.push({ type: a.msg.type, osSaidZero });
        if (a.msg.type === 'stop' || a.msg.type === 'stop-if-idle') {
          // A stop that lands on a holder with a window breaks rule 2 no matter what it answers.
          assert.ok(!(a.msg.type === 'stop' && w.windows > 0), 'a stop frame reached a holder with a window');
        }
        const r = await realSend(a);
        if (s.reuseDuring === 'ask') reuse();
        return r;
      };
      const realToken = deps.readToken;
      deps.readToken = (i, p) => { assert.strictEqual(w.identity.pid, lock && lock.pid, 'token read for a stranger'); return realToken(i, p); };

      const shown = { pid: s.shownPid, startedAt: s.shownStartedAt };
      const alivePre = lock && w.procs.get(lock.pid);
      await stopHolder({ lockPath: 'L', shown }, deps);

      const isShown = lock && lock.pid === shown.pid && lock.startedAt === shown.startedAt;
      for (const k of killed) {
        assert.ok(isShown, 'killed a holder the pane did not show');
        assert.strictEqual(k.p, lock.pid, 'killed a pid that is not the lock\'s');
        assert.strictEqual(typeof lock.processStartedAt, 'string');
        assert.strictEqual(k.osStart, lock.processStartedAt, 'killed a pid whose start time did not match');
        assert.ok(k.osSaidZero, 'killed without the OS saying 0 windows');
        assert.strictEqual(w.windows, 0, 'killed a holder that has a window');
      }
      if (sent.length) assert.ok(isShown, 'sent a control to a holder the pane did not show');
      for (const x of sent.filter(x => x.type === 'stop')) assert.ok(x.osSaidZero, 'stop sent without the OS saying 0');
      // A holder with a window that was alive (and itself) before is alive after.
      if (lock && w.windows > 0 && alivePre === lock.processStartedAt && s.reuseDuring === 'never') {
        assert.strictEqual(w.procs.get(lock.pid), lock.processStartedAt, 'a holder with a window was stopped');
      }
    },
  ), { numRuns: 3000 });
});
