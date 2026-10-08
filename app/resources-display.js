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

/**
 * `{ text, cpuText, memText, level, dim, title }` for the chip: `CPU 71%  21.4 GB / 32.0 GB`, amber from 40%, red from 75%.
 * The two figures also come apart, because a one-hour sparkline sits after each (app/resources-history-display.js).
 */
function chipView(payload) {
  const title = 'Machine total and the last hour. Click for the graphs.';
  const status = payload && payload.status ? payload.status : {};
  const m = payload && payload.machine ? payload.machine : null;
  if (!m || status.expired === true) return { text: 'CPU —  — / —', cpuText: 'CPU —', memText: '— / —', level: null, dim: status.stale === true, title };
  const mem = m.mem && isNum(m.mem.usedBytes) && isNum(m.mem.totalBytes) ? `${fmtBytes(m.mem.usedBytes)} / ${fmtBytes(m.mem.totalBytes)}` : '— / —';
  const cpuText = `CPU ${fmtCpu(m.cpu)}`;
  return { text: `${cpuText}  ${mem}`, cpuText, memText: mem, level: levelOf(m.cpu), dim: status.stale === true, title };
}

// ---- state --------------------------------------------------------------------------------------------------

const emptyState = () => ({ payload: null, expanded: [], confirm: null, pending: null, outcome: null, leftBusy: false, leftNote: null });

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
  // The Leftovers Stop's message lasts one sample, like "Stopped".
  return { ...state, payload, confirm, outcome, leftNote: null };
}

/** A Leftovers Stop was pressed: the request is in flight and every Leftovers button is disabled until it answers. */
const beginLeftStop = state => (state.leftBusy ? state : { ...state, leftBusy: true, leftNote: null });

/** Its answer: nothing to show on success (the row leaves with the next sample), a plain sentence when not everything stopped. */
function leftStopResult(state, result) {
  let note = null;
  if (!result || result.ok !== true) note = `Couldn't stop: ${result && isStr(result.text) && result.text !== '' ? result.text : 'the request did not get through'}.`;
  else if (isNum(result.failed) && result.failed > 0) note = `Couldn't stop ${result.failed} of them; they are still listed.`;
  return { ...state, leftBusy: false, leftNote: note };
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
  if (result && result.ok === true) {
    const left = Array.isArray(result.failedChildren) ? result.failedChildren.filter(c => c && Number.isInteger(c.pid)).map(c => c.pid) : [];
    return { ...state, confirm: null, pending: null, outcome: { ...base, kind: 'stopped', ...(left.length ? { left } : {}) } };
  }
  if (result && result.reason === 'gone') return { ...state, confirm: null, pending: null, outcome: { ...base, kind: 'gone', text: 'Already exited' } };
  const why = result && isStr(result.text) && result.text !== '' ? result.text : 'it could not be stopped';
  return { ...state, confirm: null, pending: null, outcome: { ...base, kind: 'refused', text: `Couldn't stop PID ${req.pid}: ${why}.` } };
}

/** A click's data attributes -> an action, or null. Strict: a pid is a positive integer, a start time is digits. */
function actionOf(data) {
  if (!data || typeof data !== 'object') return null;
  switch (data.resAct) {
    case 'toggle': return isStr(data.resKey) && data.resKey !== '' ? { act: 'toggle', key: data.resKey } : null;
    case 'left-stop': {
      const pid = /^\d+$/.test(String(data.resPid)) ? Number(data.resPid) : 0;
      return pid > 0 && /^\d+$/.test(String(data.resStart)) ? { act: 'left-stop', pid, start: data.resStart } : null;
    }
    case 'left-stop-group': return LEFT_STOP_GROUPS.includes(data.resGroup) ? { act: 'left-stop-group', group: data.resGroup } : null;
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

// ---- Leftovers (BACKLOG #74 item 6, option A) ---------------------------------------------------------------------

// [payload key, title, left-edge colour class]: red for what is stuck, yellow for what the app can say nobody runs, grey for what is only big.
const LEFT_GROUPS = [
  ['stuck', 'Stuck closing', 'res-edge-red'],
  ['probes', 'Probe windows nobody is running', 'res-edge-yellow'],
  ['shells', 'Agent shells still running', 'res-edge-yellow'],
  ['mcp', 'MCP servers', 'res-edge-grey'],
];
const LEFT_STOP_GROUPS = ['probes', 'shells'];

function fmtAge(ms) {
  if (!isNum(ms) || ms < 0) return '—';
  if (ms < 60_000) return '<1 min';
  const min = Math.floor(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h`;
}

// What a row says about its fate: an auto-stop row when it goes, anything else why it is only shown or stopped by hand.
function leftoverNote(kind, r) {
  if (r.reapable === true && r.provable === true && isNum(r.reapInMs)) return r.reapInMs <= 0 ? 'stopping…' : `stops in ${Math.ceil(r.reapInMs / 60_000)} min`;
  if (kind === 'shells') return "kept: can't tell whether an agent still needs it";
  return '';
}

// Mock A's note on a group's title line: stuck exits finish on their own; MCP servers as "<N> sessions x <MB> MB" when every row names its
// session and has a figure (the mean per session), otherwise nothing. Never a "never called" claim: no call data stands behind the list.
function groupSide(kind, rows) {
  if (kind === 'stuck') return 'finish on their own, slowly';
  if (kind !== 'mcp' || rows.length === 0) return null;
  if (!rows.every(r => isStr(r.session) && r.session !== '' && isNum(r.bytes))) return null;
  const sessions = new Set(rows.map(r => r.session)).size;
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  return `${sessions} ${sessions === 1 ? 'session' : 'sessions'} × ${Math.round(total / sessions / MB)} MB`;
}

function leftoversView(l, ui) {
  if (!l || typeof l !== 'object') return null;
  const list = k => (Array.isArray(l[k]) ? l[k] : []);
  const groups = [];
  const all = [];
  for (const [kind, title, edge] of LEFT_GROUPS) {
    const rows = list(kind).map((r) => {
      all.push(r);
      const who = isStr(r.what) && r.what !== '' ? r.what : (isStr(r.name) ? r.name : '?');
      const startOk = isStr(r.start) && /^\d+$/.test(r.start) && Number.isInteger(r.pid) && r.pid > 0;
      return {
        name: isStr(r.session) && r.session !== '' ? `${who} · ${r.session}` : who, who, pid: r.pid, start: r.start,
        ageFig: fmtAge(r.ageMs), memFig: fmtBytes(r.bytes), note: leftoverNote(kind, r), canStop: r.provable === true && startOk,
      };
    });
    const src = list(kind);
    if (rows.length) groups.push({ id: kind, title, edge, rows, side: groupSide(kind, src), foot: kind === 'stuck' ? 'Windows is still tearing these down. Nothing can stop them faster.' : null, sub: kind === 'probes' ? 'launcher gone' : null, stopCount: LEFT_STOP_GROUPS.includes(kind) ? rows.filter(x => x.canStop).length : 0 });
  }
  const stopped = list('stopped').map(s => ({ text: `Stopped ${isStr(s.what) && s.what !== '' ? s.what : (isStr(s.name) ? s.name : '?')} (PID ${s.pid}), ${fmtBytes(s.bytes)} freed` }));
  if (!all.length && !stopped.length) return null;
  // Each process once: a row inside another row's subtree (`nested`) is already in that row's figure. Not every figure measured: "at least".
  let bytes = 0;
  let measured = false;
  let complete = true;
  for (const r of all) {
    if (r.nested === true) continue;
    if (isNum(r.bytes)) { bytes += r.bytes; measured = true; } else complete = false;
  }
  const memFig = !measured ? '—' : `${complete ? '' : '≥ '}${fmtBytes(bytes)}`;
  return {
    sum: { count: all.length, memFig }, chip: all.length ? `${all.length} left over` : null, groups, stopped,
    busy: !!(ui && ui.busy), note: ui && isStr(ui.note) && ui.note !== '' ? ui.note : null,
  };
}

function leftoversHtml(v) {
  if (!v) return '';
  const lock = v.busy ? ' disabled' : '';
  const rows = g => g.rows.map(r => `<div class="res-lrow ${g.edge}" title="PID ${esc(r.pid)}"><span class="res-cname">${esc(r.name)}${g.sub ? ` <span class="res-lsub">${esc(g.sub)}</span>` : ''}</span>`
    + `<span class="res-fig res-lmem">${esc(r.memFig)}</span><span class="res-fig res-lage">${esc(r.ageFig)}</span>`
    + (r.canStop
      ? `<button type="button" class="res-lstop" data-res-act="left-stop" data-res-pid="${esc(r.pid)}" data-res-start="${esc(r.start)}" aria-label="Stop ${esc(r.who)}, PID ${esc(r.pid)}"${lock}>Stop</button>`
      : '<span class="res-lstop-gap" aria-hidden="true"></span>')
    + '</div>'
    + (r.note ? `<div class="res-note res-lnote ${g.edge}">${esc(r.note)}</div>` : '')).join('');
  const head = g => `<div class="res-sub ${g.edge}"><span>${esc(g.title)}</span>${g.side ? `<span class="res-side">${esc(g.side)}</span>` : ''}`
    + (g.stopCount > 0 ? `<button type="button" class="res-lstop" data-res-act="left-stop-group" data-res-group="${esc(g.id)}"${lock}>${v.busy ? 'Stopping…' : `Stop ${esc(g.stopCount)}`}</button>` : '')
    + '</div>';
  return `<div class="res-title">Resources${v.chip ? ` <span class="res-chip">${esc(v.chip)}</span>` : ''}</div>`
    + `<section class="res-sec res-left"><h3>Leftovers <span class="res-sum">${esc(v.sum.memFig)}</span></h3>`
    + v.groups.map(g => `${head(g)}${rows(g)}${g.foot ? `<div class="res-note res-lnote ${g.edge}">${esc(g.foot)}</div>` : ''}`).join('')
    + (v.note ? `<div class="res-note res-refused">${esc(v.note)}</div>` : '')
    + (v.stopped.length ? `<div class="res-sub"><span>Stopped</span></div>${v.stopped.map(s => `<div class="res-note">${esc(s.text)}</div>`).join('')}` : '')
    + '</section>';
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
  // Both are physical RAM in use (the machine's total minus free; ours the sum of private working sets), but they come from
  // different counters read a moment apart, so ours can come out the bigger: then the difference means nothing, "—", never 0 B.
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
      pid: c.pid, name: c.name, cmd: c.cmd, full: isStr(c.full) && c.full !== '' ? c.full : c.cmd, start: c.start, cpuFig: cpuFig(c.cpu), memFig: memFig(c.bytes), canStop: c.canStop === true,
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
    leftovers: leftoversView(p.leftovers, { busy: state.leftBusy, note: state.leftNote }),
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
    const left = Array.isArray(c.outcome.left) ? c.outcome.left : [];
    const rest = left.length ? `; couldn't stop ${left.length} ${left.length === 1 ? 'child' : 'children'} (PID${left.length === 1 ? '' : 's'} ${left.map(esc).join(', ')})` : '';
    return `<div class="res-child res-note">Stopped (PID ${esc(c.pid)})${rest}</div>`;
  }
  const stop = c.canStop
    ? `<button type="button" class="res-stop" data-res-act="ask-stop" data-res-pid="${esc(c.pid)}" data-res-start="${esc(c.start)}" data-res-name="${esc(c.name)}" aria-label="Stop ${esc(c.name)}, PID ${esc(c.pid)}" title="Stop ${esc(c.name)}, PID ${esc(c.pid)}">■</button>`
    : '';
  // ONE line per child: name (truncated first), CPU, memory, then a small square Stop at the end. The command line is the
  // row's hover tooltip, not a line of its own.
  let h = `<div class="res-child" title="${esc(c.full)}"><span class="res-cname">${esc(c.name)}</span>`
    + `<span class="res-fig">${esc(c.cpuFig)}</span><span class="res-fig">${esc(c.memFig)}</span>${stop || '<span class="res-stop-gap" aria-hidden="true"></span>'}</div>`;
  if (c.confirm) {
    const lock = c.pending ? ' disabled' : '';
    h += `<div class="res-confirm" role="alert">Stop ${esc(c.name)}, PID ${esc(c.pid)}? Only this process stops, and anything it started stops with it. `
      + `<button type="button" data-res-act="confirm-stop"${lock}>${c.pending ? 'Stopping…' : 'Stop it'}</button> <button type="button" data-res-act="cancel-stop"${lock}>Cancel</button></div>`;
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
  const selfHtml = rowHtml(s, `<div class="res-kids">${s.parts.map(x => `<div class="res-child"><span class="res-cname">${esc(x.label)}</span><span class="res-fig">${esc(x.cpuFig)}</span><span class="res-fig">${esc(x.memFig)}</span></div>`).join('')}</div>`);
  const plain = x => `<div class="res-row res-plain"><span class="res-name">${esc(x.label)}</span>${meterHtml(x.meter)}<span class="res-fig">${esc(x.cpuFig)}</span><span class="res-fig">${esc(x.memFig)}</span></div>`;
  const others = [...v.windows.map(plain), ...(v.background ? [plain(v.background)] : [])];
  return `<div class="res${v.stale.dim ? ' res-dim' : ''}">`
    + (v.stale.text ? `<div class="res-note res-stale">${esc(v.stale.text)}</div>` : '')
    + leftoversHtml(v.leftovers)
    + '<section class="res-sec"><h3>Machine</h3>'
    + `<div class="res-bar-row"><span class="res-bl">CPU</span>${bar(v.machine.cpuBar)}<span class="res-fig">${esc(v.machine.cpuFig)}</span></div>`
    + `<div class="res-bar-row"><span class="res-bl">Memory</span>${bar(v.machine.memBar)}<span class="res-fig">${esc(v.machine.memFig)}</span></div>`
    + `<div class="res-legend">${esc(v.machine.cpuLegend)}</div><div class="res-legend">${esc(v.machine.memLegend)}</div></section>`
    + `<section class="res-sec"><h3>This project <span class="res-sum">${esc(v.project.sum.cpuFig)} · ${esc(v.project.sum.memFig)}</span></h3>${sessionRowsHtml}${selfHtml}</section>`
    + (others.length ? `<section class="res-sec"><h3>Other windows</h3>${others.join('')}</section>` : '')
    + '<div class="res-footer">Every 10 s · paused while minimised</div></div>';
}

/** The chip's on/off the page holds: a payload with a real boolean wins; anything else keeps what the page had. */
const nextChipOn = (current, payload) => (payload && typeof payload.chipOn === 'boolean' ? payload.chipOn : current);

const API = { fmtAge, fmtCpu, fmtBytes, chipView, nextChipOn, emptyState, withPayload, toggle, askStop, cancelStop, beginStop, stopResult, beginLeftStop, leftStopResult, actionOf, view, html };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.resourcesDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
