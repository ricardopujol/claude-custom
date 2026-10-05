'use strict';
/**
 * The one-hour history in the top-bar chip and its popover (BACKLOG #63 follow-up, documentation/DESIGN_RESOURCE_PANEL.md
 * "Follow-up: one-hour history", option B): the tiny sparklines and the two larger stacked-area graphs. Pure geometry and
 * SVG/HTML strings; main's ring (host/resource-history.js) is where the points come from. renderer.js wires the clicks.
 *
 * A GAP IS A BREAK, NEVER A DROP TO 0 (CLAUDE.md, the `Number(null)` trap). A null figure (a failed sample, or a CPU not
 * measurable yet) and a point marked `brk` by main (samples were missed: a minimised window, a long silence, a step of the
 * clock) both split the line into separate runs, so nothing is ever drawn for a moment that was not measured. The SPACING
 * between points decides nothing: the cadence is a 10 s gap after a sample, so a slow sample is not a missed one. The points'
 * `at` is main's monotonic clock and `nowAt` is the payload's `historyNow` on the same clock. Every number that reaches the markup is one this file computed.
 *
 * WRAPPED IN AN IIFE (the renderer loads every script as a plain <script> sharing ONE global scope, CLAUDE.md's first
 * trap). One name leaves it: `resourcesHistoryDisplay`. Load it after resources-display.js.
 */

(function (root) {

const R = root.resourcesDisplay || (typeof require === 'function' ? require('./resources-display') : null);

const HOUR_MS = 60 * 60 * 1000;
const STEP_MS = 10000;
const HALF_MINUTE_MS = 30000;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const clamp01 = v => Math.min(1, Math.max(0, v));
const f1 = n => n.toFixed(1);
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = t => String(t).replace(/[&<>"']/g, c => ESCAPES[c]);

/**
 * A point's figures with "ours" made a part of its total: null where the total is null (nothing of ours is drawn where the
 * total was not measured), and never more than the total (the process counters and the machine counters are read a moment
 * apart). The graph and the readout both read these, so they agree.
 */
function figuresOf(p) {
  const q = p || {};
  const memTotal = isNum(q.memTotal) && q.memTotal > 0 ? q.memTotal : null;
  const cpu = isNum(q.cpu) ? Math.min(100, Math.max(0, q.cpu)) : null;
  const memUsed = memTotal !== null && isNum(q.memUsed) ? Math.min(memTotal, Math.max(0, q.memUsed)) : null;
  return {
    cpu,
    cpuOurs: cpu !== null && isNum(q.cpuOurs) ? Math.min(cpu, Math.max(0, q.cpuOurs)) : null,
    memUsed, memTotal,
    memOurs: memUsed !== null && isNum(q.memOurs) ? Math.min(memUsed, Math.max(0, q.memOurs)) : null,
  };
}

/** A point's figures as 0..1 fractions, each null when it was not measured: `{ at, brk, cpu, cpuOurs, mem, memOurs }`. */
function fractions(p) {
  const f = figuresOf(p);
  return {
    at: p && p.at, brk: !!(p && p.brk === true),
    cpu: f.cpu === null ? null : f.cpu / 100,
    cpuOurs: f.cpuOurs === null ? null : f.cpuOurs / 100,
    mem: f.memUsed === null ? null : f.memUsed / f.memTotal,
    memOurs: f.memOurs === null ? null : f.memOurs / f.memTotal,
  };
}

function runsOf(frs, key) {
  const runs = [];
  let cur = null;
  for (const p of frs) {
    const v = p[key];
    if (!isNum(v) || !isNum(p.at)) { cur = null; continue; }
    if (p.brk) cur = null;
    if (!cur) { cur = []; runs.push(cur); }
    cur.push({ at: p.at, v });
  }
  return runs;
}

/** The runs of one figure ('cpu' | 'cpuOurs' | 'mem' | 'memOurs'): consecutive measured points, `[{ at, v }]`. */
const segments = (points, key) => (Array.isArray(points) ? runsOf(points.map(fractions), key) : []);

const inWindow = (runs, nowAt) => runs
  .map(run => run.filter(p => p.at >= nowAt - HOUR_MS && p.at <= nowAt + STEP_MS))
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

/**
 * "12 min ago · CPU 54%, ours 41%" (memory: "12 min ago · memory 21.4 GB, ours 3.2 GB"), from the nearest MEASURED point within
 * half a minute of the hovered minute (a nearer failure does not hide it); "no data" for a minute with none. The figures are the
 * same clipped ones the graph draws.
 */
function readout(points, nowAt, minutes, kind) {
  if (!isNum(minutes)) return '';
  const target = nowAt - minutes * 60000;
  const key = kind === 'cpu' ? 'cpu' : 'memUsed';
  let best = null;
  for (const p of Array.isArray(points) ? points : []) {
    if (!isNum(p && p.at)) continue;
    const f = figuresOf(p);
    if (f[key] === null) continue;
    const d = Math.abs(p.at - target);
    if (d <= HALF_MINUTE_MS && (best === null || d < best.d)) best = { d, f };
  }
  if (!best) return `${when(minutes)} · no data`;
  const f = best.f;
  if (kind === 'cpu') return `${when(minutes)} · CPU ${R.fmtCpu(f.cpu)}, ours ${f.cpuOurs !== null ? R.fmtCpu(f.cpuOurs) : '—'}`;
  return `${when(minutes)} · memory ${R.fmtBytes(f.memUsed)}, ours ${f.memOurs !== null ? R.fmtBytes(f.memOurs) : '—'}`;
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
  const frs = Array.isArray(points) ? points.map(fractions) : [];
  const total = inWindow(runsOf(frs, kind), nowAt);
  const mine = inWindow(runsOf(frs, `${kind}Ours`), nowAt);
  const minutes = isNum(hover) ? hover : 0;
  const name = kind === 'cpu' ? 'CPU' : 'Memory';
  if (total.length === 0) {
    return `<div class="hg" data-hist-graph="${kind}"><div class="hg-name">${name}</div><div class="hg-empty">Collecting data…</div></div>`;
  }
  let svg = '';
  const yOf = v => (h - 2) - v * (h - 4) + 1;
  const dot = (run, cls) => `<circle class="${cls}" cx="${f1(xOf(run[0].at, nowAt, w))}" cy="${f1(yOf(run[0].v))}" r="1.6"/>`;
  // a run of one point is a dot, as in the sparkline: a measured minute is never left blank
  for (const run of total) svg += run.length > 1 ? `<path class="hg-rest" d="${areaPath(run, nowAt, w, h)}"/>` : dot(run, 'hg-dot-rest');
  for (const run of mine) svg += run.length > 1 ? `<path class="hg-ours" d="${areaPath(run, nowAt, w, h)}"/>` : dot(run, 'hg-dot-ours');
  const lastPoint = frs.length ? frs[frs.length - 1] : null;
  if (lastPoint && isNum(lastPoint[kind]) && isNum(lastPoint.at) && lastPoint.at >= nowAt - HOUR_MS) {
    const y = (h - 2) - lastPoint[kind] * (h - 4) + 1;
    svg += `<circle class="hg-latest" cx="${f1(xOf(lastPoint.at, nowAt, w))}" cy="${f1(y)}" r="2.5"/>`;
  }
  const cursor = isNum(hover) ? `<div class="hg-cursor" style="left:${f1((1 - hover / 60) * 100)}%"></div>` : '';
  return `<div class="hg" data-hist-graph="${kind}"><div class="hg-name">${name}</div>`
    + `<div class="hg-plot" style="width:${w}px;height:${h}px"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${svg}</svg>${cursor}</div>`
    + '<div class="hg-axis"><span>60 min</span><span>30</span><span>now</span></div>'
    + `<div class="hg-readout">${esc(readout(points, nowAt, minutes, kind))}</div></div>`;
}

/** The popover's body: the two graphs and what the colours mean. `hover` is `{ cpu, mem }` minutes ago or null. */
function popover(points, nowAt, hover = {}) {
  const h = hover || {};
  return graph(points, 'cpu', nowAt, { hover: h.cpu }) + graph(points, 'mem', nowAt, { hover: h.mem })
    + '<div class="hg-key"><i class="hg-sw hg-sw-ours"></i>claude-custom <i class="hg-sw hg-sw-rest"></i>everything else</div>';
}

/** The chip's inside: the CPU figure and its sparkline, then the memory figure and its sparkline. */
function chipHtml(cpuText, memText, points, nowAt) {
  return `<span class="tbr-n">${esc(cpuText)}</span>${sparkline(points, 'cpu', nowAt)}`
    + `<span class="tbr-n">${esc(memText)}</span>${sparkline(points, 'mem', nowAt)}`;
}

const API = { chipHtml, esc, figuresOf, fractions, segments, sparkline, minutesAgo, readout, graph, popover };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.resourcesHistoryDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
