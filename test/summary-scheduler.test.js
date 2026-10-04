'use strict';
/**
 * When a tab's summary may be refreshed (host/summary-scheduler.js, backlog #39 job 1;
 * documentation/DESIGN_SLAVE_MODE_SUMMARY.md decision 3):
 *   - only a tab with new turns, after 25 s of quiet (a streaming turn must not trigger a job every few seconds);
 *   - at most once per tab per 2 minutes;
 *   - one job at a time (the GPU is shared by every tab), oldest waiting first;
 *   - never while the machine is on battery;
 *   - a failed job (Ollama down) holds that tab off for a while and keeps it waiting.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createScheduler, QUIET_MS, MIN_GAP_MS, MAX_WAIT_MS } = require('../host/summary-scheduler');

const S = 1000;

test('the design constants: 25 s quiet, 2 min per tab, and a tab that never goes quiet waits at most 2 min more', () => {
  assert.strictEqual(QUIET_MS, 25 * S);
  assert.strictEqual(MIN_GAP_MS, 120 * S);
  assert.strictEqual(MAX_WAIT_MS, 120 * S);
});

// Dexter F1 (PR #105): a tab with turns arriving every few seconds never goes quiet, so the debounce alone starves it.
test('a tab that never goes quiet is due once it has been waiting MAX_WAIT_MS, and not a millisecond before', () => {
  const s2 = createScheduler();
  for (let t = 0; t <= 200 * S; t += 20 * S) s2.activity('busy', t);        // a turn every 20 s: always inside the quiet window
  assert.strictEqual(s2.ready(MAX_WAIT_MS - 1), null);
  assert.strictEqual(s2.ready(MAX_WAIT_MS), 'busy');
});

test('a tab nobody wrote to is never due: an idle tab costs nothing', () => {
  const s = createScheduler();
  assert.strictEqual(s.ready(10 ** 9), null);
});

test('new turns are due after the quiet period, exactly at it and not a millisecond before', () => {
  const s = createScheduler();
  s.activity('a', 1000);
  assert.strictEqual(s.ready(1000 + QUIET_MS - 1), null);
  assert.strictEqual(s.ready(1000 + QUIET_MS), 'a');
});

test('more activity restarts the quiet period (the debounce)', () => {
  const s = createScheduler();
  s.activity('a', 0);
  s.activity('a', 20 * S);
  assert.strictEqual(s.ready(30 * S), null);
  assert.strictEqual(s.ready(45 * S), 'a');
});

test('once started a tab is not due again for 2 minutes, however busy it stays', () => {
  const s = createScheduler();
  s.activity('a', 0);
  assert.strictEqual(s.start('a', 30 * S), true);
  s.finish('a', 33 * S);
  s.activity('a', 40 * S);
  assert.strictEqual(s.ready(70 * S), null, 'quiet but inside the cap');
  assert.strictEqual(s.ready(30 * S + MIN_GAP_MS - 1), null);
  assert.strictEqual(s.ready(30 * S + MIN_GAP_MS), 'a');
});

test('one job at a time: nothing else is due while one runs', () => {
  const s = createScheduler();
  s.activity('a', 0); s.activity('b', 0);
  assert.strictEqual(s.start('a', 30 * S), true);
  assert.strictEqual(s.running(), 'a');
  assert.strictEqual(s.ready(60 * S), null);
  assert.strictEqual(s.start('b', 60 * S), false, 'a second start is refused');
  s.finish('a', 62 * S);
  assert.strictEqual(s.running(), null);
  assert.strictEqual(s.ready(63 * S), 'b');
});

test('the tab that has waited longest goes first', () => {
  const s = createScheduler();
  s.activity('late', 10 * S); s.activity('early', 1 * S); s.activity('mid', 5 * S);
  const order = [];
  let now = 60 * S;
  for (let i = 0; i < 3; i++) {
    const k = s.ready(now);
    order.push(k);
    s.start(k, now);
    s.finish(k, now + 2 * S);
    now += 3 * S;
  }
  assert.deepStrictEqual(order, ['early', 'mid', 'late']);
});

test('a tab that is still inside its quiet period does not block one that is due', () => {
  const s = createScheduler();
  s.activity('busy', 59 * S); s.activity('calm', 0);
  assert.strictEqual(s.ready(60 * S), 'calm');
});

test('on battery nothing runs; an unknown power state does not stop it', () => {
  const s = createScheduler();
  s.activity('a', 0);
  assert.strictEqual(s.ready(60 * S, { onBattery: true }), null);
  assert.strictEqual(s.ready(60 * S, { onBattery: false }), 'a');
  assert.strictEqual(s.ready(60 * S, { onBattery: null }), 'a');
  assert.strictEqual(s.ready(60 * S, { onBattery: 'yes' }), 'a', 'only a real true pauses');
  assert.strictEqual(s.ready(60 * S), 'a');
});

test('a failure keeps the tab waiting and holds it off for the given time', () => {
  const s = createScheduler();
  s.activity('a', 0);
  s.start('a', 30 * S);
  s.fail('a', 33 * S, 60 * S);
  assert.strictEqual(s.running(), null);
  assert.strictEqual(s.ready(33 * S + 60 * S - 1), null);
  assert.strictEqual(s.ready(33 * S + 60 * S), 'a');
});

test('a failure gives the cap back: the job made no summary, so the hold is the only wait', () => {
  const s = createScheduler();
  s.activity('a', 0);
  s.start('a', 30 * S);
  s.fail('a', 31 * S, 5 * S);
  assert.strictEqual(s.ready(36 * S - 1), null);
  assert.strictEqual(s.ready(36 * S), 'a');
});

test('a hold that is not a real number holds nothing but cannot lose the tab either', () => {
  const s = createScheduler();
  s.activity('a', 0);
  s.start('a', 30 * S);
  s.fail('a', 31 * S, null);
  assert.strictEqual(s.state('a').dirty, true);
  assert.strictEqual(s.ready(30 * S + MIN_GAP_MS), 'a');
});

test('activity during a job keeps the tab waiting; none during it clears it', () => {
  const s = createScheduler();
  s.activity('a', 0);
  s.start('a', 30 * S);
  s.activity('a', 31 * S);
  s.finish('a', 33 * S);
  assert.strictEqual(s.state('a').dirty, true);

  const t = createScheduler();
  t.activity('a', 0);
  t.start('a', 30 * S);
  t.finish('a', 33 * S);
  assert.strictEqual(t.state('a').dirty, false);
  assert.strictEqual(t.ready(10 ** 9), null);
});

test('clean(): nothing new after all (the newest message is the one already summarised) costs no job and gives the cap back', () => {
  const s = createScheduler();
  s.activity('a', 0);
  s.start('a', 30 * S);
  s.clean('a', 30 * S);
  assert.strictEqual(s.running(), null);
  assert.strictEqual(s.state('a').dirty, false);
  s.activity('a', 40 * S);
  assert.strictEqual(s.ready(64 * S), null, 'new activity restarts the quiet period');
  assert.strictEqual(s.ready(65 * S), 'a', 'no GPU job ran, so the 2 minute cap is not spent');
});

test('a tab that closed is forgotten, and a job that was running for it stops blocking the others', () => {
  const s = createScheduler();
  s.activity('a', 0); s.activity('b', 0);
  s.start('a', 30 * S);
  s.forget('a');
  assert.strictEqual(s.running(), null);
  assert.strictEqual(s.state('a'), null);
  assert.strictEqual(s.ready(31 * S), 'b');
});

test('times that are not numbers are ignored, never read as 0 (Number(null) is 0)', () => {
  const s = createScheduler();
  s.activity('a', null);
  s.activity('a', undefined);
  s.activity('a', NaN);
  s.activity('a', '5');
  assert.strictEqual(s.state('a'), null);
  s.activity('b', 0);
  assert.strictEqual(s.ready(null), null);
  assert.strictEqual(s.ready(NaN), null);
  assert.strictEqual(s.ready(undefined), null);
  assert.strictEqual(s.start('b', null), false);
  assert.strictEqual(s.running(), null);
  s.activity('', 0);
  s.activity(null, 0);
  assert.strictEqual(s.state(''), null);
});

test('finish/fail/clean for a tab that is not the running one change nothing', () => {
  const s = createScheduler();
  s.activity('a', 0); s.activity('b', 0);
  s.start('a', 30 * S);
  s.finish('b', 31 * S);
  s.fail('b', 31 * S, 1000);
  s.clean('b', 31 * S);
  assert.strictEqual(s.running(), 'a');
  assert.strictEqual(s.state('b').dirty, true);
});

test('property: under any sequence of events, never two jobs, every start respects quiet and the per-tab cap', () => {
  const opArb = fc.oneof(
    fc.record({ op: fc.constant('activity'), key: fc.constantFrom('a', 'b', 'c'), dt: fc.nat(40000) }),
    fc.record({ op: fc.constant('tick'), dt: fc.nat(60000), battery: fc.constantFrom(true, false, null) }),
    fc.record({ op: fc.constant('end'), how: fc.constantFrom('finish', 'fail', 'clean'), dt: fc.nat(8000), hold: fc.nat(90000) }),
  );
  fc.assert(fc.property(fc.array(opArb, { maxLength: 80 }), (ops) => {
    const s = createScheduler();
    let now = 0;
    const lastActivity = {};
    const firstActivity = {};     // since the last time a job ended with nothing new
    const startedAt = {};     // when the last SUMMARY (finish) started: the only thing that spends the cap
    const pending = {};
    for (const o of ops) {
      now += o.dt;
      if (o.op === 'activity') { s.activity(o.key, now); lastActivity[o.key] = now; if (firstActivity[o.key] == null) firstActivity[o.key] = now; continue; }
      if (o.op === 'end') {
        const k = s.running();
        if (k === null) continue;
        if (o.how === 'finish') { s.finish(k, now); startedAt[k] = pending[k]; } else if (o.how === 'fail') s.fail(k, now, o.hold); else s.clean(k, now);
        if (o.how !== 'fail') firstActivity[k] = lastActivity[k] >= pending[k] ? lastActivity[k] : null;
        assert.strictEqual(s.running(), null);
        continue;
      }
      const k = s.ready(now, { onBattery: o.battery });
      if (k === null) continue;
      assert.notStrictEqual(o.battery, true, 'nothing is due on battery');
      assert.strictEqual(s.running(), null, 'nothing is due while a job runs');
      assert.ok(now - lastActivity[k] >= QUIET_MS || now - firstActivity[k] >= MAX_WAIT_MS, 'quiet, or waited long enough');
      if (startedAt[k] !== undefined) assert.ok(now - startedAt[k] >= MIN_GAP_MS, 'per-tab cap respected');
      assert.strictEqual(s.start(k, now), true);
      pending[k] = now;
    }
  }), { numRuns: 300 });
});
