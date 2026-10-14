'use strict';
/**
 * BACKLOG #90: when a quota window is used up the header says when Claude is back, and says "Claude is back" once.
 * Pure logic in app/quota-countdown.js. The rule it keeps is the project's own: absence is never a countdown.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const fc = require('fast-check');

const { backText, countdownState, createResetWatcher } = require('../app/quota-countdown');

const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();       // local time, so the clock text is deterministic
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60000;
const HOUR = 3600000;
const win = (over = {}) => ({ key: 'session', label: '5h', percent: 100, resetsAt: iso(NOW + 134 * MIN), ...over });
const fresh = (windows) => ({ ok: true, state: 'fresh', windows });
const ABSENT = { ok: false, state: 'absent', windows: [], error: 'stale' };

// --- backText ---------------------------------------------------------------------

test('hours and minutes: "Claude back in 2h 14m"', () => {
  assert.strictEqual(backText(iso(NOW + 134 * MIN), NOW), 'Claude back in 2h 14m');
});

test('whole hours, minutes only, and seconds under a minute', () => {
  assert.strictEqual(backText(iso(NOW + 2 * HOUR), NOW), 'Claude back in 2h');
  assert.strictEqual(backText(iso(NOW + 14 * MIN), NOW), 'Claude back in 14m');
  assert.strictEqual(backText(iso(NOW + 45000), NOW), 'Claude back in 45s');
});

test('it rounds up, so it never reads 0m or 0s while still waiting', () => {
  assert.strictEqual(backText(iso(NOW + 1), NOW), 'Claude back in 1s');
  assert.strictEqual(backText(iso(NOW + 60000), NOW), 'Claude back in 1m');
  assert.strictEqual(backText(iso(NOW + 60001), NOW), 'Claude back in 2m');
});

test('over a day it names the weekday and the clock time', () => {
  const at = NOW + 26 * HOUR;
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  assert.strictEqual(backText(iso(at), NOW), `Claude back ${day} ${hh}:${mm}`);
});

test('no usable future time is null, never a countdown', () => {
  for (const v of [null, undefined, '', 'soon', 5, {}, iso(NOW), iso(NOW - HOUR)]) assert.strictEqual(backText(v, NOW), null, String(v));
});

// --- countdownState ---------------------------------------------------------------

test('a window at 100% with a future reset is used up, with its text', () => {
  const s = countdownState(fresh([win()]), NOW);
  assert.strictEqual(s.state, 'usedUp');
  assert.strictEqual(s.key, 'session');
  assert.strictEqual(s.text, 'Claude back in 2h 14m');
});

test('over 100% counts too; 99.9% does not', () => {
  assert.strictEqual(countdownState(fresh([win({ percent: 140 })]), NOW).state, 'usedUp');
  assert.strictEqual(countdownState(fresh([win({ percent: 99.9 })]), NOW).state, 'normal');
});

test('two windows used up: the one that resets last is the binding one', () => {
  const s = countdownState(fresh([win(), win({ key: 'weekly', label: 'week', resetsAt: iso(NOW + 3 * 24 * HOUR) })]), NOW);
  assert.strictEqual(s.key, 'weekly');
});

test('a used-up window whose reset has passed is normal (the next poll will show it)', () => {
  assert.strictEqual(countdownState(fresh([win({ resetsAt: iso(NOW - MIN) })]), NOW).state, 'normal');
});

test('no reset time, an unknown percent, absence, reading: all normal, never a fake countdown', () => {
  assert.strictEqual(countdownState(fresh([win({ resetsAt: null })]), NOW).state, 'normal');
  assert.strictEqual(countdownState(fresh([win({ percent: null })]), NOW).state, 'normal');
  assert.strictEqual(countdownState(ABSENT, NOW).state, 'normal');
  assert.strictEqual(countdownState(null, NOW).state, 'normal');
  assert.strictEqual(countdownState({ ok: true, windows: 'x' }, NOW).state, 'normal');
});

// --- createResetWatcher -----------------------------------------------------------

test('the toast fires once when the data shows the window back, not on later polls', () => {
  const w = createResetWatcher();
  assert.strictEqual(w.see(fresh([win()]), NOW).toast, false);
  assert.strictEqual(w.see(fresh([win()]), NOW + MIN).toast, false);
  const back = NOW + 135 * MIN;
  assert.strictEqual(w.see(fresh([win({ percent: 2, resetsAt: iso(back + 5 * HOUR) })]), back).toast, true);
  assert.strictEqual(w.see(fresh([win({ percent: 2, resetsAt: iso(back + 5 * HOUR) })]), back + MIN).toast, false);
});

test('the clock passing the reset ends the episode even while the data still says 100%', () => {
  const w = createResetWatcher();
  w.see(fresh([win()]), NOW);
  const r = w.see(fresh([win()]), NOW + 135 * MIN);
  assert.strictEqual(r.toast, true);
  assert.strictEqual(r.state, 'normal');
});

test('absence before the reset neither toasts nor loses the episode; after it, the toast comes once', () => {
  const w = createResetWatcher();
  w.see(fresh([win()]), NOW);
  assert.strictEqual(w.see(ABSENT, NOW + 10 * MIN).toast, false);
  assert.strictEqual(w.see(null, NOW + 20 * MIN).toast, false);
  assert.strictEqual(w.see(ABSENT, NOW + 135 * MIN).toast, true);
  assert.strictEqual(w.see(ABSENT, NOW + 136 * MIN).toast, false);
});

test('never used up means never a toast', () => {
  const w = createResetWatcher();
  for (let i = 0; i < 5; i++) assert.strictEqual(w.see(fresh([win({ percent: 40 })]), NOW + i * MIN).toast, false);
});

test('a second exhaustion after the first reset is a new episode with its own toast', () => {
  const w = createResetWatcher();
  w.see(fresh([win()]), NOW);
  assert.strictEqual(w.see(fresh([win({ percent: 1 })]), NOW + 135 * MIN).toast, true);
  const t2 = NOW + 10 * HOUR;
  w.see(fresh([win({ resetsAt: iso(t2 + HOUR) })]), t2);
  assert.strictEqual(w.see(fresh([win({ percent: 1 })]), t2 + 2 * HOUR).toast, true);
});

test('two windows used up: Claude is back only when both are, one toast', () => {
  const w = createResetWatcher();
  const both = (t) => fresh([win({ resetsAt: iso(NOW + HOUR) }), win({ key: 'weekly', resetsAt: iso(NOW + 5 * HOUR) })]);
  w.see(both(), NOW);
  // the 5h one resets, the weekly is still out
  const mid = NOW + 2 * HOUR;
  assert.strictEqual(w.see(fresh([win({ percent: 3, resetsAt: iso(mid + 5 * HOUR) }), win({ key: 'weekly', resetsAt: iso(NOW + 5 * HOUR) })]), mid).toast, false);
  assert.strictEqual(w.see(fresh([win({ percent: 3 }), win({ key: 'weekly', percent: 4 })]), NOW + 6 * HOUR).toast, true);
});

// --- properties -------------------------------------------------------------------

test('property: the text is null or a non-negative wait, whatever the clock and the reset', () => {
  fc.assert(fc.property(fc.integer({ min: -1e10, max: 1e10 }), (delta) => {
    const text = backText(iso(NOW + delta), NOW);
    if (delta <= 0) return text === null;
    return typeof text === 'string' && text.startsWith('Claude back') && !/-\d/.test(text) && !/\b0[hms]\b/.test(text);
  }), { numRuns: 300 });
});

test('property: over any poll sequence the toasts equal the used-up episodes that ended', () => {
  const step = fc.record({
    dt: fc.integer({ min: 1, max: 30 * MIN }),
    kind: fc.constantFrom('out', 'ok', 'absent', 'null'),
  });
  fc.assert(fc.property(fc.array(step, { minLength: 1, maxLength: 40 }), (steps) => {
    const w = createResetWatcher();
    let now = NOW;
    let toasts = 0;
    let resetAt = null;                  // the model: the last reset we were told about while out
    let expected = 0;
    for (const s of steps) {
      now += s.dt;
      const quota = s.kind === 'out' ? fresh([win({ resetsAt: iso(now + 20 * MIN) })])
        : s.kind === 'ok' ? fresh([win({ percent: 10, resetsAt: iso(now + 5 * HOUR) })])
          : s.kind === 'absent' ? ABSENT : null;
      if (s.kind === 'out') resetAt = Math.max(resetAt === null ? 0 : resetAt, now + 20 * MIN);
      else if (resetAt !== null && (s.kind === 'ok' || now >= resetAt)) { expected++; resetAt = null; }
      const r = w.see(quota, now);
      if (r.toast) toasts++;
      if (r.state === 'usedUp' && !(r.text && r.text.startsWith('Claude back'))) return false;
    }
    return toasts === expected;
  }), { numRuns: 300 });
});

test('property: absence and unknown percent are never a used-up state', () => {
  fc.assert(fc.property(fc.constantFrom(null, undefined, ABSENT, { ok: true, windows: [] }, fresh([win({ percent: null })]), fresh([win({ percent: NaN })])), (q) =>
    countdownState(q, NOW).state === 'normal'), { numRuns: 50 });
});

// --- loaded as a plain script -----------------------------------------------------

test('loaded as a plain <script> it defines its names on the window and leaks no top-level binding', () => {
  const src = fs.readFileSync(require.resolve('../app/quota-countdown'), 'utf8');
  const ctx = vm.createContext({ window: {} });
  ctx.window = ctx;
  // Two scripts sharing one scope must both load: run it twice in the same context, as a collision would show.
  vm.runInContext(src, ctx, { filename: 'quota-countdown-as-script' });
  vm.runInContext(src, ctx, { filename: 'quota-countdown-as-script-again' });
  assert.strictEqual(typeof ctx.quotaBackText, 'function');
  assert.strictEqual(typeof ctx.quotaCountdownState, 'function');
  assert.strictEqual(typeof ctx.createQuotaResetWatcher, 'function');
});
