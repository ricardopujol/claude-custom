'use strict';
/**
 * The header's Profile chip, its menu and the switch decision (BACKLOG #119 A1).
 *
 * A tab runs under one account profile (host/profiles.js): the chip names it, a click lists the others, and picking one on a tab with a
 * live session ASKS first -- a session is never ended automatically. Pure like app/top-bar-display.js: inputs in, a render-ready shape
 * out, no DOM, no clock, no IPC. renderer.js owns the wiring.
 *
 * `profiles` is `[{ id, name, colour }]` as main reports it (the default first, `colour: null`). `currentId` is the profile the tab's
 * HOST reports it was started under (hello.profile), the truth, not what was last asked for.
 *
 * WRAPPED IN AN IIFE (plain <script>, ONE global scope: test/renderer-scope.test.js). One name leaves it: `profileDisplay`.
 */
(function (root) {

const DEFAULT_ID = 'default';
const HEX_RE = /^#[0-9a-f]{6}$/i;
const isString = (v) => typeof v === 'string';

function listOf(profiles) {
  return Array.isArray(profiles)
    ? profiles.filter(p => p && typeof p === 'object' && isString(p.id) && p.id !== '' && isString(p.name))
    : [];
}

const colourOf = (p) => (p && isString(p.colour) && HEX_RE.test(p.colour) ? p.colour : null);
const idOf = (id) => (isString(id) && id !== '' ? id : DEFAULT_ID);

function findIn(profiles, id) {
  return listOf(profiles).find(p => p.id === id) || null;
}

/** What the chip draws: `{ icon, id, name, colour, known, title }`. An id the list lacks is named as it is, flagged, and uncoloured. */
function chipView({ profiles, currentId } = {}) {
  const id = idOf(currentId);
  const found = findIn(profiles, id);
  if (found) {
    return {
      icon: 'user', id, name: found.name, colour: colourOf(found), known: true,
      title: `Account profile: ${found.name}. Click to switch this tab.`,
    };
  }
  if (id === DEFAULT_ID) {
    return { icon: 'user', id, name: 'Default', colour: null, known: true, title: 'Account profile: Default. Click to switch this tab.' };
  }
  return {
    icon: 'user', id, name: id, colour: null, known: false,
    title: `This session was started under "${id}", which is no longer in your profiles. Click to switch this tab.`,
  };
}

/** The menu: one row per profile (the current one marked), then the "Manage profiles…" entry. */
function menuView({ profiles, currentId } = {}) {
  const id = idOf(currentId);
  const list = listOf(profiles);
  const rows = (list.some(p => p.id === DEFAULT_ID) ? list : [{ id: DEFAULT_ID, name: 'Default', colour: null }, ...list])
    .map(p => ({ id: p.id, name: p.name, colour: colourOf(p), current: p.id === id }));
  return { rows, manageLabel: 'Manage profiles…' };
}

/**
 * What picking `pickedId` does. `none`: it is already the profile. `set`: no session yet, just remember it. `confirm`: a live session
 * would restart, so the person is asked first (`text` is the question). `refuse`: not a profile we know.
 */
function planSwitch({ profiles, currentId, pickedId, sessionLive } = {}) {
  if (!isString(pickedId) || pickedId === '') return { action: 'refuse', reason: 'no profile picked' };
  const picked = pickedId === DEFAULT_ID ? { id: DEFAULT_ID, name: 'Default' } : findIn(profiles, pickedId);
  if (!picked) return { action: 'refuse', reason: `no profile "${pickedId}"` };
  if (pickedId === idOf(currentId)) return { action: 'none' };
  if (sessionLive !== true) return { action: 'set', id: pickedId };
  return { action: 'confirm', id: pickedId, text: `Restart this session as ${picked.name}? The current session keeps its transcript.` };
}

/** The small coloured dot on a tab: `{ colour, name }`, or null for the default, an unknown profile, or one with no colour. */
function tabDot({ profiles, profileId } = {}) {
  if (!isString(profileId) || profileId === '' || profileId === DEFAULT_ID) return null;
  const p = findIn(profiles, profileId);
  const colour = colourOf(p);
  return p && colour ? { colour, name: p.name } : null;
}

// Lucide "user" (ISC; the licence text is kept in app/rail-icons.js), inline so nothing is fetched. Constant markup: no user data goes in.
const USER_ICON = '<svg class="tb-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>';
const userIconSvg = () => USER_ICON;

const api = { chipView, menuView, planSwitch, tabDot, userIconSvg };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.profileDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
