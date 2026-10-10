'use strict';
/**
 * The working agents' portraits in the tab strip while lean (BACKLOG #62, Ricardo's option C). Main's half, PURE: each tab page tells
 * main which of ITS agents are working (`lean:faces`), main keeps one list per page and hands the strip the window's whole set.
 *
 *   sanitizeFaces(value) -> [{ agent, images, portrait }]  what a page may say: at most 24 entries, a name, the "agent images" flag
 *                                                       (true | false | null) and the portrait result's plain fields. Anything else is dropped.
 *   createFaces() -> { set(owner, value) -> changed, drop(owner) -> changed, flat() -> faces }
 *                                                       flat(): every page's list in owner order, one entry per agent name
 *
 * A page that goes away drops its list (app/lean-bridge.js dropOwner), so a closed tab leaves no faces behind.
 */

const MAX_FACES = 24;
const SCAN_MAX = 200;                                       // entries looked at, valid or not: a hostile page cannot make main walk a huge array
const MEDIA_EXT = /\.(?:png|jpe?g|webp|gif|webm|mp4)$/i;
const isStr = (s, max) => typeof s === 'string' && s !== '' && s.length <= max;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * A portrait path the strip may load (PR #140 Miguel Y2): absolute with a drive letter (so no UNC, no \\?\ device path), no `..` segment,
 * and one of the media extensions the portraits tiers serve. The host that produced it owns the folders (they move per probe and per
 * environment), so the SHAPE is what main can check.
 */
function safePortraitPath(p) {
  if (!isStr(p, 1024)) return false;
  if (!/^[A-Za-z]:[\\/]/.test(p)) return false;
  if (p.split(/[\\/]/).includes('..')) return false;
  return MEDIA_EXT.test(p);
}

function sanitizePortrait(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = {};
  if (isStr(p.kind, 20)) out.kind = p.kind;
  if (safePortraitPath(p.path)) out.path = p.path;
  if (p.media === 'image' || p.media === 'video') out.media = p.media;
  if (isStr(p.tier, 20)) out.tier = p.tier;
  if (isNum(p.mtimeMs)) out.mtimeMs = p.mtimeMs;
  const fb = p.fallback;
  if (fb && typeof fb === 'object' && !Array.isArray(fb)) {
    out.fallback = { kind: 'placeholder' };
    if (isStr(fb.initials, 6)) out.fallback.initials = fb.initials;
    if (isNum(fb.hue)) out.fallback.hue = fb.hue;
  }
  if (p.kind === 'placeholder') {
    if (isStr(p.initials, 6)) out.initials = p.initials;
    if (isNum(p.hue)) out.hue = p.hue;
  }
  return out;
}

function sanitizeFaces(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const f of value.slice(0, SCAN_MAX)) {
    if (out.length >= MAX_FACES) break;
    if (!f || typeof f !== 'object' || !isStr(f.agent, 80)) continue;
    out.push({ agent: f.agent, images: f.images === true ? true : f.images === false ? false : null, portrait: sanitizePortrait(f.portrait) });
  }
  return out;
}

function createFaces() {
  const byOwner = new Map();
  const key = () => JSON.stringify([...byOwner.entries()]);
  return {
    set(owner, value) {
      const before = key();
      const list = sanitizeFaces(value);
      if (list.length === 0) byOwner.delete(owner); else byOwner.set(owner, list);
      return key() !== before;
    },
    drop(owner) { return byOwner.delete(owner); },
    flat() {
      const seen = new Set();
      const out = [];
      for (const list of byOwner.values()) for (const f of list) if (!seen.has(f.agent)) { seen.add(f.agent); out.push(f); }
      return out;
    },
  };
}

module.exports = { createFaces, sanitizeFaces, safePortraitPath, MAX_FACES, SCAN_MAX };
