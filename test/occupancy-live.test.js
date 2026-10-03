'use strict';
/**
 * host/occupancy-live.js: a claim FILE is only a claim. Shown only while the launching host is proven
 * alive, with the same proof host/background-hosts.js calls `exact`: the pid is running AND its OS start
 * time is the one the claim recorded. Windows reuses pids, so the pid alone proves nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { judge, LIVE, DEAD, UNKNOWN, UNPROVEN } = require('../host/occupancy-live');

const claim = (over = {}) => ({ agentId: 'a1', hostPid: 101, hostStartedAt: '1000', ...over });
const startTimes = (map, calls = []) => async (pids) => { calls.push(pids); return map === null ? null : new Map(pids.filter(p => map.has(p)).map(p => [p, map.get(p)])); };

const verdictOf = async (c, map) => (await judge([c], startTimes(map)))[0].verdict;

test('a running pid whose start time is the recorded one is live', async () => {
  assert.strictEqual(await verdictOf(claim(), new Map([[101, '1000']])), LIVE);
});

test('a pid that is not running is dead', async () => {
  assert.strictEqual(await verdictOf(claim(), new Map()), DEAD);
});

test('a REUSED pid (running, but started at another time) is dead', async () => {
  assert.strictEqual(await verdictOf(claim(), new Map([[101, '2000']])), DEAD);
});

test('a claim with no hostStartedAt is never live, even with its pid running (nothing to prove it against)', async () => {
  const v = await verdictOf(claim({ hostStartedAt: null }), new Map([[101, '1000']]));
  assert.strictEqual(v, UNPROVEN);
  assert.notStrictEqual(v, LIVE);
});

test('a claim with no hostStartedAt and no running pid is dead (a dead claim is a dead claim)', async () => {
  assert.strictEqual(await verdictOf(claim({ hostStartedAt: null }), new Map()), DEAD);
});

test('when the OS can\'t be asked the answer is unknown, never dead (that would let a sweep delete a live claim)', async () => {
  assert.strictEqual(await verdictOf(claim(), null), UNKNOWN);
});

test('a running pid whose start time can\'t be read is unknown, not dead', async () => {
  assert.strictEqual(await verdictOf(claim(), new Map([[101, null]])), UNKNOWN);
});

test('one query covers every pid; none is made for no claims', async () => {
  const calls = [];
  const out = await judge([claim({ agentId: 'a' }), claim({ agentId: 'b' }), claim({ agentId: 'c', hostPid: 202 })],
    startTimes(new Map([[101, '1000']]), calls));
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual([...calls[0]].sort(), [101, 202]);
  assert.deepStrictEqual(out.map(o => o.verdict), [LIVE, LIVE, DEAD]);
  const none = [];
  assert.deepStrictEqual(await judge([], startTimes(new Map(), none)), []);
  assert.strictEqual(none.length, 0);
});

test('a query that throws is unknown for everyone', async () => {
  const out = await judge([claim()], async () => { throw new Error('powershell died'); });
  assert.strictEqual(out[0].verdict, UNKNOWN);
});

test('each result carries its claim', async () => {
  const c = claim();
  const out = await judge([c], startTimes(new Map([[101, '1000']])));
  assert.strictEqual(out[0].claim, c);
});

test('PROPERTY: live exactly when the pid runs with exactly the recorded start time', async () => {
  const ft = fc.bigInt({ min: 1n, max: 999n }).map(String);
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.option(ft, { nil: null }),
    fc.option(fc.option(ft, { nil: null }), { nil: undefined }),
    async (pid, recorded, running) => {
      // running: undefined = not running, null = running with an unreadable start, string = its start
      const map = new Map();
      if (running !== undefined) map.set(pid, running);
      const v = await verdictOf(claim({ hostPid: pid, hostStartedAt: recorded }), map);
      const expectLive = recorded !== null && typeof running === 'string' && running === recorded;
      assert.strictEqual(v === LIVE, expectLive);
      if (running === undefined) assert.strictEqual(v, DEAD);
      return true;
    }), { numRuns: 300 });
});
