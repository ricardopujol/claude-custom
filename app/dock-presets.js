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
// Two names are the same name when they look the same ignoring case: NFC first (a composed and a decomposed
// e-acute are one name), then lower-case. Lower-casing, not full case folding: German sharp s and SS stay two names.
const keyOf = name => name.normalize('NFC').toLowerCase().normalize('NFC');
// Control characters (Cc), format characters (Cf: bidi overrides, zero-width, soft hyphen) and the line and
// paragraph separators (Zl, Zp): none can be seen, and a bidi override can make a name read backwards.
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const NAME_SCAN_MAX = 1024;             // a bad sender can't make main normalize a megabyte

/** The name as stored (NFC, trimmed), or null when it is not 1 to 40 characters (counted after NFC) free of invisible ones. */
function checkName(raw) {
  if (typeof raw !== 'string' || raw.length > NAME_SCAN_MAX) return null;
  const name = raw.normalize('NFC').trim();
  const length = [...name].length;
  if (length < 1 || length > NAME_MAX) return null;
  if (UNSEEN.test(name)) return null;
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

// The whole stored list is at most this many bytes of JSON. Derived, not chosen: 32 entries, each a layout of at
// most 8192 bytes plus its name (40 characters, at most 160 bytes in UTF-8), its id (at most 64) and the JSON around
// them (under 50), so 512 bytes of room an entry. Every list the rules above allow is under it; main refuses nothing that fits.
const MAX_LIST_BYTES = MAX_PRESETS * (MAX_PRESET_BYTES + 512);

// Which preset a question is about (BACKLOG #59): a name can pass to another preset while a question about it is
// open in another window, so every preset carries an id. It is given when the preset is saved, kept by rename and
// replace, and never shown. A stored id that isn't 1 to 64 characters of text counts as none.
const ID_MAX = 64;
const isId = v => typeof v === 'string' && v.length >= 1 && v.length <= ID_MAX;
const randomId = () => globalThis.crypto.randomUUID();

/**
 * The entries of a stored value this build can use, each with where it sits in the stored array (`at`) and its id
 * (null when it has none): a plain object with a name that passes checkName, a layout that passes copyLayout, and a
 * name no earlier entry has (ignoring case: the first wins). Everything else in the array is left alone by every
 * operation below.
 */
function usable(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set();
  raw.forEach((entry, at) => {
    if (!isObject(entry)) return;
    const name = checkName(entry.name);
    if (name === null || seen.has(keyOf(name))) return;
    const layout = copyLayout(entry.layout);
    if (layout === null) return;
    seen.add(keyOf(name));
    out.push({ name, layout, id: isId(entry.id) ? entry.id : null, at });
  });
  return out;
}

/** Anything stored -> the list the menu shows: usable entries only, as { name, layout, id? }. Display only; never written back. */
function cleanPresets(raw) {
  return usable(raw).map(({ name, layout, id }) => (id === null ? { name, layout } : { name, layout, id }));
}

// The ONE rule for who needs an id: a usable preset with none, or with one an earlier preset already has.
// `taken` is every id that is good as it stands, `lacking` the presets that need a new one.
function sortIds(raw) {
  const taken = new Set();
  const lacking = [];
  for (const p of usable(raw)) {
    if (p.id !== null && !taken.has(p.id)) taken.add(p.id);
    else lacking.push(p);
  }
  return { taken, lacking };
}

/** True when a usable preset in `raw` has no id, or one an earlier preset already has: what withIds would mend. */
function needsIds(raw) {
  return sortIds(raw).lacking.length > 0;
}

/**
 * `raw` with an id given to every usable preset that has none, or a bad one, or one an earlier preset already has.
 * The SAME array comes back when there is nothing to give (so a caller can tell whether to write), and entries this
 * build can't use are never touched. An id that can't be made (`newId` throws or answers junk) is left for next time.
 */
function withIds(raw, newId = randomId) {
  if (!Array.isArray(raw)) return raw;
  const { taken, lacking } = sortIds(raw);
  const give = new Map();
  for (const p of lacking) {
    let id;
    try { id = newId(); } catch { continue; }
    if (!isId(id) || taken.has(id)) continue;
    taken.add(id);
    give.set(p.at, id);
  }
  return give.size === 0 ? raw : raw.map((e, i) => (give.has(i) ? { ...e, id: give.get(i) } : e));
}

/** What the menu shows of a stored value, and how many stored entries it keeps without showing (another version's). */
function describe(raw) {
  const list = cleanPresets(raw);
  return { list, kept: Array.isArray(raw) ? raw.length - list.length : 0 };
}

// Where `name` sits in a list of usable entries, ignoring case and padding; -1 when it isn't there or isn't a string.
function indexOf(list, name) {
  if (typeof name !== 'string' || name.length > NAME_SCAN_MAX) return -1;
  const want = keyOf(name.trim());
  return list.findIndex(p => keyOf(p.name) === want);   // stored names are already NFC and trimmed
}

/** The preset called `name` (ignoring case), or null. */
function find(raw, name) {
  const shown = cleanPresets(raw);
  const at = indexOf(shown, name);
  return at < 0 ? null : shown[at];
}

const refuse = reason => ({ ok: false, reason });

// A question carries the id of the preset it was asked about. The preset now under that name must have that very id,
// or the answer is `changed`. No id (null: the page was shown a preset with none, as an older build writes them) is
// no proof of anything, because two presets with none look the same: it fails closed, and the page re-reads the list
// (the read gives every preset an id) so the next question can be answered. Only a direct caller of the three
// functions below that leaves `id` out altogether (the option, not the request) goes by name; applyOp never does.
const stale = (entry, id) => id !== undefined && !(isId(id) && entry.id === id);
const bytesOf = list => { try { return new TextEncoder().encode(JSON.stringify(list)).length; } catch { return Infinity; } };

// A list that grew must still fit the byte cap. Thinning (a delete) is never refused: it is how a list gets under.
const grown = list => (bytesOf(list) > MAX_LIST_BYTES ? refuse('full') : { ok: true, list });

/**
 * Save `layout` under `name`, over the STORED array `raw` (not the cleaned view): every other entry comes back
 * exactly as it was. A name the list already has (ignoring case) is refused as `taken` unless `replace` is true,
 * which replaces in place and takes the newly typed name (fields this build doesn't know stay). The cap of 32
 * counts every stored entry. A replace carrying the `id` of another preset than the one under that name is `changed`.
 * Order of refusals: unreadable, name, layout, taken, changed, full -- the first one the user can fix.
 */
function savePreset(raw, name, layout, { replace = false, id } = {}) {
  if (!Array.isArray(raw)) return refuse('unreadable');
  const nm = checkName(name);
  if (nm === null) return refuse('name');
  const copy = copyLayout(layout);
  if (copy === null) return refuse('layout');
  const shown = usable(raw);
  const at = indexOf(shown, nm);
  if (at >= 0) {
    if (!replace) return refuse('taken');
    if (stale(shown[at], id)) return refuse('changed');
    const where = shown[at].at;
    return grown(raw.map((e, i) => (i === where ? { ...e, name: nm, layout: copy } : e)));
  }
  if (raw.length >= MAX_PRESETS) return refuse('full');
  return grown([...raw, { name: nm, layout: copy }]);
}

/**
 * Rename `from` to `to`; the entry keeps its layout, its id and any field this build doesn't know. Another case of
 * its own name is fine; a name another preset has is `taken`; an `id` that isn't the one `from` has is `changed`.
 */
function renamePreset(raw, from, to, { id } = {}) {
  if (!Array.isArray(raw)) return refuse('unreadable');
  const shown = usable(raw);
  const at = indexOf(shown, from);
  if (at < 0) return refuse('missing');
  if (stale(shown[at], id)) return refuse('changed');
  const nm = checkName(to);
  if (nm === null) return refuse('name');
  const other = indexOf(shown, nm);
  if (other >= 0 && other !== at) return refuse('taken');
  const where = shown[at].at;
  return grown(raw.map((e, i) => (i === where ? { ...e, name: nm } : e)));
}

/** Delete `name`; an `id` that isn't the one it has is `changed`. */
function deletePreset(raw, name, { id } = {}) {
  if (!Array.isArray(raw)) return refuse('unreadable');
  const shown = usable(raw);
  const at = indexOf(shown, name);
  if (at < 0) return refuse('missing');
  if (stale(shown[at], id)) return refuse('changed');
  const where = shown[at].at;
  return { ok: true, list: raw.filter((_, i) => i !== where) };
}

// A request that names no id is a question that was never tied to a preset: null, so it is refused as `changed`.
const idOf = r => (r.id === undefined ? null : r.id);
const OPS = {
  save: (raw, r) => savePreset(raw, r.name, r.layout, { replace: r.replace === true, id: idOf(r) }),
  rename: (raw, r) => renamePreset(raw, r.name, r.to, { id: idOf(r) }),
  delete: (raw, r) => deletePreset(raw, r.name, { id: idOf(r) }),
};

/**
 * One operation request -> its result over the stored array: `{ op: 'save' | 'rename' | 'delete', name, to?,
 * layout?, replace?, id? }`. This is what main runs, under the store's lock, on a fresh read: the page sends what the
 * user did, never a list. The id is checked against the list as it was read, and only then are ids given (withIds)
 * to a new preset and to any stored before ids existed.
 */
function applyOp(raw, req, { newId = randomId } = {}) {
  if (!isObject(req) || typeof req.op !== 'string' || !Object.prototype.hasOwnProperty.call(OPS, req.op)) return refuse('op');
  const r = OPS[req.op](raw, req);
  return r.ok ? { ok: true, list: withIds(r.list, newId) } : r;
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
  const unusable = { usable: false, list: [], kept: 0 };
  if (!isObject(answer)) return unusable;
  if (answer.status === 'missing') return { usable: true, list: [], kept: 0 };
  if (answer.status === 'ok' && Array.isArray(answer.layout)) return { usable: true, ...describe(answer.layout) };
  return unusable;
}

/**
 * What `harness.layoutPresets.op` answered -> the page's view of it. Main answers { ok: true, list } (the stored
 * array, which may hold entries this build can't show) or { ok: false, reason }; anything else (no answer, a
 * sender main refused, a call that threw) is `failed`, never taken for success.
 */
function afterOp(answer) {
  if (isObject(answer) && answer.ok === true && Array.isArray(answer.list)) return { ok: true, ...describe(answer.list) };
  if (isObject(answer) && answer.ok === false && typeof answer.reason === 'string') return { ok: false, reason: answer.reason };
  return { ok: false, reason: 'failed' };
}

/** The line under the list that says presets this build can't show are still in the file ('' when none). */
function keptText(n) {
  if (!(n > 0)) return '';
  return n === 1 ? '1 preset from another version is kept' : `${n} presets from another version are kept`;
}

const WORDS = {
  name: 'Use 1 to 40 characters, with no line breaks or other invisible characters.',
  taken: 'A preset with that name already exists.',
  full: 'You\'ve reached the limit of 32 presets. Delete one first.',
  missing: 'That preset isn\'t there any more.',
  layout: 'This layout can\'t be saved as a preset.',
  unreadable: 'The saved presets couldn\'t be read, so saving is off until they can be.',
  failed: 'The presets couldn\'t be saved.',
  version: 'This preset can\'t be read by this version.',
  changed: 'That preset changed since you asked. Nothing was changed.',
};
/** The words for a refusal reason. */
function refusalText(reason) {
  return Object.prototype.hasOwnProperty.call(WORDS, reason) ? WORDS[reason] : 'That couldn\'t be done.';
}

// A question that went stale says what was NOT done, by the question that was open.
const NOT_DONE = { delete: 'deleted', rename: 'renamed', replace: 'replaced' };
/** The words for a question whose preset changed under it (`mode`: delete, rename or replace). */
function changedText(mode) {
  return Object.prototype.hasOwnProperty.call(NOT_DONE, mode)
    ? `That preset changed since you asked. Nothing was ${NOT_DONE[mode]}.`
    : refusalText('changed');
}

// --- the Presets section's state: what the open Window menu is doing ----------------------------------
//
// { mode, name?, id?, text?, error?, focus?, select? }. mode is 'idle', 'save' (the name field), 'replace' (asking to
// replace `name`), 'rename' (`name`'s field) or 'delete' (asking about `name`); `id` is the id of the preset the
// question is about, sent with the answer so main can tell it is still that one. `error` is the line the user sees;
// `focus` is where focus goes after the next redraw (one-shot: the page sends `focused` once it has moved it) and
// `select` says the field's text is selected on that focus (only when the field opens, never on a redraw).
// Focus targets: { kind: 'field' | 'confirm' | 'save-open' } | { kind: 'row', name } | { kind: 'act', name, act }.

const sameName = (a, b) => typeof a === 'string' && typeof b === 'string' && keyOf(a.trim()) === keyOf(b.trim());
const nameIn = (list, name) => (Array.isArray(list) ? list.find(p => isObject(p) && sameName(p.name, name)) : undefined);
const gone = name => `'${name}' no longer exists`;
const IDLE_AT = focus => ({ mode: 'idle', focus, select: false });
const CLOSED = error => ({ mode: 'idle', error, focus: { kind: 'save-open' }, select: false });
// The id a question remembers, only when the event brought one (none: the question can't be proven to be about one
// preset, which main refuses when it is confirmed).
const withId = (state, id) => (id === undefined ? state : { ...state, id });
// The preset a question is about has passed to another one: its name now belongs to a preset with another id.
// Only a question that holds a real id can say so: one opened with none (null) is refused by main when confirmed, and a
// preset that merely gained its first id (another window's op, a get's write-back, this window's own case-only rename)
// is the same preset, so it isn't read as a swap.
const swapped = (state, list) => { const p = nameIn(list, state.name); return isId(state.id) && !!p && p.id !== state.id; };
const rowFocus = (list, name) => { const p = nameIn(list, name); return p ? { kind: 'row', name: p.name } : { kind: 'save-open' }; };

// The row focus lands on once `name` is deleted: the one after it, else the one before, else Save this layout.
function afterDelete(before, after, name) {
  const at = Array.isArray(before) ? before.findIndex(p => isObject(p) && sameName(p.name, name)) : -1;
  for (const near of at < 0 ? [] : [before[at + 1], before[at - 1]]) if (near && nameIn(after, near.name)) return { kind: 'row', name: nameIn(after, near.name).name };
  return { kind: 'save-open' };
}

function reduceMenu(state, event) {
  if (!isObject(event) || typeof event.type !== 'string') return state;
  switch (event.type) {
    case 'open':
      if (event.mode === 'save') return { mode: 'save', text: '', error: null, focus: { kind: 'field' }, select: true };
      if (event.mode === 'rename') return withId({ mode: 'rename', name: event.name, text: event.name, error: null, focus: { kind: 'field' }, select: true }, event.id);
      if (event.mode === 'delete') return withId({ mode: 'delete', name: event.name, error: null, focus: { kind: 'confirm' }, select: false }, event.id);
      return state;
    case 'typed': return { ...state, text: event.text };
    case 'focused': return { ...state, focus: null, select: false };
    case 'close': return { mode: 'idle' };
    case 'cancel':
      if (state.mode === 'save' || state.mode === 'replace') return IDLE_AT({ kind: 'save-open' });
      if (state.mode === 'rename' || state.mode === 'delete') return IDLE_AT({ kind: 'act', name: state.name, act: state.mode });
      return state;
    case 'taken': return withId({ mode: 'replace', name: event.name, text: event.text, error: null, focus: { kind: 'confirm' }, select: false }, event.id);
    case 'notice': return { mode: 'idle', error: event.error, focus: event.focus || null, select: false };
    case 'list':
      // Another window removed the preset an open rename / delete / replace is about, or put another preset under
      // its name: back to the plain list, and say so (the question or field would otherwise vanish without a word,
      // or worse, stay open over a preset the user never asked about).
      if (state.mode === 'rename' || state.mode === 'delete' || state.mode === 'replace') {
        if (!nameIn(event.list, state.name)) return CLOSED(gone(state.name));
        if (swapped(state, event.list)) return CLOSED(changedText(state.mode));
      }
      return state;
    case 'answer': return afterAnswer(state, event);
    default: return state;
  }
}

function afterAnswer(state, { req, result, before, after }) {
  if (!isObject(req) || !isObject(result)) return state;
  if (result.ok === true) {
    if (req.op === 'delete') return IDLE_AT(afterDelete(before, after, req.name));
    return IDLE_AT(rowFocus(after, req.op === 'rename' ? req.to : req.name));
  }
  if (result.reason === 'unreadable') return IDLE_AT(null);
  if (result.reason === 'missing') return CLOSED(gone(req.name));
  if (result.reason === 'changed') return CLOSED(changedText(state.mode));
  // A save under a name that exists asks to replace it, naming the preset that would go (its own spelling is kept),
  // and remembering which one that is: the one the window shows now (`after`, the list when the answer arrived, so a
  // push that landed in flight counts). One this window never saw is asked about as id-less (null), so main refuses
  // the replace as `changed` rather than overwrite a preset nobody here was shown.
  if (result.reason === 'taken' && state.mode === 'save' && req.op === 'save') {
    const have = nameIn(after, req.name);
    return reduceMenu(state, { type: 'taken', name: have ? have.name : req.name, text: req.name, id: have && isId(have.id) ? have.id : null });
  }
  const back = state.mode === 'save' || state.mode === 'rename' ? { kind: 'field' } : { kind: 'confirm' };
  return { ...state, error: refusalText(result.reason), focus: back, select: false };
}

/** True for a refusal that means this window's list is out of date (`changed`, `missing`): the page asks main for the list again, so the next question is about what is really there. */
const needsResync = reason => reason === 'changed' || reason === 'missing';

/** An unreadable list is asked for again every time the Window menu opens; a usable or still-loading one is not. */
function needsRetry(presets) {
  return isObject(presets) && presets.loaded === true && presets.usable === false;
}

// What assistive tech reads for each control: always the preset it acts on, never two the same.
const LABELS = {
  'apply': n => `Apply preset '${n}'`,
  'rename-open': n => `Rename preset '${n}'`,
  'delete-open': n => `Delete preset '${n}'`,
  'rename-field': n => `New name for preset '${n}'`,
  'rename-commit': n => `Rename '${n}' to the new name`,
  'rename-cancel': n => `Cancel renaming '${n}'`,
  'delete-confirm': n => `Delete '${n}' now`,
  'delete-cancel': n => `Cancel deleting '${n}'`,
  'replace-confirm': n => `Replace '${n}'`,
  'replace-cancel': n => `Cancel replacing '${n}'`,
};
/** The accessible name of a preset control (`kind` is a key of LABELS). */
function labelFor(kind, name) {
  return Object.prototype.hasOwnProperty.call(LABELS, kind) ? LABELS[kind](String(name)) : String(name);
}

/**
 * A preset's layout as it will be APPLIED: the version-2 tree, or the older L1 zones shape, which `readAny` (the
 * page's dockTree.readAny) migrates. Anything else (a version this build doesn't know, a stray object) is refused:
 * readAny would answer the DEFAULT layout for it, and applying that would silently replace the user's layout.
 */
function presetLayout(layout, ids, readAny) {
  const readable = isObject(layout) && (layout.version === 2 || isObject(layout.zones));
  if (!readable || typeof readAny !== 'function') return refuse('version');
  try { return { ok: true, layout: readAny(layout, ids) }; } catch { return refuse('version'); }
}

const API = {
  NAME_MAX, MAX_PRESETS, MAX_PRESET_BYTES, MAX_LIST_BYTES, ID_MAX, THUMB, checkName, nameKey: keyOf, cleanPresets, describe, find,
  needsIds, withIds, savePreset, renamePreset, deletePreset, applyOp,
  thumbBoxes, afterGet, afterOp, keptText, refusalText, changedText, reduceMenu, needsRetry, needsResync, labelFor, presetLayout,
};

// One namespace on the page (`window.dockPresets`), not loose globals.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockPresets = API;
})(typeof window !== 'undefined' ? window : globalThis);
