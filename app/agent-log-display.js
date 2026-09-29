'use strict';
/**
 * BACKLOG #10: what an agent is doing, drawn from the frames the host streams
 * out of its transcript (host/agent-log-session.js).
 *
 * Two pure pieces, nothing here touches the DOM or the socket:
 *
 *   applyFrame(model, frame)   the reducer: one frame in, the next model out
 *   renderAgentLog(model)      the model as HTML, everything escaped
 *
 * THREE RULES this module exists to keep, because this repo has paid for each:
 *
 *   1. ABSENCE IS SAID. A frame with `source: null` is drawn as words --
 *      "no transcript found for X" -- and never as an empty list, which reads
 *      as "idle". A transcript that exists but has no lines yet says that too.
 *   2. EVERY line shown came from a transcript line. Nothing is synthesised: no
 *      "working..." row, no progress estimate. Status words (live / finished /
 *      reading) come from the frame's own `running` and `done`.
 *   3. NOTHING FROM THE TRANSCRIPT IS TRUSTED AS MARKUP. An agent name, a tool
 *      name, a file path and a command are all somebody else's strings.
 *      Everything is escaped, and `kind` is checked against a whitelist before
 *      it becomes a CSS class.
 *
 * WRAPPED IN AN IIFE, as every display module is: the renderer loads them all as
 * plain <script> tags sharing ONE global scope, and no unit test can see a
 * collision (see app/agent-card-display.js and test/renderer-scope.test.js).
 * The single name it publishes is `agentLogDisplay`.
 */

(function (root) {

// The most entries held (and drawn). A long-running agent writes thousands of
// lines; the newest are what a reader wants, and the count of the rest is said.
const MAX_ENTRIES = 1000;
// How close to the bottom still counts as "following".
const FOLLOW_SLACK_PX = 24;
const KINDS = ['tool_use', 'tool_result', 'text', 'unknown'];
const DASH = '—';   // em dash -- absence, not a guess

const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// Strict: `Number(null)` is 0, and 0 is a confident wrong answer.
const isCount = v => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function emptyLog() {
  return {
    open: false, agent: null, waiting: false,
    source: null, reason: null,
    entries: [], dropped: 0, unknown: 0, skippedBytes: 0,
    running: false, done: false, tracked: true,
    render: 'rebuild', added: 0,
  };
}

/** The model for a log that was just asked for: nothing has arrived yet. */
function openLog(agent) {
  return { ...emptyLog(), open: true, agent, waiting: true };
}

function closeLog() {
  return emptyLog();
}

// A junk entry is KEPT as an unknown one: dropping it would be the silent loss
// the host went out of its way not to commit.
function normalizeEntry(e) {
  if (!isObject(e)) return { ts: null, kind: 'unknown', name: 'entry', summary: '', error: false };
  return {
    ts: typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : null,
    kind: KINDS.includes(e.kind) ? e.kind : 'unknown',
    name: typeof e.name === 'string' ? e.name : '',
    summary: typeof e.summary === 'string' ? e.summary : '',
    error: e.error === true,
  };
}

/**
 * Fold one frame into the model. Anything that is not a well-formed frame for
 * the log that is open returns the model itself, untouched: a late frame for an
 * agent that was closed, or a malformed one, must not redraw anything.
 */
function applyFrame(model, frame) {
  if (!model || !model.open) return model;
  if (!isObject(frame) || frame.type !== 'agent-log' || frame.agent !== model.agent) return model;

  if (frame.source === null) {
    return {
      ...model, waiting: false, source: null, render: 'rebuild', added: 0,
      reason: typeof frame.reason === 'string' && frame.reason ? frame.reason : 'no-transcript',
      entries: [], dropped: 0, unknown: 0, skippedBytes: 0,
      running: frame.running === true, done: false,
    };
  }
  if (typeof frame.source !== 'string' || !frame.source) return model;

  const reset = frame.reset === true || frame.source !== model.source;
  const fresh = (Array.isArray(frame.entries) ? frame.entries : []).map(normalizeEntry);
  let entries = (reset ? [] : model.entries).concat(fresh);
  let dropped = reset ? 0 : model.dropped;
  let capped = false;
  if (entries.length > MAX_ENTRIES) {
    dropped += entries.length - MAX_ENTRIES;
    entries = entries.slice(entries.length - MAX_ENTRIES);
    capped = true;
  }
  // HOW THE WINDOW SHOULD DRAW THIS, so it never rebuilds what it can extend:
  // a rebuild throws away the reader's text selection (Miguel M3, PR #63 -- a
  // live log could not have a command copied out of it, being redrawn every
  // tick). Rows are only ever APPENDED to a list that is already on screen;
  // anything that changes what is above the last row -- a reset, a cap drop, a
  // first row replacing the "empty so far" line, a different source, an
  // absence before it -- is a rebuild.
  const onScreen = !model.waiting && model.source === frame.source && model.entries.length > 0;
  const render = reset || capped || !onScreen ? 'rebuild' : fresh.length > 0 ? 'append' : 'status';
  return {
    ...model, waiting: false, source: frame.source, reason: null,
    render, added: render === 'append' ? fresh.length : 0,
    entries, dropped,
    unknown: isCount(frame.unknown) ? frame.unknown : (reset ? 0 : model.unknown),
    // How much of the transcript's START the host did not send (it opens a big
    // one at its end). Distinct from `dropped`, which is entries this window
    // itself pushed out past its cap.
    skippedBytes: isCount(frame.skippedBytes) ? frame.skippedBytes : (reset ? 0 : model.skippedBytes),
    running: frame.running === true,
    done: frame.done === true,
    // Only an explicit `false` marks a run this host does not track (a
    // transcript picked by name): its status is "latest run", never "finished".
    tracked: frame.tracked !== false,
  };
}

const KIND_LABEL = { tool_use: 'call', tool_result: 'result', text: 'say', unknown: '?' };

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function timeOf(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return DASH;
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function absenceText(agent, reason) {
  switch (reason) {
    case 'no-transcript': return `no transcript found for ${agent}`;
    case 'unidentified': return `${agent} is running but hasn't said which run it is yet, so its transcript can't be picked out`;
    case 'pending': return `${agent} is running, but its transcript isn't written yet`;
    case 'unreadable': return `couldn't read the transcript for ${agent}`;
    default: return `no transcript available for ${agent} (${reason})`;
  }
}

function entryHtml(e) {
  const label = e.kind === 'tool_result' && e.error ? 'error' : KIND_LABEL[e.kind];
  const cls = `alog-entry alog-${e.kind}${e.error ? ' alog-error' : ''}`;
  return `<div class="${cls}">` +
    `<span class="alog-time">${escapeHtml(timeOf(e.ts))}</span>` +
    `<span class="alog-kind">${label}</span>` +
    `<span class="alog-name">${escapeHtml(e.name)}</span>` +
    `<span class="alog-sum" title="${escapeHtml(e.summary)}">${escapeHtml(e.summary)}</span>` +
    `</div>`;
}

function basename(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? p : p.slice(i + 1);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function plural(n, one, many) { return n === 1 ? one : many; }

/** The status word beside the agent's name: '' when there is no transcript. */
function statusText(model) {
  if (!model || !model.open || model.source === null) return '';
  return model.running ? 'live' : model.done ? 'finished' : model.tracked === false ? 'latest run' : 'reading';
}

/** The rows for these entries (also what an append adds). */
function renderRows(entries) {
  return entries.map(entryHtml).join('');
}

/** The notes above the rows (what is not shown, what is unrecognised), as HTML. */
function renderNotes(model) {
  const notes = [];
  if (model.skippedBytes > 0) {
    notes.push(`the first ${formatBytes(model.skippedBytes)} of this transcript are not shown`);
  }
  if (model.dropped > 0) {
    notes.push(`${model.dropped} earlier ${plural(model.dropped, 'entry', 'entries')} not shown`);
  }
  if (model.unknown > 0) {
    notes.push(`${model.unknown} ${plural(model.unknown, 'line', 'lines')} of a kind this view cannot show as a call or message (dimmed)`);
  }
  return notes.map(n => `<div class="alog-note">${escapeHtml(n)}</div>`).join('');
}

/** The log panel's HTML, or '' when no log is open. */
function renderAgentLog(model) {
  if (!model || !model.open) return '';
  const agent = String(model.agent);

  const head =
    `<div class="alog-head">` +
      `<button type="button" class="alog-close" data-agent-log-close title="Close the log">&larr;</button>` +
      `<span class="alog-title" title="${escapeHtml(agent)}">${escapeHtml(agent)}</span>` +
      `<span class="alog-status">${statusText(model)}</span>` +
    `</div>`;

  if (model.waiting) {
    return head + `<div class="alog-body"><div class="alog-none">waiting for the host…</div></div>`;
  }
  if (model.source === null) {
    return head + `<div class="alog-body"><div class="alog-none">${escapeHtml(absenceText(agent, model.reason))}</div></div>`;
  }

  const src = `<div class="alog-src" title="${escapeHtml(model.source)}">${escapeHtml(basename(model.source))}</div>`;
  const rows = model.entries.length === 0
    ? `<div class="alog-none">the transcript is empty so far</div>`
    : renderRows(model.entries);
  return head + src +
    `<div class="alog-body"><div class="alog-notes">${renderNotes(model)}</div><div class="alog-rows">${rows}</div></div>`;
}

/**
 * Should a re-render keep the view pinned to the bottom? True unless the reader
 * has scrolled up. Called with the scroller's metrics BEFORE the re-render.
 * Nothing measured (a first render, a NaN) means the reader has not scrolled
 * anywhere, so: follow.
 */
function shouldFollow(metrics) {
  if (!isObject(metrics)) return true;
  const { scrollTop, clientHeight, scrollHeight } = metrics;
  if (![scrollTop, clientHeight, scrollHeight].every(v => typeof v === 'number' && Number.isFinite(v))) return true;
  return scrollHeight - scrollTop - clientHeight <= FOLLOW_SLACK_PX;
}

/**
 * Draw `model` into `el`, extending what is on screen when the model says it can
 * (`model.render`), and rebuilding otherwise. Returns which it did.
 *
 * Only APPENDING keeps the reader's text selection alive: setting innerHTML on
 * a container replaces every node in it. `data-count` on the rows container is
 * how many rows are on screen, checked before an append so a repeated or
 * missed paint rebuilds instead of duplicating or losing rows.
 *
 * Scroll: pinned to the bottom if the reader was at (or near) it BEFORE this
 * paint, otherwise left where they put it.
 */
function paint(el, model) {
  const body = el.querySelector('.alog-body');
  const follow = shouldFollow(body
    ? { scrollTop: body.scrollTop, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight }
    : null);
  const keep = body ? body.scrollTop : 0;

  let how = 'rebuild';
  const rows = el.querySelector('.alog-rows');
  const canExtend = model && model.open && body && rows &&
    (model.render === 'append' || model.render === 'status') &&
    Number(rows.dataset.count) === model.entries.length - (model.render === 'append' ? model.added : 0);
  if (canExtend) {
    how = model.render;
    if (how === 'append') {
      rows.insertAdjacentHTML('beforeend', renderRows(model.entries.slice(model.entries.length - model.added)));
      rows.dataset.count = String(model.entries.length);
    }
    const status = el.querySelector('.alog-status');
    if (status && status.textContent !== statusText(model)) status.textContent = statusText(model);
    const notes = el.querySelector('.alog-notes');
    const html = renderNotes(model);
    if (notes && notes.dataset.sig !== html) { notes.innerHTML = html; notes.dataset.sig = html; }
  } else {
    el.innerHTML = renderAgentLog(model);
    const fresh = el.querySelector('.alog-rows');
    if (fresh) fresh.dataset.count = String(model.entries.length);
    const notes = el.querySelector('.alog-notes');
    if (notes) notes.dataset.sig = renderNotes(model);
  }

  const after = el.querySelector('.alog-body');
  if (after) after.scrollTop = follow ? after.scrollHeight : keep;
  return how;
}

const api = {
  paint, emptyLog, openLog, closeLog, applyFrame, renderAgentLog, renderRows, renderNotes, statusText,
  shouldFollow, MAX_ENTRIES, FOLLOW_SLACK_PX,
};

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.agentLogDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
