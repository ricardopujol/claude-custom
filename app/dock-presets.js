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

// Where `name` sits in a clean list, ignoring case and padding; -1 when it isn't there or isn't a string.
function indexOf(list, name) {
  if (typeof name !== 'string') return -1;
  const want = keyOf(name.trim());
  return list.findIndex(p => keyOf(p.name) === want);
}

/** The preset called `name` (ignoring case), or null. */
function find(list, name) {
  const clean = cleanPresets(list);
  const at = indexOf(clean, name);
  return at < 0 ? null : clean[at];
}

const refuse = reason => ({ ok: false, reason });

/**
 * Save `layout` under `name`. A name the list already has (ignoring case) is refused as `taken` unless
 * `replace` is true, which replaces in place and takes the newly typed name. Order of refusals: name, layout,
 * taken, full -- the first one the user can fix.
 */
function savePreset(list, name, layout, { replace = false } = {}) {
  const clean = cleanPresets(list);
  const nm = checkName(name);
  if (nm === null) return refuse('name');
  const copy = copyLayout(layout);
  if (copy === null) return refuse('layout');
  const at = indexOf(clean, nm);
  if (at >= 0) {
    if (!replace) return refuse('taken');
    return { ok: true, list: clean.map((p, i) => (i === at ? { name: nm, layout: copy } : p)) };
  }
  if (clean.length >= MAX_PRESETS) return refuse('full');
  return { ok: true, list: [...clean, { name: nm, layout: copy }] };
}

/** Rename `from` to `to`. Another case of its own name is fine; a name another preset has is `taken`. */
function renamePreset(list, from, to) {
  const clean = cleanPresets(list);
  const at = indexOf(clean, from);
  if (at < 0) return refuse('missing');
  const nm = checkName(to);
  if (nm === null) return refuse('name');
  const other = indexOf(clean, nm);
  if (other >= 0 && other !== at) return refuse('taken');
  return { ok: true, list: clean.map((p, i) => (i === at ? { name: nm, layout: p.layout } : p)) };
}

function deletePreset(list, name) {
  const clean = cleanPresets(list);
  const at = indexOf(clean, name);
  if (at < 0) return refuse('missing');
  return { ok: true, list: clean.filter((_, i) => i !== at) };
}

// A window of 1200 x 750 drawn into the small picture beside each name.
const THUMB = { width: 44, height: 28, window: { width: 1200, height: 750 } };
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const tenth = v => Math.round(v * 10) / 10;

/**
 * The boxes of the little picture of a layout: its terminal and groups, fitted into a 1200 x 750 window and
 * scaled to 44 x 28. `fitFn(layout, ids, viewport)` is the page's (normalize, then dockTree.fit), so a layout
 * naming a module this build lacks still draws. Never throws; a fit that fails or answers junk draws nothing.
 * Floating panels are not drawn here (their shape belongs to D2).
 * @returns {{ kind: 'term'|'group', x: number, y: number, w: number, h: number }[]}
 */
function thumbBoxes(layout, ids, fitFn) {
  if (typeof fitFn !== 'function') return [];
  let fitted;
  try { fitted = fitFn(layout, ids, { ...THUMB.window }); } catch { return []; }
  if (!isObject(fitted) || !Array.isArray(fitted.boxes)) return [];
  const sx = THUMB.width / THUMB.window.width;
  const sy = THUMB.height / THUMB.window.height;
  const out = [];
  for (const b of fitted.boxes) {
    if (!isObject(b) || (b.kind !== 'term' && b.kind !== 'group') || !isObject(b.rect)) continue;
    const { x, y, width, height } = b.rect;
    if (![x, y, width, height].every(isNum)) continue;
    const bx = tenth(Math.min(Math.max(x * sx, 0), THUMB.width - 1));
    const by = tenth(Math.min(Math.max(y * sy, 0), THUMB.height - 1));
    out.push({
      kind: b.kind, x: bx, y: by,
      w: Math.min(Math.max(tenth(width * sx), 1), tenth(THUMB.width - bx)),
      h: Math.min(Math.max(tenth(height * sy), 1), tenth(THUMB.height - by)),
    });
  }
  return out;
}

/**
 * The store's answer to `layout-presets:get` -> what the page does. Only MISSING is "no presets yet" (the first
 * save creates the file); an unreadable or corrupt file (antivirus holding it, EBUSY) is "couldn't read": never an
 * empty list, because saving over it would destroy the presets that are really there.
 */
function afterGet(answer) {
  const unusable = { usable: false, list: [] };
  if (!isObject(answer)) return unusable;
  if (answer.status === 'missing') return { usable: true, list: [] };
  if (answer.status === 'ok' && Array.isArray(answer.layout)) return { usable: true, list: cleanPresets(answer.layout) };
  return unusable;
}

/** What `harness.layoutPresets.set` answered: main echoes the list once written, and answers null when it refused or failed. */
function presetsSaved(answer) { return Array.isArray(answer); }

const WORDS = {
  name: 'Use 1 to 40 characters, with no line breaks.',
  taken: 'A preset with that name already exists.',
  full: 'You\'ve reached the limit of 32 presets. Delete one first.',
  missing: 'That preset isn\'t there any more.',
  layout: 'This layout can\'t be saved as a preset.',
  unreadable: 'The saved presets couldn\'t be read, so saving is off until they can be.',
};
/** The words for a refusal reason. */
function refusalText(reason) {
  return Object.prototype.hasOwnProperty.call(WORDS, reason) ? WORDS[reason] : 'That couldn\'t be done.';
}

const API = {
  NAME_MAX, MAX_PRESETS, MAX_PRESET_BYTES, THUMB, checkName, cleanPresets, find, savePreset, renamePreset, deletePreset,
  thumbBoxes, afterGet, presetsSaved, refusalText,
};

// One namespace on the page (`window.dockPresets`), not loose globals.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockPresets = API;
})(typeof window !== 'undefined' ? window : globalThis);
