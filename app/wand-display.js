'use strict';
/**
 * The wand panel (BACKLOG #51): favourite skills as emoji buttons. Pure decisions and HTML strings only;
 * renderer.js wires the clicks, the drag and the websocket, the same split as app/loadout-display.js.
 *
 * WHAT A CLICK MEANS. Outside edit mode a click TYPES `/skill [args]` into this tab's CLI input and stops:
 * the plan (clickPlan) carries a command and nothing that submits it, and the flash says "typed, press
 * Enter" -- never that anything ran. The typing itself is renderer.js's typeCommand, the one shared
 * typeAndCheck (clears a one-line draft, refuses a dialog or a multi-line draft, reads the box back).
 *
 * ABSENCE IS NOT EMPTINESS, in three places (the bug this project keeps catching):
 *   - the wand can be UNAVAILABLE (a corrupt or unreadable file): the panel says so and shows no grid, so
 *     it can never read as "you have no favourites";
 *   - before the first hello the panel is LOADING, not an empty grid;
 *   - when the skill list could not be read, NOTHING is dimmed: "could not look" is not "no such skill".
 *
 * A favourite whose skill is not in the list is dimmed and says "skill not found"; clicking it says so,
 * and never types.
 *
 * REFUSALS ANSWER ONE WINDOW. The host broadcasts every answer; only the window that asked shows a
 * refusal, and a `quiet` frame (another host's edit, a skill rescan) neither sets nor clears one (PR #64
 * N1, Dexter F6 on the belt). An open editor survives such a refresh, so half-typed text is never thrown
 * away; it closes only if its favourite is gone or the wand became unavailable.
 *
 * Every control is a <button>, and the grid is rebuilt from state, so the page holds no state of its own.
 * Everything from the host is escaped.
 *
 * WRAPPED IN AN IIFE, and that is not style -- see app/career-display.js. The renderer loads every script
 * as a plain <script> tag sharing ONE global scope; a top-level name declared twice silently kills the
 * second file, and no unit test can see it. Rendered proof: verify/probe-wand.js.
 */

(function (root) {

const isStr = (x) => typeof x === 'string';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const SKILL_LIST_CAP = 40;
const FLASH_TEXT = 'typed, press Enter';
const EMOJI_CHOICES = Object.freeze([
  '🌙', '✅', '🔀', '💡', '🚀', '⚡', '🧪', '🔧', '🛠️', '📝', '📌', '🔍', '🧹', '🎯', '🔥', '⭐',
  '💬', '📦', '🔒', '🧠', '🎨', '🐛', '📈', '⏰', '✨', '🤖', '📚', '🧭', '🪄', '🧰',
]);
const EDITOR_FIELDS = ['emoji', 'skill', 'args', 'query'];

function emptyState() {
  return {
    loaded: false, status: null, favourites: [], unavailable: null, dropped: 0, file: null,
    skills: [], skillsLoaded: false, skillsError: null,
    edit: false, editor: null, error: null, notice: null, flash: null, asked: false,
  };
}

function readFavourites(raw) {
  const out = [];
  for (const f of raw) {
    if (!isObj(f) || !isStr(f.id) || f.id === '' || !isStr(f.emoji) || f.emoji === '' || !isStr(f.skill) || f.skill === '') continue;
    out.push({ id: f.id, emoji: f.emoji, skill: f.skill, args: isStr(f.args) ? f.args : '' });
  }
  return out;
}

function readSkills(raw) {
  const out = [];
  for (const s of raw) {
    if (!isObj(s) || !isStr(s.name) || s.name === '') continue;
    out.push({ name: s.name, description: isStr(s.description) ? s.description : '', source: isStr(s.source) ? s.source : '' });
  }
  return out;
}

/** Fold the host's wand payload (hello's `wand`, or a `wand` frame) into the state. A malformed one changes nothing. */
function applyWand(cur, w) {
  if (!isObj(w)) return cur;
  const status = w.status;
  if (status !== 'ok' && status !== 'missing' && status !== 'unavailable') return cur;
  if (status !== 'unavailable' && !Array.isArray(w.favourites)) return cur;

  const next = { ...cur, loaded: true, status, dropped: Number.isInteger(w.dropped) && w.dropped > 0 ? w.dropped : 0,
    file: isStr(w.file) && w.file !== '' ? w.file : cur.file };
  if (Array.isArray(w.skills)) {
    next.skills = readSkills(w.skills);
    next.skillsLoaded = true;
    next.skillsError = isStr(w.skillsError) && w.skillsError !== '' ? w.skillsError : null;
  }
  if (status === 'unavailable') {
    next.favourites = [];
    next.unavailable = isStr(w.unavailable) && w.unavailable !== '' ? w.unavailable : 'the wand file could not be read';
    next.edit = false;
    next.editor = null;
    return next;
  }
  next.favourites = readFavourites(w.favourites);
  next.unavailable = null;
  // An editor for a favourite another host just deleted would save into nothing.
  if (next.editor && next.editor.id !== null && !next.favourites.some(f => f.id === next.editor.id)) next.editor = null;
  return next;
}

/**
 * Fold one host message into the panel state. `hello` carries `wand`; a `wand` frame is the answer to an
 * edit (or a state refresh when `quiet`). Anything else returns the state untouched.
 */
function reduce(state, msg) {
  const cur = state || emptyState();
  if (!isObj(msg)) return cur;
  if (msg.type === 'hello') return isObj(msg.wand) ? applyWand(cur, msg.wand) : cur;
  if (msg.type !== 'wand') return cur;

  const next = applyWand(cur, msg);
  if (next === cur) return cur;
  if (msg.quiet === true) return next;
  // Broadcast to every window, but a refusal answers ONE click: only the window that asked shows it.
  if (msg.ok === false) {
    if (!cur.asked) return next;
    const reason = isStr(msg.reason) && msg.reason ? msg.reason : 'the wand was not changed';
    return { ...next, asked: false, error: reason, editor: next.editor ? { ...next.editor, saving: false } : null };
  }
  if (msg.ok === true && cur.asked) {
    // My save landed: the editor's job is done.
    return { ...next, asked: false, error: null, editor: cur.editor && cur.editor.saving ? null : next.editor };
  }
  return next;
}

/** Note that THIS window just asked for an edit, so its answer (a refusal included) is shown. */
function ask(state) {
  return { ...(state || emptyState()), asked: true };
}

/** An edit that never left this window (no socket): shown now, since no answer is coming. */
function failed(state, reason) {
  const s = state || emptyState();
  return { ...s, asked: false, error: isStr(reason) && reason ? reason : 'the wand was not changed',
    editor: s.editor ? { ...s.editor, saving: false } : null };
}

// --- the skill list ---------------------------------------------------------------------------------------

function matchingSkills(skills, query) {
  const list = Array.isArray(skills) ? skills : [];
  const q = isStr(query) ? query.trim().toLowerCase() : '';
  if (q === '') return list.slice();
  const rank = (s) => {
    const n = s.name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.includes(q)) return 1;
    if (isStr(s.description) && s.description.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return list.map((s, i) => ({ s, i, r: rank(s) })).filter(x => x.r !== -1)
    .sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.s);
}

/** The picker's list: matches for `query` (name first, then description), capped at SKILL_LIST_CAP. */
function filterSkills(skills, query) {
  return matchingSkills(skills, query).slice(0, SKILL_LIST_CAP);
}

// --- the view ---------------------------------------------------------------------------------------------

const hasSkill = (state, name) => state.skills.some(s => s.name === name);
const checkable = (state) => state.skillsLoaded && state.skillsError === null;
const isMissing = (state, name) => checkable(state) && !hasSkill(state, name);

const commandOf = (f) => (f.args !== '' ? `/${f.skill} ${f.args}` : `/${f.skill}`);

function titleOf(state, f) {
  const s = state.skills.find(x => x.name === f.skill);
  const lines = [];
  if (isMissing(state, f.skill)) lines.push(`/${f.skill}: skill not found`);
  else lines.push(s && s.description ? `/${f.skill} — ${s.description}` : `/${f.skill}`);
  if (f.args !== '') lines.push(`pre-fills: ${f.args}`);
  if (state.edit) lines.push('click to edit, drag to reorder');
  return lines.join('\n');
}

function editorView(state) {
  const e = state.editor;
  if (!e) return null;
  const all = matchingSkills(state.skills, e.query);
  return {
    id: e.id, isNew: e.id === null, emoji: e.emoji, skill: e.skill, args: e.args, query: e.query, saving: e.saving,
    emojiChoices: EMOJI_CHOICES.slice(),
    skills: all.slice(0, SKILL_LIST_CAP),
    moreSkills: Math.max(0, all.length - SKILL_LIST_CAP),
    skillMissing: e.skill !== '' && isMissing(state, e.skill),
    skillsUnreadable: state.skillsError !== null,
  };
}

function view(state) {
  const s = state || emptyState();
  let mode = 'loading';
  let note = null;
  if (s.loaded) {
    if (s.status === 'unavailable') {
      mode = 'unavailable';
      note = `Wand unavailable: ${s.unavailable}. Nothing was changed; fix or delete .harness/state/wand.json to get it back.`;
    } else {
      mode = 'ok';
      if (s.favourites.length === 0) note = 'No favourites yet. Turn on edit and add one.';
    }
  } else {
    note = 'reading the wand…';
  }
  const n = s.dropped;
  // Favourites the file holds that did not load: shown nowhere, and the host refuses every edit while they are
  // there (an edit would erase them for good), so the panel offers none and says where to fix it.
  const canEdit = mode === 'ok' && n === 0;
  return {
    mode, note,
    canEdit,
    edit: canEdit && s.edit,
    file: s.file,
    warning: n > 0 ? `${n} favourite${n === 1 ? '' : 's'} in ${s.file || 'the file'} ${n === 1 ? "isn't" : "aren't"} valid and ${n === 1 ? "isn't" : "aren't"} shown, so editing is off until ${n === 1 ? 'it is' : 'they are'} fixed.` : null,
    skillsNote: s.skillsError !== null ? `Couldn't read the skill list (${s.skillsError}), so no favourite is checked.` : null,
    buttons: mode === 'ok' ? s.favourites.map(f => ({
      id: f.id, emoji: f.emoji, skill: f.skill, args: f.args, command: commandOf(f), title: titleOf(s, f),
      missing: isMissing(s, f.skill), flash: !!(s.flash && s.flash.id === f.id),
    })) : [],
    editor: mode === 'ok' ? editorView(s) : null,
    error: s.error,
    status: s.flash ? s.flash.text : s.notice,
  };
}

// --- clicks -----------------------------------------------------------------------------------------------

/**
 * What a click on a favourite does. `type` carries the command and nothing that submits it; `missing`
 * carries the note to show instead of typing; `edit` is a click in edit mode; null for an unknown id.
 */
function clickPlan(state, id) {
  const s = state || emptyState();
  const f = isStr(id) ? s.favourites.find(x => x.id === id) : undefined;
  if (!f) return null;
  if (s.edit) return { kind: 'edit', id: f.id };
  if (isMissing(s, f.skill)) return { kind: 'missing', id: f.id, note: `/${f.skill}: skill not found, so nothing was typed` };
  return { kind: 'type', command: commandOf(f), id: f.id };
}

/** typeCommand's answer for a click: a flash on that button, or why nothing was typed. */
function typed(state, id, result) {
  const s = state || emptyState();
  const f = isStr(id) ? s.favourites.find(x => x.id === id) : undefined;
  if (!f) return { ...s, flash: null };
  if (isObj(result) && result.ok === true) return { ...s, flash: { id: f.id, text: FLASH_TEXT }, notice: null };
  const reason = isObj(result) && isStr(result.reason) && result.reason ? result.reason : 'the terminal did not take it';
  return { ...s, flash: null, notice: `didn't type ${commandOf(f)}: ${reason}` };
}

const clearFlash = (state) => ({ ...(state || emptyState()), flash: null });
const setNotice = (state, text) => ({ ...(state || emptyState()), flash: null, notice: isStr(text) && text ? text : null });

// --- edit mode and the editor -----------------------------------------------------------------------------

function toggleEdit(state) {
  const s = state || emptyState();
  return { ...s, edit: !s.edit, editor: null, error: null, notice: null, flash: null };
}

function openEditor(state, id) {
  const s = state || emptyState();
  if (!s.edit || s.status === 'unavailable' || s.dropped > 0) return s;
  if (id === null) {
    return { ...s, error: null, editor: { id: null, emoji: '', skill: '', args: '', query: '', saving: false } };
  }
  const f = isStr(id) ? s.favourites.find(x => x.id === id) : undefined;
  if (!f) return s;
  return { ...s, error: null, editor: { id: f.id, emoji: f.emoji, skill: f.skill, args: f.args, query: '', saving: false } };
}

const closeEditor = (state) => ({ ...(state || emptyState()), editor: null, error: null });

function editorSet(state, field, value) {
  const s = state || emptyState();
  if (!s.editor || !EDITOR_FIELDS.includes(field) || !isStr(value)) return s;
  return { ...s, editor: { ...s.editor, [field]: value } };
}

/** { state, message }: the host message for the editor's Save, or null and why on screen. */
function editorSubmit(state) {
  const s = state || emptyState();
  const e = s.editor;
  if (!e) return { state: s, message: null };
  if (e.emoji.trim() === '') return { state: { ...s, error: 'Pick or type an emoji.' }, message: null };
  if (e.skill === '') return { state: { ...s, error: 'Pick a skill.' }, message: null };
  const message = e.id === null
    ? { type: 'wand-add', emoji: e.emoji.trim(), skill: e.skill, args: e.args }
    : { type: 'wand-update', id: e.id, patch: { emoji: e.emoji.trim(), skill: e.skill, args: e.args } };
  return { state: { ...s, error: null, asked: true, editor: { ...e, saving: true } }, message };
}

function deleteMsg(state, id) {
  const s = state || emptyState();
  if (!s.edit || s.dropped > 0 || !isStr(id) || !s.favourites.some(f => f.id === id)) return { state: s, message: null };
  return { state: ask(s), message: { type: 'wand-delete', id } };
}

/** A drop of `id` onto `targetId`'s slot: the id takes that slot's index. */
function moveMsg(state, id, targetId) {
  const s = state || emptyState();
  if (!s.edit || s.dropped > 0 || !isStr(id) || !isStr(targetId) || id === targetId) return { state: s, message: null };
  const to = s.favourites.findIndex(f => f.id === targetId);
  if (to === -1 || !s.favourites.some(f => f.id === id)) return { state: s, message: null };
  return { state: ask(s), message: { type: 'wand-move', id, to } };
}

const skillsRequest = () => ({ type: 'wand-skills' });

// --- html -------------------------------------------------------------------------------------------------

function buttonHtml(v, b) {
  const main = `<button type="button" class="wand-btn${b.missing ? ' dim' : ''}${b.flash ? ' flash' : ''}" ` +
    `data-wand-act="press" data-wand-id="${esc(b.id)}" title="${esc(b.title)}" aria-label="${esc(b.command)}"` +
    `${v.edit ? ' draggable="true"' : ''}><span class="wand-emoji">${esc(b.emoji)}</span></button>`;
  if (!v.edit) return main;
  return `<span class="wand-cell" data-wand-cell="${esc(b.id)}">${main}` +
    `<button type="button" class="wand-x" data-wand-act="delete" data-wand-id="${esc(b.id)}" ` +
    `title="Delete ${esc(b.command)}" aria-label="Delete ${esc(b.command)}">✕</button></span>`;
}

function skillListHtml(v) {
  const e = v.editor;
  if (!e) return '';
  if (e.skillsUnreadable && e.skills.length === 0) return '<div class="wand-skill-none">The skill list could not be read.</div>';
  const rows = e.skills.map(s =>
    `<button type="button" class="wand-skill${s.name === e.skill ? ' on' : ''}" data-wand-act="pick-skill" ` +
    `data-wand-skill="${esc(s.name)}" title="${esc(s.description)}">` +
    `<span class="wand-skill-name">/${esc(s.name)}</span>` +
    `${s.source === 'plugin' ? '<span class="wand-skill-src">plugin</span>' : ''}` +
    `<span class="wand-skill-desc">${esc(s.description)}</span></button>`).join('');
  return rows +
    (e.skills.length === 0 ? '<div class="wand-skill-none">No skill matches.</div>' : '') +
    (e.moreSkills > 0 ? `<div class="wand-skill-more">+${e.moreSkills} more: type to narrow</div>` : '');
}

function editorHtml(v) {
  const e = v.editor;
  if (!e) return '';
  return `<div class="wand-editor" data-no-card-click>` +
    `<div class="wand-ed-title">${e.isNew ? 'New favourite' : 'Edit favourite'}</div>` +
    (v.error ? `<div class="wand-error" role="alert">${esc(v.error)}</div>` : '') +
    `<label class="wand-ed-row">Emoji <input type="text" class="wand-ed-emoji" data-wand-field="emoji" value="${esc(e.emoji)}" maxlength="16" size="4" autocomplete="off" spellcheck="false"></label>` +
    `<div class="wand-emoji-pick">${e.emojiChoices.map(x =>
      `<button type="button" class="wand-pick" data-wand-act="pick-emoji" data-wand-emoji="${esc(x)}" aria-label="${esc(x)}">${esc(x)}</button>`).join('')}</div>` +
    `<div class="wand-picked">Skill: ${e.skill !== '' ? `/${esc(e.skill)}` : '<span class="dim">none picked</span>'}` +
      `${e.skillMissing ? ' <span class="wand-missing">skill not found</span>' : ''}</div>` +
    `<input type="search" class="wand-ed-search" data-wand-field="query" value="${esc(e.query)}" placeholder="search skills" autocomplete="off" spellcheck="false">` +
    `<div id="wand-skill-list" class="wand-skill-list">${skillListHtml(v)}</div>` +
    `<label class="wand-ed-row">Argument <input type="text" class="wand-ed-args" data-wand-field="args" value="${esc(e.args)}" maxlength="200" placeholder="optional, pre-filled after the skill" autocomplete="off" spellcheck="false"></label>` +
    `<div class="wand-ed-actions"><button type="button" data-wand-act="save"${e.saving ? ' disabled' : ''}>Save</button>` +
    `<button type="button" data-wand-act="cancel">Cancel</button></div></div>`;
}

function html(v) {
  const head = `<div class="wand-head"><span class="wand-title">Wand</span>` +
    (v.canEdit ? `<button type="button" class="wand-edit${v.edit ? ' on' : ''}" data-wand-act="toggle-edit" ` +
      `aria-pressed="${v.edit ? 'true' : 'false'}" title="${v.edit ? 'Done editing' : 'Add, edit, delete and reorder favourites'}">✎</button>` : '') +
    `</div>`;
  const lines = [
    v.note ? `<div class="wand-note${v.mode === 'unavailable' ? ' bad' : ''}">${esc(v.note)}</div>` : '',
    v.warning ? `<div class="wand-note warn">${esc(v.warning)}</div>` : '',
    v.skillsNote ? `<div class="wand-note warn">${esc(v.skillsNote)}</div>` : '',
  ].join('');
  const grid = v.mode === 'ok'
    ? `<div class="wand-grid">${v.buttons.map(b => buttonHtml(v, b)).join('')}` +
      (v.edit ? `<button type="button" class="wand-btn wand-add" data-wand-act="add" title="Add a favourite" aria-label="Add a favourite">+</button>` : '') +
      `</div>`
    : '';
  return `<div class="wand">${head}${lines}${grid}${editorHtml(v)}` +
    (v.error && !v.editor ? `<div class="wand-error" role="alert">${esc(v.error)}</div>` : '') +
    (v.status ? `<div class="wand-status" role="status">${esc(v.status)}</div>` : '') +
    `</div>`;
}

const ACTS = new Set(['toggle-edit', 'press', 'delete', 'add', 'save', 'cancel', 'pick-skill', 'pick-emoji']);

/** A click's dataset -> what it means, or null. */
function clickAction(ds) {
  if (!isObj(ds) || !isStr(ds.wandAct) || !ACTS.has(ds.wandAct)) return null;
  const kind = ds.wandAct;
  if (kind === 'press' || kind === 'delete') return isStr(ds.wandId) && ds.wandId ? { kind, id: ds.wandId } : null;
  if (kind === 'pick-skill') return isStr(ds.wandSkill) && ds.wandSkill ? { kind, skill: ds.wandSkill } : null;
  if (kind === 'pick-emoji') return isStr(ds.wandEmoji) && ds.wandEmoji ? { kind, emoji: ds.wandEmoji } : null;
  return { kind };
}

const api = {
  emptyState, reduce, ask, failed, view, html, skillListHtml, clickAction, clickPlan, typed, clearFlash, setNotice,
  toggleEdit, openEditor, closeEditor, editorSet, editorSubmit, deleteMsg, moveMsg, skillsRequest, filterSkills,
  SKILL_LIST_CAP, FLASH_TEXT,
};

// Loaded two ways: require() from tests, and a plain <script> tag in the renderer, which has no module
// system. Only ONE name leaves the IIFE.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.wandDisplay = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
