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
const { ZONES, MIN, fitSizes, shapeOf } = layoutApi;

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
    const selected = layout.active[z];
    // Squeezed below its minimum by a window too narrow for it (the terminal
    // wins, Dexter F7): drawn as its rail, the selected tab still marked.
    const squeezed = selected !== null && sizes[z] < (shapeOf(z) === 'tall' ? MIN.side : MIN.wide);
    const panel = squeezed ? null : selected;
    zones[z] = {
      empty: ids.length === 0,
      collapsed: ids.length > 0 && panel === null,
      shape: shapeOf(z),
      size: sizes[z],
      panel,
      tabs: ids.filter(id => byId.has(id)).map((id) => {
        const t = byId.get(id);
        return { id, label: t.label, title: t.title, on: id === selected };
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

    // Rebuilt only when its MODULES change; a selection change just moves the
    // `on` class, so the clicked button (and its focus) survives (PR #82 Miguel S4).
    const nav = el.querySelector('.zone-tabs');
    if (nav) {
      const sig = JSON.stringify(zp.tabs.map(t => [t.id, t.label, t.title]));
      if (nav.dataset.sig !== sig) {
        nav.dataset.sig = sig;
        nav.textContent = '';
        for (const t of zp.tabs) {
          const b = doc.createElement('button');
          b.type = 'button';
          b.dataset.module = t.id;
          b.title = t.title;
          b.textContent = t.label;
          b.draggable = true;
          nav.appendChild(b);
        }
      }
      const on = new Set(zp.tabs.filter(t => t.on).map(t => t.id));
      for (const b of nav.querySelectorAll('button[data-module]')) b.classList.toggle('on', on.has(b.dataset.module));
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

/**
 * The layout menu (▦): every module, in TABS order, with where it is now --
 * 'left' | 'right' | 'top' | 'bottom' | 'hidden'. It lists hidden modules on
 * purpose: it is the way back for one, and the way out when every module is
 * hidden and there is no tab left to right-click.
 */
function layoutRows(layout, tabs) {
  return tabs.map((t) => {
    const at = ZONES.find(z => layout.zones[z].includes(t.id)) || (layout.hidden.includes(t.id) ? 'hidden' : null);
    return { id: t.id, label: t.label, at };
  }).filter(r => r.at !== null);
}

const TARGET_LABELS = { left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom', hide: 'Hide' };

/** A module's right-click menu: every zone and Hide, with where it already is disabled. */
function moveTargets(layout, id) {
  const at = ZONES.find(z => layout.zones[z].includes(id)) || (layout.hidden.includes(id) ? 'hide' : null);
  if (at === null) return [];
  return [...ZONES, 'hide'].map(target => ({ target, label: TARGET_LABELS[target], enabled: target !== at }));
}

/**
 * What a redraw may do besides drawing, given what was showing before and
 * after: which modules just appeared (their panels load), whether the vault
 * was left (its secrets go out of sight), and where keyboard focus goes.
 *
 * Focus moves ONLY when the vault opens or closes. A redraw happens on a
 * resize, a grip drag, a layout pushed from another window or a hello; moving
 * focus to the terminal on those sent the rest of a half-typed secret into
 * the session (PR #82 Dexter F2, Miguel B1).
 */
function renderEffects(before, after, { userAction = false, quiet = false } = {}) {
  const newlyShown = [...after].filter(id => !before.has(id));
  const vaultLeft = before.has('vault') && !after.has('vault');
  const vaultOpened = after.has('vault') && !before.has('vault');
  let focus = null;
  if (vaultOpened) focus = 'vault';
  else if (vaultLeft) focus = 'term';
  // The user's own click or key: typing goes back to the session, as the old
  // setTab did -- but never while the vault is showing.
  else if (userAction && !after.has('vault')) focus = 'term';
  // `quiet`: the panels come back without anyone opening them (lean mode ending, #62): a vault that was open before is not
  // "opened" now, and the keyboard stays where it is (PR #140 Dexter F1).
  if (quiet) focus = null;
  return { newlyShown, vaultLeft, focus };
}

/**
 * What holds keyboard focus, as focusOnOpen reads it: { tag, type, isTerminal,
 * visible, connected }, or null for nothing. `el` is document.activeElement,
 * `termEl` xterm's root element.
 */
function describeFocus(el, termEl) {
  if (!el) return null;
  return {
    tag: el.tagName,
    type: el.type === undefined ? null : el.type,
    isTerminal: !!(termEl && termEl.contains(el)),
    visible: typeof el.getClientRects === 'function' && el.getClientRects().length > 0,
    connected: el.isConnected === true,
  };
}

/**
 * Whether the socket opening focuses the terminal. `first` is whether this is
 * the FIRST open of this page's socket (a flag the page keeps, never read from
 * what has focus: a stored layout showing the vault focuses its search before
 * the socket opens, and that must not cost a new tab the keyboard).
 *
 * ws.onopen fires on every reattach. On a RECONNECT focus stays on any visible
 * element outside the terminal: taking it sent the rest of a half-typed vault
 * secret into the session, and a Tab onto a button then Shift+Tab would send
 * keys there too (backlog #36, the same class as renderEffects above). The
 * terminal takes it only when nothing, the body, its own textarea, or an
 * element that is hidden or gone holds it.
 */
function focusOnOpen(first, held) {
  if (first) return true;
  if (!held || held.isTerminal) return true;
  if (held.tag === 'BODY' || held.tag === 'HTML') return true;
  return !held.visible || !held.connected;
}

/**
 * main's answer to `layout:get` -> what the page does. Only a MISSING store
 * file means "first launch: migrate and save"; an unreadable or corrupt one
 * (antivirus holding it, EBUSY) must never be overwritten by a migration
 * (PR #82 Dexter F3, Miguel I1) -- the page keeps what it drew and saves
 * nothing until the user changes something.
 */
function afterLayoutGet(answer) {
  if (!answer || typeof answer !== 'object') return 'keep';
  if (answer.status === 'missing') return 'migrate';
  const l = answer.layout;
  if (answer.status === 'ok' && l && typeof l === 'object' && !Array.isArray(l)) return 'use';
  return 'keep';
}

/**
 * A tab's own layout changed while the socket was down (PR #82 Dexter F8).
 * `pending` is { layout } the host hasn't confirmed, or null; `incoming` is
 * the host's word (hello or broadcast). The host echoing the pending value
 * settles it; anything else is the host's OLD value and must not undo the
 * user's change -- the pending one is drawn and sent again.
 */
function overrideOnHello(pending, incoming) {
  const value = incoming === undefined ? null : incoming;
  if (!pending) return { apply: value, resend: false, settled: false };
  if (JSON.stringify(pending.layout) === JSON.stringify(value)) return { apply: value, resend: false, settled: true };
  return { apply: pending.layout, resend: true, settled: false };
}

const API = {
  zonePlan, dragSize, applyPlan, layoutRows, moveTargets, renderEffects, describeFocus, focusOnOpen, afterLayoutGet, overrideOnHello,
  WIDE_FACE_CHROME,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockZones = API;

})(typeof window !== 'undefined' ? window : globalThis);
