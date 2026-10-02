'use strict';
/**
 * Tab marks (#40, DESIGN_TAB_MARKS.md): one of ten emoji on a tab, each with a
 * meaning shown on hover. Purely visual: a mark changes nothing about the tab,
 * its session or its branch.
 *
 * Pure: the set, the file's parse/serialize, set/get, prune and the menu's
 * rows. host/tab-marks-store.js reads and writes the file; app/main.js wires it.
 *
 * The file stores each mark's ID, never its emoji, so changing an emoji here
 * doesn't orphan the marks already saved.
 *
 * Branch names are somebody else's strings, `__proto__` included, so the map
 * is null-prototype and every lookup is an own-property check.
 */

const MARKS = Object.freeze([
  { id: 'review', emoji: String.fromCodePoint(0x1f440), meaning: 'Review this code' },
  { id: 'waiting', emoji: String.fromCodePoint(0x23f3), meaning: 'Waiting on a merge' },
  { id: 'urgent', emoji: String.fromCodePoint(0x1f525), meaning: 'Urgent / do next' },
  { id: 'testing', emoji: String.fromCodePoint(0x1f9ea), meaning: 'Testing / hand check' },
  { id: 'bug', emoji: String.fromCodePoint(0x1f41b), meaning: 'Has a bug to chase' },
  { id: 'parked', emoji: String.fromCodePoint(0x1f4a4), meaning: 'Parked' },
  { id: 'decide', emoji: String.fromCodePoint(0x1f914), meaning: 'Needs a decision' },
  { id: 'docs', emoji: String.fromCodePoint(0x1f4dd), meaning: 'Docs / write-up' },
  { id: 'ship', emoji: String.fromCodePoint(0x1f680), meaning: 'Ready to ship' },
  { id: 'star', emoji: String.fromCodePoint(0x2b50), meaning: 'Favourite / keep an eye on' },
].map(Object.freeze));

const VERSION = 1;
const byId = new Map(MARKS.map(x => [x.id, x]));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isBranch = b => typeof b === 'string' && b !== '';
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function emptyMarks() {
  return { marks: Object.create(null) };
}

function copyOf(store) {
  const out = emptyMarks();
  if (store && store.marks) for (const b of Object.keys(store.marks)) out.marks[b] = store.marks[b];
  return out;
}

/**
 * `{ ok: true, store }`, or `{ ok: false }` for anything that isn't a version-1
 * marks object. Refused, never read as empty: a file this code doesn't
 * understand is the person's data, and saving over it would lose it.
 */
function parseMarks(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false }; }
  if (!isPlainObject(data) || data.version !== VERSION || !isPlainObject(data.marks)) return { ok: false };
  const store = emptyMarks();
  for (const b of Object.keys(data.marks)) {
    if (isBranch(b) && byId.has(data.marks[b])) store.marks[b] = data.marks[b];
  }
  return { ok: true, store };
}

function serializeMarks(store) {
  const marks = {};
  // defineProperty, not assignment: `marks.__proto__ = id` would set the
  // prototype instead of writing a key, and the mark would vanish from the file.
  for (const b of Object.keys(store.marks)) {
    Object.defineProperty(marks, b, { value: store.marks[b], enumerable: true, writable: true, configurable: true });
  }
  return JSON.stringify({ version: VERSION, marks }, null, 2) + '\n';
}

/** `{ id, emoji, meaning }` for the branch's mark, or null. */
function markFor(store, branch) {
  if (!store || !store.marks || !isBranch(branch) || !has(store.marks, branch)) return null;
  const x = byId.get(store.marks[branch]);
  return x ? { id: x.id, emoji: x.emoji, meaning: x.meaning } : null;
}

/** A new store with `branch` marked `id`, or cleared when `id` is null. */
function setMark(store, branch, id) {
  if (!isBranch(branch)) throw new TypeError('setMark: branch must be a non-empty string');
  if (id !== null && !byId.has(id)) throw new TypeError(`setMark: unknown mark ${String(id)}`);
  const out = copyOf(store);
  if (id === null) delete out.marks[branch];
  else out.marks[branch] = id;
  return out;
}

/**
 * The store without marks on branches that no longer exist. `liveBranches`
 * that isn't a list means "not known", and an unknown never deletes.
 */
function pruneMarks(store, liveBranches) {
  if (!Array.isArray(liveBranches)) return copyOf(store);
  const live = new Set(liveBranches);
  const out = emptyMarks();
  for (const b of Object.keys(store.marks)) if (live.has(b)) out.marks[b] = store.marks[b];
  return out;
}

function markCount(store) {
  return store && store.marks ? Object.keys(store.marks).length : 0;
}

/**
 * The branch names in `git for-each-ref --format=%(refname) refs/heads`, or
 * null. Full refnames, never `refname:short`, which turns a branch that shares
 * a tag's name into `heads/<name>`. An empty answer is null: a repo always has
 * a branch, so "none" means the answer is wrong, and pruning on it would wipe
 * every mark.
 */
function liveBranchesFrom(text) {
  if (typeof text !== 'string') return null;
  const PREFIX = 'refs/heads/';
  const out = text.split(/\r?\n/).filter(l => l.startsWith(PREFIX) && l.length > PREFIX.length)
    .map(l => l.slice(PREFIX.length));
  return out.length ? out : null;
}

/**
 * What the tab's **Mark ▸** submenu offers. `state` is the file's load state
 * (host/tab-marks-store.js): only 'ok' and 'missing' may be written over.
 */
function markMenuModel(store, branch, state) {
  const current = markFor(store, branch);
  let why = null;
  if (state !== 'ok' && state !== 'missing') why = 'marks file unreadable';
  else if (!isBranch(branch)) why = 'no branch';
  return {
    enabled: why === null,
    why,
    rows: MARKS.map(x => ({ id: x.id, label: `${x.emoji}  ${x.meaning}`, checked: !!current && current.id === x.id })),
    canClear: why === null && current !== null,
  };
}

module.exports = {
  MARKS, emptyMarks, parseMarks, serializeMarks, markFor, setMark, pruneMarks, markCount, liveBranchesFrom,
  markMenuModel,
};
