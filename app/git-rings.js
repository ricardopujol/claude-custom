'use strict';
/**
 * The Rings dial's geometry (documentation/DESIGN_GIT_TREE.md, PLAN_GIT_TREE.md Task 9). Pure:
 * the model's branches (host/git-tree.js, already in time order) -> one spoke per branch.
 *
 *   layout(branches) -> { spokes: [{ name, angle, x0, y0, x1, y1, width, tipR, dashed }],
 *                         weeks:  [{ week, a0, a1, alt }] }
 *
 * Time runs clockwise from 12 o'clock, starting just past a small gap (where history begins and
 * "now" ends). A spoke's reach is its spend on a square-root scale, so a 9M branch is 3x a 1M one,
 * not 9x; unknown spend (null) is a dashed spoke at the minimum reach -- never drawn as 0. Width is
 * commits, the tip is agent runs. The dial NEVER grows: more branches make thinner slices, so the
 * whole history is visible at a glance, without scrolling (Ricardo's ask, mock v3 -> v4).
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `gitRings`.
 */
(function (root) {

const DIAL = Object.freeze({
  width: 360, height: 430,      // the viewBox
  cx: 180, cy: 214,             // the hub
  r0: 46,                       // where spokes start (the hub's ring)
  r1: 168,                      // the rim: the biggest spend reaches it
  minLen: 8,                    // the reach of an unknown or tiny spend
  gap: 10 * Math.PI / 180,      // the 12 o'clock gap
  maxTip: 7,
});

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The Monday of a 'YYYY-MM-DD' day's week, or null. */
function weekOf(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d\d-\d\d/.test(day)) return null;
  const t = new Date(day.slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(t.getTime())) return null;
  t.setUTCDate(t.getUTCDate() - (t.getUTCDay() + 6) % 7);
  return t.toISOString().slice(0, 10);
}

function layout(branches) {
  const list = Array.isArray(branches) ? branches : [];
  const n = list.length;
  if (!n) return { spokes: [], weeks: [] };
  const { cx, cy, r0, r1, minLen, gap, maxTip } = DIAL;
  const slice = (2 * Math.PI - gap) / n;
  const angleOf = i => -Math.PI / 2 + gap / 2 + (i + 0.5) * slice;
  const max = list.reduce((m, b) => Math.max(m, num(b.spend) || 0), 0);
  const span = r1 - r0 - minLen;

  const spokes = list.map((b, i) => {
    const spend = num(b.spend);
    const reach = minLen + (spend !== null && max > 0 ? span * Math.sqrt(spend / max) : 0);
    const angle = angleOf(i);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const commits = num(b.commits);
    const runs = num(b.runs) || 0;
    return {
      name: b.name, angle,
      x0: cx + r0 * c, y0: cy + r0 * s,
      x1: cx + (r0 + reach) * c, y1: cy + (r0 + reach) * s,
      width: commits ? Math.min(3, 0.8 + Math.sqrt(commits) * 0.3) : 1,
      tipR: Math.min(maxTip, 1.4 + Math.sqrt(runs) * 0.9),
      dashed: spend === null,
    };
  });

  // One faint arc per week, for each run of consecutive branches in that week; they alternate.
  const weeks = [];
  let alt = false;
  list.forEach((b, i) => {
    const week = weekOf(b.when);
    const last = weeks[weeks.length - 1];
    if (week === null) return;
    if (last && last.week === week && last.end === i - 1) {
      last.a1 = angleOf(i) + slice * 0.4;
      last.end = i;
      return;
    }
    if (last) alt = !alt;
    weeks.push({ week, a0: angleOf(i) - slice * 0.4, a1: angleOf(i) + slice * 0.4, alt, end: i });
  });
  return { spokes, weeks: weeks.map(({ end, ...w }) => w) };
}

const api = { layout, weekOf, DIAL };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.gitRings = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
