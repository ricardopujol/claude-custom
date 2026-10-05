'use strict';
/**
 * The one-hour history in the top-bar chip and its popover (BACKLOG #63 follow-up, documentation/DESIGN_RESOURCE_PANEL.md
 * "Follow-up: one-hour history", option B): the tiny sparklines and the two larger stacked-area graphs. Pure geometry and
 * SVG/HTML strings; main's ring (host/resource-history.js) is where the points come from. renderer.js wires the clicks.
 *
 * A GAP IS A BREAK, NEVER A DROP TO 0 (CLAUDE.md, the `Number(null)` trap). A null figure (a failed sample, or a CPU not
 * measurable yet) and a time gap (a minimised window records nothing) both split the line into separate runs, so nothing
 * is ever drawn for a moment that was not measured. Every number that reaches the markup is one this file computed.
 *
 * WRAPPED IN AN IIFE (the renderer loads every script as a plain <script> sharing ONE global scope, CLAUDE.md's first
 * trap). One name leaves it: `resourcesHistoryDisplay`. Load it after resources-display.js.
 */

(function (root) {

const R = root.resourcesDisplay || (typeof require === 'function' ? require('./resources-display') : null);

const HOUR_MS = 60 * 60 * 1000;
const STEP_MS = 10000;
const GAP_MS = 2.5 * STEP_MS;       // more than this between two points and the line breaks
const HALF_MINUTE_MS = 30000;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const clamp01 = v => Math.min(1, Math.max(0, v));
const f1 = n => n.toFixed(1);

/** A point's figures as 0..1 fractions, each null when it was not measured: `{ at, cpu, cpuOurs, mem, memOurs }`. */
function fractions(p) {
  const q = p || {};
  const total = isNum(q.memTotal) && q.memTotal > 0 ? q.memTotal : null;
  return {
    at: q.at,
    cpu: isNum(q.cpu) ? clamp01(q.cpu / 100) : null,
    cpuOurs: isNum(q.cpuOurs) ? clamp01(q.cpuOurs / 100) : null,
    mem: total !== null && isNum(q.memUsed) ? clamp01(q.memUsed / total) : null,
    memOurs: total !== null && isNum(q.memOurs) ? clamp01(q.memOurs / total) : null,
  };
}

function runsOf(frs, key) {
  const runs = [];
  let cur = null;
  let lastAt = null;
  for (const p of frs) {
    const v = p[key];
    if (!isNum(v) || !isNum(p.at)) { cur = null; lastAt = null; continue; }
    if (cur && lastAt !== null && p.at - lastAt > GAP_MS) cur = null;
    if (!cur) { cur = []; runs.push(cur); }
    cur.push({ at: p.at, v });
    lastAt = p.at;
  }
  return runs;
}

/** The runs of one figure ('cpu' | 'cpuOurs' | 'mem' | 'memOurs'): consecutive measured points, `[{ at, v }]`. */
const segments = (points, key) => (Array.isArray(points) ? runsOf(points.map(fractions), key) : []);

// `ours` can never be more than the total it is a part of: clip it to the total at the same point (counters read a moment apart).
function withOursClipped(frs, kind) {
  const ours = `${kind}Ours`;
  return frs.map(p => (isNum(p[ours]) && isNum(p[kind]) ? { ...p, [ours]: Math.min(p[ours], p[kind]) } : p));
}

const inWindow = (runs, nowAt) => runs
  .map(run => run.filter(p => p.at >= nowAt - HOUR_MS))
  .filter(run => run.length > 0);

const xOf = (at, nowAt, w) => Math.min(w, Math.max(0, ((at - (nowAt - HOUR_MS)) / HOUR_MS) * w));

/** The tiny one-hour line: one polyline per run, a dot for a run of one. `kind` is 'cpu' | 'mem'. */
function sparkline(points, kind, nowAt, { w = 56, h = 14 } = {}) {
  const yOf = v => (h - 1) - v * (h - 2);
  const frs = Array.isArray(points) ? points.map(fractions) : [];
  let body = '';
  for (const run of inWindow(runsOf(frs, kind), nowAt)) {
    const xy = run.map(p => `${f1(xOf(p.at, nowAt, w))},${f1(yOf(p.v))}`);
    body += run.length === 1
      ? `<circle cx="${xy[0].split(',')[0]}" cy="${xy[0].split(',')[1]}" r="1.2"/>`
      : `<polyline points="${xy.join(' ')}" fill="none"/>`;
  }
  return `<svg class="hs" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${body}</svg>`;
}

/** The fraction across a graph (0 = 60 min ago, 1 = now) as whole minutes ago, 0 to 60; null for anything that is not a number. */
function minutesAgo(frac) {
  if (!isNum(frac)) return null;
  return Math.round((1 - clamp01(frac)) * 60);
}

const when = m => (m === 0 ? 'now' : `${m} min ago`);

/** "12 min ago · CPU 54%, ours 41%" (memory: "12 min ago · memory 21.4 GB, ours 3.2 GB"); "no data" for a minute with no sample. */
function readout(points, nowAt, minutes, kind) {
  if (!isNum(minutes)) return '';
  const target = nowAt - minutes * 60000;
  let best = null;
  for (const p of Array.isArray(points) ? points : []) {
    if (!isNum(p && p.at)) continue;
    const d = Math.abs(p.at - target);
    if (d <= HALF_MINUTE_MS && (best === null || d < best.d)) best = { d, p };
  }
  const f = best ? fractions(best.p) : null;
  if (!f || f[kind] === null) return `${when(minutes)} · no data`;
  const src = best.p;
  if (kind === 'cpu') return `${when(minutes)} · CPU ${R.fmtCpu(src.cpu)}, ours ${isNum(src.cpuOurs) ? R.fmtCpu(src.cpuOurs) : '—'}`;
  return `${when(minutes)} · memory ${R.fmtBytes(src.memUsed)}, ours ${f.memOurs !== null ? R.fmtBytes(src.memOurs) : '—'}`;
}

const areaPath = (run, nowAt, w, h) => {
  const yOf = v => (h - 2) - v * (h - 4) + 1;
  const first = xOf(run[0].at, nowAt, w);
  const last = xOf(run[run.length - 1].at, nowAt, w);
  return `M${f1(first)},${h - 1} ${run.map(p => `L${f1(xOf(p.at, nowAt, w))},${f1(yOf(p.v))}`).join(' ')} L${f1(last)},${h - 1} Z`;
};

/**
 * One larger graph: ours (accent) stacked under everything else (neutral), a mark on the latest point, the 60 / 30 / now
 * axis, and the hover readout. `hover` is the minutes ago the pointer is on, or null (the readout then says "now").
 */
function graph(points, kind, nowAt, { w = 300, h = 64, hover = null } = {}) {
  const frs = Array.isArray(points) ? withOursClipped(points.map(fractions), kind) : [];
  const total = inWindow(runsOf(frs, kind), nowAt);
  const mine = inWindow(runsOf(frs, `${kind}Ours`), nowAt);
  const minutes = isNum(hover) ? hover : 0;
  const name = kind === 'cpu' ? 'CPU' : 'Memory';
  if (total.length === 0) {
    return `<div class="hg" data-hist-graph="${kind}"><div class="hg-name">${name}</div><div class="hg-empty">Collecting data…</div></div>`;
  }
  let svg = '';
  for (const run of total) if (run.length > 1) svg += `<path class="hg-rest" d="${areaPath(run, nowAt, w, h)}"/>`;
  for (const run of mine) if (run.length > 1) svg += `<path class="hg-ours" d="${areaPath(run, nowAt, w, h)}"/>`;
  const lastPoint = frs.length ? frs[frs.length - 1] : null;
  if (lastPoint && isNum(lastPoint[kind]) && isNum(lastPoint.at) && lastPoint.at >= nowAt - HOUR_MS) {
    const y = (h - 2) - lastPoint[kind] * (h - 4) + 1;
    svg += `<circle class="hg-latest" cx="${f1(xOf(lastPoint.at, nowAt, w))}" cy="${f1(y)}" r="2.5"/>`;
  }
  const cursor = isNum(hover) ? `<div class="hg-cursor" style="left:${f1((1 - hover / 60) * 100)}%"></div>` : '';
  return `<div class="hg" data-hist-graph="${kind}"><div class="hg-name">${name}</div>`
    + `<div class="hg-plot" style="width:${w}px;height:${h}px"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${svg}</svg>${cursor}</div>`
    + '<div class="hg-axis"><span>60 min</span><span>30</span><span>now</span></div>'
    + `<div class="hg-readout">${readout(points, nowAt, minutes, kind)}</div></div>`;
}

/** The popover's body: the two graphs and what the colours mean. `hover` is `{ cpu, mem }` minutes ago or null. */
function popover(points, nowAt, hover = {}) {
  const h = hover || {};
  return graph(points, 'cpu', nowAt, { hover: h.cpu }) + graph(points, 'mem', nowAt, { hover: h.mem })
    + '<div class="hg-key"><i class="hg-sw hg-sw-ours"></i>claude-custom <i class="hg-sw hg-sw-rest"></i>everything else</div>';
}

const API = { fractions, segments, sparkline, minutesAgo, readout, graph, popover, GAP_MS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.resourcesHistoryDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
