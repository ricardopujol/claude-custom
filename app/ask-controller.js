'use strict';
/**
 * What the "Ask the repo" panel DOES (BACKLOG #33): the asks and their order, the profile, the first index's polling. No DOM: the display
 * (app/ask-display.js) draws `state()` and calls these; the host (host/ask-service.js) answers `request`.
 *
 *   create({ request, storage, onChange, setTimer, clearTimer }) ->
 *     state()                   -> { profile, host, hostError, ui, entry, trail, history, view }
 *     show() / hide()           the panel is on screen (status, the first index, polling) / not
 *     ask(question, opts?)      a typed question          explain({ file, start, end }, opts?)   the code selected in the reader
 *     reask('simpler'|'deeper') drill(words)              askClaude()   select(id)   startOllama()
 *     toggleSettings() / saveSettings({ name, level, aboutMe, model }) / rename()
 *     setNamingName(text) / setNamingPortrait(p) / saveNaming() -> boolean
 *
 * THE ORDER OF A QUESTION (round 7: places first): the host is asked for the PLACES (the search alone) and for the ANSWER at once; the
 * places come back first and show as cards while the words are still being written; the answer then finishes the entry. A reply for an
 * earlier question never lands on a later one (each ask finishes its own entry), and a late places reply after the answer is ignored.
 * NOTHING IS ASKED before the explainer is named. THE EXPLAINER IS REFUSED here too for a model the host says has not passed the bar
 * (the host refuses it as well; this saves the round trip and the flash of a waiting view).
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `askController`.
 */
(function (root) {

const S = typeof module !== 'undefined' && module.exports ? require('./ask-panel-state') : root.askPanelState;
const P = typeof module !== 'undefined' && module.exports ? require('./ask-profile') : root.askProfile;

const POLL_MS = 2500;
// the first index is started by the first status; until the host reports it as building the state is 'none', so a few polls look for it
const NONE_POLLS = 8;
const WRITING_AFTER_MS = Object.freeze({ local: 4000, claude: 2500 });
const DIRECTIONS = Object.freeze(['simpler', 'deeper']);
const CLAUDE_DEFAULT = 'haiku';

const isStr = (x) => typeof x === 'string';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function create({ request, storage = null, onChange = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = clearTimeout } = {}) {
  let profile = P.load(storage);
  let st = S.create();
  let host = null;
  let hostError = null;
  let shown = false;
  let warmedOk = false;        // the first index starts with the first status that is ANSWERED, not the first one that is asked
  let pollTimer = null;
  let pendingExplain = null;
  let nonePolls = NONE_POLLS;
  const ui = { settings: false, naming: { name: profile.name || P.DEFAULT_NAME, portrait: profile.portrait, error: '' }, startMsg: '' };

  const changed = () => { try { onChange(); } catch { /* a display that threw must not stop the asks */ } };

  // ---- host status and the first index ---------------------------------------------------------------------------------------
  async function refreshStatus() {
    const r = await request('status', warmedOk ? {} : { warm: true });
    if (isObj(r) && r.ok === true) { host = r; hostError = null; warmedOk = true; } else { hostError = (isObj(r) && r.error) || 'The session did not answer.'; }
    changed();
    schedulePoll();
  }
  function schedulePoll() {
    if (pollTimer !== null) { clearTimer(pollTimer); pollTimer = null; }
    const idx = host && host.index;
    const looking = isObj(idx) && idx.state === 'none' && nonePolls > 0;
    if (looking) nonePolls -= 1;
    if (shown && isObj(idx) && (idx.state === 'building' || idx.state === 'partial' || looking)) {
      pollTimer = setTimer(() => { pollTimer = null; refreshStatus(); }, POLL_MS);
    }
  }

  // ---- one ask ----------------------------------------------------------------------------------------------------------------
  async function run(entryId, op, body, modelId) {
    const claude = modelId !== 'local';
    const sent = { ...body, model: modelId };
    request('places', sent).then((r) => {
      st = S.setPlaces(st, entryId, r);
      changed();
      if (isObj(r) && r.ok === true) {
        setTimer(() => { st = S.setStage(st, entryId, 'writing'); changed(); }, claude ? WRITING_AFTER_MS.claude : WRITING_AFTER_MS.local);
      }
    });
    const reply = await request(op, sent);
    st = S.finish(st, entryId, reply);
    changed();
    if (isObj(reply) && reply.ok === false && reply.reason === 'index-building') refreshStatus();
  }

  function ask(question, { parent, modelId, direction } = {}) {
    const q = isStr(question) ? question.trim() : '';
    if (!q) return undefined;
    if (!profile.named) { changed(); return undefined; }
    const mid = modelId || profile.model;
    st = S.begin(st, { kind: 'question', label: q, request: { question: q, ...(direction ? { direction } : {}) }, parent, model: mid });
    changed();
    return run(S.current(st).id, 'ask', { question: q }, mid);
  }

  function explain(sel, { parent, direction, modelId, label, term, answer } = {}) {
    const { file, start, end } = sel || {};
    if (!profile.named) { pendingExplain = { file, start, end }; changed(); return undefined; }
    const mid = modelId || profile.model;
    const lab = label || (term || `${file}:${start}${end > start ? '-' + end : ''}`);
    if (!S.canExplain(host, mid)) {
      st = S.begin(st, { kind: 'explain', label: lab, request: { file, start, end }, parent, model: mid });
      st = S.finish(st, S.current(st).id, { ok: false, reason: 'explainer-off' });
      changed();
      return undefined;
    }
    const body = { file, start, end, level: profile.level, aboutMe: profile.aboutMe, ...(term ? { term, answer } : {}), ...(direction ? { direction } : {}) };
    st = S.begin(st, { kind: 'explain', label: lab, request: body, parent, model: mid });
    changed();
    return run(S.current(st).id, 'explain', body, mid);
  }

  function reask(direction) {
    const cur = S.current(st);
    if (!DIRECTIONS.includes(direction) || !cur || cur.kind !== 'explain') return undefined;
    const { file, start, end, term, answer } = cur.request;
    return explain({ file, start, end }, { parent: cur.parent, modelId: cur.model, label: cur.label, direction, term, answer });
  }

  function drill(words) {
    const cur = S.current(st);
    const t = isStr(words) ? words.trim() : '';
    if (!cur || !t) return undefined;
    if (cur.kind === 'explain') {
      const { file, start, end } = cur.request;
      return explain({ file, start, end }, { parent: cur.id, modelId: cur.model, term: t, answer: cur.reply && cur.reply.text });
    }
    return ask(`What is ${t}?`, { parent: cur.id, modelId: cur.model });
  }

  // "Ask Claude instead": the same thing, once, of a Claude model. The quota is used only on this click.
  function askClaude() {
    const cur = S.current(st);
    if (!cur) return undefined;
    const claudeId = profile.model !== 'local' ? profile.model : CLAUDE_DEFAULT;
    if (cur.kind === 'explain') {
      const { file, start, end, term, answer } = cur.request;
      if (S.canExplain(host, claudeId)) return explain({ file, start, end }, { parent: cur.parent, modelId: claudeId, label: cur.label, term, answer });
      return ask(`What is the code in ${file} lines ${start}-${end} doing?`, { parent: cur.parent, modelId: claudeId });
    }
    return ask((cur.request && cur.request.question) || cur.label, { parent: cur.parent, modelId: claudeId });
  }

  function select(id) { st = S.select(st, id); changed(); }

  async function startOllama() {
    ui.startMsg = 'Starting Ollama…';
    changed();
    const r = await request('start-ollama', {});
    ui.startMsg = isObj(r) && r.ok === true
      ? (r.already ? 'Ollama is already running.' : 'Ollama is starting. Ask again in a few seconds.')
      : `Couldn't start Ollama${isObj(r) && (r.reason || r.error) ? ': ' + (r.reason || r.error) : ''}.`;
    changed();
    return refreshStatus();
  }

  // ---- the profile ------------------------------------------------------------------------------------------------------------
  function saveProfile(next) { profile = next; P.save(storage, profile); }

  function setNamingName(text) { ui.naming.name = isStr(text) ? text : ''; }
  function setNamingPortrait(p) { ui.naming.portrait = p; changed(); }
  function saveNaming() {
    const r = P.name(profile, ui.naming.name, ui.naming.portrait);
    if (!r.ok) { ui.naming.error = 'Give it a name first.'; changed(); return false; }
    ui.naming.error = '';
    saveProfile(r.profile);
    const pend = pendingExplain;
    pendingExplain = null;
    changed();
    if (pend) explain(pend);
    return true;
  }
  function rename() {
    ui.naming = { name: profile.name || P.DEFAULT_NAME, portrait: profile.portrait, error: '' };
    ui.settings = false;
    saveProfile({ ...profile, named: false });
    changed();
  }
  function toggleSettings() { ui.settings = !ui.settings; changed(); }
  function saveSettings({ name, level, aboutMe, model } = {}) {
    let next = profile;
    const nm = P.name(next, name, next.portrait);
    if (nm.ok) next = nm.profile;
    next = P.setLevel(next, level);
    next = P.setAboutMe(next, aboutMe);
    next = P.setModel(next, model);
    saveProfile(next);
    ui.settings = false;
    changed();
  }

  return {
    show() { shown = true; nonePolls = NONE_POLLS; return refreshStatus(); },
    hide() { shown = false; if (pollTimer !== null) { clearTimer(pollTimer); pollTimer = null; } },
    refreshStatus, ask, explain, reask, drill, askClaude, select, startOllama,
    toggleSettings, saveSettings, rename, setNamingName, setNamingPortrait, saveNaming,
    state: () => ({
      profile, host, hostError, ui, entry: S.current(st), trail: S.trail(st), history: S.history(st), view: S.viewOf(st, profile),
    }),
  };
}

const API = { create, POLL_MS, WRITING_AFTER_MS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.askController = API;

})(typeof window !== 'undefined' ? window : globalThis);
