'use strict';
/**
 * Lean mode's decisions on the page side (BACKLOG #62, documentation/DESIGN_LEAN_MODE.md). PURE, like
 * app/bg-media-display.js: the renderer and the strip only turn what this returns into DOM.
 *
 *   normalize(payload)       the pushed state, strictly: { on, byBedtime, bedtimeSince }. Only a real `true` is on;
 *                            a night with no believable start is not shown as one (absence is not a time).
 *   holdStill({ lean, focused, night })  Ricardo's rule (2026-10-09): while lean, an animated background plays ONLY while the window is
 *                            focused AND no /bedtime night is on; otherwise it shows its still frame. Not lean: false (nothing changes). An
 *                            unknown focus holds (only a real true plays).
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
 *   stillSize(w, h, fw, fh, vector)  the size to draw a still frame at: the image's own; for a VECTOR image the size it covers the box at;
 *                            else (0) the fallback box, so the draw has a real destination and `cover` fills the window (Dexter N2)
 *   stillNode(doc, face, portraitMedia)  one working agent's portrait as a DOM node that never moves (the strip's, #62 option C): the initials
 *                            placeholder, a static <img>, or a <canvas> painted with the image's / video's first frame (paintStill). Built with
 *                            the DOM API only: a name is somebody's string.
 *   advanceCooldowns(list,now) the cooldown widget's countdown step, so a resume after a long lean shows the real time left (Dexter F7)
 *   createSuspender()        the registry of suspend/resume pairs: every panel, poller or animation registers one;
 *                            `set(true)` suspends all (in registration order), `set(false)` resumes them in reverse.
 *                            One pair throwing never stops the others (its name comes back in `failed`).
 *   leanShown(shown, lean)   the dock panels that stay mounted: lean unmounts every one EXCEPT LEAN_KEEPS (PR #200, Ricardo 2026-10-21: Schedules is
 *                            exempt because its content is the night itself, the wakeups running while lean is on). Not lean: the plan as it is.
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
  const nightOn = p.night === true;
  if (p.on !== true) return { on: false, byBedtime: false, bedtimeSince: null, night: nightOn };
  const night = p.byBedtime === true && typeof p.bedtimeSince === 'number' && Number.isFinite(p.bedtimeSince);
  return { on: true, byBedtime: night, bedtimeSince: night ? p.bedtimeSince : null, night: nightOn };
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

function holdStill(o) {
  const s = o && typeof o === 'object' ? o : {};
  if (s.lean !== true) return false;
  return !(s.focused === true && s.night !== true);
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

function stillSize(w, h, fw, fh, vector = false) {
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  // A vector image (SVG) is drawn at the size it will be SHOWN at, covering the box: Chromium reports 240x150 for the generated art's
  // viewBox-only SVG and drawing at that size, scaled up by `cover`, would be a blurry 5x enlargement.
  if (vector && ok(fw) && ok(fh)) {
    const aw = ok(w) && ok(h) ? w : fw;
    const ah = ok(w) && ok(h) ? h : fh;
    const scale = Math.max(fw / aw, fh / ah);
    return { width: Math.round(aw * scale), height: Math.round(ah * scale) };
  }
  if (ok(w) && ok(h)) return { width: Math.round(w), height: Math.round(h) };
  return { width: ok(fw) ? Math.round(fw) : 300, height: ok(fh) ? Math.round(fh) : 300 };
}

const STILL_VIDEO_TIMEOUT_MS = 10000;

// A canvas (data-still-src, data-still-kind) painted with a centred square of the first frame; a video is unloaded after.
function paintStill(doc, c, portraitMedia) {
  const src = c.dataset.stillSrc;
  // dataset.stillDrawn / stillFailed say what happened (a blocked or undecodable file is otherwise just a blank canvas)
  const draw = (el, w, h) => {
    try {
      const side = Math.min(w, h) || 1;
      c.getContext('2d').drawImage(el, (w - side) / 2, (h - side) / 2, side, side, 0, 0, c.width, c.height);
      c.dataset.stillDrawn = '1';
    } catch { c.dataset.stillFailed = '1'; /* stays blank: a face never moves */ }
  };
  if (c.dataset.stillKind === 'video') {
    const v = doc.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.addEventListener('loadeddata', () => { draw(v, v.videoWidth, v.videoHeight); portraitMedia.unloadVideo(v); }, { once: true });
    v.addEventListener('error', () => { c.dataset.stillFailed = '1'; portraitMedia.unloadVideo(v); }, { once: true });
    // a video that never loads (a stalled path) must not stay a loading element for ever (PR #140 Miguel S6)
    const timer = setTimeout(() => portraitMedia.unloadVideo(v), STILL_VIDEO_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    v.src = src;
    return;
  }
  const img = doc.createElement('img');
  img.onload = () => draw(img, img.naturalWidth, img.naturalHeight);
  img.onerror = () => { c.dataset.stillFailed = '1'; };
  img.src = src;
}

function stillNode(doc, face, portraitMedia) {
  const f = face && typeof face === 'object' ? face : {};
  const d = portraitMedia.mediaElementFor(f.portrait, { imagesEnabled: f.images });
  if (d.tag === 'placeholder') {
    const span = doc.createElement('span');
    span.className = 'face-media face-placeholder';
    span.title = String(d.attrs.title || '');
    span.textContent = String(d.attrs.initials);
    span.style.background = `hsl(${Number(d.attrs.hue) || 0} 42% 62%)`;
    return span;
  }
  if (d.tag === 'img' && !mayAnimate(d.attrs.src)) {
    const img = doc.createElement('img');
    img.className = 'face-media';
    img.alt = '';
    img.src = d.attrs.src;
    return img;
  }
  const c = doc.createElement('canvas');
  c.className = 'face-media face-still';
  c.width = 36;
  c.height = 36;
  c.dataset.stillSrc = d.attrs.src;
  c.dataset.stillKind = d.tag === 'video' ? 'video' : 'image';
  paintStill(doc, c, portraitMedia);
  return c;
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

// The panels lean keeps mounted: ids as the dock uses them (TABS in app/renderer.js). The ONE place this exemption lives.
const LEAN_KEEPS = Object.freeze(['schedules']);

function leanShown(shown, lean) {
  const set = shown instanceof Set ? shown : new Set(Array.isArray(shown) ? shown : []);
  if (lean !== true) return new Set(set);
  return new Set([...set].filter((id) => LEAN_KEEPS.includes(id)));
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

const API = { normalize, chip, holdStill, wantWebgl, mayAnimate, stillNode, paintStill, hostListsLean, stillSize, advanceCooldowns, createSuspender, workingFaces, leanShown, LEAN_KEEPS, FACE_LIMIT };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.leanDisplay = API;

})(typeof window !== 'undefined' ? window : globalThis);
