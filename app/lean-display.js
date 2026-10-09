'use strict';
/**
 * Lean mode's decisions on the page side (BACKLOG #62, documentation/DESIGN_LEAN_MODE.md). PURE, like
 * app/bg-media-display.js: the renderer and the strip only turn what this returns into DOM.
 *
 *   normalize(payload)       the pushed state, strictly: { on, byBedtime, bedtimeSince }. Only a real `true` is on;
 *                            a night with no believable start is not shown as one (absence is not a time).
 *   chip(state)              the strip's chip: null while normal, else { label: '☾ lean', night: 'bedtime HH:MM' | null,
 *                            back: 'Back to normal' }
 *   wantWebgl({ lean, hasBackground, supported })
 *                            may the terminal use the WebGL renderer: only when not lean, no background is set (WebGL
 *                            mis-draws a transparent terminal: renderer.js applyBackground) and the addon exists
 *   mayAnimate(url)          could this image move: everything but a known-static decode (jpg/jpeg). By CONTENT it cannot be told from a
 *                            name: an APNG is a .png, a WebP may be animated, an SVG may carry SMIL/CSS animation (PR #140 Dexter F4). Lean
 *                            draws such an image's first frame into a canvas; for a still one that is the same picture. ONE rule, shared by
 *                            the background and the portraits strip.
 *   hostListsLean(controls)  does the host's hello list `lean` among its control types: a frame to a host that does not would be TYPED into the
 *                            session as JSON (hosts outlive app updates; PR #140 Dexter N1). Only an exact array entry counts.
 *   stillSize(w, h, fw, fh)  the size to draw a still frame at: the image's own, else (a viewBox-only SVG reports 0) the fallback box, so
 *                            the draw has a real destination and `cover` fills the window (Dexter N2)
 *   advanceCooldowns(list,now) the cooldown widget's countdown step, so a resume after a long lean shows the real time left (Dexter F7)
 *   createSuspender()        the registry of suspend/resume pairs: every panel, poller or animation registers one;
 *                            `set(true)` suspends all (in registration order), `set(false)` resumes them in reverse.
 *                            One pair throwing never stops the others (its name comes back in `failed`).
 *   workingFaces(rows, opts) the portraits-only strip: the agents whose state is exactly 'working', by name, at most
 *                            `limit`, and how many more did not fit
 *
 * WRAPPED IN AN IIFE, and publishes ONE global (`leanDisplay`) -- see app/career-display.js's header: the renderer
 * loads every script as a plain <script> sharing one global scope, and no unit test can see a collision. Loaded by
 * the strip page too. Enforced by test/renderer-scope.test.js.
 */

(function (root) {

const FACE_LIMIT = 8;

function normalize(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (p.on !== true) return { on: false, byBedtime: false, bedtimeSince: null };
  const night = p.byBedtime === true && typeof p.bedtimeSince === 'number' && Number.isFinite(p.bedtimeSince);
  return { on: true, byBedtime: night, bedtimeSince: night ? p.bedtimeSince : null };
}

const two = (n) => String(n).padStart(2, '0');

function chip(state) {
  const s = normalize(state);
  if (!s.on) return null;
  let night = null;
  if (s.byBedtime) {
    const d = new Date(s.bedtimeSince);
    night = `bedtime ${two(d.getHours())}:${two(d.getMinutes())}`;
  }
  return { label: '☾ lean', night, back: 'Back to normal' };
}

function wantWebgl(o) {
  const s = o && typeof o === 'object' ? o : {};
  return s.lean === false && s.hasBackground === false && s.supported === true;
}

const STATIC_EXT = /\.(?:jpe?g)$/i;
function mayAnimate(url) {
  if (typeof url !== 'string' || url === '') return false;
  return !STATIC_EXT.test(url.split('#')[0].split('?')[0]);
}

function hostListsLean(controls) {
  return Array.isArray(controls) && controls.includes('lean');
}

function stillSize(w, h, fw, fh) {
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (ok(w) && ok(h)) return { width: Math.round(w), height: Math.round(h) };
  return { width: ok(fw) ? Math.round(fw) : 300, height: ok(fh) ? Math.round(fh) : 300 };
}

/** Each entry's remaining time reduced by the time since its last tick; the expired go. Pure: `now` in, a new list out. */
function advanceCooldowns(list, now) {
  return (Array.isArray(list) ? list : [])
    .map((c) => ({ ...c, remainingMs: c.remainingMs - (now - (c._tick || now)), _tick: now }))
    .filter((c) => c.remainingMs > 0);
}

function createSuspender() {
  const pairs = new Map();
  let on = false;

  function run(name, fn, failed) {
    try { fn(); } catch { failed.push(name); }
  }

  function register(name, pair) {
    if (typeof name !== 'string' || !name) throw new Error('a suspend/resume pair needs a name');
    if (!pair || typeof pair.suspend !== 'function' || typeof pair.resume !== 'function') {
      throw new Error(`pair "${name}" needs suspend and resume functions`);
    }
    pairs.set(name, pair);
    if (on) { const failed = []; run(name, pair.suspend, failed); }
  }

  function set(next) {
    const want = next === true;
    const failed = [];
    if (want === on) return { failed };
    on = want;
    const list = [...pairs.entries()];
    if (on) for (const [name, p] of list) run(name, p.suspend, failed);
    else for (const [name, p] of list.reverse()) run(name, p.resume, failed);
    return { failed };
  }

  return { register, set, isOn: () => on, names: () => [...pairs.keys()] };
}

function workingFaces(rows, { limit = FACE_LIMIT } = {}) {
  const working = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r === 'object' && typeof r.agent === 'string' && r.agent !== '' && r.state === 'working')
    .sort((a, b) => a.agent.localeCompare(b.agent));
  const cap = Number.isInteger(limit) && limit >= 0 ? limit : FACE_LIMIT;
  return {
    faces: working.slice(0, cap).map((r) => ({ agent: r.agent, portrait: r.portrait || null })),
    more: Math.max(0, working.length - cap),
  };
}

const API = { normalize, chip, wantWebgl, mayAnimate, hostListsLean, stillSize, advanceCooldowns, createSuspender, workingFaces, FACE_LIMIT };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.leanDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
