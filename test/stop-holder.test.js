'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { stopHolder } = require('../host/stop-holder');

const INSTALL = 'C:\\inst-a';
const LOCK = { pid: 4242, processStartedAt: '1000', startedAt: 77, port: 5150, claudePid: 9, install: INSTALL };
// What the blocked pane was shown: host/session-lock.js holderOf(), no start time.
const SHOWN = { pid: 4242, startedAt: 77, port: 5150, claudePid: 9, install: INSTALL };

// A small world: the lock on disk, the live processes (pid -> OS start time),
// the holder's identity file and token, and how the holder answers controls.
function world(over = {}) {
  const procs = new Map([[4242, '1000']]);
  const calls = { control: [], kill: [], token: [] };
  const w = {
    procs, calls,
    lock: { ...LOCK },
    identity: { port: 5150, cwd: 'x', pid: 4242, startedAt: 1 },
    token: 'tok',
    windows: 0,
    controlError: null,
    stopEnds: true,
    ...over,
  };
  const deps = {
    readLock: () => (w.lock === null ? { gone: true } : { raw: JSON.stringify(w.lock), st: null, parsed: w.lock }),
    isAlive: pid => procs.has(pid),
    startTimes: async pids => new Map(pids.filter(p => procs.has(p)).map(p => [p, procs.get(p)])),
    readIdentity: ({ install, port }) => (install === INSTALL && port === 5150 ? w.identity : null),
    readToken: (install, port) => { calls.token.push([install, port]); return w.token; },
    sendControl: async ({ msg }) => {
      calls.control.push(msg.type);
      if (w.controlError) return { ok: false, error: w.controlError };
      if (msg.type === 'raise') return { ok: true, reply: { type: 'raised', windows: w.windows } };
      if (msg.type === 'stop') {
        if (w.stopEnds) procs.delete(w.lock.pid);
        return { ok: true, reply: null };
      }
      return { ok: false, error: 'unsupported' };
    },
    killPidTree: pid => { calls.kill.push(pid); procs.delete(pid); },
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 100); })(),
  };
  return { w, deps };
}

test('a holder with no window is asked to stop through its own controls', async () => {
  const { w, deps } = world();
  const r = await stopHolder({ lockPath: 'L', shown: SHOWN }, deps);
  assert.strictEqual(r.outcome, 'stopped');
  assert.deepStrictEqual(w.calls.control, ['raise', 'stop']);
  assert.deepStrictEqual(w.calls.kill, []);
});

test('a holder with a window open is brought forward, never stopped', async () => {
  const { w, deps } = world({ windows: 2 });
  const r = await stopHolder({ lockPath: 'L', shown: SHOWN }, deps);
  assert.strictEqual(r.outcome, 'has-window');
  assert.deepStrictEqual(w.calls.control, ['raise']);
  assert.deepStrictEqual(w.calls.kill, []);
  assert.ok(w.procs.has(4242));
});

test('a lock that changed hands since the pane was drawn is left alone', async () => {
  for (const lock of [
    { ...LOCK, pid: 5555 },                          // another host took it
    { ...LOCK, startedAt: 78 },                      // same pid, a later lock
  ]) {
    const { w, deps } = world({ lock });
    w.procs.set(5555, '1000');
    const r = await stopHolder({ lockPath: 'L', shown: SHOWN }, deps);
    assert.strictEqual(r.outcome, 'changed', JSON.stringify(lock));
    assert.deepStrictEqual(w.calls.control, []);
    assert.deepStrictEqual(w.calls.kill, []);
    assert.deepStrictEqual(w.calls.token, []);
  }
});

test('no pane holder to compare against is "changed", not a licence to stop', async () => {
  for (const shown of [null, undefined, {}, { pid: 4242 }, { startedAt: 77 }]) {
    const { w, deps } = world();
    const r = await stopHolder({ lockPath: 'L', shown }, deps);
    assert.strictEqual(r.outcome, 'changed', JSON.stringify(shown));
    assert.deepStrictEqual(w.calls.control, []);
    assert.deepStrictEqual(w.calls.kill, []);
  }
});

test('a lock that is gone, unreadable or unparsable stops nothing', async () => {
  const { w, deps } = world({ lock: null });
  assert.strictEqual((await stopHolder({ lockPath: 'L', shown: SHOWN }, deps)).outcome, 'gone');
  for (const seen of [{ unreadable: true }, { raw: '', st: null, parsed: null }]) {
    const d = { ...deps, readLock: () => seen };
    assert.strictEqual((await stopHolder({ lockPath: 'L', shown: SHOWN }, d)).outcome, 'changed');
  }
  assert.deepStrictEqual(w.calls.control, []);
  assert.deepStrictEqual(w.calls.kill, []);
});

test('a holder whose pid now has another start time has already ended: nothing is stopped', async () => {
  const { w, deps } = world();
  w.procs.set(4242, '2000');                         // Windows reused the pid
  const r = await stopHolder({ lockPath: 'L', shown: SHOWN }, deps);
  assert.strictEqual(r.outcome, 'gone');
  assert.deepStrictEqual(w.calls.control, []);
  assert.deepStrictEqual(w.calls.kill, []);
  assert.ok(w.procs.has(4242));
});

test('a dead holder pid is "gone" without asking anything', async () => {
  const { w, deps } = world();
  w.procs.delete(4242);
  assert.strictEqual((await stopHolder({ lockPath: 'L', shown: SHOWN }, deps)).outcome, 'gone');
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
    const r = await stopHolder({ lockPath: 'L', shown: SHOWN }, deps);
    assert.strictEqual(r.outcome, 'unproven', name);
    assert.deepStrictEqual(w.calls.control, [], name);
    assert.deepStrictEqual(w.calls.kill, [], name);
  }
});

test('a holder that cannot take the controls has its process tree ended, once proven', async () => {
  const OLDER = 'that session runs an older claude-custom that can\'t take "raise" (reopen it to update)';
  const cases = [
    ['a lock from before `install` existed', world({ lock: { ...LOCK, install: undefined } })],
    ['an older build without raise', world({ controlError: OLDER })],
    ['a hung host', world({ controlError: 'timed out after 3000ms' })],
    ['no token file', world({ token: null })],
  ];
  for (const [name, { w, deps }] of cases) {
    const r = await stopHolder({ lockPath: 'L', shown: SHOWN }, deps);
    assert.strictEqual(r.outcome, 'stopped', name);
    assert.deepStrictEqual(w.calls.kill, [4242], name);
  }
});

test('another host on the holder\'s port: its token is never read, the holder is ended by pid', async () => {
  const { w, deps } = world({ identity: { port: 5150, cwd: 'y', pid: 7777, startedAt: 1 } });
  const r = await stopHolder({ lockPath: 'L', shown: SHOWN }, deps);
  assert.strictEqual(r.outcome, 'stopped');
  assert.deepStrictEqual(w.calls.token, []);
  assert.deepStrictEqual(w.calls.control, []);
  assert.deepStrictEqual(w.calls.kill, [4242]);
});

test('a stop the holder refuses falls back to ending its tree', async () => {
  const { w, deps } = world();
  const send = deps.sendControl;
  deps.sendControl = async (a) => (a.msg.type === 'stop' ? (w.calls.control.push('stop'), { ok: false, error: 'closed before reply' }) : send(a));
  const r = await stopHolder({ lockPath: 'L', shown: SHOWN }, deps);
  assert.strictEqual(r.outcome, 'stopped');
  assert.deepStrictEqual(w.calls.control, ['raise', 'stop']);
  assert.deepStrictEqual(w.calls.kill, [4242]);
});

test('the start time is proven again right before a kill: a pid reused meanwhile is spared', async () => {
  const { w, deps } = world({ lock: { ...LOCK, install: undefined } });
  let asked = 0;
  const real = deps.startTimes;
  deps.startTimes = async (pids) => (++asked === 2 ? new Map([[4242, '2000']]) : real(pids));
  const r = await stopHolder({ lockPath: 'L', shown: SHOWN }, deps);
  assert.strictEqual(r.outcome, 'gone');
  assert.deepStrictEqual(w.calls.kill, []);
});

test('a holder that cannot be re-proven before a kill is not killed', async () => {
  const { w, deps } = world({ lock: { ...LOCK, install: undefined } });
  let asked = 0;
  const real = deps.startTimes;
  deps.startTimes = async (pids) => (++asked === 2 ? null : real(pids));
  const r = await stopHolder({ lockPath: 'L', shown: SHOWN }, deps);
  assert.strictEqual(r.outcome, 'unproven');
  assert.deepStrictEqual(w.calls.kill, []);
});

test('a holder still running after the wait is reported, not claimed stopped', async () => {
  const { w, deps } = world({ stopEnds: false });
  const r = await stopHolder({ lockPath: 'L', shown: SHOWN }, deps);
  assert.strictEqual(r.outcome, 'failed');
  assert.match(r.text, /still running/);
  assert.ok(w.procs.has(4242));
});

test('a raise reply that does not say how many windows stops nothing', async () => {
  for (const windows of [undefined, null, '0', -1, 1.5, NaN]) {
    const { w, deps } = world({ windows });
    const r = await stopHolder({ lockPath: 'L', shown: SHOWN }, deps);
    assert.strictEqual(r.outcome, 'failed', String(windows));
    assert.deepStrictEqual(w.calls.control, ['raise'], String(windows));
    assert.deepStrictEqual(w.calls.kill, [], String(windows));
  }
});

// THE INVARIANTS, over arbitrary worlds: whatever the lock, the pane, the
// processes, the identity file, the token and the holder's answers,
//   1. a kill only ever targets the lock's own pid, and only while the OS start
//      time of that pid equals the lock's processStartedAt;
//   2. a kill or a control is only ever aimed at the holder the pane showed;
//   3. `stop` is only sent after a `raise` that answered exactly 0 windows;
//   4. a token is only read once the identity file names the holder's pid.
test('property: nothing is stopped that is not proven, windowless, and the shown holder', async () => {
  const pid = fc.constantFrom(4242, 5555);
  const start = fc.option(fc.constantFrom('1000', '2000'), { nil: undefined });
  await fc.assert(fc.asyncProperty(
    fc.record({
      lockPid: pid, lockStart: fc.option(fc.constantFrom('1000', '2000', 1000), { nil: undefined }),
      lockStartedAt: fc.constantFrom(77, 78), install: fc.option(fc.constant(INSTALL), { nil: undefined }),
      lockGone: fc.boolean(),
      shownPid: pid, shownStartedAt: fc.constantFrom(77, 78),
      procs: fc.record({ a: start, b: start }),
      reuseOnSecondAsk: fc.boolean(), osUnaskable: fc.boolean(),
      identityPid: pid, token: fc.option(fc.constant('tok'), { nil: null }),
      windows: fc.constantFrom(0, 0, 1, 2, undefined, null, '0', -1),
      controlError: fc.option(fc.constantFrom('timed out after 3000ms', 'connection refused'), { nil: null }),
      stopEnds: fc.boolean(),
    }),
    async (s) => {
      const lock = s.lockGone ? null : {
        pid: s.lockPid, processStartedAt: s.lockStart, startedAt: s.lockStartedAt, port: 5150, install: s.install,
      };
      const { w, deps } = world({
        lock, identity: { port: 5150, pid: s.identityPid }, token: s.token,
        windows: s.windows, controlError: s.controlError, stopEnds: s.stopEnds,
      });
      w.procs.clear();
      if (s.procs.a !== undefined) w.procs.set(4242, s.procs.a);
      if (s.procs.b !== undefined) w.procs.set(5555, s.procs.b);

      let asks = 0;
      const realStarts = deps.startTimes;
      deps.startTimes = async (pids) => {
        asks += 1;
        if (s.osUnaskable && asks > 1) return null;
        if (s.reuseOnSecondAsk && asks === 2) for (const p of pids) if (w.procs.has(p)) w.procs.set(p, '9999');
        return realStarts(pids);
      };
      const killed = [];
      deps.killPidTree = (p) => { killed.push({ p, osStart: w.procs.get(p) }); w.procs.delete(p); };
      const sent = [];
      const realSend = deps.sendControl;
      deps.sendControl = async (a) => { const r = await realSend(a); sent.push({ type: a.msg.type, r }); return r; };
      const realToken = deps.readToken;
      deps.readToken = (i, p) => { assert.strictEqual(w.identity.pid, lock && lock.pid, 'token read for a stranger'); return realToken(i, p); };

      const shown = { pid: s.shownPid, startedAt: s.shownStartedAt };
      const r = await stopHolder({ lockPath: 'L', shown }, deps);

      const isShown = lock && lock.pid === shown.pid && lock.startedAt === shown.startedAt;
      for (const k of killed) {
        assert.ok(isShown, 'killed a holder the pane did not show');
        assert.strictEqual(k.p, lock.pid, 'killed a pid that is not the lock\'s');
        assert.strictEqual(typeof lock.processStartedAt, 'string');
        assert.strictEqual(k.osStart, lock.processStartedAt, 'killed a pid whose start time did not match');
      }
      if (sent.length) assert.ok(isShown, 'sent a control to a holder the pane did not show');
      const stopAt = sent.findIndex(x => x.type === 'stop');
      if (stopAt !== -1) {
        assert.strictEqual(stopAt, 1);
        assert.strictEqual(sent[0].type, 'raise');
        assert.strictEqual(sent[0].r.reply.windows, 0, 'stop sent to a holder with a window (or an unclear answer)');
      }
      if (r.outcome === 'stopped') assert.ok(!lock || !w.procs.has(lock.pid) || w.procs.get(lock.pid) !== lock.processStartedAt);
    },
  ), { numRuns: 2000 });
});
