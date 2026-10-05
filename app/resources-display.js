'use strict';
/**
 * The Resources panel and the top-bar chip (BACKLOG #63, documentation/DESIGN_RESOURCE_PANEL.md): pure decisions
 * and HTML strings. renderer.js wires the clicks and the IPC; main's sampler (host/resource-sampler.js) and
 * view model (host/resource-model.js) are where the figures come from.
 *
 * ABSENCE IS NOT ZERO (CLAUDE.md, the `Number(null)` trap). A figure that was not measured is "—", and before the
 * second sample a CPU figure reads "measuring…" (CPU % is a delta; memory is there at once). `typeof` checks only:
 * a coercing finite-check would turn "no value" into a confident 0%. A sample that is overdue dims the last good
 * figures with "last updated N s ago"; after three failures they turn into "—".
 *
 * WHAT THE PAGE HOLDS. One state object, `{ payload, expanded, confirm, outcome }`, changed only through the
 * functions below (each returns a new one), and drawn from `view` -> `html`. Everything the machine says about a
 * process (its name, its command line, a folder name) is somebody else's string and is escaped.
 *
 * WRAPPED IN AN IIFE, and that is not style: the renderer loads every script as a plain <script> tag sharing ONE
 * global scope (CLAUDE.md, the first trap). One name leaves it: `resourcesDisplay`.
 */

(function (root) {

const MB = 1024 * 1024;
const GB = 1024 * MB;
const AMBER = 40;
const RED = 75;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isStr = v => typeof v === 'string';
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ESCAPES[c]);
const clampPct = v => (isNum(v) ? Math.min(100, Math.max(0, v)) : 0);

function fmtCpu(pct) {
  if (!isNum(pct) || pct < 0) return '—';
  if (pct === 0) return '0%';
  if (pct < 1) return '<1%';
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function fmtBytes(n) {
  if (!isNum(n) || n < 0) return '—';
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  return `${Math.round(n / MB)} MB`;
}

const levelOf = pct => (!isNum(pct) ? null : pct >= RED ? 'red' : pct >= AMBER ? 'amber' : null);

// ---- the top-bar chip -------------------------------------------------------------------------------------

/** `{ text, level, dim, title }` for the chip: `CPU 71%  21.4 GB / 32.0 GB`, amber from 40%, red from 75%. */
function chipView(payload) {
  const title = 'Machine total. Open the Resources panel for who\'s using it.';
  const status = payload && payload.status ? payload.status : {};
  const m = payload && payload.machine ? payload.machine : null;
  if (!m || status.expired === true) return { text: 'CPU —  — / —', level: null, dim: status.stale === true, title };
  const mem = m.mem && isNum(m.mem.usedBytes) && isNum(m.mem.totalBytes) ? `${fmtBytes(m.mem.usedBytes)} / ${fmtBytes(m.mem.totalBytes)}` : '— / —';
  return { text: `CPU ${fmtCpu(m.cpu)}  ${mem}`, level: levelOf(m.cpu), dim: status.stale === true, title };
}

// ---- state --------------------------------------------------------------------------------------------------

const emptyState = () => ({ payload: null, expanded: [], confirm: null, pending: null, outcome: null });

function sessionRows(payload) {
  return payload && payload.model && payload.model.project && Array.isArray(payload.model.project.rows) ? payload.model.project.rows : [];
}
function hasChild(payload, pid, start) {
  return sessionRows(payload).some(r => Array.isArray(r.children) && r.children.some(c => c.pid === pid && c.start === start));
}

/** A new sample arrived: "Stopped" lasts one sample, and a confirm or message about a process that left is dropped. */
function withPayload(state, payload) {
  let { confirm, outcome } = state;
  if (confirm && !hasChild(payload, confirm.pid, confirm.start)) confirm = null;
  if (outcome && (outcome.kind === 'stopped' || !hasChild(payload, outcome.pid, outcome.start))) outcome = null;
  return { ...state, payload, confirm, outcome };
}

function toggle(state, id) {
  const open = state.expanded.includes(id);
  return { ...state, expanded: open ? state.expanded.filter(x => x !== id) : [...state.expanded, id] };
}
const askStop = (state, req) => ({ ...state, confirm: { pid: req.pid, start: req.start, name: req.name }, outcome: null });
const cancelStop = state => (state.pending ? state : { ...state, confirm: null });

/** "Stop it" was pressed: the request is in flight. A second press does nothing, and the buttons read "Stopping…" (one Stop, one answer). */
const beginStop = state => (state.confirm && !state.pending ? { ...state, pending: state.confirm } : state);

function stopResult(state, req, result) {
  const base = { pid: req.pid, start: req.start, name: req.name };
  if (result && result.ok === true) return { ...state, confirm: null, pending: null, outcome: { ...base, kind: 'stopped' } };
  if (result && result.reason === 'gone') return { ...state, confirm: null, pending: null, outcome: { ...base, kind: 'gone', text: 'Already exited' } };
  const why = result && isStr(result.text) && result.text !== '' ? result.text : 'it could not be stopped';
  return { ...state, confirm: null, pending: null, outcome: { ...base, kind: 'refused', text: `Couldn't stop PID ${req.pid}: ${why}.` } };
}

/** A click's data attributes -> an action, or null. Strict: a pid is a positive integer, a start time is digits. */
function actionOf(data) {
  if (!data || typeof data !== 'object') return null;
  switch (data.resAct) {
    case 'toggle': return isStr(data.resKey) && data.resKey !== '' ? { act: 'toggle', key: data.resKey } : null;
    case 'confirm-stop': return { act: 'confirm-stop' };
    case 'cancel-stop': return { act: 'cancel-stop' };
    case 'ask-stop': {
      const pid = /^\d+$/.test(String(data.resPid)) ? Number(data.resPid) : 0;
      if (!(pid > 0) || !/^\d+$/.test(String(data.resStart)) || !isStr(data.resName)) return null;
      return { act: 'ask-stop', pid, start: data.resStart, name: data.resName };
    }
    default: return null;
  }
}

// ---- the view -------------------------------------------------------------------------------------------------

function view(state) {
  const p = state.payload;
  if (!p || !p.model) return { loading: true };
  const model = p.model;
  const status = p.status || {};
  const expired = status.expired === true;
  const measuring = model.measuring === true;
  const cpuFig = cpu => (expired ? '—' : (!isNum(cpu) ? (measuring ? 'measuring…' : '—') : fmtCpu(cpu)));
  const memFig = bytes => (expired ? '—' : fmtBytes(bytes));
  const meter = cpu => (expired || !isNum(cpu) ? null : clampPct(cpu));
  const open = id => state.expanded.includes(id);

  const m = model.machine || {};
  const ours = m.ours || {};
  const mem = m.mem && isNum(m.mem.usedBytes) && isNum(m.mem.totalBytes) && m.mem.totalBytes > 0 ? m.mem : null;
  const cpuKnown = !expired && isNum(m.cpu);
  const restCpu = cpuKnown && isNum(ours.cpu) ? Math.max(0, m.cpu - ours.cpu) : null;
  // claude-custom's figure is PRIVATE (commit) bytes and the machine's is physical in use: when ours is the bigger one
  // (a lot of it paged out) the two are not the same unit and a difference means nothing, so it is "—", never 0 B.
  const restMem = mem && isNum(ours.bytes) && ours.bytes <= mem.usedBytes ? mem.usedBytes - ours.bytes : null;
  const machine = {
    cpuFig: cpuFig(m.cpu),
    // A segment that was not measured is not drawn (the bar is the hatched empty one), never a 0 or "the rest is everything".
    cpuBar: cpuKnown && restCpu !== null ? { ours: clampPct(ours.cpu), rest: clampPct(restCpu) } : null,
    cpuLegend: `claude-custom ${cpuFig(ours.cpu)} · everything else ${expired || restCpu === null ? '—' : fmtCpu(restCpu)}`,
    memFig: expired || !mem ? '—' : `${fmtBytes(mem.usedBytes)} / ${fmtBytes(mem.totalBytes)}`,
    memBar: !expired && mem && restMem !== null ? { ours: clampPct((ours.bytes / mem.totalBytes) * 100), rest: clampPct((restMem / mem.totalBytes) * 100) } : null,
    memLegend: `claude-custom ${memFig(ours.bytes)} · everything else ${expired || restMem === null ? '—' : fmtBytes(restMem)}`,
    level: expired ? null : levelOf(m.cpu),
  };

  const proj = model.project || { rows: [], self: { parts: [] } };
  const childView = (c) => {
    const same = x => !!x && x.pid === c.pid && x.start === c.start;
    return {
      pid: c.pid, name: c.name, cmd: c.cmd, start: c.start, cpuFig: cpuFig(c.cpu), memFig: memFig(c.bytes), canStop: c.canStop === true,
      confirm: same(state.confirm), pending: same(state.pending), outcome: same(state.outcome) ? state.outcome : null,
    };
  };
  const rows = (proj.rows || []).map((r) => {
    const id = `s:${r.key}`;
    const more = r.more && r.more.count > 0 ? (r.more.underOnePct ? `+${r.more.count} more, under 1% each` : `+${r.more.count} more`) : null;
    return {
      id, label: r.label, cpuFig: cpuFig(r.cpu), memFig: memFig(r.bytes), meter: meter(r.cpu), expanded: open(id),
      children: (r.children || []).map(childView), moreText: more,
    };
  });
  const selfParts = (proj.self && proj.self.parts) || [];
  const self = {
    id: 'self', label: 'claude-custom itself', cpuFig: cpuFig(proj.self && proj.self.cpu), memFig: memFig(proj.self && proj.self.bytes),
    meter: meter(proj.self && proj.self.cpu), expanded: open('self'),
    parts: selfParts.map(x => ({ label: x.label, cpuFig: cpuFig(x.cpu), memFig: memFig(x.bytes) })),
  };
  const sumRow = x => ({ cpuFig: cpuFig(x.cpu), memFig: memFig(x.bytes), meter: meter(x.cpu) });
  return {
    loading: false,
    stale: { dim: status.stale === true, text: status.stale === true && isNum(status.ageMs) ? `last updated ${Math.round(status.ageMs / 1000)} s ago` : null },
    machine,
    project: { sum: { cpuFig: cpuFig(proj.cpu), memFig: memFig(proj.bytes) }, rows, self },
    windows: (model.windows || []).map(w => ({ label: w.label, ...sumRow(w) })),
    background: model.background ? { label: 'background sessions', ...sumRow(model.background) } : null,
  };
}

// ---- the HTML ---------------------------------------------------------------------------------------------------

const bar = (b) => (b
  ? `<div class="res-bar"><i class="res-ours" style="width:${Math.round(b.ours)}%"></i><i class="res-rest" style="width:${Math.round(b.rest)}%"></i></div>`
  : '<div class="res-bar res-bar-empty"></div>');

const meterHtml = pct => (pct === null
  ? '<span class="res-meter res-meter-empty"></span>'
  : `<span class="res-meter"><i style="width:${Math.round(pct)}%"></i></span>`);

function childHtml(c) {
  if (c.outcome && c.outcome.kind === 'stopped') {
    return `<div class="res-child res-note">Stopped (PID ${esc(c.pid)})</div>`;
  }
  const stop = c.canStop
    ? `<button type="button" class="res-stop" data-res-act="ask-stop" data-res-pid="${esc(c.pid)}" data-res-start="${esc(c.start)}" data-res-name="${esc(c.name)}">Stop</button>`
    : '';
  let h = `<div class="res-child"><span class="res-cname">${esc(c.name)}</span><span class="res-ccmd" title="${esc(c.cmd)}">${esc(c.cmd)}</span>`
    + `<span class="res-fig">${esc(c.cpuFig)}</span><span class="res-fig">${esc(c.memFig)}</span>${stop}</div>`;
  if (c.confirm) {
    const off = c.pending ? ' disabled' : '';
    h += `<div class="res-confirm" role="alert">Stop ${esc(c.name)}, PID ${esc(c.pid)}? Only this process stops, and anything it started stops with it. `
      + `<button type="button" data-res-act="confirm-stop"${off}>${c.pending ? 'Stopping…' : 'Stop it'}</button> <button type="button" data-res-act="cancel-stop"${off}>Cancel</button></div>`;
  }
  if (c.outcome) h += `<div class="res-note res-refused">${esc(c.outcome.text)}</div>`;
  return h;
}

function rowHtml(r, body) {
  return `<div class="res-row${r.expanded ? ' open' : ''}" data-res-act="toggle" data-res-key="${esc(r.id)}" role="button" tabindex="0" aria-expanded="${r.expanded ? 'true' : 'false'}">`
    + `<span class="res-name">${esc(r.label)}</span>${meterHtml(r.meter)}<span class="res-fig">${esc(r.cpuFig)}</span><span class="res-fig">${esc(r.memFig)}</span></div>${r.expanded ? body : ''}`;
}

function html(v) {
  if (v.loading) return '<div class="res-note">measuring…</div>';
  const sessionRowsHtml = v.project.rows.map((r) => rowHtml(r,
    `<div class="res-kids">${r.children.map(childHtml).join('')}${r.moreText ? `<div class="res-note">${esc(r.moreText)}</div>` : ''}</div>`)).join('');
  const s = v.project.self;
  const selfHtml = rowHtml(s, `<div class="res-kids">${s.parts.map(x => `<div class="res-child"><span class="res-cname">${esc(x.label)}</span><span class="res-ccmd"></span><span class="res-fig">${esc(x.cpuFig)}</span><span class="res-fig">${esc(x.memFig)}</span></div>`).join('')}</div>`);
  const plain = x => `<div class="res-row res-plain"><span class="res-name">${esc(x.label)}</span>${meterHtml(x.meter)}<span class="res-fig">${esc(x.cpuFig)}</span><span class="res-fig">${esc(x.memFig)}</span></div>`;
  const others = [...v.windows.map(plain), ...(v.background ? [plain(v.background)] : [])];
  return `<div class="res${v.stale.dim ? ' res-dim' : ''}">`
    + (v.stale.text ? `<div class="res-note res-stale">${esc(v.stale.text)}</div>` : '')
    + '<section class="res-sec"><h3>Machine</h3>'
    + `<div class="res-bar-row"><span class="res-bl">CPU</span>${bar(v.machine.cpuBar)}<span class="res-fig">${esc(v.machine.cpuFig)}</span></div>`
    + `<div class="res-bar-row"><span class="res-bl">Memory</span>${bar(v.machine.memBar)}<span class="res-fig">${esc(v.machine.memFig)}</span></div>`
    + `<div class="res-legend">${esc(v.machine.cpuLegend)}</div><div class="res-legend">${esc(v.machine.memLegend)}</div></section>`
    + `<section class="res-sec"><h3>This project <span class="res-sum">${esc(v.project.sum.cpuFig)} · ${esc(v.project.sum.memFig)}</span></h3>${sessionRowsHtml}${selfHtml}</section>`
    + (others.length ? `<section class="res-sec"><h3>Other windows</h3>${others.join('')}</section>` : '')
    + '<div class="res-footer">Every 10 s while this panel is shown · paused when hidden</div></div>';
}

const API = { fmtCpu, fmtBytes, chipView, emptyState, withPayload, toggle, askStop, cancelStop, beginStop, stopResult, actionOf, view, html };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.resourcesDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
