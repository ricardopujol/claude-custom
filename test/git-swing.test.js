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

// ---- Mutation-survivor kills (backlog #58, release PR #101) ----

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

test('step: the dial\'s clock wraps to zero exactly when it reaches the period, not a frame later', () => {
  // 89.9375 + 0.0625 s at full speed is exactly 90 in binary floating point
  const s = S.step({ clock: 89.9375, speed: 1, t: 0, resumeAt: 0 }, 62.5, {});
  assert.strictEqual(s.clock, 0);
  assert.strictEqual(S.step({ clock: 89.875, speed: 1, t: 0, resumeAt: 0 }, 62.5, {}).clock, 89.9375);
});

test('step: the hold lasts until resumeAt and ends AT resumeAt, not a millisecond after', () => {
  const held = { clock: 5, speed: 0, t: 1984, resumeAt: 2000 };
  assert.strictEqual(S.step(held, 1999, {}).speed, 0, 'still held before resumeAt');
  assert.ok(S.step(held, 2000, {}).speed > 0, 'at resumeAt it picks up');
});

test('step: speed eases down toward a stop and up toward full, by dt / EASE_S per frame', () => {
  const down = S.step({ clock: 0, speed: 1, t: 0, resumeAt: 0 }, 50, { holding: true });
  near(down.speed, 1 - 0.05 / 0.5);
  const up = S.step({ clock: 0, speed: 0, t: 0, resumeAt: 0 }, 50, {});
  near(up.speed, 0.05 / 0.5);
  // the clock moves by the mean of the old and new speed
  near(down.clock, 0.05 * (1 + down.speed) / 2);
  assert.strictEqual(S.step({ clock: 0, speed: 0.95, t: 0, resumeAt: 0 }, 100, {}).speed, 1, 'never overshoots full speed');
  assert.strictEqual(S.step({ clock: 0, speed: 0.05, t: 0, resumeAt: 0 }, 100, { holding: true }).speed, 0, 'never below a stop');
});

test('breathPhase is FNV-1a over the name: pinned to its published test vectors', () => {
  assert.strictEqual(S.breathPhase(''), 0x811c9dc5 / 4294967296);
  assert.strictEqual(S.breathPhase('a'), 0xe40c292c / 4294967296);
  assert.strictEqual(S.breathPhase('foobar'), 0xbf9cf968 / 4294967296);
  assert.strictEqual(S.breathPhase(42), S.breathPhase('42'), 'a name is stringified');
});

test('breath: 1 + 3% * sin(2 pi (sec / 9 + phase)), checked at several times and names', () => {
  for (const name of ['', 'a', 'feat/x', 'main']) {
    for (const sec of [0, 1, 2.25, 4.5, 9, 13.7]) {
      near(S.breath(name, sec), 1 + 0.03 * Math.sin(2 * Math.PI * (sec / 9 + S.breathPhase(name))), 1e-12);
    }
  }
  // one full breathing period later it is back where it was; half a period later it is on the other side
  near(S.breath('a', 3), S.breath('a', 12), 1e-12);
  near(S.breath('a', 3) - 1, -(S.breath('a', 7.5) - 1), 1e-12);
  assert.strictEqual(S.breath('a', 3, { reduced: true }), 1);
});

test('rotate: exact quarter and half turns, about the origin and about another hub', () => {
  const r = (x, y, cx, cy, deg, ex, ey) => {
    const p = S.rotatePoint(x, y, cx, cy, deg);
    near(p[0], ex); near(p[1], ey);
  };
  r(1, 0, 0, 0, 90, 0, 1);
  r(0, 1, 0, 0, 90, -1, 0);
  r(3, 3, 2, 3, 180, 1, 3);
  r(5, 7, 2, 3, 90, -2, 6);            // dx 3, dy 4 -> (-4, 3) about (2, 3)
  r(5, 7, 2, 3, -90, 6, 0);
  r(1, 2, 0, 0, 30, Math.cos(Math.PI / 6) - 1, 0.5 + 2 * Math.cos(Math.PI / 6));   // dx and dy both non-zero
  r(2, 3, 2, 3, 37, 2, 3);             // the hub itself never moves
  r(3, 0, 1, 0, 45, 1 + 2 * Math.SQRT1_2, 2 * Math.SQRT1_2);
});

test('rotate: a zero angle returns the very same coordinates, with no rounding from the hub', () => {
  assert.deepStrictEqual(S.rotatePoint(0.1, 0.2, 0.7, 0.9, 0), [0.1, 0.2]);
});

test('grown: exactly the names whose spend rose between two measured answers', () => {
  const prev = [{ name: 'rose', spend: 1 }, { name: 'same', spend: 5 }, { name: 'fell', spend: 9 },
    { name: 'wasNull', spend: null }, { name: 'strBefore', spend: '1' }, { name: 'nan', spend: NaN },
    { name: 'inf', spend: Infinity }, null, { name: 'gone', spend: 1 }];
  const next = [{ name: 'rose', spend: 2 }, { name: 'same', spend: 5 }, { name: 'fell', spend: 3 },
    { name: 'wasNull', spend: 4 }, { name: 'strBefore', spend: 9 }, { name: 'nan', spend: 3 },
    { name: 'inf', spend: Infinity }, { name: 'fresh', spend: 4 }, null, { name: 'nowStr', spend: '99' },
    { name: 'nowNull', spend: null }, { name: 'nowInf', spend: Infinity }];
  assert.deepStrictEqual([...S.grown(prev, next)], ['rose']);
  assert.deepStrictEqual([...S.grown([{ name: 'nowInf', spend: 1 }], next)], [], 'an infinite spend is not measured');
  assert.deepStrictEqual([...S.grown([], next)], []);
  assert.deepStrictEqual([...S.grown(prev, [])], []);
  assert.deepStrictEqual([...S.grown(prev, 'x')], []);
  assert.deepStrictEqual([...S.grown('x', next)], []);
});

test('liveSet: a working folder or measured growth makes a branch live, and nothing else does', () => {
  const branches = [{ name: 'a', folder: '/w/a' }, { name: 'b', folder: '' }, { name: 'c', folder: 5 },
    { name: 'd' }, { name: 'e', folder: '/w/e' }];
  const live = (wf, g, on) => [...S.liveSet(branches, wf, g, on)].sort();
  assert.deepStrictEqual(live(new Set(['/w/a', '', 5, undefined]), null, false), ['a'], 'a blank or non-string folder is never working');
  assert.deepStrictEqual(live(null, new Set(['d']), true), ['d']);
  assert.deepStrictEqual(live(new Set(['/w/a']), new Set(['e']), true), ['a', 'e']);
  assert.deepStrictEqual(live(null, new Set(['d']), false), [], 'growth only counts while sparks are active');
  assert.deepStrictEqual(live(null, new Set(['d']), 1), [], 'sparksActive must be exactly true');
  assert.deepStrictEqual(live(new Set(['/w/a']), null, true), ['a']);
  // a non-array branch list is no branches, even when growth names `undefined`
  assert.deepStrictEqual([...S.liveSet(null, new Set(), new Set([undefined]), true)], []);
  assert.deepStrictEqual([...S.liveSet('x', new Set(), new Set([undefined]), true)], []);
});

test('sparkNames: only measured growth, only while sparks are active', () => {
  assert.deepStrictEqual([...S.sparkNames(new Set(['a', 'b']), true)], ['a', 'b']);
  assert.deepStrictEqual([...S.sparkNames(new Set(['a']), false)], []);
  assert.deepStrictEqual([...S.sparkNames(new Set(['a']), 'yes')], []);
  assert.deepStrictEqual([...S.sparkNames(null, true)], []);
  const grownSet = new Set(['a']);
  assert.notStrictEqual(S.sparkNames(grownSet, true), grownSet, 'a copy, not the caller\'s set');
});

test('sparksOn: from the moment growth was measured, for SPARK_MS, and only for a finite time', () => {
  assert.strictEqual(S.sparksOn(1000, 999), false);
  assert.strictEqual(S.sparksOn(1000, 1000), true);
  assert.strictEqual(S.sparksOn(1000, 1000 + S.SPARK_MS - 1), true);
  assert.strictEqual(S.sparksOn(1000, 1000 + S.SPARK_MS), false);
  assert.strictEqual(S.sparksOn(null, 5), false);
  assert.strictEqual(S.sparksOn(NaN, 5), false);
  assert.strictEqual(S.sparksOn('1000', 1500), false);
  assert.strictEqual(S.sparksOn(Infinity, 5), false);
});

test('sparkAt: spark i of n sits at i/n plus the time, one lap every 1.2 s, wrapped into [0, 1)', () => {
  assert.strictEqual(S.sparkAt(0, 4, 0), 0, 'exactly zero at the start, not a full lap');
  near(S.sparkAt(1, 4, 0), 0.25);
  near(S.sparkAt(3, 4, 0), 0.75);
  near(S.sparkAt(0, 4, 600), 0.5);       // half of 1.2 s
  near(S.sparkAt(1, 4, 600), 0.75);
  near(S.sparkAt(2, 4, 600), 0.0);       // 0.5 + 0.5 wraps
  near(S.sparkAt(0, 4, 1200), 0);
  near(S.sparkAt(1, 4, 1800), 0.75);     // 1.5 laps + 0.25
  near(S.sparkAt(0, 4, -600), 0.5);      // a negative time wraps up, not down
  near(S.sparkAt(1, 4, -300), 0.0);
  near(S.sparkAt(1, 0, 0), 0);           // n of 0 is read as 1: i / 1 = 1, wrapped to 0
  near(S.sparkAt(0, 1, 300), 0.25);
  for (let i = 0; i < 5; i++) {
    for (const t of [-5000, -1, 0, 7, 12345]) {
      const p = S.sparkAt(i, 5, t);
      assert.ok(p >= 0 && p < 1, `${p}`);
    }
  }
});

// A plain <script> has no `module`: evaluating the file the way the page does proves BOTH load paths.
// `process` is injected because Stryker reads the active mutant through it; real code never touches it.
test('load path: with module.exports it exports, without it it hangs gitSwing off window or the global', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const src = fs.readFileSync(require.resolve('../app/git-swing'), 'utf8');
  const load = (sandbox) => {
    const ctx = vm.createContext({ process, ...sandbox });
    vm.runInContext(src, ctx, { filename: 'git-swing-as-script' });
    return ctx;
  };

  const mod = { exports: {} };
  const asModule = load({ module: mod });
  assert.strictEqual(typeof mod.exports.step, 'function');
  assert.strictEqual(asModule.gitSwing, undefined, 'a module load leaves no global behind');

  const win = {};
  load({ window: win });
  assert.strictEqual(typeof win.gitSwing.step, 'function');

  const bare = load({});
  assert.strictEqual(typeof bare.gitSwing.step, 'function');

  const emptyModule = load({ module: {} });   // a `module` without exports is not CommonJS
  assert.strictEqual(typeof emptyModule.gitSwing.step, 'function');
});
