'use strict';
/**
 * Fitting the terminal to its box until the fit agrees with itself (BACKLOG #177). Pure: the page hands in the three things it has.
 *
 * WHY ONE fit.fit() IS NOT ENOUGH. xterm derives its CSS cell width from the CURRENT column count:
 * `css.cell.width = round(cols * device.cell.width / dpr) / cols`, so the same box can propose a different count depending on the
 * count the terminal had when it was asked. MEASURED 2026-11-06 (probe-repo-browser --width=839, a 620 px box, 591 px for text):
 * closing the code reader from 32 columns, the 32-col cell (8.21875) proposed floor(591 / 8.21875) = 71; at 71 the cell is 8.197183
 * and the box fits 72 (591 / 8.197183 = 72.1). The observer had fired once for the box's change and never again, so the terminal and
 * the pty stayed one column short. `settleFit` asks again after every resize until the proposal is the size it already has.
 *
 * A CYCLE (n proposes m, m proposes n) is possible on a knife edge; it ends on the smaller size, the one that proposes the bigger:
 * the bigger one's own cells don't fit the box. Bounded by MAX_STEPS either way.
 *
 * `needsSend` is the pty's side: told only when the settled size differs from what it was last told (a refit that changes nothing
 * sends nothing). A reconnect still tells the host its size, unconditionally, outside this (renderer.js connect()).
 */
(function (root) {

const MAX_STEPS = 4;

const usable = (d) => !!d && Number.isInteger(d.cols) && Number.isInteger(d.rows) && d.cols > 0 && d.rows > 0;
const same = (a, b) => !!a && !!b && a.cols === b.cols && a.rows === b.rows;

/**
 * settleFit({ size, propose, resize, maxSteps }) -> { cols, rows }: the terminal's size once it has settled.
 *   size()             the terminal's current { cols, rows }
 *   propose()          what fits the box as measured now ({ cols, rows }), or nothing (no box, no renderer yet: nothing is changed)
 *   resize(cols, rows) the terminal's resize
 */
function settleFit({ size, propose, resize, maxSteps = MAX_STEPS }) {
  const been = [];
  let cur = size();
  for (let i = 0; i < maxSteps; i++) {
    const p = propose();
    if (!usable(p) || same(p, cur)) break;
    been.push(cur);
    if (been.some((b) => same(b, p))) {
      const small = { cols: Math.min(p.cols, cur.cols), rows: Math.min(p.rows, cur.rows) };
      if (!same(small, cur)) resize(small.cols, small.rows);
      break;
    }
    resize(p.cols, p.rows);
    cur = size();
  }
  const end = size();
  return { cols: end.cols, rows: end.rows };
}

/** Whether the pty must be told `now`, given what it was told last (null: never told). */
function needsSend(now, lastSent) {
  return usable(now) && !same(now, lastSent);
}

const API = { settleFit, needsSend, MAX_STEPS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.termFit = API;

})(typeof window !== 'undefined' ? window : globalThis);
