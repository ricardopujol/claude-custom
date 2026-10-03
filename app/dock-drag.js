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
// on the terminal it is no zone at all in D1 (D2 makes it the float zone).
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
  if (isGroup) zones.push(zone(rect.x + bandW, top + bandH, rect.width - 2 * bandW, midH, 'center'));
  return zones.filter(z => area(z.rect) > 0);
}

const isCell = b => !!b && typeof b === 'object' && (b.kind === 'term' || b.kind === 'group') && !!b.rect;

/**
 * @param boxes    `fit`'s boxes
 * @param viewport { width, height } of the area the boxes fill
 * @param point    { x, y } of the pointer, relative to that area
 * @param opts     { tabBar } a group's tab bar height in px
 * @returns { zones: [{ rect, target, hot }], target } -- the rim is always listed; over a cell, that
 *          cell's zones too; `target` is the hot zone's, or null (over a rail, a gutter, nothing, or
 *          outside the window).
 */
function zonesAt(boxes, viewport, point, { tabBar = TAB_BAR } = {}) {
  const vp = viewport && typeof viewport === 'object' ? viewport : {};
  const width = dim(vp.width);
  const height = dim(vp.height);
  const barPx = isNumber(tabBar) && tabBar >= 0 ? tabBar : TAB_BAR;
  const p = point && isNumber(point.x) && isNumber(point.y) ? point : null;
  const zones = rimZones(width, height);
  if (p && contains({ x: 0, y: 0, width, height }, p)) {
    const under = (Array.isArray(boxes) ? boxes : []).find(b => isCell(b) && contains(b.rect, p));
    if (under) zones.push(...cellZones(under, barPx));
  }
  // The rim comes first in the list, so it wins over a cell's band.
  const hot = p ? zones.find(z => contains(z.rect, p)) : null;
  return { zones: zones.map(z => ({ ...z, hot: z === hot })), target: hot ? hot.target : null };
}

const API = { RIM, BAND, TAB_BAR, zonesAt };

// One namespace on the page (`window.dockDrag`).
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockDrag = API;

})(typeof window !== 'undefined' ? window : globalThis);
