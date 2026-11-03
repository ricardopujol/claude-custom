'use strict';
/**
 * Chrome grammar A (Ricardo's pick, 2026-10-26): every header item is one chip shape, icon, value, and a 28 px micro-bar when there is
 * a fill. The decisions behind that, pure, so nothing in a browser script has to be trusted untested:
 *   microBar(fraction)   how many of the bar's 28 px are filled, or UNKNOWN (never an empty bar: no value is not zero)
 *   warningsChip(items)  the header's warnings as ONE chip with a count; the detail goes in the hover text, never in the chrome
 *
 * WRAPPED IN AN IIFE: renderer.html loads these as plain <script> tags sharing ONE global scope (test/renderer-scope.test.js).
 */
(function (root) {

const BAR_PX = 28;

/** `{ known, px }`. A strict typeof, because Number(null) is 0 and an absent value must not draw a confident empty bar. */
function microBar(fraction) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return { known: false, px: 0 };
  return { known: true, px: Math.round(Math.min(1, Math.max(0, fraction)) * BAR_PX) };
}

/** Items are `{ text, title? }`; anything without a non-empty string text is no warning. */
function warningsChip(items) {
  const real = (Array.isArray(items) ? items : []).filter(i => i && typeof i === 'object' && typeof i.text === 'string' && i.text !== '');
  if (!real.length) return { shown: false, count: 0, label: '', title: '' };
  return {
    shown: true,
    count: real.length,
    label: String(real.length),
    title: real.map(i => (typeof i.title === 'string' && i.title !== '' ? i.title : i.text)).join('\n'),
  };
}

/**
 * The HP chip: what it says, how full its bar is, and whether it shimmers or is dimmed. `last` is the last KNOWN value
 * ({ label, fraction } or null), which the caller keeps. While the suite runs the chip keeps that value and bar, dimmed (stale),
 * and shimmers; an unknown result that is not running is a dash with no bar and no movement. `known` is what to remember next
 * (null when this call has no new known value).
 */
function healthChip(h, last) {
  const running = !!(h && h.running);
  const state = h && h.state;
  const finished = !running && state !== 'unknown' && h && typeof h.passed === 'number' && typeof h.total === 'number';
  if (finished) {
    const label = `${h.passed}/${h.total}`;
    return { label, bar: microBar(h.fraction), running: false, stale: false, known: { label, fraction: h.fraction } };
  }
  if (running && last) return { label: last.label, bar: microBar(last.fraction), running: true, stale: true, known: null };
  return { label: '—', bar: microBar(null), running, stale: false, known: null };
}

// ---- the resources chip: `CPU 23% · RAM 52% · GPU 8%` (Ricardo's pick, option A, 2026-10-28) -------------------------------------
const RES_AMBER_PCT = 75;
const RES_RED_PCT = 90;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** A whole percent in 0..100, or null: absence is not zero (strict typeof, never a coercion). */
const pctOf = v => (isNum(v) ? Math.round(Math.min(100, Math.max(0, v))) : null);
/** 'amber' from 75, 'red' from 90, on the figure as shown; null for no figure. */
const levelOfPct = p => (!isNum(p) ? null : p >= RES_RED_PCT ? 'red' : p >= RES_AMBER_PCT ? 'amber' : null);
const ofText = mem => (mem.totalBytes >= GIB ? `${(mem.usedBytes / GIB).toFixed(1)} of ${(mem.totalBytes / GIB).toFixed(1)} GB` : `${Math.round(mem.usedBytes / MIB)} of ${Math.round(mem.totalBytes / MIB)} MB`);
const ofTotal = mem => (mem && typeof mem === 'object' && isNum(mem.usedBytes) && isNum(mem.totalBytes) && mem.totalBytes > 0 ? mem : null);

/**
 * `{ segments, aria, title }` for the header chip. Each segment is `{ key, label, pct, value, short, level }`: `value` is "23%", `short` the
 * narrow form "23", a missing figure is "—" with no level. RAM is used/total as a percent; GPU is its utilisation (its memory is in the
 * title). The GPU segment exists when the payload carries a GPU part, even if expired (unknown, not absent: the chip keeps its width).
 */
function resourcesChip(payload) {
  const m = payload && payload.machine && typeof payload.machine === 'object' ? payload.machine : null;
  const live = !!m && !(payload.status && payload.status.expired === true);
  const mem = live ? ofTotal(m.mem) : null;
  const gpu = m && m.gpu && typeof m.gpu === 'object' ? m.gpu : null;
  const seg = (key, label, pct) => ({ key, label, pct, value: pct === null ? '—' : `${pct}%`, short: pct === null ? '—' : String(pct), level: levelOfPct(pct) });
  const segments = [
    seg('cpu', 'CPU', live ? pctOf(m.cpu) : null),
    seg('ram', 'RAM', mem ? pctOf((mem.usedBytes / mem.totalBytes) * 100) : null),
  ];
  if (gpu) segments.push(seg('gpu', 'GPU', live ? pctOf(gpu.busy) : null));
  const by = Object.fromEntries(segments.map(s => [s.key, s]));
  const gmem = live && gpu ? ofTotal(gpu.mem) : null;
  const lines = [`CPU ${by.cpu.value}`,
    mem ? `RAM ${ofText(mem)} (${by.ram.value})` : 'RAM —'];
  if (by.gpu) lines.push(`GPU ${by.gpu.value}${gmem ? ` (${ofText(gmem)})` : ''}`);
  lines.push('Machine total. Click for the graphs of the last hour.');
  return { segments, aria: segments.map(s => `${s.label} ${s.value}`).join(', '), title: lines.join('\n') };
}

/** The chip's markup: constants and digits only. The label is grey, the level colours the number alone, "%" and labels drop when narrow. */
function resourcesChipHtml(chip) {
  return chip.segments.map(s => {
    const num = s.pct === null ? '—' : `${s.pct}<span class="tbr-pc">%</span>`;
    return `<span class="tbr-n"><span class="tbr-l">${s.label}</span> <span class="tbr-v${s.level ? ` lv-${s.level}` : ''}">${num}</span></span>`;
  }).join('<span class="tbr-sep">·</span>');
}

const API = { BAR_PX, microBar, warningsChip, healthChip, RES_AMBER_PCT, RES_RED_PCT, levelOfPct, resourcesChip, resourcesChipHtml };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.chipModel = API;

})(typeof window !== 'undefined' ? window : globalThis);
