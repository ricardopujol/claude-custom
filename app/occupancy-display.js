'use strict';
/**
 * What the live occupancy claims look like (backlog #44 + #47, documentation/DESIGN_WORKTREE_OCCUPANCY.md,
 * mock take B "hatched edge"). Pure: the strip, a tab's page and the hub's agent cards only draw what these
 * functions say. host/occupancy-service.js has already decided which claims are live.
 *
 *   tabOccupancy(claims, key, { keyOf, turn, now })  the strip's mark for one tab, or null
 *   bannerModel(here, { turn, now })                 the banner over a worktree's terminal, or null
 *   chipModel(here, { turn, now })                   the same facts as the terminal bar's chip (the banner
 *                                                    retired into it, backlog #49 + #52), or null
 *   cardLine(claims, agentName, sessionId)           the hub card's `-> worktree` line, or null
 *   viewPayload(claims, key, { keyOf })              what main pushes to one tab's page
 *   initials(name) / minutesLabel(firstAt, now)
 *
 * TRUTH RULES
 *   - Nothing claims a tab: null. Never an empty object a painter could mistake for "occupied".
 *   - The TWO-WRITERS warning is `turn === 'turn'` and nothing else (host/turn-state.js: 'idle' | 'turn' |
 *     'prompt'). An unknown turn, an idle one, or a dialog is not a warning: it only says what is known, and it
 *     never says a worktree is free (a worktree with a claim is occupied whatever the turn).
 *   - A clock only feeds the "4 min" label: a missing time, or one in the future, gives no label (null),
 *     never "0 min" and never a negative number.
 *   - Paths are compared by `keyOf` (the shell passes host/project-layout.js normPath), never as spelled.
 *   - Names are somebody else's strings: the painters set textContent, never innerHTML.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js): the tab pages load every script as a plain
 * <script> sharing ONE global scope. One name leaves it: `occupancyDisplay`.
 */
(function (root) {

const MIN = 60_000;
const TAGS_MAX = 3;
const SEP = ' · ';
const identity = p => p;
const isStr = s => typeof s === 'string' && s !== '';
const isClaim = c => !!c && typeof c === 'object' && isStr(c.agentId) && isStr(c.worktree);

function initials(name) {
  if (typeof name !== 'string') return '?';
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = w => Array.from(w)[0];
  const out = words.length === 1 ? Array.from(words[0]).slice(0, 2).join('') : first(words[0]) + first(words[1]);
  return out.toUpperCase();
}

function minutesLabel(firstAt, now) {
  if (typeof firstAt !== 'number' || !Number.isFinite(firstAt) || typeof now !== 'number' || !Number.isFinite(now)) return null;
  const ms = now - firstAt;
  if (ms < 0) return null;
  const m = Math.floor(ms / MIN);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

// One agent once, however many claims name it (the later `lastAt` speaks), in the order they arrived.
function distinctAgents(claims) {
  const by = new Map();
  for (const c of Array.isArray(claims) ? claims : []) {
    if (!isClaim(c)) continue;
    const seen = by.get(c.agentId);
    if (!seen || (Number.isFinite(c.lastAt) ? c.lastAt : 0) >= (Number.isFinite(seen.lastAt) ? seen.lastAt : 0)) by.set(c.agentId, c);
  }
  const at = c => (Number.isFinite(c.firstAt) ? c.firstAt : 0);
  return [...by.values()].sort((a, b) => (at(a) - at(b)) || (a.agentId < b.agentId ? -1 : 1));
}

const nameOf = c => (isStr(c.agent) ? c.agent : 'an agent');
// #81: an agent of a read-only side session is a reader. It is shown, and it is never an agent WORKING in the folder.
const isReader = c => c.role === 'reader';
const READING = 'reading only';

function lineFor(c, now) {
  const parts = [nameOf(c)];
  if (isStr(c.fromBranch)) parts.push(`from ${c.fromBranch}`);
  const since = minutesLabel(c.firstAt, now);
  if (since !== null) parts.push(since);
  if (isReader(c)) parts.push(READING);
  return parts.join(SEP);
}

const OWN_WRITING = "this tab's own session is writing too";

// `withAlso`: the close check also counts a folder the agent touched earlier, the same set known() doubts for an unprovable
// claim (PR #139 Dexter F4). The strip draws only where an agent works now.
function tabOccupancy(claims, key, { keyOf = identity, turn, now, withAlso = false } = {}) {
  const here = c => keyOf(c.worktree) === key ||
    (withAlso === true && Array.isArray(c.also) && c.also.some(a => isStr(a) && keyOf(a) === key));
  const mine = distinctAgents((Array.isArray(claims) ? claims : []).filter(c => isClaim(c) && here(c)));
  if (mine.length === 0) return null;
  // Only a writer can be the second one writing, and only a writer counts as "an agent working here".
  const writers = mine.filter(c => !isReader(c)).length;
  const warn = turn === 'turn' && writers > 0;
  const lines = mine.map(c => lineFor(c, now));
  if (warn) lines.push(OWN_WRITING);
  return {
    tags: mine.slice(0, TAGS_MAX).map(c => initials(c.agent)),
    more: Math.max(0, mine.length - TAGS_MAX),
    warn,
    lines,
    count: writers,
    readersOnly: writers === 0,
  };
}

function bannerModel(here, { turn, now } = {}) {
  const mine = distinctAgents(here).filter(c => !isReader(c));
  if (mine.length === 0) return null;
  const lead = mine[0];
  const others = mine.slice(1);
  const warn = turn === 'turn';
  const from = isStr(lead.fromBranch) ? ` (from ${lead.fromBranch})` : '';
  return {
    warn,
    text: `${nameOf(lead).replace(/^an agent$/, 'An agent')}${from} is working in this folder`,
    since: minutesLabel(lead.firstAt, now),
    more: others.length ? `+${others.length} ${others.map(nameOf).join(', ')}` : '',
    note: warn ? "This tab's own session is writing too." : '',
    jump: isStr(lead.fromRoot)
      ? { label: isStr(lead.fromBranch) ? `Jump to ${lead.fromBranch}` : 'Jump to its session', root: lead.fromRoot }
      : null,
  };
}

/**
 * The terminal bar's occupancy chip (documentation/DESIGN_TERMINAL_BAR.md): the agents' initials, one hover line
 * each (plus the two-writers line), the warning colour and where Jump goes. Built from the SAME pure pieces as the
 * strip's mark and the banner (distinctAgents, lineFor, bannerModel's jump), so the three never disagree.
 */
function chipModel(here, { turn, now } = {}) {
  const mine = distinctAgents(here).filter(c => !isReader(c));
  if (mine.length === 0) return null;
  const warn = turn === 'turn';
  const lines = mine.map(c => lineFor(c, now));
  if (warn) lines.push(OWN_WRITING);
  return {
    tags: mine.slice(0, TAGS_MAX).map(c => initials(c.agent)),
    more: Math.max(0, mine.length - TAGS_MAX),
    warn,
    lines,
    jump: bannerModel(here, { turn, now }).jump,
  };
}

// A windows-folder comparison good enough for "the same worktree twice" on a card, where the page has no
// project-layout: slashes, trailing separators and case folded away.
const fold = p => String(p).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
const baseName = p => {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
};

// A card is one session's agent: an agent NAME launched from this FOLDER can be another session's run (two sessions
// in `dev` each running an Explore), so the claim's session has to be the card's (backlog #57, PR #96 Dexter F5).
// A claim that names no session, or a card that doesn't know its own yet, can't be proven to be this card's: nothing.
function cardLine(claims, agentName, sessionId) {
  if (!isStr(agentName) || !isStr(sessionId) || !Array.isArray(claims)) return null;
  const mine = claims
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => isClaim(c) && c.agent === agentName && c.sessionId === sessionId)
    .sort((a, b) => ((Number.isFinite(b.c.lastAt) ? b.c.lastAt : 0) - (Number.isFinite(a.c.lastAt) ? a.c.lastAt : 0)) || (b.i - a.i))
    .map(({ c }) => c);
  if (mine.length === 0) return null;
  const places = [];
  const seen = new Set();
  for (const c of mine) {
    for (const w of [c.worktree, ...(Array.isArray(c.also) ? c.also.filter(isStr) : [])]) {
      if (!seen.has(fold(w))) { seen.add(fold(w)); places.push(w); }
    }
  }
  const latest = places[0];
  return {
    text: `→ ${baseName(latest)}`,
    plus: places.length - 1,
    root: latest,
    title: `${agentName} is working in ${latest}`,
  };
}

const PAGE_FIELDS = ['agentId', 'agent', 'worktree', 'also', 'fromBranch', 'fromRoot', 'sessionId', 'firstAt', 'lastAt'];
const forPage = (c) => {
  const out = {};
  for (const f of PAGE_FIELDS) out[f] = f === 'also' ? (Array.isArray(c.also) ? c.also.filter(isStr) : []) : (c[f] === undefined ? null : c[f]);
  if (isReader(c)) out.role = 'reader';     // only a reader carries it: a writer's page payload is what it always was
  if (Number.isFinite(c.wroteAt)) out.wroteAt = c.wroteAt;     // the Map's conflict edge: when this worktree was last written to (absent: the claim is a read)
  return out;
};

function viewPayload(claims, key, { keyOf = identity } = {}) {
  const list = (Array.isArray(claims) ? claims : []).filter(isClaim);
  return {
    here: list.filter(c => keyOf(c.worktree) === key).map(forPage),
    launched: list.filter(c => isStr(c.fromRoot) && keyOf(c.fromRoot) === key).map(forPage),
  };
}

const api = { initials, minutesLabel, tabOccupancy, bannerModel, chipModel, cardLine, viewPayload, TAGS_MAX, OWN_WRITING };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.occupancyDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
