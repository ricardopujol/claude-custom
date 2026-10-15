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
 *     setNamingName(text) / setNamingPortrait(p) / choosePicture() / saveNaming() -> boolean
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

function create({ request, storage = null, pickPortrait = null, onChange = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = clearTimeout } = {}) {
  let profile = P.load(storage);
  let st = S.create();
  let host = null;
  let hostError = null;
  let shown = false;
  let warmedOk = false;        // the first index starts with the first status that is ANSWERED, not the first one that is asked
  let pollTimer = null;
  let pendingExplain = null;
  let nonePolls = NONE_POLLS;
  const ui = { settings: false, draft: null, drillText: '', naming: { name: profile.name || P.DEFAULT_NAME, portrait: profile.portrait, error: '' }, startMsg: '' };

  const changed = () => { try { onChange(); } catch { /* a display that threw must not stop the asks */ } };

  // ---- host status and the first index ---------------------------------------------------------------------------------------
  let statusSeq = 0;
  let newestStatus = null;
  // An older reply never overwrites a newer one (PR #169 Miguel G9), but whoever WAITED on the older request (an explain that needs the host's
  // word) gets the newest answer, not nothing (Miguel Y-R2-2): a superseded request resolves when the newest has been applied.
  function refreshStatus({ fresh = false } = {}) {
    const mine = ++statusSeq;
    const p = (async () => {
      const r = await request('status', { ...(warmedOk ? {} : { warm: true }), ...(fresh ? { fresh: true } : {}) });
      if (mine !== statusSeq) { await newestStatus; return; }
      if (isObj(r) && r.ok === true) { host = r; hostError = null; warmedOk = true; } else { hostError = (isObj(r) && r.error) || 'The session did not answer.'; }
      changed();
      schedulePoll();
    })();
    newestStatus = p;
    return p;
  }
  function schedulePoll() {
    if (pollTimer !== null) { clearTimer(pollTimer); pollTimer = null; }
    const idx = host && host.index;
    const looking = isObj(idx) && idx.state === 'none' && nonePolls > 0;
    if (looking) nonePolls -= 1;
    // an interrupted (partial) index is polled only while a build is actually running it (PR #169 Miguel Y5)
    const building = isObj(idx) && (idx.state === 'building' || (idx.state === 'partial' && idx.running === true));
    if (shown && isObj(idx) && (building || looking)) {
      pollTimer = setTimer(() => { pollTimer = null; refreshStatus(); }, POLL_MS);
    }
  }

  // ---- one ask ----------------------------------------------------------------------------------------------------------------
  const writingTimers = new Map();
  const stopWriting = (entryId) => { if (writingTimers.has(entryId)) { clearTimer(writingTimers.get(entryId)); writingTimers.delete(entryId); } };

  // ONE retrieval per ask (PR #169 El Gordo 1): the host searches for the PLACES first and keeps its hits under an id; the cards show at
  // once (round 7: places first), and the answer that follows names the id, so it is written from the very same hits.
  async function run(entryId, op, body, modelId) {
    const claude = modelId !== 'local';
    const sent = { ...body, model: modelId };
    const pr = await request('places', sent);
    st = S.setPlaces(st, entryId, pr);
    changed();
    if (!(isObj(pr) && pr.ok === true)) {
      // the search itself failed (the index is still empty, unreadable, a bad selection ...): that is the answer, in words
      st = S.finish(st, entryId, pr);
      changed();
      if (isObj(pr) && pr.reason === 'index-building') refreshStatus();
      return;
    }
    writingTimers.set(entryId, setTimer(() => {
      writingTimers.delete(entryId);
      const before = st;
      st = S.setStage(st, entryId, 'writing');
      if (st !== before) changed();      // an answer that has landed is never repainted by a late timer (PR #169 Miguel B1)
    }, claude ? WRITING_AFTER_MS.claude : WRITING_AFTER_MS.local));
    const reply = await request(op, { ...sent, ...(pr.retrieval ? { retrieval: pr.retrieval } : {}) });
    stopWriting(entryId);
    st = S.finish(st, entryId, reply);
    changed();
    if (isObj(reply) && reply.ok === false && reply.reason === 'index-building') refreshStatus();
  }

  function ask(question, { parent, modelId, direction, step } = {}) {
    const q = isStr(question) ? question.trim() : '';
    if (!q) return undefined;
    if (!profile.named) { changed(); return undefined; }
    const mid = modelId || profile.model;
    ui.startMsg = '';
    // a drill-down step is marked, so the host doesn't count it as a question of its own (BACKLOG #33 gamification)
    const mark = step === true ? { step: true } : {};
    st = S.begin(st, { kind: 'question', label: q, request: { question: q, ...(direction ? { direction } : {}), ...mark }, parent, model: mid, name: profile.name });
    changed();
    return run(S.current(st).id, 'ask', { question: q, ...mark }, mid);
  }

  function explain(sel, opts = {}) {
    const { file, start, end } = sel || {};
    if (!profile.named) { pendingExplain = { file, start, end }; changed(); return undefined; }
    // The host has not said yet (the panel was never opened in this window): ask first. Silence is not "the model hasn't passed"
    // (PR #169 Dexter 4, Miguel B2).
    if (host === null) return refreshStatus().then(() => explainNow(sel, opts));
    return explainNow(sel, opts);
  }

  function explainNow(sel, { parent, direction, modelId, label, term, answer } = {}) {
    const { file, start, end } = sel || {};
    const mid = modelId || profile.model;
    const lab = label || (term || `${file}:${start}${end > start ? '-' + end : ''}`);
    if (host === null) {
      // still nothing from the host: say that, in its own words, not a verdict on the model
      st = S.begin(st, { kind: 'explain', label: lab, request: { file, start, end }, parent, model: mid, name: profile.name });
      st = S.finish(st, S.current(st).id, { ok: false, error: hostError || 'The session did not answer, so this can\'t be explained yet.' });
      changed();
      return undefined;
    }
    ui.startMsg = '';
    if (!S.canExplain(host, mid)) {
      st = S.begin(st, { kind: 'explain', label: lab, request: { file, start, end }, parent, model: mid, name: profile.name });
      st = S.finish(st, S.current(st).id, { ok: false, reason: 'explainer-off' });
      changed();
      return undefined;
    }
    const body = { file, start, end, level: profile.level, aboutMe: profile.aboutMe, ...(term ? { term, answer } : {}), ...(direction ? { direction } : {}) };
    st = S.begin(st, { kind: 'explain', label: lab, request: body, parent, model: mid, name: profile.name });
    changed();
    return run(S.current(st).id, 'explain', body, mid);
  }

  function reask(direction) {
    const cur = S.current(st);
    if (!DIRECTIONS.includes(direction) || !cur || cur.kind !== 'explain') return undefined;
    const { file, start, end, term, answer } = cur.request;
    return explain({ file, start, end }, { parent: cur.parent, modelId: cur.model, label: cur.label, direction, term, answer });
  }

  // the box a keyboard user types the words into is rebuilt with the body: what is typed lives here (PR #169 Miguel Y-R2-1)
  function setDrillText(text) { ui.drillText = isStr(text) ? text : ''; }
  function drill(words) {
    const cur = S.current(st);
    const t = isStr(words) ? words.trim() : '';
    if (!cur || !t) return undefined;
    ui.drillText = '';
    if (cur.kind === 'explain') {
      const { file, start, end } = cur.request;
      return explain({ file, start, end }, { parent: cur.id, modelId: cur.model, term: t, answer: cur.reply && cur.reply.text });
    }
    return ask(`What is ${t}?`, { parent: cur.id, modelId: cur.model, step: true });
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
    return ask((cur.request && cur.request.question) || cur.label, { parent: cur.parent, modelId: claudeId, step: !!(cur.request && cur.request.step === true) });
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
  // The agents' upload: `pickPortrait()` opens the OS file picker and hands the file to the host as the explainer's own picture (true when it did).
  async function choosePicture() {
    if (typeof pickPortrait !== 'function') return false;
    let ok = false;
    try { ok = (await pickPortrait()) === true; } catch { ok = false; }
    if (ok) { ui.naming.portrait = { kind: 'upload' }; changed(); }
    return ok;
  }
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
    ui.draft = null;
    saveProfile({ ...profile, named: false });
    changed();
  }
  // The settings boxes are rebuilt with the body, so what is typed in them lives here until Save (PR #169 Miguel B1).
  function toggleSettings() {
    ui.settings = !ui.settings;
    ui.draft = ui.settings ? { name: profile.name, level: profile.level, aboutMe: profile.aboutMe, model: profile.model } : null;
    changed();
  }
  function setSettingsDraft(partial) { if (ui.draft && isObj(partial)) ui.draft = { ...ui.draft, ...partial }; }
  function saveSettings({ name, level, aboutMe, model } = {}) {
    let next = profile;
    const nm = P.name(next, name, next.portrait);
    if (nm.ok) next = nm.profile;
    next = P.setLevel(next, level);
    next = P.setAboutMe(next, aboutMe);
    next = P.setModel(next, model);
    saveProfile(next);
    ui.settings = false;
    ui.draft = null;
    changed();
  }

  return {
    show() { shown = true; nonePolls = NONE_POLLS; return refreshStatus(); },
    hide() { shown = false; if (pollTimer !== null) { clearTimer(pollTimer); pollTimer = null; } },
    refreshStatus, ask, explain, reask, drill, askClaude, select, startOllama,
    toggleSettings, setSettingsDraft, setDrillText, saveSettings, rename, setNamingName, setNamingPortrait, choosePicture, saveNaming,
    state: () => ({
      profile, host, hostError, ui, entry: S.current(st), trail: S.trail(st), history: S.history(st), view: S.viewOf(st, profile),
    }),
  };
}

const API = { create, POLL_MS, WRITING_AFTER_MS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.askController = API;

})(typeof window !== 'undefined' ? window : globalThis);
