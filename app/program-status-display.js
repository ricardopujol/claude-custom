'use strict';
/**
 * How the window shows the CLI's own state (OSC 7501, host/program-status.js). Decides nothing about the protocol;
 * the host parsed and stored it. This only turns the host's `program-status` frame into what the dots say.
 *
 *   hostListsProgramStatus(controls)  does the host's hello list `program-status` (an older host never sends it)
 *   clean(root)                       the root record as { state, kind, msg, progress }, or null: absence is never idle
 *   cueEvents(prev, next)             which tab-status.js pendingAfter events a change of root state means
 *   headerView(program)               { cls, title } for the header dot, or null
 *   stripDots({ working, needsInput, program })   [{ cls, title }]: the dots a tab on the strip draws
 *
 * `title` is a tooltip: the program's own words go there as plain text and never into chrome prose (a message is
 * somebody else's string; the callers set it with textContent / the title property).
 *
 * WRAPPED IN AN IIFE (the page loads this as a plain <script>, see app/usage-display.js). One name leaves it:
 * `programStatusDisplay`.
 */
(function (root_) {

const STATES = ['idle', 'working', 'done', 'blocked', 'error'];
const KINDS = ['permission', 'question', 'auth'];
const MSG_MAX = 300;

const hostListsProgramStatus = (controls) => Array.isArray(controls) && controls.includes('program-status');

function clean(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || !STATES.includes(r.state)) return null;
  return {
    state: r.state,
    kind: KINDS.includes(r.kind) ? r.kind : null,
    msg: typeof r.msg === 'string' && r.msg !== '' ? r.msg.slice(0, MSG_MAX) : null,
    // a strict check: Number(null) is 0, and "no progress" must not read as 0%
    progress: typeof r.progress === 'number' && Number.isInteger(r.progress) && r.progress >= 0 && r.progress <= 100 ? r.progress : null,
  };
}

const stateOf = (p) => (p && typeof p.state === 'string' ? p.state : null);

function cueEvents(prev, next) {
  const a = stateOf(prev);
  const b = stateOf(next);
  const out = [];
  if (b === 'working' && a !== 'working') out.push('working');
  // The need was answered: the CLI went back to work or rest. A `done` carries its own finished frame from the host.
  if ((a === 'blocked' || a === 'error') && (b === null || b === 'working' || b === 'idle')) out.push('answered');
  return out;
}

const withMsg = (head, p) => (p.msg ? `${head}\n${p.msg}` : head);

function describe(p) {
  switch (p.state) {
    case 'working': return typeof p.progress === 'number' ? `Working, ${p.progress}%` : 'Working';
    case 'blocked': return withMsg(p.kind ? `Needs your input (${p.kind})` : 'Needs your input', p);
    case 'error': return withMsg('Hit an error', p);
    case 'done': return withMsg('Done', p);
    default: return 'Idle';
  }
}

function headerView(program) {
  const p = clean(program);
  if (p === null || p.state === 'idle') return null;
  return { cls: `ps-${p.state}`, title: describe(p) };
}

function stripDots({ working, needsInput, program } = {}) {
  const p = clean(program);
  const dots = [];
  if (working === true) dots.push({ cls: 'working', title: p && p.state === 'working' ? describe(p) : 'Working' });
  if (needsInput === true) {
    const own = p && (p.state === 'blocked' || p.state === 'error');
    dots.push({ cls: own && p.state === 'error' ? 'needs error' : 'needs', title: own ? describe(p) : 'Needs your input' });
  } else if (p && p.state === 'done' && working !== true) {
    dots.push({ cls: 'done', title: describe(p) });
  }
  return dots;
}

const api = { hostListsProgramStatus, clean, cueEvents, headerView, stripDots };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root_.programStatusDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
