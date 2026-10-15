'use strict';
/**
 * Drop zones as pure geometry (BACKLOG #53, dockable panels D1): while a panel
 * is dragged by its tab, which zones to light and which one is under the
 * pointer. Pointer events rather than HTML5 drag-and-drop, because the overlay
 * (and later the keyboard move mode) need the same hit rules and HTML5 drag
 * gives no control over them.
 *
 * Pure. app/renderer.js only feeds it the boxes `fit` drew and the pointer, and
 * draws what comes back; every rule about WHERE a drop lands lives here.
 */

/*
 * WRAPPED IN AN IIFE: the renderer loads this as a plain <script> sharing one
 * global scope (test/renderer-scope.test.js). The page sees one name, `dockDrag`.
 */
(function (root) {

const RIM = 14;            // px along each window edge: dock along that whole edge
const BAND = 0.28;         // a cell's side bands, as a share of its body
const TAB_BAR = 26;        // a group's tab bar: dropping on it joins the group

const dim = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const isNumber = v => typeof v === 'number' && Number.isFinite(v);
const area = r => r.width * r.height;
const contains = (r, p) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

// The window's rim. Top and bottom run the full width and the sides sit between them, so no two
// rim zones share a pixel (a corner is the top or bottom edge's); in a window too small for 14 px
// on both sides each strip gets half. Always listed, even when it has no area.
function rimZones(width, height) {
  const t = Math.min(RIM, Math.floor(height / 2));
  const l = Math.min(RIM, Math.floor(width / 2));
  return [
    { rect: { x: 0, y: 0, width, height: t }, target: { edge: 'top' } },
    { rect: { x: 0, y: height - t, width, height: t }, target: { edge: 'bottom' } },
    { rect: { x: 0, y: t, width: l, height: height - 2 * t }, target: { edge: 'left' } },
    { rect: { x: width - l, y: t, width: l, height: height - 2 * t }, target: { edge: 'right' } },
  ];
}

// A cell cut into a tab bar (groups only), four 28% bands and a middle. The middle joins a group;
// on the terminal it is the float zone (D2).
function cellZones(box, tabBar) {
  const { rect } = box;
  const isGroup = box.kind === 'group';
  const cell = isGroup ? box.id : 'term';
  const head = isGroup ? Math.min(tabBar, rect.height) : 0;
  const top = rect.y + head;
  const bodyH = rect.height - head;
  const bandH = Math.round(bodyH * BAND);
  const bandW = Math.round(rect.width * BAND);
  const midH = bodyH - 2 * bandH;
  const zone = (x, y, width, height, side) => ({ rect: { x, y, width, height }, target: { cell, side } });
  const zones = [
    zone(rect.x, rect.y, rect.width, head, 'center'),
    zone(rect.x, top, rect.width, bandH, 'top'),
    zone(rect.x, top + bodyH - bandH, rect.width, bandH, 'bottom'),
    zone(rect.x, top + bandH, bandW, midH, 'left'),
    zone(rect.x + rect.width - bandW, top + bandH, bandW, midH, 'right'),
  ];
  const middle = zone(rect.x + bandW, top + bandH, rect.width - 2 * bandW, midH, 'center');
  // A group's middle joins it as a tab; the terminal's middle floats the panel (the page fills in where).
  zones.push(isGroup ? middle : { rect: middle.rect, target: { float: true } });
  return zones.filter(z => area(z.rect) > 0);
}

const hasRect = b => !!b && typeof b === 'object' && !!b.rect;
const isCell = b => hasRect(b) && (b.kind === 'term' || b.kind === 'group');

/**
 * @param boxes    `fit`'s boxes
 * @param viewport { width, height } of the area the boxes fill
 * @param point    { x, y } of the pointer, relative to that area
 * @param opts     { tabBar } a group's tab bar height in px
 * @returns { zones: [{ rect, target, hot }], target } -- the rim is always listed; over a cell, that
 *          cell's zones too; `target` is the hot zone's, or null (over a rail, a gutter, nothing, or
 *          outside the window).
 */
function zonesAt(boxes, viewport, point, { tabBar = TAB_BAR, exclude = null } = {}) {
  const vp = viewport && typeof viewport === 'object' ? viewport : {};
  const width = dim(vp.width);
  const height = dim(vp.height);
  const barPx = isNumber(tabBar) && tabBar >= 0 ? tabBar : TAB_BAR;
  const p = point && isNumber(point.x) && isNumber(point.y) ? point : null;
  const zones = rimZones(width, height);
  let floatZone = null;
  if (p && contains({ x: 0, y: 0, width, height }, p)) {
    const list = Array.isArray(boxes) ? boxes : [];
    // Floats are drawn after the tree, bottom to top, so the LAST one under the pointer is the visible one. Only
    // "join as a tab" is on offer over it (the whole box); the float being dragged by a tab is no target.
    const float = [...list].reverse().find(b => hasRect(b) && b.kind === 'float' && b.id !== exclude && contains(b.rect, p));
    if (float) {
      floatZone = { rect: { ...float.rect }, target: { cell: float.id, side: 'center' } };
      zones.push(floatZone);
    } else {
      const under = list.find(b => isCell(b) && contains(b.rect, p));
      if (under) zones.push(...cellZones(under, barPx));
    }
  }
  // The rim comes first in the list, so it wins over a cell's band. A float under the pointer wins over the
  // rim too (PR #102 Dexter 7): you drop on what you see on top, and a float pushed flush against an edge
  // would otherwise be un-joinable along its outermost 14 px.
  const hot = !p ? null : (floatZone || zones.find(z => contains(z.rect, p)));
  return { zones: zones.map(z => ({ ...z, hot: z === hot })), target: hot ? hot.target : null };
}

// --- the keyboard move mode (D4) ----------------------------------------------------------------
//
// The tab's menu has *Move*: the zones of one cell light, the arrow keys step to the next zone (and across to the next
// cell), Enter drops, Esc cancels. It walks the very zones the pointer lights, from the same boxes, so a panel that can
// be dragged somewhere can be moved there without a mouse.

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isTerm = b => hasRect(b) && b.kind === 'term';
const sameTarget = (a, b) => isObject(a) && isObject(b) && a.edge === b.edge && a.cell === b.cell && a.side === b.side && (a.float === true) === (b.float === true);
const sized = (vp) => {
  const v = isObject(vp) ? vp : null;
  return v && dim(v.width) > 0 && dim(v.height) > 0 ? { width: dim(v.width), height: dim(v.height) } : null;
};

/**
 * Every zone a panel can be dropped on, as the pointer would light them: the window's rim, each cell's bands and middle
 * (the terminal's middle floats), and a float's whole box (join). Empty zones are left out. `exclude`: a float being
 * moved is not its own target.
 */
function candidates(boxes, viewport, { tabBar = TAB_BAR, exclude = null } = {}) {
  const vp = sized(viewport);
  if (!vp) return [];
  const barPx = isNumber(tabBar) && tabBar >= 0 ? tabBar : TAB_BAR;
  const out = rimZones(vp.width, vp.height).filter(z => area(z.rect) > 0);
  for (const b of Array.isArray(boxes) ? boxes : []) {
    if (isCell(b)) out.push(...cellZones(b, barPx));
    else if (hasRect(b) && b.kind === 'float' && typeof b.id === 'string' && b.id !== exclude && area(b.rect) > 0) out.push({ rect: { ...b.rect }, target: { cell: b.id, side: 'center' } });
  }
  // A group's tab bar and its middle both mean "join it": the keyboard steps through the middle only.
  return out.filter((z, i) => !out.slice(i + 1).some(o => sameTarget(o.target, z.target)));
}

/**
 * Where a move starts: the middle of the group (or float) the module sits in -- for a group folded to a rail, that group,
 * lit over its rail, so Enter at once drops where the panel already is -- else the terminal's float zone. The boxes are
 * the page's plan, whose tabs are { id, label, ... } objects (a bare list of ids is read too).
 */
function startTarget(boxes, id) {
  const holds = b => Array.isArray(b.tabs) && b.tabs.some(t => t === id || (isObject(t) && t.id === id));
  const own = (Array.isArray(boxes) ? boxes : []).find(b => hasRect(b) && (b.kind === 'group' || b.kind === 'float') && holds(b));
  if (own) return { cell: own.id, side: 'center' };
  const onRail = (Array.isArray(boxes) ? boxes : []).filter(b => hasRect(b) && b.kind === 'rail' && Array.isArray(b.groups)).flatMap(b => b.groups).find(gr => isObject(gr) && typeof gr.id === 'string' && holds(gr));
  return onRail ? { cell: onRail.id, side: 'center' } : { float: true };
}

const STEPS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const CYCLE = { Tab: 1, ShiftTab: -1 };

/**
 * The zone one key away from `current`. An arrow: the nearest zone whose middle lies beyond it in that direction (a zone
 * straight ahead beats one off to the side), or `current` itself when there is none. 'Tab' / 'ShiftTab': the next or
 * previous zone in the order the pointer meets them, round and round -- the way to a zone an arrow can't pick out (one
 * lying behind another). A target that is not on screen any more (the layout changed under the move) restarts at the
 * terminal's float zone. Any other key changes nothing.
 */
function nextZone(boxes, viewport, current, key, { tabBar = TAB_BAR, exclude = null } = {}) {
  const has = o => Object.prototype.hasOwnProperty.call(o, key);
  const step = has(STEPS) ? STEPS[key] : null;
  const cycle = has(CYCLE) ? CYCLE[key] : 0;
  if (!step && !cycle) return current;
  const all = candidates(boxes, viewport, { tabBar });
  const dests = exclude === null ? all : candidates(boxes, viewport, { tabBar, exclude });
  const here = all.find(z => sameTarget(z.target, current));
  if (!here) {
    const home = dests.find(z => z.target.float === true) || dests[0];
    return home ? home.target : null;
  }
  if (cycle) {
    if (!dests.length) return current;
    // From a zone that is not a destination (the float being moved), the order continues from where it would stand.
    const at = all.indexOf(here);
    const order = all.filter((z, i) => i === at || dests.some(d => sameTarget(d.target, z.target)));
    const i = order.indexOf(here);
    return order[(i + cycle + order.length) % order.length].target;
  }
  const mid = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const a = mid(here.rect);
  // The zones ahead, each with how far and how far off to the side. Those within 45 degrees of the key win first (up from
  // a group's middle is its top band, not the thin rim strip that happens to sit a few pixels higher far to the side);
  // only when none is, anything ahead at all.
  const ahead = [];
  for (const z of dests) {
    if (sameTarget(z.target, current)) continue;
    const b = mid(z.rect);
    const along = step[0] !== 0 ? (b.x - a.x) * step[0] : (b.y - a.y) * step[1];
    if (along <= 0) continue;
    ahead.push({ z, along, aside: step[0] !== 0 ? Math.abs(b.y - a.y) : Math.abs(b.x - a.x) });
  }
  const pool = ahead.some(c => c.aside <= c.along) ? ahead.filter(c => c.aside <= c.along) : ahead;
  let best = null;
  for (const c of pool) if (best === null || c.along + 2 * c.aside < best.along + 2 * best.aside) best = c;
  return best ? best.z.target : current;
}

/**
 * The zones to draw while a move is on: the rim, and the cell the target belongs to. `target` comes back as the hot
 * zone's, or null when it is not on screen.
 */
function zonesFor(boxes, viewport, target, { tabBar = TAB_BAR } = {}) {
  const vp = sized(viewport);
  const barPx = isNumber(tabBar) && tabBar >= 0 ? tabBar : TAB_BAR;
  const list = Array.isArray(boxes) ? boxes : [];
  const zones = vp ? rimZones(vp.width, vp.height) : [];
  const t = isObject(target) ? target : {};
  const owner = t.float === true ? list.find(isTerm)
    : typeof t.cell === 'string' ? list.find(b => (t.cell === 'term' ? isTerm(b) : hasRect(b) && (b.kind === 'group' || b.kind === 'float') && b.id === t.cell))
      : null;
  // A group folded to a rail has no box of its own: the move that starts on it lights the rail (not a place to step to).
  const railOf = !owner && typeof t.cell === 'string' ? list.find(b => hasRect(b) && b.kind === 'rail' && Array.isArray(b.groups) && b.groups.some(gr => isObject(gr) && gr.id === t.cell)) : null;
  if (railOf) zones.push({ rect: { ...railOf.rect }, target: { cell: t.cell, side: 'center' } });
  else if (owner && owner.kind === 'float') zones.push({ rect: { ...owner.rect }, target: { cell: owner.id, side: 'center' } });
  else if (owner) zones.push(...cellZones(owner, barPx));
  // A group's tab bar and its middle are both "join it": the middle (listed last) is the one that is hot.
  const hot = [...zones].reverse().find(z => sameTarget(z.target, target));
  return { zones: zones.map(z => ({ ...z, hot: z === hot })), target: hot ? hot.target : null };
}

/** The target in words, for the screen reader: `nameOf(cellId)` names a group or 'term'. */
function describeTarget(target, nameOf) {
  const name = c => (typeof nameOf === 'function' ? nameOf(c) : String(c));
  if (!isObject(target)) return 'nowhere';
  if (typeof target.edge === 'string') return `along the window's ${target.edge} edge`;
  if (target.float === true) return 'floating over the terminal';
  if (typeof target.cell !== 'string') return 'nowhere';
  const n = name(target.cell);
  switch (target.side) {
    case 'left': return `left of ${n}`;
    case 'right': return `right of ${n}`;
    case 'top': return `above ${n}`;
    case 'bottom': return `below ${n}`;
    case 'center': return `as a tab in ${n}`;
    default: return 'nowhere';
  }
}

/** What a keyboard drop says once it is done: `moved` is whether the layout changed (dock refuses a drop where the panel already is). */
function describeDrop(moved, panel, where) {
  return moved ? `Moved ${panel} ${where}.` : `Not moved: ${panel} is already there.`;
}

const API = { RIM, BAND, TAB_BAR, zonesAt, candidates, startTarget, nextZone, zonesFor, describeTarget, describeDrop };

// One namespace on the page (`window.dockDrag`).
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockDrag = API;

})(typeof window !== 'undefined' ? window : globalThis);
