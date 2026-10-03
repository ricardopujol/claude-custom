'use strict';
/**
 * Layout presets (BACKLOG #53, dockable panels D3): a preset is { name, layout }, where `layout` is a
 * placement (the version-2 tree object), never a window's selection. The list is install-wide and lives in
 * main's store under `layout-presets`; this module holds every rule about it and nothing else.
 *
 * Pure. Every function takes a list and returns a NEW one (or a named refusal), and none throws: the list
 * comes off disk, so anything can be in it. A layout is stored as it was saved and only normalized when it is
 * APPLIED (dockTree.normalize), because only the page knows which modules this build has.
 */

/*
 * WRAPPED IN AN IIFE: the renderer loads this as a plain <script> sharing one global scope
 * (test/renderer-scope.test.js). The page sees one name, `dockPresets`.
 */
(function (root) {

const NAME_MAX = 40;
const MAX_PRESETS = 32;
const MAX_PRESET_BYTES = 8192;          // one layout is well under 1 KB; this stops a bad sender bloating the store

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const keyOf = name => name.toLowerCase();

/** The trimmed name, or null when it is not 1 to 40 characters without a control character. */
function checkName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > NAME_MAX) return null;
  if (/\p{Cc}/u.test(name)) return null;
  return name;
}

// A deep copy that is also the size check: null when the layout is not an object, cannot be serialized, or is too big.
function copyLayout(layout) {
  if (!isObject(layout)) return null;
  let json;
  try { json = JSON.stringify(layout); } catch { return null; }
  if (typeof json !== 'string' || new TextEncoder().encode(json).length > MAX_PRESET_BYTES) return null;
  return JSON.parse(json);
}

/** Anything stored -> a clean list: valid entries only, names unique ignoring case (the first wins), at most 32. */
function cleanPresets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (out.length >= MAX_PRESETS) break;
    if (!isObject(entry)) continue;
    const name = checkName(entry.name);
    if (name === null || seen.has(keyOf(name))) continue;
    const layout = copyLayout(entry.layout);
    if (layout === null) continue;
    seen.add(keyOf(name));
    out.push({ name, layout });
  }
  return out;
}

const API = { NAME_MAX, MAX_PRESETS, MAX_PRESET_BYTES, checkName, cleanPresets };

// One namespace on the page (`window.dockPresets`), not loose globals.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockPresets = API;
})(typeof window !== 'undefined' ? window : globalThis);
