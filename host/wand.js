'use strict';
/**
 * The wand's pure core (BACKLOG #51): favourite skills as emoji buttons. Pure: no fs, no clock, no
 * globals. host/wand-control.js is the only place that touches the disk; app/wand-display.js draws.
 *
 * THE STORE, `.harness/state/wand.json`, key 'wand':
 *
 *     { "version": 1, "favourites": [ { "id", "emoji", "skill", "args", "typeOnly" } ] }
 *
 * `typeOnly` (BACKLOG #61) is optional and additive, so `version` stays 1: a click normally TYPES the command
 * and presses Enter (app/submit-gate.js); a type-only favourite is for a skill that takes an argument typed at
 * run time, and keeps the old behaviour (type, leave the Enter to the person). A file without it loads as
 * false. A value that is not a boolean is an invalid favourite (dropped and counted, never coerced: `"false"`
 * must not become a submitting favourite or a silent flip).
 *
 * INSTALL-WIDE, one global set (Ricardo's pick; per-project extras are a later design), like the
 * tool belt next to it.
 *
 * THE RULE THIS MODULE EXISTS FOR: a file that is not a wand store is NEVER an empty grid.
 * An unreadable or corrupt file, a file of the wrong shape and a file from a newer build all load as
 * `unavailable` with the reason and `favourites: null` -- an empty grid would read as "you have no
 * favourites" and the next edit would write over the real ones. Only a MISSING file is the default
 * set, and only a list the user emptied on purpose is `ok` and empty.
 *
 * Items are validated one by one on the way in: a favourite that is not valid (not one emoji, a skill
 * that can never be typed as a slash command, an argument with a newline) is dropped and COUNTED, so
 * the panel can say so; the rest keep their order. A missing or repeated id is repaired, never a
 * reason to lose the favourite.
 *
 * WHAT IS VALID, and why: everything a favourite holds ends up typed into the CLI's input box
 * through app/top-bar-display.js planTyping, whose one-line slash-command rule is the single source of
 * truth. SKILL_NAME (host/wand-skills.js) is pinned to it by a test, and the arguments are held to the
 * same rule: one line, no control character, whitespace collapsed (the read-back compares collapsed
 * text, so a double space would fail a type that was fine).
 */

const { SKILL_NAME } = require('./wand-skills');

const VERSION = 1;
const MAX_FAVOURITES = 48;
const MAX_ARGS = 200;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const AUTO_ID_RE = /^f(\d{1,9})$/;

const isStr = (x) => typeof x === 'string';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

const DEFAULTS = Object.freeze([
  Object.freeze({ emoji: '🌙', skill: 'bedtime' }),
  Object.freeze({ emoji: '✅', skill: 'checkpoint' }),
  Object.freeze({ emoji: '🔀', skill: 'merged' }),
  Object.freeze({ emoji: '💡', skill: 'brainstorming' }),
]);

function defaultFavourites() {
  return DEFAULTS.map((d, i) => ({ id: `f${i + 1}`, emoji: d.emoji, skill: d.skill, args: '', typeOnly: false }));
}

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/**
 * Exactly one emoji: one grapheme cluster (a ZWJ family, a flag, a skin-toned hand are each one) that
 * is a pictograph, a flag or a keycap. Plain text, two emoji and the empty string are not.
 */
function isOneEmoji(s) {
  if (!isStr(s) || s === '' || s.length > 32) return false;
  if (segmenter) {
    let n = 0;
    for (const _ of segmenter.segment(s)) { if (++n > 1) return false; }       // eslint-disable-line no-unused-vars
  }
  return /^\p{Extended_Pictographic}/u.test(s)
    || /^\p{Regional_Indicator}{2}$/u.test(s)
    || /^[0-9#*]️?⃣$/u.test(s);
}

/** The arguments, collapsed and trimmed; '' for none; null for anything that cannot be typed on one line. */
function cleanArgs(args) {
  if (args === undefined || args === null) return '';
  // Control (C0 and C1: U+0085 and U+009B among them), format (zero-width, soft hyphen), line and paragraph
  // separators: none is printable text, and any could submit or edit something else (Dexter D7). A tab collapses.
  if (!isStr(args) || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(args.replace(/\t/g, ' '))) return null;
  const t = args.replace(/\s+/g, ' ').trim();
  return t.length > MAX_ARGS ? null : t;
}

/** `/skill` or `/skill args`: what a click types. Null when it is not a favourite. */
function commandOf(fav) {
  if (!isObj(fav) || !isStr(fav.skill)) return null;
  return isStr(fav.args) && fav.args !== '' ? `/${fav.skill} ${fav.args}` : `/${fav.skill}`;
}

function freshId(used) {
  let max = 0;
  for (const id of used) {
    const m = AUTO_ID_RE.exec(id);
    if (m && Number(m[1]) > max) max = Number(m[1]);
  }
  let n = max + 1;
  while (used.has(`f${n}`)) n++;
  return `f${n}`;
}

const nextId = (favs) => freshId(new Set((Array.isArray(favs) ? favs : []).map(f => f && f.id)));

/** One favourite from untrusted input: { emoji, skill, args, typeOnly } (and the id the caller checks), or null. */
function readFavourite(raw) {
  if (!isObj(raw)) return null;
  if (!isOneEmoji(raw.emoji)) return null;
  if (!isStr(raw.skill) || !SKILL_NAME.test(raw.skill)) return null;
  const args = cleanArgs(raw.args);
  if (args === null) return null;
  if (raw.typeOnly !== undefined && typeof raw.typeOnly !== 'boolean') return null;
  return { emoji: raw.emoji, skill: raw.skill, args, typeOnly: raw.typeOnly === true };
}

// `transient`: only an UNREADABLE read (a handle held for a moment) is worth retrying; corrupt, wrong shape and
// a newer version are what they are until somebody fixes the file.
function unavailable(reason, transient = false) {
  return { status: 'unavailable', favourites: null, reason, dropped: 0, transient };
}

/**
 * store.readState()'s answer -> what the wand shows.
 *   { status: 'missing',     favourites: <the default set> }
 *   { status: 'ok',          favourites: [...], dropped }       (maybe deliberately empty)
 *   { status: 'unavailable', favourites: null,  reason }        (never an empty list)
 */
function load(state) {
  if (!isObj(state)) return unavailable('the wand file could not be read');
  if (state.status === 'missing') return { status: 'missing', favourites: defaultFavourites(), reason: null, dropped: 0, transient: false };
  if (state.status === 'corrupt') return unavailable('the wand file is not valid JSON');
  if (state.status === 'unreadable') {
    const e = state.error;
    const why = e && (e.code || e.message) ? ` (${e.code || e.message})` : '';
    return unavailable(`the wand file could not be read${why}`, true);
  }
  if (state.status !== 'ok') return unavailable('the wand file could not be read');

  const v = state.value;
  // The version first: a newer build may have changed the shape too, and "not a wand store" (fix or delete it)
  // is the wrong advice for a file a newer build wrote (Dexter D11).
  if (isObj(v) && typeof v.version === 'number' && v.version !== VERSION) {
    return unavailable(`the wand file is version ${v.version}, which this build does not support (it reads version ${VERSION})`);
  }
  if (!isObj(v) || !Array.isArray(v.favourites)) return unavailable('the wand file is not a wand store');
  if (v.version !== VERSION) return unavailable('the wand file has no version');

  const kept = [];
  let dropped = 0;
  const claimed = new Set();
  for (const raw of v.favourites) {
    const f = readFavourite(raw);
    if (!f) { dropped++; continue; }
    const wanted = raw.id;
    const ok = isStr(wanted) && ID_RE.test(wanted) && !claimed.has(wanted);
    if (ok) claimed.add(wanted);
    kept.push({ id: ok ? wanted : null, ...f });
  }
  // Second pass: ids that were missing, malformed or repeated get a fresh one that no kept id owns.
  for (const f of kept) {
    if (f.id !== null) continue;
    f.id = freshId(claimed);
    claimed.add(f.id);
  }
  return { status: 'ok', favourites: kept.map(f => ({ id: f.id, emoji: f.emoji, skill: f.skill, args: f.args, typeOnly: f.typeOnly })), reason: null, dropped, transient: false };
}

const serialize = (favourites) => ({ version: VERSION, favourites: favourites.map(f => ({ id: f.id, emoji: f.emoji, skill: f.skill, args: f.args, typeOnly: f.typeOnly === true })) });

// --- edits: each returns { ok, favourites, reason, id? }; a refusal returns the list untouched -------------

const refuse = (favs, reason) => ({ ok: false, favourites: favs, reason });
const list = (favs) => (Array.isArray(favs) ? favs : []);

const REASONS = {
  emoji: 'Pick one emoji.',
  skill: "Pick a skill whose name can be typed as a slash command.",
  args: `The argument must be one line of plain text, up to ${MAX_ARGS} characters.`,
  typeOnly: 'Type only must be on or off.',
};

/**
 * Check the fields named in `patch` (emoji, skill and args are all required for an add; `typeOnly` is optional
 * and false when not named). Returns { fields } or { reason }.
 */
function checkFields(patch, all) {
  const p = isObj(patch) ? patch : {};
  const fields = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(p, k);
  if (all || has('emoji')) {
    if (!isOneEmoji(p.emoji)) return { reason: REASONS.emoji };
    fields.emoji = p.emoji;
  }
  if (all || has('skill')) {
    if (!isStr(p.skill) || !SKILL_NAME.test(p.skill)) return { reason: REASONS.skill };
    fields.skill = p.skill;
  }
  if (all || has('args')) {
    const a = cleanArgs(p.args);
    if (a === null) return { reason: REASONS.args };
    fields.args = a;
  }
  if (has('typeOnly')) {
    if (typeof p.typeOnly !== 'boolean') return { reason: REASONS.typeOnly };
    fields.typeOnly = p.typeOnly;
  } else if (all) {
    fields.typeOnly = false;
  }
  return { fields };
}

function add(favs, patch) {
  const cur = list(favs);
  if (cur.length >= MAX_FAVOURITES) return refuse(favs, `A wand holds at most ${MAX_FAVOURITES} favourites.`);
  const c = checkFields(patch, true);
  if (c.reason) return refuse(favs, c.reason);
  const id = nextId(cur);
  return { ok: true, reason: null, id, favourites: [...cur, { id, emoji: c.fields.emoji, skill: c.fields.skill, args: c.fields.args, typeOnly: c.fields.typeOnly }] };
}

function update(favs, id, patch) {
  const cur = list(favs);
  const i = isStr(id) ? cur.findIndex(f => f.id === id) : -1;
  if (i === -1) return refuse(favs, 'That favourite no longer exists.');
  const c = checkFields(patch, false);
  if (c.reason) return refuse(favs, c.reason);
  const next = cur.slice();
  next[i] = { ...cur[i], ...c.fields };
  return { ok: true, reason: null, id, favourites: next };
}

function remove(favs, id) {
  const cur = list(favs);
  if (!isStr(id) || !cur.some(f => f.id === id)) return refuse(favs, 'That favourite no longer exists.');
  return { ok: true, reason: null, id, favourites: cur.filter(f => f.id !== id) };
}

/** `id` ends up at index `to` of the resulting list, the others shifting round it (a drop onto a slot). */
function moveTo(favs, id, to) {
  const cur = list(favs);
  const from = isStr(id) ? cur.findIndex(f => f.id === id) : -1;
  if (from === -1) return refuse(favs, 'That favourite no longer exists.');
  if (!Number.isInteger(to) || to < 0 || to >= cur.length) return refuse(favs, 'That is not a place in the wand.');
  const next = cur.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return { ok: true, reason: null, id, favourites: next };
}

module.exports = {
  VERSION, MAX_FAVOURITES, MAX_ARGS, defaultFavourites, isOneEmoji, cleanArgs, commandOf, nextId,
  load, serialize, add, update, remove, moveTo,
};
