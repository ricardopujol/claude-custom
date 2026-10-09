'use strict';
/**
 * BACKLOG #76: the roster card's two names, the Role/Name toggle and the search
 * filter. Pure decisions only, drawn by renderer.js and tested without a DOM,
 * the same split as app/roster-tabs-display.js.
 *
 * ROLE is the agent's type ("code-reviewer"), PERSONA the name its description
 * gives it ("Miguel", host/roster-index.js). The toggle picks which one is big;
 * the other sits small beside it. An agent with no persona shows its role only,
 * in both modes: there is no second name to show, and none is invented.
 *
 * Wrapped in an IIFE and published as ONE name: renderer.html loads every
 * script into a single shared scope (test/renderer-scope.test.js).
 */

(function (root) {

const MODES = ['role', 'name'];

/** 'name' or 'role'; anything else (a missing, corrupt or old stored value) is the default, 'role'. */
function normalizeMode(v) {
  return v === 'name' ? 'name' : 'role';
}

function personaOf(entry) {
  return entry && typeof entry.persona === 'string' && entry.persona !== '' ? entry.persona : null;
}

/** `{ big, small }`: `small` is null when the agent has no persona. */
function cardNames(agent, entry, mode) {
  const persona = personaOf(entry);
  if (!persona) return { big: agent, small: null };
  return normalizeMode(mode) === 'name' ? { big: persona, small: agent } : { big: agent, small: persona };
}

/** Whether the agent matches a search query: role, persona or function text, ignoring case. A blank query matches all. */
function matches(agent, entry, query) {
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!q) return true;
  const fn = entry && typeof entry.fn === 'string' ? entry.fn : '';
  return [agent, personaOf(entry) || '', fn].some((s) => s.toLowerCase().includes(q));
}

/** What the roster says when the search finds nothing in the current tab. */
function emptyMessage(tab, query) {
  const here = tab === 'inactive' ? 'inactive' : 'active';
  const other = here === 'active' ? 'inactive' : 'active';
  return `No ${here} agent matches “${String(query == null ? '' : query).trim()}”. Try the ${other} tab.`;
}

const api = { MODES, normalizeMode, cardNames, matches, emptyMessage };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.rosterSearchDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
