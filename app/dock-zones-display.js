'use strict';
/**
 * Drawing a dock layout (layout pass L1, Task 5).
 *
 * Two halves. `zonePlan` and `dragSize` are pure: what each zone shows, how big
 * it is, which panels are visible, where a dragged grip puts a zone edge.
 * `applyPlan` copies a plan onto the page and nothing else -- it makes no
 * decisions, so a wrong window means a wrong plan, and the plan is tested.
 *
 * Panels are MOVED between zones (appendChild), never rebuilt: the vault's
 * masked field, the Models search and an open agent log hold live state and
 * listeners that a rebuild would silently drop.
 */

/*
 * WRAPPED IN AN IIFE: plain <script> files share one global scope
 * (test/renderer-scope.test.js). The page sees one name, `dockZones`.
 */
(function (root) {

const layoutApi = typeof module !== 'undefined' && module.exports
  ? require('./dock-layout')
  : root.dockLayout;
const { ZONES, fitSizes, shapeOf } = layoutApi;

// Portraits in a wide (top/bottom) zone: the card is a row, so the face is
// bounded by the zone's height minus its tab bar and the card's name line.
const WIDE_FACE_CHROME = 60;

/**
 * @param layout   a normalized layout (app/dock-layout.js)
 * @param tabs     the module registry: [{ id, label, title }] (app/side-tabs.js TABS)
 * @param viewport { width, height } the zones share with the terminal
 * @param faceSize width -> portrait px (app/roster-width.js)
 */
function zonePlan(layout, tabs, viewport, { faceSize } = {}) {
  const sizes = fitSizes(layout, viewport);
  const byId = new Map(tabs.map(t => [t.id, t]));
  const zones = {};
  const shown = [];
  let face = null;
  for (const z of ZONES) {
    const ids = layout.zones[z];
    const panel = layout.active[z];
    zones[z] = {
      empty: ids.length === 0,
      collapsed: ids.length > 0 && panel === null,
      shape: shapeOf(z),
      size: sizes[z],
      panel,
      tabs: ids.filter(id => byId.has(id)).map((id) => {
        const t = byId.get(id);
        return { id, label: t.label, title: t.title, on: id === panel };
      }),
    };
    if (panel !== null) shown.push(panel);
    if (panel === 'agents') {
      face = shapeOf(z) === 'tall'
        ? (typeof faceSize === 'function' ? faceSize(sizes[z]) : null)
        : Math.max(28, Math.min(150, sizes[z] - WIDE_FACE_CHROME));
    }
  }
  return { zones, shown, face };
}

/**
 * The size a zone would have with its grip under `point`, measured from the
 * zone's anchored edge of `rect` (the area the zones and terminal share).
 * Null when the pointer is past that edge or anything is junk; the minimum is
 * setSize's job, not this one's.
 */
function dragSize(zone, point, rect) {
  if (!rect || !point) return null;
  const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const x = n(point.x);
  const y = n(point.y);
  let px;
  if (zone === 'right') px = n(rect.right) - x;
  else if (zone === 'left') px = x - n(rect.left);
  else if (zone === 'top') px = y - n(rect.top);
  else if (zone === 'bottom') px = n(rect.bottom) - y;
  else return null;
  return Number.isFinite(px) && px > 0 ? Math.round(px) : null;
}

/**
 * Copy a plan onto the page. `doc` holds `.zone[data-zone=…]` elements (each
 * with `.zone-tabs` and `.zone-panels`), the `.panel[data-panel=…]` blocks and
 * the `#panel-store` that keeps panels no zone is showing.
 */
function applyPlan(plan, doc) {
  const rootStyle = doc.documentElement.style;
  const store = doc.getElementById('panel-store');
  const showing = new Set(plan.shown);
  for (const z of ZONES) {
    const zp = plan.zones[z];
    const el = doc.querySelector(`.zone[data-zone="${z}"]`);
    if (!el) continue;
    el.dataset.shape = zp.shape;
    el.toggleAttribute('data-empty', zp.empty);
    el.toggleAttribute('data-collapsed', zp.collapsed);
    rootStyle.setProperty(`--zone-${z}`, `${zp.size}px`);

    // Rebuilt only when what it shows changed, so a hover or focus survives a re-render.
    const nav = el.querySelector('.zone-tabs');
    const sig = JSON.stringify(zp.tabs);
    if (nav && nav.dataset.sig !== sig) {
      nav.dataset.sig = sig;
      nav.textContent = '';
      for (const t of zp.tabs) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.dataset.module = t.id;
        b.title = t.title;
        b.textContent = t.label;
        b.draggable = true;
        b.classList.toggle('on', t.on);
        nav.appendChild(b);
      }
    }

    const holder = el.querySelector('.zone-panels');
    if (zp.panel !== null && holder) {
      const p = doc.querySelector(`.panel[data-panel="${zp.panel}"]`);
      if (p && p.parentNode !== holder) holder.appendChild(p);
    }
  }
  for (const p of doc.querySelectorAll('.panel[data-panel]')) {
    const on = showing.has(p.dataset.panel);
    p.classList.toggle('on', on);
    if (!on && store && p.parentNode !== store) store.appendChild(p);
  }
  if (plan.face !== null) rootStyle.setProperty('--face', `${plan.face}px`);
}

const API = { zonePlan, dragSize, applyPlan, WIDE_FACE_CHROME };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockZones = API;

})(typeof window !== 'undefined' ? window : globalThis);
