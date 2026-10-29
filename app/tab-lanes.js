'use strict';
/**
 * The decisions behind the tab strip's Lanes menu and its overflow (BACKLOG #139, #141;
 * documentation/DESIGN_TAB_STRIP.md, Ricardo's picks 1B and 2A), as pure functions so they can be tested and
 * property-tested without a window.
 *
 *   1B  A branch tab is on the strip only while its lane has a running session, or it is the selected tab. Every other
 *       lane (not started, merged, closed by hand) is a row in the Lanes menu: placeLanes.
 *   2A  Tabs shrink to MIN_TAB; the ones that still do not fit go to the same menu as "Hidden tabs", shown as +N. The
 *       selected tab and develop always stay: splitOverflow, capacityFor.
 *   Drag to reorder: develop is first and never moves; every other lane has a place in a saved order: applyOrder, moveKey.
 *
 * Entries are the strip model's (app/tab-model.js, as app/tab-shell.js fills them in): `{ key, label, isDev, selected,
 * started, starting, ended, phase, badge, setup, briefing, side, shell, parentKey }`. A side or shell tab (`side` /
 * `shell`, with a `parentKey`) is a companion: it follows its lane and is never a menu row of its own.
 *
 * WRAPPED IN AN IIFE (every plain <script> page shares one global scope). One name leaves it: `tabLanes`.
 */
(function (root) {

/** The narrowest a tab shrinks to (px), and so how many fit: floor(width / MIN_TAB). */
const MIN_TAB = 112;

const isString = s => typeof s === 'string';
const isEntry = e => !!e && typeof e === 'object' && isString(e.key);
const isCompanion = e => e.side === true || e.shell === true;
const MERGED_PHASES = ['finishing', 'kept'];

/** A session is running, starting, or the tab is being made ready: it keeps its tab. Only real `true`s count. */
function isRunning(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.starting === true) return true;
  if (e.started === true && e.ended !== true) return true;
  if (e.setup && typeof e.setup === 'object' && e.setup.running === true) return true;
  return e.briefing === true;
}

// A lane whose folder is going, or failed to go, has something to say on the strip; it can't slip into a menu quietly.
const needsEye = e => e.phase === 'removing' || e.badge === 'warn';

const rowOf = (e, state) => ({ key: e.key, label: isString(e.label) && e.label !== '' ? e.label : e.key, state, closed: false });

/**
 * placeLanes(entries, closedRows) -> { strip: entries[], menu: { notStarted: row[], merged: row[] } }
 * `closedRows` are the lanes closed by hand (`{ key, label }`), which are not entries at all. A row is
 * `{ key, label, state: 'not started' | 'ended' | 'merged' | 'closed', closed }`. Every entry is in `strip` or is a
 * menu row, exactly once; a closed row never repeats a lane that has an entry.
 */
function placeLanes(entries, closedRows) {
  const list = Array.isArray(entries) ? entries.filter(isEntry) : [];
  const hasCompanion = new Set(list.filter(isCompanion).map(e => e.parentKey));
  const onStrip = new Set();
  for (const e of list) {
    if (isCompanion(e)) continue;
    if (e.isDev === true || e.selected === true || isRunning(e) || needsEye(e) || hasCompanion.has(e.key)) onStrip.add(e.key);
  }
  const strip = [];
  const notStarted = [];
  const merged = [];
  for (const e of list) {
    if (isCompanion(e)) {
      if (onStrip.has(e.parentKey)) strip.push(e);
      continue;
    }
    if (onStrip.has(e.key)) { strip.push(e); continue; }
    if (MERGED_PHASES.includes(e.phase)) merged.push(rowOf(e, 'merged'));
    else notStarted.push(rowOf(e, e.started === true ? 'ended' : 'not started'));
  }
  const known = new Set(list.map(e => e.key));
  for (const c of Array.isArray(closedRows) ? closedRows : []) {
    if (!c || typeof c !== 'object' || !isString(c.key) || c.key === '' || known.has(c.key)) continue;
    known.add(c.key);
    notStarted.push({ key: c.key, label: isString(c.label) && c.label !== '' ? c.label : c.key, state: 'closed', closed: true });
  }
  return { strip, menu: { notStarted, merged } };
}

/** How many tabs fit in `width` px: whole MIN_TAB-wide ones, at least one. A width that isn't a number is no limit. */
function capacityFor(width, minTab = MIN_TAB) {
  if (typeof width !== 'number' || !Number.isFinite(width)) return Infinity;
  return Math.max(1, Math.floor(width / minTab));
}

/**
 * splitOverflow(stripEntries, capacity) -> { shown: entries[], hidden: laneEntries[] }
 * A lane and its companions are one unit (the units' sizes add up to the entries). Develop and the unit holding the
 * selected tab are always shown, whatever the capacity; the rest are shown from the left while they fit, and from the
 * first that doesn't, it and everything after it is hidden. `hidden` lists the LANES, so "+N" counts lanes.
 */
function splitOverflow(stripEntries, capacity) {
  const list = Array.isArray(stripEntries) ? stripEntries.filter(isEntry) : [];
  const cap = typeof capacity === 'number' && !Number.isNaN(capacity) ? capacity : Infinity;
  const units = [];
  const byLane = new Map();
  for (const e of list) {
    if (isCompanion(e) && byLane.has(e.parentKey)) { byLane.get(e.parentKey).entries.push(e); continue; }
    const u = { lane: e, entries: [e] };
    units.push(u);
    byLane.set(e.key, u);
  }
  const must = (u) => u.lane.isDev === true || u.entries.some(x => x.selected === true);
  let budget = cap - units.filter(must).reduce((n, u) => n + u.entries.length, 0);
  const shownUnits = new Set(units.filter(must));
  let full = false;
  for (const u of units) {
    if (must(u) || full) continue;
    if (u.entries.length <= budget) { budget -= u.entries.length; shownUnits.add(u); } else full = true;
  }
  const shown = [];
  const hidden = [];
  for (const u of units) {
    if (shownUnits.has(u)) shown.push(...u.entries); else hidden.push(u.lane);
  }
  return { shown, hidden };
}

/**
 * The items in saved order: those the order names first, in its order (a key it names twice, or that matches no item,
 * counts once or not at all); the rest after them, in the order they came. `keyOf(item)` names an item's key. Develop is
 * not this function's business: it stays first by the caller putting it there.
 */
function applyOrder(items, order, keyOf = (x) => x.key) {
  const list = Array.isArray(items) ? items : [];
  const rank = new Map();
  for (const k of Array.isArray(order) ? order : []) if (isString(k) && !rank.has(k)) rank.set(k, rank.size);
  const named = list.filter(x => rank.has(keyOf(x))).sort((a, b) => rank.get(keyOf(a)) - rank.get(keyOf(b)));
  return [...named, ...list.filter(x => !rank.has(keyOf(x)))];
}

/**
 * moveKey(order, key, beforeKey) -> the saved order with `key` moved to just before `beforeKey`, or to the end when
 * `beforeKey` is null or isn't in the order. A key the order doesn't have yet is added. Junk (a key that isn't a
 * non-empty string) moves nothing. The result never repeats a key.
 */
function moveKey(order, key, beforeKey) {
  const base = [];
  for (const k of Array.isArray(order) ? order : []) if (isString(k) && k !== '' && !base.includes(k)) base.push(k);
  if (!isString(key) || key === '') return base;
  if (key === beforeKey) return base.includes(key) ? base : [...base, key];
  const rest = base.filter(k => k !== key);
  const at = isString(beforeKey) ? rest.indexOf(beforeKey) : -1;
  if (at < 0) return [...rest, key];
  return [...rest.slice(0, at), key, ...rest.slice(at)];
}

/**
 * dropBefore(stripEntries, draggedKey, overKey, leftHalf) -> { ok: true, before: key | null } | { ok: false }
 * Where a dragged lane tab lands when dropped on the tab `overKey`: the left half drops before that lane, the right half
 * before the lane after it (null: the end). Over a companion counts as over its lane; over develop is "first of the
 * others" (before: develop's key, which the shell turns into that). Pass the WHOLE strip, hidden lanes included, so
 * "after the last tab you can see" lands before the first hidden one. Develop, a companion, a stranger, or a drop on the
 * tab itself is { ok: false }.
 */
function dropBefore(stripEntries, draggedKey, overKey, leftHalf) {
  const list = Array.isArray(stripEntries) ? stripEntries.filter(isEntry) : [];
  const lanes = list.filter(e => !isCompanion(e));
  const dragged = lanes.find(e => e.key === draggedKey);
  if (!dragged || dragged.isDev === true) return { ok: false };
  const over = list.find(e => e.key === overKey);
  const lane = over ? (isCompanion(over) ? lanes.find(e => e.key === over.parentKey) : over) : null;
  if (!lane || lane.key === dragged.key) return { ok: false };
  if (lane.isDev === true) return { ok: true, before: lane.key };
  if (leftHalf === true) return { ok: true, before: lane.key };
  const next = lanes[lanes.indexOf(lane) + 1];
  return { ok: true, before: next ? next.key : null };
}

/**
 * The keys that were on the strip and are not now, for the short fade: not the ones overflow merely moved into the
 * menu (`hiddenKeys`), because a window that got narrower is not a lane leaving.
 */
function leaving(prevKeys, nextKeys, hiddenKeys) {
  const keep = new Set([...(Array.isArray(nextKeys) ? nextKeys : []), ...(Array.isArray(hiddenKeys) ? hiddenKeys : [])]);
  return (Array.isArray(prevKeys) ? prevKeys : []).filter(k => !keep.has(k));
}

/**
 * The Lanes menu as plain rows for the native menu (main maps them to its template):
 * `{ type: 'header', label }` | `{ type: 'row', label, key, state, action: 'select' | 'reopen' }`. Hidden tabs first,
 * then Not started, then Merged; a group with nothing in it has no header.
 */
function lanesMenuRows(menu, hiddenEntries) {
  const m = menu && typeof menu === 'object' ? menu : {};
  const out = [];
  const group = (title, rows) => {
    if (rows.length === 0) return;
    out.push({ type: 'header', label: title });
    out.push(...rows);
  };
  const hidden = (Array.isArray(hiddenEntries) ? hiddenEntries : []).filter(isEntry)
    .map(e => ({ type: 'row', label: isString(e.label) && e.label !== '' ? e.label : e.key, key: e.key, state: 'running', action: 'select' }));
  const asRows = (rows) => (Array.isArray(rows) ? rows : []).filter(isEntry)
    .map(r => ({ type: 'row', label: isString(r.label) && r.label !== '' ? r.label : r.key, key: r.key, state: isString(r.state) ? r.state : '', action: r.closed === true ? 'reopen' : 'select' }));
  group('Hidden tabs', hidden);
  group('Not started', asRows(m.notStarted));
  group('Merged', asRows(m.merged));
  return out;
}

const api = { MIN_TAB, isRunning, placeLanes, capacityFor, splitOverflow, applyOrder, moveKey, dropBefore, leaving, lanesMenuRows };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.tabLanes = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
