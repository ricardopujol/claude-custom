'use strict';
/**
 * The Home window's card list (documentation/DESIGN_PROJECT_HUB.md §3; plan documentation/PLAN_PROJECT_HUB.md H-PR1). Pure: every
 * fact that needs the disk (projectOf, exists, keyOf = normPath) is handed in.
 *
 *   homeCards({ record, recents, windows, windowless, filter, projectOf, exists, keyOf, labelOf }) -> { cards, summary }
 *
 *   record      app/home-record.js read(): { projects: [{ root, lastOpened }], pins: [root], removed: [root] }
 *   recents     host/recent.js rows [{ path, approximate, lastUsed }] (Claude Code's history), or null
 *   windows     this process's project windows: [{ root, label, tabs, needs, lanes: [{ key, label, path, needs }] }]
 *   windowless  sessions with no window: [{ cwd }]
 *
 * One card per project: every path is folded to its project root by projectOf (a path it cannot place is its own root), and roots
 * are compared by keyOf. The card's root is spelled as its first source spells it (a window, then the record, then the rest).
 *
 *   state    'open' (a window here) | 'windowless' (sessions, no window) | 'closed'
 *   actions  open: go-to, close-window · windowless: open, stop-sessions · closed: open; then pin | unpin, show-in-explorer,
 *            new-lane; and remove only on a card that is not live (a live project always shows: Remove would not hold)
 *
 * Left out: a root whose folder is gone, and a removed root, unless the project is live (a window must stay reachable from Home).
 * Every number is strict (`typeof`): `Number(null)` is 0, and an absence is never shown as a zero.
 */

/** A time is a strict positive finite number, or no time at all (`Number(null)` is 0: never coerce). */
const timeOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const countOf = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const later = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));
const listOf = (v) => (Array.isArray(v) ? v : []);
const isPath = (p) => typeof p === 'string' && p !== '';

function actionsOf(state, pinned) {
  const lead = state === 'open' ? ['go-to', 'close-window'] : state === 'windowless' ? ['open', 'stop-sessions'] : ['open'];
  return [...lead, pinned ? 'unpin' : 'pin', 'show-in-explorer', 'new-lane', ...(state === 'closed' ? ['remove'] : [])];
}

function homeCards({ record, recents, windows, windowless, filter, projectOf, exists, keyOf, labelOf } = {}) {
  const rootOf = (p) => {
    try {
      const pr = projectOf(p);
      return pr && isPath(pr.root) ? pr.root : p;
    } catch { return p; }
  };
  const there = (p) => { try { return exists(p) === true; } catch { return false; } };
  const byKey = new Map();
  const entry = (root) => {
    const key = keyOf(root);
    if (key === null) return null;
    let e = byKey.get(key);
    if (!e) {
      e = { key, root, lastUsed: null, lanes: new Map(), window: null, sessions: 0 };
      byKey.set(key, e);
    }
    return e;
  };
  const keySet = (list) => new Set(listOf(list).filter(isPath).map((p) => keyOf(p)).filter((k) => k !== null));

  for (const w of listOf(windows)) {
    if (!w || !isPath(w.root)) continue;
    const e = entry(w.root);
    if (e && e.window === null) e.window = w;
  }
  const rec = record && typeof record === 'object' ? record : {};
  for (const p of listOf(rec.projects)) {
    if (!p || !isPath(p.root)) continue;
    const e = entry(rootOf(p.root));
    if (e) e.lastUsed = later(e.lastUsed, timeOf(p.lastOpened));
  }
  for (const s of listOf(windowless)) {
    if (!s || !isPath(s.cwd)) continue;
    const e = entry(rootOf(s.cwd));
    if (e) e.sessions += 1;
  }
  for (const r of listOf(recents)) {
    if (!r || r.approximate === true || !isPath(r.path)) continue;
    const e = entry(rootOf(r.path));
    if (!e) continue;
    e.lastUsed = later(e.lastUsed, timeOf(r.lastUsed));
    const laneKey = keyOf(r.path);
    if (laneKey !== null && laneKey !== e.key && !e.lanes.has(laneKey)) {
      e.lanes.set(laneKey, { key: laneKey, label: labelOf(r.path), path: r.path, needs: false });
    }
  }

  const pins = keySet(rec.pins);
  const removed = keySet(rec.removed);
  const cards = [];
  for (const e of byKey.values()) {
    const state = e.window !== null ? 'open' : e.sessions > 0 ? 'windowless' : 'closed';
    if (state === 'closed' && (removed.has(e.key) || !there(e.root))) continue;
    const pinned = pins.has(e.key);
    const w = e.window;
    const lanes = w === null ? [...e.lanes.values()] : listOf(w.lanes).filter((l) => l && isPath(l.path)).map((l) => ({
      key: keyOf(l.path), label: typeof l.label === 'string' && l.label ? l.label : labelOf(l.path), path: l.path, needs: l.needs === true,
    }));
    cards.push({
      key: e.key, root: e.root, label: labelOf(e.root), pinned, state,
      tabs: w === null ? null : countOf(w.tabs),
      needs: w === null ? 0 : (countOf(w.needs) || 0),
      sessions: state === 'windowless' ? e.sessions : null,
      lastUsed: e.lastUsed, lanes, actions: actionsOf(state, pinned),
    });
  }
  cards.sort(byOrder);
  const text = typeof filter === 'string' ? filter.trim().toLowerCase() : '';
  const shown = text === '' ? cards
    : cards.filter((c) => c.label.toLowerCase().includes(text) || c.root.toLowerCase().includes(text));
  const summary = {
    open: cards.filter((c) => c.state === 'open').length,
    needs: cards.reduce((n, c) => n + c.needs, 0),
    total: cards.length, shown: shown.length,
  };
  return { cards: shown, summary };
}

/**
 * H7: pinned first, then the most recent (no time last), then the key, so the order is total and stable. Nothing live is read here:
 * a card that needs you does not move (its border shows it), and the property tests hold that.
 */
function byOrder(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.lastUsed !== b.lastUsed) {
    if (a.lastUsed === null) return 1;
    if (b.lastUsed === null) return -1;
    return b.lastUsed - a.lastUsed;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

module.exports = { homeCards };
