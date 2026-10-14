'use strict';
/**
 * BACKLOG #90: when a quota window is used up the header says when Claude is back, and says "Claude is back" once.
 * Pure logic in app/quota-countdown.js. The rule it keeps is the project's own: absence is never a countdown, and unknown is
 * never "back".
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const fc = require('fast-check');

const {
  backText, countdownState, createResetWatcher, createToastGate, tickDelayMs, settlePastResets, DATA_STALE_MS,
} = require('../app/quota-countdown');
const { clockText, weekdayText } = require('../app/quota-display');
const { DATA_STALE_MS: HOST_STALE_MS } = require('../host/quota-share');

const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();       // local time, so the clock text is deterministic
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const win = (over = {}) => ({ key: 'session', label: '5h', percent: 100, resetsAt: iso(NOW + 134 * MIN), ...over });
const scoped = (over = {}) => win({ key: 'weekly_scoped:Fable', label: 'Fable', resetsAt: iso(NOW + 3 * DAY), ...over });
const fresh = (windows, extra = {}) => ({ ok: true, state: 'fresh', windows, ...extra });
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

test('it rounds up, so it never reads 0m or 0s while still waiting, and never "60s"', () => {
  assert.strictEqual(backText(iso(NOW + 1), NOW), 'Claude back in 1s');
  assert.strictEqual(backText(iso(NOW + 59000), NOW), 'Claude back in 59s');
  assert.strictEqual(backText(iso(NOW + 59500), NOW), 'Claude back in 1m');          // Dexter 6, Miguel G4
  assert.strictEqual(backText(iso(NOW + 59001), NOW), 'Claude back in 1m');
  assert.strictEqual(backText(iso(NOW + 60000), NOW), 'Claude back in 1m');
  assert.strictEqual(backText(iso(NOW + 60001), NOW), 'Claude back in 2m');
});

test('the 24 h edge: just under reads in hours, exactly a day names the weekday and the time', () => {
  assert.strictEqual(backText(iso(NOW + DAY - 1), NOW), 'Claude back in 24h');
  const d = new Date(NOW + DAY);
  assert.strictEqual(backText(iso(NOW + DAY), NOW),
    `Claude back ${d.toLocaleDateString('en-US', { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
});

test('over a day it names the weekday and the clock time, the clock as the header writes it', () => {
  const at = NOW + 26 * HOUR;
  const d = new Date(at);
  assert.strictEqual(backText(iso(at), NOW), `Claude back ${weekdayText(d)} ${clockText(d)}`);
});

test('six days out or more adds the date, so a same-weekday reset cannot read like today', () => {
  const at = NOW + 6 * DAY + 23 * HOUR;
  const d = new Date(at);
  const text = backText(iso(at), NOW);
  assert.match(text, new RegExp(`^Claude back ${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()} [A-Z][a-z]{2} \\d\\d:\\d\\d$`));
  // 5 days 23 h is still the bare weekday form
  assert.match(backText(iso(NOW + 5 * DAY + 23 * HOUR), NOW), /^Claude back [A-Z][a-z]{2} \d\d:\d\d$/);
  // the edge itself
  assert.match(backText(iso(NOW + 6 * DAY), NOW), /^Claude back [A-Z][a-z]{2} \d+ [A-Z][a-z]{2} \d\d:\d\d$/);
  assert.match(backText(iso(NOW + 6 * DAY - 1), NOW), /^Claude back [A-Z][a-z]{2} \d\d:\d\d$/);
});

test('a scoped window names its model, not Claude', () => {
  assert.strictEqual(backText(iso(NOW + 14 * MIN), NOW, 'Fable'), 'Fable back in 14m');
});

test('no usable future time is null, never a countdown', () => {
  for (const v of [null, undefined, '', 'soon', 5, {}, iso(NOW), iso(NOW - HOUR)]) assert.strictEqual(backText(v, NOW), null, String(v));
});

test('the stale bound equals the host bound (the renderer cannot require host/)', () => {
  assert.strictEqual(DATA_STALE_MS, HOST_STALE_MS);
});

// --- countdownState ---------------------------------------------------------------

test('a window at 100% with a future reset is used up, with its text', () => {
  const s = countdownState(fresh([win()]), NOW);
  assert.strictEqual(s.state, 'usedUp');
  assert.strictEqual(s.key, 'session');
  assert.strictEqual(s.text, 'Claude back in 2h 14m');
  assert.deepStrictEqual(s.texts, { session: 'Claude back in 2h 14m' });
});

test('over 100% counts too; 99.9% does not', () => {
  assert.strictEqual(countdownState(fresh([win({ percent: 140 })]), NOW).state, 'usedUp');
  assert.strictEqual(countdownState(fresh([win({ percent: 99.9 })]), NOW).state, 'normal');
});

test('Ricardo: two Claude-wide windows used up each show their own "Claude back" text; the one that resets last is the binding state', () => {
  const s = countdownState(fresh([win(), win({ key: 'weekly', label: 'week', resetsAt: iso(NOW + 3 * DAY) })]), NOW);
  assert.strictEqual(s.state, 'usedUp');
  assert.strictEqual(s.key, 'weekly');
  assert.deepStrictEqual(Object.keys(s.texts).sort(), ['session', 'weekly']);
  assert.strictEqual(s.texts.session, 'Claude back in 2h 14m');
  assert.match(s.texts.weekly, /^Claude back [A-Z][a-z]{2} \d\d:\d\d$/);
  // a window that has already reset shows no text, the other keeps its own
  const half = countdownState(fresh([win({ percent: 3 }), win({ key: 'weekly', resetsAt: iso(NOW + 3 * DAY) })]), NOW);
  assert.deepStrictEqual(Object.keys(half.texts), ['weekly']);
});

test('Dexter 1: a model-scoped window at 100% is not Claude being out', () => {
  const only = countdownState(fresh([scoped()]), NOW);
  assert.strictEqual(only.state, 'normal');
  assert.match(only.texts['weekly_scoped:Fable'], /^Fable back /);
  // and next to a Claude-wide window it never takes the binding place
  const both = countdownState(fresh([win(), scoped()]), NOW);
  assert.strictEqual(both.state, 'usedUp');
  assert.strictEqual(both.key, 'session');
  assert.strictEqual(both.text, 'Claude back in 2h 14m');
  assert.match(both.texts['weekly_scoped:Fable'], /^Fable back /);
});

test('Dexter 5: a window the server locked counts as used up under 100%, as quota-display does', () => {
  const s = countdownState(fresh([win({ percent: 98, lockedReason: 'rate_limited', resetsAt: iso(NOW + HOUR) })]), NOW);
  assert.strictEqual(s.state, 'usedUp');
  assert.strictEqual(s.text, 'Claude back in 1h');
  assert.strictEqual(countdownState(fresh([win({ percent: 98, lockedReason: null })]), NOW).state, 'normal');
  assert.strictEqual(countdownState(fresh([win({ percent: null, lockedReason: 'limit_reached', resetsAt: iso(NOW + HOUR) })]), NOW).state, 'usedUp');
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

test('Dexter 7: a payload read longer ago than the stale bound is not a countdown', () => {
  assert.strictEqual(countdownState(fresh([win()], { readAt: NOW - DATA_STALE_MS - 1 }), NOW).state, 'normal');
  assert.strictEqual(countdownState(fresh([win()], { readAt: NOW - DATA_STALE_MS }), NOW).state, 'usedUp');
  assert.strictEqual(countdownState(fresh([win()], { readAt: null }), NOW).state, 'usedUp');
});

test('soonestMs is the nearest reset among every used-up window, scoped included', () => {
  assert.strictEqual(countdownState(fresh([win(), scoped({ resetsAt: iso(NOW + 30 * 1000) })]), NOW).soonestMs, 30000);
  assert.strictEqual(countdownState(fresh([win({ percent: 5 })]), NOW).soonestMs, null);
});

// --- tickDelayMs ------------------------------------------------------------------

test('the header ticks every second in the last 90 s of any used-up window, else every 30 s', () => {
  assert.strictEqual(tickDelayMs(fresh([win({ resetsAt: iso(NOW + 90000) })]), NOW), 1000);
  assert.strictEqual(tickDelayMs(fresh([win({ resetsAt: iso(NOW + 90001) })]), NOW), 30000);
  assert.strictEqual(tickDelayMs(fresh([scoped({ resetsAt: iso(NOW + 10000) })]), NOW), 1000);
  assert.strictEqual(tickDelayMs(null, NOW), 30000);
  assert.strictEqual(tickDelayMs(ABSENT, NOW), 30000);
});

// --- settlePastResets -------------------------------------------------------------

test('Miguel Y5: a used-up window whose reset passed is drawn unknown, not as its old 100%', () => {
  const q = fresh([win({ resetsAt: iso(NOW - MIN), lockedReason: 'limit_reached', severity: 'critical' }), win({ key: 'weekly', percent: 40 })]);
  const s = settlePastResets(q, NOW);
  assert.strictEqual(s.windows[0].percent, null);
  assert.strictEqual(s.windows[0].lockedReason, null);
  assert.strictEqual(s.windows[1].percent, 40);
  assert.strictEqual(q.windows[0].percent, 100, 'the payload is not mutated');
  assert.strictEqual(settlePastResets(q, NOW - 10 * MIN), q, 'before the reset nothing changes');
  assert.strictEqual(settlePastResets(null, NOW), null);
  assert.strictEqual(settlePastResets(ABSENT, NOW), ABSENT);
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

test('a reset the data shows early (percent known and the reset moved on) ends it before the clock', () => {
  const w = createResetWatcher();
  w.see(fresh([win()]), NOW);
  assert.strictEqual(w.see(fresh([win({ percent: 1, resetsAt: iso(NOW + 5 * HOUR) })]), NOW + 10 * MIN).toast, true);
});

test('absence before the reset neither toasts nor loses the episode; after it, the toast comes once', () => {
  const w = createResetWatcher();
  w.see(fresh([win()]), NOW);
  assert.strictEqual(w.see(ABSENT, NOW + 10 * MIN).toast, false);
  assert.strictEqual(w.see(null, NOW + 20 * MIN).toast, false);
  assert.strictEqual(w.see(ABSENT, NOW + 135 * MIN).toast, true);
  assert.strictEqual(w.see(ABSENT, NOW + 136 * MIN).toast, false);
});

test('a stale payload does not end an episode early either', () => {
  const w = createResetWatcher();
  w.see(fresh([win()]), NOW);
  const old = fresh([win({ percent: 1, resetsAt: iso(NOW + 5 * HOUR) })], { readAt: NOW - 10 * HOUR });
  assert.strictEqual(w.see(old, NOW + 10 * MIN).toast, false);
});

test('Dexter 2 / Miguel Y1: a fresh read that does not KNOW the window is under 100 never ends the episode', () => {
  for (const unknown of [
    fresh([win({ percent: null })]),
    fresh([win({ percent: null, resetsAt: iso(NOW + 5 * HOUR) })]),      // Dexter r2: unknown percent WITH a moved reset
    fresh([win({ resetsAt: null, percent: 3 })]),
    fresh([]),
    fresh([win({ percent: NaN })]),
    fresh([win({ key: 'other', percent: 1, resetsAt: iso(NOW + 5 * HOUR) })]),
  ]) {
    const w = createResetWatcher();
    w.see(fresh([win()]), NOW);
    assert.strictEqual(w.see(unknown, NOW + MIN).toast, false, JSON.stringify(unknown));
    // the episode is still open: it ends by the clock, once
    assert.strictEqual(w.see(unknown, NOW + 135 * MIN).toast, true, JSON.stringify(unknown));
    assert.strictEqual(w.see(unknown, NOW + 136 * MIN).toast, false);
  }
});

test('Dexter 4: 100% -> 99.6% -> 100% with the same reset is one toast, at the reset', () => {
  const w = createResetWatcher();
  const R = iso(NOW + 2 * HOUR);
  assert.strictEqual(w.see(fresh([win({ resetsAt: R })]), NOW).toast, false);
  assert.strictEqual(w.see(fresh([win({ percent: 99.6, resetsAt: R })]), NOW + MIN).toast, false);
  assert.strictEqual(w.see(fresh([win({ resetsAt: R })]), NOW + 2 * MIN).toast, false);
  assert.strictEqual(w.see(fresh([win({ percent: 1, resetsAt: iso(NOW + 7 * HOUR) })]), NOW + 2 * HOUR + MIN).toast, true);
  assert.strictEqual(w.see(fresh([win({ percent: 1, resetsAt: iso(NOW + 7 * HOUR) })]), NOW + 2 * HOUR + 2 * MIN).toast, false);
});

test('the same reset reported a second later is jitter, not a reset', () => {
  const w = createResetWatcher();
  w.see(fresh([win()]), NOW);
  assert.strictEqual(w.see(fresh([win({ percent: 99, resetsAt: iso(NOW + 134 * MIN + 1000) })]), NOW + MIN).toast, false);
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

test('two unscoped windows used up: Claude is back only when both are, one toast', () => {
  const w = createResetWatcher();
  const weeklyReset = iso(NOW + 5 * HOUR);
  w.see(fresh([win({ resetsAt: iso(NOW + HOUR) }), win({ key: 'weekly', resetsAt: weeklyReset })]), NOW);
  const mid = NOW + 2 * HOUR;       // the 5h one reset, the weekly is still out
  assert.strictEqual(w.see(fresh([win({ percent: 3, resetsAt: iso(mid + 5 * HOUR) }), win({ key: 'weekly', resetsAt: weeklyReset })]), mid).toast, false);
  assert.strictEqual(w.see(fresh([win({ percent: 3 }), win({ key: 'weekly', percent: 4 })]), NOW + 6 * HOUR).toast, true);
});

test('Dexter 1: the 5h reset toasts while a scoped window stays at 100%', () => {
  const w = createResetWatcher();
  const quota = (pct5h, at5h) => fresh([win({ percent: pct5h, resetsAt: at5h }), scoped()]);
  assert.strictEqual(w.see(quota(100, iso(NOW + 2 * HOUR)), NOW).toast, false);
  const r = w.see(quota(3, iso(NOW + 7 * HOUR)), NOW + 2 * HOUR + 5 * MIN);
  assert.strictEqual(r.toast, true);
  assert.strictEqual(r.state, 'normal');
  assert.match(r.texts['weekly_scoped:Fable'], /^Fable back /);
});

test('a scoped window alone never opens an episode, so Thursday brings no "Claude is back"', () => {
  const w = createResetWatcher();
  assert.strictEqual(w.see(fresh([scoped()]), NOW).toast, false);
  assert.strictEqual(w.see(fresh([scoped({ percent: 1 })]), NOW + 4 * DAY).toast, false);
});

// --- createToastGate --------------------------------------------------------------

test('Dexter 3: a toast raised while the header is hidden shows the next time it is visible, once', () => {
  const g = createToastGate();
  assert.strictEqual(g.step({ toast: true, visible: false }), false);
  assert.strictEqual(g.step({ visible: false }), false);
  assert.strictEqual(g.step({ visible: true }), true);
  assert.strictEqual(g.step({ visible: true }), false);
});

test('a toast raised while visible shows at once, once', () => {
  const g = createToastGate();
  assert.strictEqual(g.step({ toast: true, visible: true }), true);
  assert.strictEqual(g.step({ visible: true }), false);
});

test('a newer used-up episode drops a held toast: the "back" is stale', () => {
  const g = createToastGate();
  g.step({ toast: true, visible: false });
  assert.strictEqual(g.step({ usedUp: true, visible: true }), false);
  assert.strictEqual(g.step({ visible: true }), false);
});

test('a new gate (a reload after the reset) has nothing to replay', () => {
  assert.strictEqual(createToastGate().step({ visible: true }), false);
});

// --- properties -------------------------------------------------------------------

test('property: the text is null or a positive wait in words, whatever the clock and the reset', () => {
  fc.assert(fc.property(fc.integer({ min: -1e10, max: 1e10 }), (delta) => {
    const text = backText(iso(NOW + delta), NOW);
    if (delta <= 0) return text === null;
    return typeof text === 'string' && text.startsWith('Claude back') && !/-\d/.test(text) && !/\b0[hms]\b/.test(text) && !/\b60s\b/.test(text);
  }), { numRuns: 500 });
});

// The oracle is stated as the SPEC, not as the implementation: an episode is open from the first unscoped "out" read; it closes
// on a non-out step that is an "ok" read (every window known under 100 with its reset moved on) or at or after the latest reset
// it was told about, and on no other step. Toasts happen exactly at closings. "out" reads carry only the window they are about,
// so no step gives early evidence about a window it isn't about.
test('property: over any poll sequence with two windows, toasts happen exactly when an episode closes', () => {
  const step = fc.record({
    dt: fc.integer({ min: 1, max: 30 * MIN }),
    kind: fc.constantFrom('outA', 'outB', 'outBoth', 'outScoped', 'ok', 'dip', 'unknown', 'okEmpty', 'absent', 'null', 'stale'),
  });
  fc.assert(fc.property(fc.array(step, { minLength: 1, maxLength: 60 }), (steps) => {
    const w = createResetWatcher();
    let now = NOW;
    let open = false;
    let atA = null;
    let atB = null;                       // the latest reset told about for each window waited on, else null
    for (const s of steps) {
      now += s.dt;
      const at = now + 20 * MIN;
      const A = (over) => ({ key: 'session', label: '5h', percent: 100, resetsAt: iso(at), ...over });
      const B = (over) => ({ key: 'weekly', label: 'week', percent: 100, resetsAt: iso(at), ...over });
      const S = () => ({ key: 'weekly_scoped:Fable', label: 'Fable', percent: 100, resetsAt: iso(at) });
      const moved = iso(now + 5 * HOUR);
      const quota = {
        outA: fresh([A()]),
        outB: fresh([B()]),
        outBoth: fresh([A(), B()]),
        outScoped: fresh([S()]),
        ok: fresh([A({ percent: 5, resetsAt: moved }), B({ percent: 5, resetsAt: moved }), S()]),
        // under 100 with each window's own reset: a dip, not a reset
        dip: fresh([A({ percent: 99, resetsAt: iso(atA || at) }), B({ percent: 99, resetsAt: iso(atB || at) })]),
        unknown: fresh([A({ percent: null }), B({ resetsAt: null, percent: 3 })]),
        okEmpty: fresh([]),
        absent: ABSENT,
        null: null,
        stale: fresh([A({ percent: 5, resetsAt: moved })], { readAt: now - DATA_STALE_MS - 1 }),
      }[s.kind];
      let expectToast = false;
      if (s.kind === 'outA' || s.kind === 'outBoth') { open = true; atA = at; }
      if (s.kind === 'outB' || s.kind === 'outBoth') { open = true; atB = at; }
      if (!['outA', 'outB', 'outBoth'].includes(s.kind) && open) {
        const latest = Math.max(atA || 0, atB || 0);
        expectToast = s.kind === 'ok' || now >= latest;
      }
      const r = w.see(quota, now);
      if (r.toast !== expectToast) return false;
      if (expectToast) { open = false; atA = null; atB = null; }
    }
    return true;
  }), { numRuns: 500 });
});

test('property: absence, unknown, empty and stale reads are never a used-up state and never a toast on their own', () => {
  fc.assert(fc.property(fc.constantFrom(null, undefined, ABSENT, { ok: true, windows: [] }, fresh([win({ percent: null })]), fresh([win({ percent: NaN })]),
    fresh([win()], { readAt: NOW - DATA_STALE_MS - 1 })), (q) => {
    const w = createResetWatcher();
    const r = w.see(q, NOW);
    return countdownState(q, NOW).state === 'normal' && r.toast === false;
  }), { numRuns: 50 });
});

test('property: the dip rule: percents around 100 with one fixed reset give at most one toast, and only at the reset', () => {
  fc.assert(fc.property(fc.array(fc.double({ min: 90, max: 101, noNaN: true }), { minLength: 1, maxLength: 30 }), (pcts) => {
    const w = createResetWatcher();
    const R = iso(NOW + 2 * HOUR);
    let toasts = 0;
    pcts.forEach((p, i) => { if (w.see(fresh([win({ percent: p, resetsAt: R })]), NOW + i * MIN).toast) toasts++; });
    if (toasts !== 0) return false;      // all before the reset: none
    if (w.see(fresh([win({ percent: 1, resetsAt: R })]), NOW + 2 * HOUR + MIN).toast) toasts++;
    return toasts <= 1;
  }), { numRuns: 300 });
});

// --- loaded as a plain script -----------------------------------------------------

test('loaded as a plain <script> it defines its names on the window and leaks no top-level binding', () => {
  const display = fs.readFileSync(require.resolve('../app/quota-display'), 'utf8');
  const src = fs.readFileSync(require.resolve('../app/quota-countdown'), 'utf8');
  const ctx = vm.createContext({ window: {} });
  ctx.window = ctx;
  vm.runInContext(display, ctx, { filename: 'quota-display-as-script' });
  // Two scripts sharing one scope must both load: run it twice in the same context, as a collision would show.
  vm.runInContext(src, ctx, { filename: 'quota-countdown-as-script' });
  vm.runInContext(src, ctx, { filename: 'quota-countdown-as-script-again' });
  for (const name of ['quotaBackText', 'quotaCountdownState', 'createQuotaResetWatcher', 'createQuotaToastGate', 'quotaTickDelayMs', 'quotaSettlePastResets']) {
    assert.strictEqual(typeof ctx[name], 'function', name);
  }
  // and it works against the clock helpers the display script exported
  assert.match(ctx.quotaBackText(iso(NOW + 3 * DAY), NOW), /^Claude back [A-Z][a-z]{2} \d\d:\d\d$/);
});

test('property: every unscoped window that is out has its own text, no other does, and the binding one resets last', () => {
  fc.assert(fc.property(
    fc.array(fc.record({ pct: fc.constantFrom(0, 50, 99.9, 100, 120, null), min: fc.integer({ min: 1, max: 20000 }), locked: fc.boolean() }), { minLength: 2, maxLength: 2 }),
    (rows) => {
      const keys = ['session', 'weekly'];
      const windows = rows.map((r, i) => win({ key: keys[i], percent: r.pct, resetsAt: iso(NOW + r.min * MIN), lockedReason: r.locked ? 'x' : null }));
      const out = windows.filter((w, i) => rows[i].locked || (rows[i].pct !== null && rows[i].pct >= 100));
      const s = countdownState(fresh(windows), NOW);
      if (JSON.stringify(Object.keys(s.texts).sort()) !== JSON.stringify(out.map(w => w.key).sort())) return false;
      if (out.length === 0) return s.state === 'normal';
      const last = out.reduce((a, b) => (Date.parse(b.resetsAt) > Date.parse(a.resetsAt) ? b : a));
      return s.state === 'usedUp' && s.key === last.key && s.text === s.texts[last.key];
    }), { numRuns: 300 });
});
