'use strict';
/**
 * The Files tab's refresh policy (PR #95 Dexter D4, Miguel M1): the overlay is re-read at most every few
 * seconds, a change that lands while a read is running is NOT dropped (one follow-up), and while the tab is
 * hidden a change only marks it stale: the work happens when it is shown.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createRefresher, OVERLAY_EVERY_MS } = require('../app/repo-refresh');

function rig({ shown = true } = {}) {
  const s = { t: 100000, timers: [], tree: 0, overlay: 0, gates: [], shown };
  const r = createRefresher({
    reloadTree: () => { s.tree += 1; },
    loadOverlay: () => new Promise((resolve) => { s.overlay += 1; s.gates.push(resolve); }),
    isShown: () => s.shown,
    now: () => s.t,
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; s.timers.push(h); return h; },
    clearTimer: (h) => { h.cleared = true; },
  });
  const fire = () => { const h = s.timers.find(x => !x.cleared && !x.fired); if (h) { h.fired = true; h.fn(); } return !!h; };
  return { s, r, fire };
}
const tick = () => new Promise(r => setImmediate(r));

test('D4: a change while an overlay read is running is not dropped: exactly one follow-up after it', async () => {
  const { s, r, fire } = rig();
  r.askOverlay({ urgent: true });
  assert.strictEqual(s.overlay, 1);
  s.t += OVERLAY_EVERY_MS + 800;           // the read took longer than the interval
  r.onChanged();                           // the watcher fires mid-read
  r.onChanged();
  assert.strictEqual(s.overlay, 1, 'no second read starts while one is running');
  s.gates[0]();
  await tick(); fire(); await tick();
  assert.strictEqual(s.overlay, 2, 'one follow-up read, for the change that landed meanwhile');
  s.gates[1]();
  await tick(); fire(); await tick();
  assert.strictEqual(s.overlay, 2, 'and none after that');
});

test('D4: no change during the read means no follow-up', async () => {
  const { s, r, fire } = rig();
  r.askOverlay({ urgent: true });
  s.gates[0]();
  await tick(); fire(); await tick();
  assert.strictEqual(s.overlay, 1);
});

test('the overlay is asked at most every OVERLAY_EVERY_MS: an earlier change waits for the rest of the interval, once', async () => {
  const { s, r, fire } = rig();
  r.askOverlay({ urgent: true });
  s.gates[0](); await tick();
  s.t += 1000;
  r.onChanged(); r.onChanged(); r.onChanged();
  assert.strictEqual(s.overlay, 1);
  const waits = s.timers.filter(h => !h.cleared);
  assert.strictEqual(waits.length, 1, 'one pending timer however many changes');
  assert.strictEqual(waits[0].ms, OVERLAY_EVERY_MS - 1000);
  s.t += OVERLAY_EVERY_MS - 1000; fire(); await tick();
  assert.strictEqual(s.overlay, 2);
});

test('a change after the interval has passed reads at once', async () => {
  const { s, r } = rig();
  r.askOverlay({ urgent: true }); s.gates[0](); await tick();
  s.t += OVERLAY_EVERY_MS + 1;
  r.onChanged();
  assert.strictEqual(s.overlay, 2);
});

test('every change reloads the tree (the listing is cheap and host-side cached)', () => {
  const { s, r } = rig();
  r.onChanged(); r.onChanged();
  assert.strictEqual(s.tree, 2);
});

test('M1: while the tab is hidden a change does no work (no tree, no overlay) and only marks it stale', async () => {
  const { s, r } = rig({ shown: false });
  r.onChanged(); r.onChanged();
  assert.deepStrictEqual([s.tree, s.overlay], [0, 0]);
  assert.strictEqual(r.isStale(), true);
});

test('M1: showing a stale tab refreshes once and clears the mark; showing a fresh one does not reload the tree', async () => {
  const { s, r } = rig({ shown: false });
  r.onChanged();
  s.shown = true;
  r.shown();
  assert.strictEqual(s.tree, 1);
  assert.strictEqual(s.overlay, 1, 'the overlay is asked for on every show');
  assert.strictEqual(r.isStale(), false);
  s.gates[0](); await tick();
  r.shown();
  assert.strictEqual(s.tree, 1, 'nothing changed while it was hidden: no reload');
});

test('M1: a change that arrives while the tab is hidden does not leave a timer behind', () => {
  const { s, r } = rig({ shown: false });
  r.askOverlay({ urgent: true });
  s.gates[0]();
  r.onChanged();
  assert.ok(s.timers.every(h => h.cleared || h.fired) || s.timers.length === 0);
});

test('a throwing overlay load is not a stuck busy flag: the next ask runs', async () => {
  const s = { calls: 0 };
  const r = createRefresher({ reloadTree: () => {}, loadOverlay: async () => { s.calls++; throw new Error('boom'); }, isShown: () => true,
    now: () => 1e6 + s.calls * 1e5, setTimer: () => ({}), clearTimer: () => {} });
  r.askOverlay({ urgent: true });
  await tick(); await tick();
  r.askOverlay({ urgent: true });
  assert.strictEqual(s.calls, 2);
});
