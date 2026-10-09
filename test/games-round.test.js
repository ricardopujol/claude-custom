'use strict';
/** app/games-round.js (BACKLOG #41): the 45-second round, the hand-back to Claude, and when a game may take keys or draw. */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const R = require('../app/games-round');

const PHASES = ['idle', 'running', 'paused', 'over'];
const running = () => R.start();

test('a round is 45 seconds and starts with no score', () => {
  assert.strictEqual(R.ROUND_SECONDS, 45);
  assert.deepStrictEqual(R.idle(), { phase: 'idle', left: 45, score: 0, why: null });
  assert.deepStrictEqual(R.start(), { phase: 'running', left: 45, score: 0, why: null });
});

test('the clock runs only while the round is running', () => {
  for (const s of [R.idle(), R.handBack(running()), { phase: 'over', left: 0, score: 3, why: 'time' }]) {
    assert.strictEqual(R.tick(s, 0.04), s);
  }
  assert.strictEqual(R.tick(running(), 0.04).left, 45 - 0.04);
});

test('one long frame counts as 50 ms, and a bad dt is no time', () => {
  assert.strictEqual(R.tick(running(), 3).left, 45 - 0.05);
  for (const bad of [0, -1, NaN, Infinity, undefined, null, '0.01']) assert.strictEqual(R.tick(running(), bad).left, 45, String(bad));
});

test('the round ends with "time" when the clock runs out, keeping the score', () => {
  let s = R.withScore({ ...running(), left: 0.04 }, 7);
  s = R.tick(s, 0.05);
  assert.deepStrictEqual(s, { phase: 'over', left: 0, score: 7, why: 'time' });
});

test('a score is taken only while running, and only if it is a real number', () => {
  assert.strictEqual(R.withScore(running(), 5).score, 5);
  assert.strictEqual(R.withScore(running(), 0).score, 0);
  for (const bad of [NaN, Infinity, null, undefined, '5']) assert.strictEqual(R.withScore(running(), bad).score, 0, String(bad));
  const paused = R.handBack(R.withScore(running(), 4));
  assert.strictEqual(R.withScore(paused, 9), paused);
});

test('finish ends a live or paused round for a named reason, and an unknown reason reads as time', () => {
  assert.strictEqual(R.finish(running(), 'missed').why, 'missed');
  assert.strictEqual(R.finish(running(), 'full').phase, 'over');
  assert.strictEqual(R.finish(running(), 'nonsense').why, 'time');
  assert.strictEqual(R.finish(R.handBack(running()), 'missed').phase, 'over');
  const idle = R.idle();
  assert.strictEqual(R.finish(idle, 'missed'), idle);
});

test('HAND-BACK: Claude needing Ricardo freezes a running round with "Claude needs you"', () => {
  const s = R.handBack(R.withScore(running(), 6));
  assert.strictEqual(s.phase, 'paused');
  assert.strictEqual(s.why, 'claude');
  assert.strictEqual(s.score, 6, 'nothing is lost');
  assert.strictEqual(R.cover(s).text, '✋ Claude needs you');
});

test('HAND-BACK: it does nothing to a round that is not running', () => {
  const idle = R.idle();
  const over = { phase: 'over', left: 0, score: 4, why: 'time' };
  assert.strictEqual(R.handBack(idle), idle);
  assert.strictEqual(R.handBack(over), over);
  const paused = R.hide(running());
  assert.strictEqual(R.handBack(paused), paused, 'a second signal does not overwrite why it paused');
});

test('the round resumes where it stopped when Ricardo comes back, and not before', () => {
  let s = R.tick(running(), 0.05);
  s = R.handBack(s);
  const frozen = R.tick(s, 0.05);
  assert.strictEqual(frozen.left, s.left, 'frozen while paused');
  const back = R.comeBack(s);
  assert.strictEqual(back.phase, 'running');
  assert.strictEqual(back.left, s.left);
  assert.strictEqual(back.why, null);
});

test('coming back changes nothing for a round that is not paused', () => {
  const run = running();
  assert.strictEqual(R.comeBack(run), run);
  const over = { phase: 'over', left: 0, score: 1, why: 'time' };
  assert.strictEqual(R.comeBack(over), over);
});

test('a panel that leaves the screen freezes the round, with its own reason', () => {
  const s = R.hide(running());
  assert.strictEqual(s.phase, 'paused');
  assert.strictEqual(s.why, 'hidden');
  assert.match(R.cover(s).text, /out of sight/);
  const idle = R.idle();
  assert.strictEqual(R.hide(idle), idle);
});

test('KEYS: a game takes keys only while running, with focus in the panel and never with the terminal', () => {
  assert.strictEqual(R.acceptsKeys(running(), { panel: true, terminal: false }), true);
  assert.strictEqual(R.acceptsKeys(running(), { panel: true, terminal: true }), false, 'the terminal has focus');
  assert.strictEqual(R.acceptsKeys(running(), { panel: false, terminal: false }), false, 'focus is elsewhere');
  assert.strictEqual(R.acceptsKeys(R.handBack(running()), { panel: true, terminal: false }), false, 'paused');
  assert.strictEqual(R.acceptsKeys(R.idle(), { panel: true, terminal: false }), false);
  assert.strictEqual(R.acceptsKeys(running(), null), false);
  assert.strictEqual(R.acceptsKeys(running(), { panel: 1, terminal: 0 }), false, 'only a real true counts');
});

test('DRAW: the panel paints only when shown, the page is visible, and it is not lean', () => {
  assert.strictEqual(R.shouldDraw({ shown: true, pageVisible: true, lean: false }), true);
  assert.strictEqual(R.shouldDraw({ shown: true, pageVisible: true }), true);
  assert.strictEqual(R.shouldDraw({ shown: false, pageVisible: true }), false);
  assert.strictEqual(R.shouldDraw({ shown: true, pageVisible: false }), false);
  assert.strictEqual(R.shouldDraw({ shown: true, pageVisible: true, lean: true }), false);
  assert.strictEqual(R.shouldDraw(null), false);
  assert.strictEqual(R.shouldDraw({ shown: 'yes', pageVisible: true }), false);
});

test('the clock shows whole seconds, 45 down to 0', () => {
  assert.strictEqual(R.secondsLeft({ left: 45 }), 45);
  assert.strictEqual(R.secondsLeft({ left: 0.01 }), 1);
  assert.strictEqual(R.secondsLeft({ left: 0 }), 0);
  assert.strictEqual(R.secondsLeft({ left: -3 }), 0);
});

test('the cover: nothing while live, and a button for every other phase', () => {
  assert.strictEqual(R.cover(running()), null);
  assert.strictEqual(R.cover(R.idle(), 'Space or click to drop.').text, 'Space or click to drop.');
  assert.strictEqual(R.cover(R.idle()).button, 'Play');
  assert.strictEqual(R.cover(R.handBack(running())).button, 'Resume');
  assert.deepStrictEqual(R.cover({ phase: 'over', left: 0, score: 12, why: 'missed' }), { text: 'Missed: 12', note: '', button: 'Again' });
  assert.strictEqual(R.cover({ phase: 'over', left: 0, score: 3, why: 'time' }).text, 'Time: 3');
});

// --- properties -----------------------------------------------------------------------------------------------------

const opArb = fc.oneof(
  fc.constant(['start']), fc.constant(['handBack']), fc.constant(['hide']), fc.constant(['comeBack']),
  fc.double({ min: -1, max: 5, noNaN: true }).map(dt => ['tick', dt]),
  fc.integer({ min: 0, max: 99 }).map(n => ['score', n]),
  fc.constantFrom('missed', 'full', 'time').map(w => ['finish', w]),
);
const apply = (s, [op, arg]) => (op === 'start' ? R.start() : op === 'score' ? R.withScore(s, arg) : R[op](s, arg));

test('P: after any sequence of events the round is in a known phase, the clock is within 0..45, and it only moves while running', () => {
  fc.assert(fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
    let s = R.idle();
    for (const op of ops) {
      const before = s;
      s = apply(s, op);
      assert.ok(PHASES.includes(s.phase));
      assert.ok(s.left >= 0 && s.left <= 45);
      assert.ok(s.left <= before.left || op[0] === 'start', 'the clock never goes back up except on a new round');
      if (s.phase !== 'running' && op[0] === 'tick') assert.strictEqual(s.left, before.left, 'no time passes outside a running round');
      assert.ok(s.phase !== 'paused' || ['claude', 'hidden'].includes(s.why), 'a pause always says why');
    }
  }), { numRuns: 300 });
});

test('P: a hand-back at any point of a round, then coming back, loses neither the score nor a second of the clock', () => {
  fc.assert(fc.property(fc.array(fc.double({ min: 0, max: 0.05, noNaN: true }), { maxLength: 40 }), fc.integer({ min: 0, max: 50 }), (dts, score) => {
    let s = R.withScore(running(), score);
    for (const dt of dts) s = R.tick(s, dt);
    if (s.phase !== 'running') return;
    const paused = R.handBack(s);
    assert.strictEqual(R.tick(paused, 0.05).left, s.left);
    const back = R.comeBack(paused);
    assert.deepStrictEqual(back, s);
  }), { numRuns: 200 });
});
