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
const FIELDS = ['cpu', 'cpuOurs', 'memUsed', 'memOurs', 'memTotal'];

const isNum = v => typeof v === 'number' && Number.isFinite(v);

function createHistory({ capacity = CAPACITY } = {}) {
  let ring = [];

  function push(at, figures) {
    if (!isNum(at)) return;
    if (ring.length && at <= ring[ring.length - 1].at) return;   // time only moves forward
    const p = { at };
    for (const f of FIELDS) p[f] = isNum(figures[f]) ? figures[f] : null;
    ring.push(p);
    if (ring.length > capacity) ring = ring.slice(ring.length - capacity);
  }

  return {
    /** `{ at, cpu, cpuOurs, memUsed, memOurs, memTotal }`: any figure that is not a finite number is stored as null. */
    record(p) { push(p && p.at, p || {}); },
    /** A sample that failed: nothing was measured, so every figure is null. */
    recordFailure(at) { push(at, {}); },
    points: () => ring.map(p => ({ ...p })),
    clear() { ring = []; },
  };
}

module.exports = { createHistory, CAPACITY };
