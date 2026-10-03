'use strict';
/**
 * The Git dial's motion (documentation/DESIGN_GIT_TREE.md, "Enhancement #46", A3 Settle). Pure, with a
 * fake clock: the dial swings forward and back on a sine wave, never a full turn,
 *   angle = 40 deg * sin(2 pi * clock / 90 s)
 * and its OWN clock slows to a stop (about 0.5 s) while the pointer is over the dial or a branch is
 * pinned, then picks up about 2.5 s after. Reduced motion is still. Each spoke breathes +-3% on a
 * slow sine whose phase is stable per branch name. Sparks are for MEASURED growth only.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const S = require('../app/git-swing');

// run the swing for `ms`, in `frame`-ms steps, with a constant input
function run(state, from, ms, input, frame = 16) {
  let s = state;
  let t = from;
  for (let end = from + ms; t < end; t += frame) s = S.step(s, t, input);
  return { state: S.step(s, t, input), t };
}

test('the constants are the ones Ricardo chose', () => {
  assert.strictEqual(S.SWING_DEG, 40);
  assert.strictEqual(S.PERIOD_S, 90);
  assert.strictEqual(S.EASE_S, 0.5);
  assert.strictEqual(S.RESUME_MS, 2500);
  assert.strictEqual(S.BREATH, 0.03);
});

test('angle is 40 degrees times sin(2 pi clock / 90 s)', () => {
  assert.strictEqual(S.angleDeg(0), 0);
  assert.ok(Math.abs(S.angleDeg(22.5) - 40) < 1e-9, 'a quarter period is the full swing forward');
  assert.ok(Math.abs(S.angleDeg(45)) < 1e-9, 'half a period is back at rest');
  assert.ok(Math.abs(S.angleDeg(67.5) + 40) < 1e-9, 'three quarters is the full swing back');
});

test('a running dial advances its own clock at one second per second', () => {
  const a = run(S.start(), 1000, 4000, {});
  assert.ok(Math.abs(a.state.clock - 4) < 0.05, `clock ${a.state.clock}`);
});

test('the first step has no past: it advances nothing', () => {
  const s = S.step(S.start(), 123456, {});
  assert.strictEqual(s.clock, 0);
});

test('a pointer over the dial eases it to a stop in about half a second, and holds', () => {
  let r = run(S.start(), 0, 3000, {});
  const before = r.state.clock;
  r = run(r.state, r.t, 600, { holding: true });
  const settled = r.state.clock;
  assert.ok(settled > before, 'it kept moving while it eased');
  assert.ok(settled - before < 0.5, `it slid ${settled - before} s of clock: an ease, not a coast`);
  const later = run(r.state, r.t, 5000, { holding: true });
  assert.strictEqual(later.state.clock, settled, 'held: the clock never advances');
  assert.strictEqual(later.state.speed, 0);
});

test('it picks up again about 2.5 s after the hold ends, and not before', () => {
  let r = run(S.start(), 0, 2000, {});
  r = run(r.state, r.t, 1000, { holding: true });
  const held = r.state.clock;
  const release = r.t;
  r = run(r.state, release, 2300, {});
  assert.strictEqual(r.state.clock, held, 'still waiting 2.3 s after release');
  r = run(r.state, r.t, 1500, {});
  assert.ok(r.state.clock > held + 0.3, `moving again: ${r.state.clock - held}`);
});

test('it eases back up as well: speed rises over about half a second, it does not jump', () => {
  let r = run(S.start(), 0, 1000, { holding: true });
  r = run(r.state, r.t, 2500, {});
  const s0 = S.step(r.state, r.t + 16, {}).speed;
  assert.ok(s0 > 0 && s0 < 0.2, `first frame of the pick-up: ${s0}`);
});

test('reduced motion is still: the clock never moves and the angle is the rest angle', () => {
  const r = run(S.start(), 0, 10000, { reduced: true });
  assert.strictEqual(r.state.clock, 0);
  assert.strictEqual(S.angleDeg(r.state.clock), 0);
  assert.strictEqual(S.breath('feat/a', 123.4, { reduced: true }), 1);
});

test('a frame that comes after a long gap (a hidden window) moves the dial a step, not a leap', () => {
  const a = S.step(S.start(), 0, {});
  const b = S.step(a, 3600 * 1000, {});
  assert.ok(b.clock < 0.2, `an hour gap advanced ${b.clock} s`);
});

test('a clock that runs for ever stays inside one period', () => {
  let s = S.start();
  for (let t = 0; t < 200 * 1000; t += 90) s = S.step(s, t, {});
  assert.ok(s.clock >= 0 && s.clock < S.PERIOD_S);
});

test('property: the angle never exceeds the swing, for any clock', () => {
  fc.assert(fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), c => Math.abs(S.angleDeg(c)) <= S.SWING_DEG + 1e-9));
});

test('property: a held clock never advances, whatever happened before', () => {
  fc.assert(fc.property(
    fc.array(fc.record({ dt: fc.integer({ min: 1, max: 400 }), holding: fc.boolean() }), { maxLength: 80 }),
    fc.integer({ min: 600, max: 4000 }),
    (history, holdMs) => {
      let s = S.start();
      let t = 0;
      for (const h of history) { t += h.dt; s = S.step(s, t, { holding: h.holding }); }
      // hold long enough to be at rest, then every further frame leaves the clock exactly where it was
      for (let end = t + holdMs; t < end; t += 16) s = S.step(s, t, { holding: true });
      const rest = s.clock;
      for (let i = 0; i < 40; i++) { t += 16; s = S.step(s, t, { holding: true }); assert.strictEqual(s.clock, rest); }
    }));
});

test('property: the clock never goes backwards inside a period, and speed stays in [0, 1]', () => {
  fc.assert(fc.property(
    fc.array(fc.record({ dt: fc.integer({ min: 1, max: 300 }), holding: fc.boolean(), reduced: fc.boolean() }), { maxLength: 100 }),
    (history) => {
      let s = S.start();
      let t = 0;
      for (const h of history) {
        t += h.dt;
        const next = S.step(s, t, h);
        assert.ok(next.speed >= 0 && next.speed <= 1);
        const moved = (next.clock - s.clock + S.PERIOD_S) % S.PERIOD_S;
        assert.ok(moved <= 0.1 + 1e-9, `moved ${moved} in one step`);
        s = next;
      }
    }));
});

test('breathing: inside +-3% for any name and time', () => {
  fc.assert(fc.property(fc.string(), fc.double({ min: 0, max: 1e7, noNaN: true }), (name, t) => {
    const f = S.breath(name, t);
    assert.ok(f >= 1 - S.BREATH - 1e-12 && f <= 1 + S.BREATH + 1e-12, String(f));
  }));
});

test('breathing: a name\'s phase is stable, and different names are out of step', () => {
  assert.strictEqual(S.breathPhase('feat/a'), S.breathPhase('feat/a'));
  assert.notStrictEqual(S.breathPhase('feat/a'), S.breathPhase('feat/b'));
  const p = S.breathPhase('anything');
  assert.ok(p >= 0 && p < 1);
  assert.strictEqual(S.breath('feat/a', 5), S.breath('feat/a', 5));
});

test('breathing: it does reach both ends over a period (it is a real sine, not a constant)', () => {
  let lo = 2; let hi = 0;
  for (let t = 0; t < 20; t += 0.05) { const f = S.breath('feat/a', t); lo = Math.min(lo, f); hi = Math.max(hi, f); }
  assert.ok(lo < 0.99 && hi > 1.01, `${lo} .. ${hi}`);
});

test('breathing: names that are data (__proto__, constructor) are only hashed', () => {
  for (const n of ['__proto__', 'constructor', 'toString', '']) {
    const f = S.breath(n, 3);
    assert.ok(Number.isFinite(f));
  }
});

test('rotate: a point turns about the hub, and a zero angle leaves it where it is', () => {
  const p = S.rotatePoint(10, 0, 0, 0, 90);
  assert.ok(Math.abs(p[0]) < 1e-9 && Math.abs(p[1] - 10) < 1e-9, JSON.stringify(p));
  assert.deepStrictEqual(S.rotatePoint(3, 4, 1, 1, 0), [3, 4]);
});

// ---- live activity: sparks are for MEASURED growth only ----

test('grown: only a branch whose spend was measured before AND is larger now', () => {
  const prev = [{ name: 'a', spend: 100 }, { name: 'b', spend: 100 }, { name: 'c', spend: null }, { name: 'd', spend: 5 }];
  const next = [{ name: 'a', spend: 150 }, { name: 'b', spend: 100 }, { name: 'c', spend: 50 }, { name: 'd', spend: null },
    { name: 'e', spend: 70 }];
  assert.deepStrictEqual([...S.grown(prev, next)], ['a']);
});

test('grown: no previous answer means nothing was measured to grow', () => {
  assert.strictEqual(S.grown(null, [{ name: 'a', spend: 5 }]).size, 0);
  assert.strictEqual(S.grown(undefined, undefined).size, 0);
});

test('grown: a spend that fell (a re-read) is not growth, and a number-like string is not a number', () => {
  const g = S.grown([{ name: 'a', spend: 100 }, { name: 'b', spend: '1' }], [{ name: 'a', spend: 40 }, { name: 'b', spend: '9' }]);
  assert.strictEqual(g.size, 0);
});

test('grown: a branch called __proto__ or constructor is just a name', () => {
  const g = S.grown([{ name: '__proto__', spend: 1 }, { name: 'constructor', spend: 1 }], [{ name: '__proto__', spend: 2 }, { name: 'constructor', spend: 1 }]);
  assert.deepStrictEqual([...g], ['__proto__']);
});

test('property: grown names are exactly those with two finite spends and next > prev', () => {
  const spend = fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 1000 }));
  fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 6 }), spend, spend), { maxLength: 7 }), (rows) => {
    const names = new Map();
    for (const [i, a, b] of rows) names.set(`n${i}`, [a, b]);
    const prev = [...names].map(([name, [a]]) => ({ name, spend: a }));
    const next = [...names].map(([name, [, b]]) => ({ name, spend: b }));
    const want = [...names].filter(([, [a, b]]) => a !== null && b !== null && b > a).map(([n]) => n);
    assert.deepStrictEqual([...S.grown(prev, next)].sort(), want.sort());
  }));
});

test('sparks run for a while after the refresh that measured growth, then stop', () => {
  assert.strictEqual(S.sparksOn(null, 1000), false, 'no growth measured: no sparks');
  assert.strictEqual(S.sparksOn(1000, 1000), true);
  assert.strictEqual(S.sparksOn(1000, 1000 + S.SPARK_MS - 1), true);
  assert.strictEqual(S.sparksOn(1000, 1000 + S.SPARK_MS), false);
  assert.strictEqual(S.sparksOn(5000, 1000), false, 'a growth stamped in the future is not a spark yet');
});

test('a spark flies outward along its spoke and starts over: positions stay between the tip and the reach', () => {
  for (let i = 0; i < 6; i++) {
    for (let t = 0; t < 4000; t += 97) {
      const p = S.sparkAt(i, 6, t);
      assert.ok(p >= 0 && p <= 1, String(p));
    }
  }
  assert.notStrictEqual(S.sparkAt(0, 6, 500), S.sparkAt(1, 6, 500), 'the sparks of one spoke are spread out');
});
