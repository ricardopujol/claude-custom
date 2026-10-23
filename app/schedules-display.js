'use strict';
/**
 * The Schedules panel (BACKLOG #119 A7): what will run, when, from which session. Pure decisions and HTML strings; renderer.js wires the
 * click and the frames. The list itself is the host's (host/schedules.js buildView, one entry per session, grouped Next hour /
 * Tonight / Later / Recurring); this file only draws it.
 *
 * READ-ONLY IN v1. The session owns its schedule (a wakeup is its model's call, a cron job its CLI's), so the only action is a click on
 * a row, which selects that session's tab. The hover says so.
 *
 * Everything a session says (its label, its folder, a prompt, a reason) is somebody else's string and is escaped. The one link, to the
 * cloud Routines page, is a constant here: a payload can't point it somewhere else (clickTarget refuses any other address).
 *
 * WRAPPED IN AN IIFE, and that is not style: the renderer loads every script as a plain <script> tag sharing ONE global scope
 * (CLAUDE.md, the first trap). One name leaves it: `schedulesDisplay`.
 */

(function (root) {

const ROUTINES_URL = 'https://claude.ai/code';
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ESCAPES[c]);
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * `{ view, oldHost }`: the host's last list, or null until a host has sent one (an older host never does: "not heard", not "nothing").
 * `oldHost`: the hello of a host that does not list the `schedules` control type (hosts outlive app updates).
 */
const emptyState = () => ({ view: null, oldHost: false });

const validView = (v) => isObj(v) && Array.isArray(v.groups);

/**
 * Does this host's hello list the control type? A page sends a control frame ONLY to a host that does: an older one would type it into the
 * session's prompt as JSON (the PR #140 rule every panel follows; PR #200 Dexter 1).
 */
const hostLists = (controls) => Array.isArray(controls) && controls.includes('schedules');

/** The frame that asks a host for the current list, or null when it must not be sent. */
const requestMsg = (controls) => (hostLists(controls) ? { type: 'schedules' } : null);

/** hello carries `schedules` and `controls`; every change is `{ type: 'schedules', schedules }`. Anything else leaves the state as it is. */
function reduce(state, msg) {
  if (!isObj(msg) || (msg.type !== 'hello' && msg.type !== 'schedules')) return state;
  if (msg.type === 'hello') {
    const view = validView(msg.schedules) ? msg.schedules : null;
    return { view, oldHost: !hostLists(msg.controls) && view === null };
  }
  if (!validView(msg.schedules)) return state;
  return { view: msg.schedules, oldHost: false };
}

/** The hover: the capped prompt, the reason, and where the schedule is owned. Built here so the prompt crosses the wire once. */
function hoverOf(r) {
  return [isStr(r.promptFull) ? r.promptFull : '', isStr(r.reason) && r.reason !== '' ? `Why: ${r.reason}` : '',
    'The session owns its schedule: cancel or change it there.'].filter(Boolean).join('\n\n');
}

function rowHtml(r) {
  if (!isObj(r)) return '';
  const cwd = isStr(r.cwd) && r.cwd !== '' ? r.cwd : null;
  const kind = ['wakeup', 'loop', 'bedtime', 'cron'].includes(r.kind) ? r.kind : 'wakeup';
  const isGone = r.ended === true;
  const parts = [
    `<span class="sched-when">${esc(isStr(r.whenText) ? r.whenText : '')}</span>`,
    isStr(r.nextText) && r.nextText !== '' ? `<span class="sched-next">${esc(r.nextText)}</span>` : '',
    `<span class="sched-chip sched-kind-${kind}">${kind}</span>`,
    `<span class="sched-what">${esc(isStr(r.promptLine) ? r.promptLine : '')}</span>`,
    isStr(r.detail) && r.detail !== '' ? `<span class="sched-detail">${esc(r.detail)}</span>` : '',
    isStr(r.reason) && r.reason !== '' ? `<span class="sched-reason">${esc(r.reason)}</span>` : '',
    `<span class="sched-session">${esc(isStr(r.session) ? r.session : '')}</span>`,
    isGone ? `<span class="sched-gone">${esc(isStr(r.endedText) && r.endedText !== '' ? r.endedText : 'session ended')}</span>` : '',
  ].join('');
  const attrs = [
    'type="button"', 'class="sched-btn"', `data-sched-key="${esc(isStr(r.key) ? r.key : '')}"`, `data-sched-id="${esc(isStr(r.id) ? r.id : '')}"`,
    cwd ? `data-sched-cwd="${esc(cwd)}"` : '', `title="${esc(hoverOf(r))}"`, cwd ? '' : 'disabled',
  ].filter(Boolean).join(' ');
  return `<li class="sched-row${isGone ? ' sched-ended' : ''}"><button ${attrs}>${parts}</button></li>`;
}

function footerHtml() {
  return `<p class="sched-foot">Routines on <a href="#" data-sched-link="${ROUTINES_URL}" title="Open ${ROUTINES_URL} in your browser">claude.ai/code</a> run in the cloud and are not listed here.</p>`;
}

/** The panel's inner markup. */
function html(state) {
  const view = state && validView(state.view) ? state.view : null;
  if (view === null) {
    if (state && state.oldHost === true) return `<p class="sched-old">This session's host predates Schedules: restart it to see its schedule.</p>${footerHtml()}`;
    return `<p class="sched-wait">waiting for the host…</p>${footerHtml()}`;
  }
  const groups = view.groups.filter(g => isObj(g) && Array.isArray(g.rows) && g.rows.length > 0);
  if (groups.length === 0) return `<p class="sched-empty">Nothing scheduled. Wakeups, loops, bedtime nights and cron jobs from every session show here.</p>${footerHtml()}`;
  const body = groups.map(g => `<section class="sched-group" data-sched-group="${esc(isStr(g.id) ? g.id : '')}"><h3 class="sched-head">${esc(isStr(g.label) ? g.label : '')}</h3><ul class="sched-list">${g.rows.map(rowHtml).join('')}</ul></section>`).join('');
  return body + footerHtml();
}

/** The rail icon's count: live rows in the next hour. Absence (no list yet, junk) is 0, never a made-up number. */
function badge(state) {
  const n = state && isObj(state.view) ? state.view.nextHour : null;
  return isNum(n) && n > 0 ? Math.floor(n) : 0;
}

const badgeText = (n) => (!isNum(n) || n <= 0 ? '' : n > 99 ? '99+' : String(Math.floor(n)));

/** What a click on the panel means: select a session's tab, open our one link, or nothing. `target` is the DOM event's target. */
function clickTarget(target) {
  if (!target || typeof target.closest !== 'function') return null;
  const link = target.closest('[data-sched-link]');
  if (link) return link.dataset && link.dataset.schedLink === ROUTINES_URL ? { kind: 'link', url: ROUTINES_URL } : null;
  const row = target.closest('[data-sched-cwd]');
  const where = row && row.dataset ? row.dataset.schedCwd : null;
  return isStr(where) && where !== '' ? { kind: 'select', folder: where } : null;
}

const API = { emptyState, reduce, hostLists, requestMsg, html, badge, badgeText, clickTarget, ROUTINES_URL };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.schedulesDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
