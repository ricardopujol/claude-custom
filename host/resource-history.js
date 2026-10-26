'use strict';
/**
 * The one-hour history behind the top-bar sparklines (BACKLOG #63 follow-up, documentation/DESIGN_RESOURCE_PANEL.md
 * "Follow-up: one-hour history"): a ring of machine samples, one point per 10 s sample, 360 to the hour. In memory only.
 *
 * ABSENCE IS NOT ZERO (CLAUDE.md, the `Number(null)` trap). A figure that was not measured is null, and a failed sample
 * is a point with every figure null: the view breaks the line there instead of drawing a drop to 0. A minimised window
 * records nothing at all, and the view breaks the line on the TIME gap. Pure: no clock, no OS.
 */

const CAPACITY = 360;
const FIELDS = ['cpu', 'cpuOurs', 'memUsed', 'memOurs', 'memTotal', 'gpu', 'gpuMemUsed', 'gpuMemTotal'];
// A step bigger than this between two points means samples were missed. The cadence is a 10 s gap AFTER a sample and a sample
// can take up to its 20 s timeout, so a good, slow sample is 30 s after the last (Dexter, PR #114 D3): a minute is the margin.
const MAX_STEP_MS = 60000;
// How far the wall clock may disagree with the monotonic one between two points before it counts as a step of the clock
// (a resume from sleep, a sync, a manual change), in either direction.
const WALL_SLACK_MS = 5000;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const round = (f, v) => (f === 'cpu' || f === 'cpuOurs' || f === 'gpu' ? Math.round(v * 10) / 10 : Math.round(v));

/**
 * `at` is a MONOTONIC time in ms (main's `performance.now()`): it orders and spaces the points. The wall clock can step, and a
 * ring that trusted it froze for hours after one wrong reading (Dexter, PR #114 D1). `wall` is only compared against it, to
 * notice such a step; it is not stored. A point that follows missed samples carries `brk: true`: the view breaks the line
 * before it. A gap is a break, never a drop to 0, and the spacing alone is never what decides it.
 */
function createHistory({ capacity = CAPACITY } = {}) {
  let ring = [];
  let pendingBreak = false;
  let lastWall = null;

  function push(at, wall, figures) {
    if (!isNum(at)) return;
    const last = ring.length ? ring[ring.length - 1] : null;
    if (last && at <= last.at) return;   // the monotonic clock only moves forward
    const p = { at };
    for (const f of FIELDS) p[f] = isNum(figures[f]) ? round(f, figures[f]) : null;
    if (last && (pendingBreak || at - last.at > MAX_STEP_MS
      || (isNum(wall) && isNum(lastWall) && Math.abs((wall - lastWall) - (at - last.at)) > WALL_SLACK_MS))) p.brk = true;
    pendingBreak = false;
    lastWall = isNum(wall) ? wall : null;
    ring.push(p);
    if (ring.length > capacity) ring = ring.slice(ring.length - capacity);
  }

  return {
    /** `{ at, wall?, cpu, cpuOurs, memUsed, memOurs, memTotal, gpu, gpuMemUsed, gpuMemTotal }`: any figure that is not a finite number is stored as null. */
    record(p) { push(p && p.at, p && p.wall, p || {}); },
    /** A sample that failed: nothing was measured, so every figure is null. */
    recordFailure(at, wall) { push(at, wall, {}); },
    /** Sampling stopped for a while (a minimised window): the next point starts a new run. */
    markBreak() { pendingBreak = true; },
    points: () => ring.map(p => ({ ...p })),
    clear() { ring = []; pendingBreak = false; lastWall = null; },
  };
}

module.exports = { createHistory, CAPACITY, MAX_STEP_MS, WALL_SLACK_MS };
