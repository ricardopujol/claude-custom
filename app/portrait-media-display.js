'use strict';
/**
 * What an agent's face becomes, and when it may move (BACKLOG C #13, #18).
 *
 * PURE decisions, like app/agent-card-display.js: the renderer only turns what
 * this returns into DOM. Three concerns live here so each can be tested:
 *
 *   - `mediaElementFor(result, { imagesEnabled })`: the descriptor
 *     `{ tag: 'img' | 'video' | 'placeholder', attrs }` for one portrait result
 *     from host/portraits.js.
 *   - `visibilityAction(isIntersecting, docVisible)`: a looping video plays
 *     only while its face is on screen AND the window is visible. Off-screen
 *     or hidden video is decoded for nobody.
 *   - the global "agent images off" override (#18): with the toggle anything
 *     but exactly `true`, EVERY result draws the lightweight placeholder --
 *     never an `<img>`, never a `<video>`, no file URL in the DOM. It
 *     overrides the global default (#3) and per-agent media (#13) without
 *     deleting a file.
 *
 * "Not yet known" is not "on": the toggle is read from Electron main
 * asynchronously, and an unknown value must not start decoding video that the
 * user may have turned off. The renderer treats a missing bridge as `true`.
 *
 * WRAPPED IN AN IIFE, and publishes ONE global (`portraitMedia`) rather than
 * six -- see app/career-display.js's header: the renderer loads every script
 * as a plain <script> sharing one global scope, and no unit test can see a
 * collision. Enforced by test/renderer-scope.test.js.
 */

(function (root) {

// Wording per tier: the card must say WHERE a picture came from (this
// project's signature defect is a display that can't).
const TIER_TITLE = {
  uploaded: 'your upload',
  forge: 'generated',
  global: 'your global default picture',
  shipped: 'default picture',
  text: 'no picture yet',
};

const IMAGES_OFF_TITLE = 'agent images are turned off';
// Not yet known is neither on nor off (Dexter F5, PR #64): say so.
const IMAGES_UNKNOWN_TITLE = 'agent images: reading the setting';

function tierTitle(result) {
  const tier = result && typeof result.tier === 'string' ? result.tier : 'text';
  return Object.prototype.hasOwnProperty.call(TIER_TITLE, tier) ? TIER_TITLE[tier] : '';
}

// A local, minimal escape. Attribute AND text safe; the renderer's own
// escapeHtml is a sibling global this module must not depend on.
function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * A file:// URL for a portrait path. Spaces and the URL-significant `#` and `?`
 * are percent-encoded (a `#` in a folder name silently truncated the URL), and
 * a known mtime rides along as `?v=` so replacing a picture with one of the
 * SAME extension is not served from the image cache (Miguel I4, PR #35).
 */
function fileUrl(p, mtimeMs) {
  const clean = String(p).replace(/\\/g, '/')
    .replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/]/gu, (c) => encodeURIComponent(c));
  const v = typeof mtimeMs === 'number' && Number.isFinite(mtimeMs) ? `?v=${Math.trunc(mtimeMs)}` : '';
  return `file:///${clean}${v}`;
}

function placeholderAttrs(source, title) {
  const fb = source && (source.kind === 'placeholder' ? source : source.fallback);
  const initials = fb && typeof fb.initials === 'string' && fb.initials ? fb.initials : '??';
  const hue = fb && typeof fb.hue === 'number' && Number.isFinite(fb.hue) ? fb.hue : 0;
  return { initials, hue, title };
}

function mediaElementFor(result, opts) {
  const imagesEnabled = !!opts && opts.imagesEnabled === true;
  const r = result && typeof result === 'object' ? result : null;

  if (!imagesEnabled) {
    const known = !!opts && opts.imagesEnabled === false;
    return { tag: 'placeholder', attrs: placeholderAttrs(r, known ? IMAGES_OFF_TITLE : IMAGES_UNKNOWN_TITLE) };
  }
  if (r && r.kind === 'file' && typeof r.path === 'string' && r.path) {
    const src = fileUrl(r.path, r.mtimeMs);
    const title = tierTitle(r);
    // `media` (set by host/portraits.js from the file's own extension) decides
    // the tag, never the extension re-sniffed here. A GIF is media 'image'.
    return r.media === 'video'
      ? { tag: 'video', attrs: { src, title, autoplay: true, loop: true, muted: true, playsinline: true } }
      : { tag: 'img', attrs: { src, title, alt: '' } };
  }
  return { tag: 'placeholder', attrs: placeholderAttrs(r, tierTitle(r || { tier: 'text' })) };
}

/**
 * Identity of a video face across repaints: the agent plus the exact URL (which
 * carries the file's version). `null` for anything that is not a playing video.
 * A roster repaint runs about once a second while anything is running; a video
 * that is unloaded and recreated each time restarts from frame 0 and never
 * loops (Dexter F1 / Miguel I2, PR #64).
 */
function videoKey(result, opts) {
  const d = mediaElementFor(result, opts);
  if (d.tag !== 'video') return null;
  return `${result.agent}|${d.attrs.src}`;
}

/**
 * Which existing video nodes survive a repaint: `reuse` (keys present before
 * and after) stay in the DOM untouched; `drop` (keys that went away or
 * changed) are the only ones to unload.
 */
function planVideoReuse(oldKeys, newKeys) {
  const before = new Set(Array.isArray(oldKeys) ? oldKeys : []);
  const after = new Set(Array.isArray(newKeys) ? newKeys : []);
  const reuse = new Set();
  const drop = [];
  for (const k of before) (after.has(k) ? reuse.add(k) : drop.push(k));
  return { reuse, drop };
}

/** The descriptor as markup. Every interpolated value is escaped or forced numeric. */
function faceMediaHtml(result, opts) {
  const d = mediaElementFor(result, opts);
  const a = d.attrs;
  if (d.tag === 'video') {
    return `<video class="face-media" data-face-key="${esc(videoKey(result, opts))}" src="${esc(a.src)}" title="${esc(a.title)}" autoplay loop muted playsinline></video>`;
  }
  if (d.tag === 'img') {
    return `<img class="face-media" src="${esc(a.src)}" alt="" title="${esc(a.title)}" />`;
  }
  return placeholderHtml(a);
}

// The hue is forced numeric so it can't carry markup into the style.
function placeholderHtml(a) {
  return `<span class="face-media face-placeholder" title="${esc(a.title)}" style="width:100%;height:100%;display:flex;align-items:center;` +
         `justify-content:center;background:hsl(${Number(a.hue) || 0} 42% 62%)">${esc(a.initials)}</span>`;
}

/** Strict: a face plays only when BOTH inputs are exactly `true`. */
function visibilityAction(isIntersecting, docVisible) {
  return isIntersecting === true && docVisible === true ? 'play' : 'pause';
}

/**
 * Stop a video and release its decoder: pause, drop the source, load(). Merely
 * removing the element leaves the media pipeline running until GC gets to it.
 * Tolerant of a detached or non-video node.
 */
function unloadVideo(el) {
  if (!el || typeof el !== 'object') return;
  try { if (typeof el.pause === 'function') el.pause(); } catch { /* detached */ }
  try { if (typeof el.removeAttribute === 'function') el.removeAttribute('src'); } catch { /* detached */ }
  try { if (typeof el.load === 'function') el.load(); } catch { /* detached */ }
}

const API = { mediaElementFor, faceMediaHtml, videoKey, planVideoReuse, visibilityAction, unloadVideo, fileUrl, tierTitle, TIER_TITLE };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.portraitMedia = API;

})(typeof window !== 'undefined' ? window : globalThis);
