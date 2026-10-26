'use strict';
/**
 * What the "Ask the repo" panel shows, as pure state (BACKLOG #33, DESIGN_ASK_REPO.md "The design, in full", rounds 1-8).
 * app/ask-display.js draws it; app/ask-requester.js carries the questions; the host (host/ask-service.js) answers them.
 *
 *   create() -> state                      begin(state, { kind, label, request, parent?, model? }) -> state (a waiting entry, now current)
 *   setPlaces(state, id, reply) / setStage(state, id, stage) / finish(state, id, reply) / select(state, id)
 *   current(state) / history(state) / trail(state) / viewOf(state, profile) -> 'naming' | 'empty' | 'waiting' | 'answer' | 'note'
 *   stagesOf(entry, modelId) -> the three named waiting steps      noticeOf(reply, { name, kind, modelId, modelName, hasPlaces }) -> { text, actions }
 *   indexLine(indexStatus) / statusLine(hostStatus, modelId) / canExplain(hostStatus, modelId) / examplesOf(hostStatus)
 *
 * ABSENCE IS NEVER SHOWN AS EMPTINESS: a failed ask is a 'note' with its reason in words (and the places the search found, which
 * come back with the failure); there is no silent empty answer. A reply for an entry that no longer exists changes nothing.
 * History is this session only (round 1): the entries are kept in memory, newest first, capped. The drill-down breadcrumb (round 3)
 * is the chain of `parent`s from the current entry; a step asked from an earlier one is its sibling, nothing is overwritten.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `askPanelState`.
 */
(function (root) {

const HISTORY_MAX = 50;
const GENERIC_EXAMPLES = Object.freeze([
  'Where is the login handled?',
  'What does the main entry point do?',
  'Where are errors logged?',
]);
const CLAUDE_NAMES = Object.freeze({ haiku: 'Haiku', sonnet: 'Sonnet' });

const isStr = (x) => typeof x === 'string';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isCount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

const create = () => ({ entries: [], currentId: null, nextId: 1 });

function begin(state, { kind, label, request, parent, model, name } = {}) {
  const id = state.nextId;
  const entry = {
    id, kind: kind === 'explain' ? 'explain' : 'question', label: isStr(label) ? label : '', request: request || {},
    parent: Number.isInteger(parent) ? parent : null, model: isStr(model) ? model : 'local',
    phase: 'waiting', stage: 'searching', places: null, reply: null,
    // who answered, by the name it had THEN (a later rename does not relabel an old answer)
    name: isStr(name) ? name : null,
  };
  const entries = [...state.entries, entry];
  while (entries.length > HISTORY_MAX) entries.shift();
  return { entries, currentId: id, nextId: id + 1 };
}

const find = (state, id) => state.entries.find(e => e.id === id) || null;
// An entry that is not changed leaves the STATE the very same object (a late timer or reply that changes nothing repaints nothing).
function patch(state, id, fn) {
  const e = find(state, id);
  if (!e) return state;
  const next = fn(e);
  return next === e ? state : { ...state, entries: state.entries.map(x => (x.id === id ? next : x)) };
}

const placesOf = (reply) => (isObj(reply) && Array.isArray(reply.places) ? reply.places : null);

function setPlaces(state, id, reply) {
  return patch(state, id, (e) => (e.phase !== 'waiting' ? e : { ...e, places: placesOf(reply) || e.places, stage: placesOf(reply) ? 'loading' : e.stage }));
}
function setStage(state, id, stage) {
  return patch(state, id, (e) => (e.phase !== 'waiting' || !['loading', 'writing'].includes(stage) ? e : { ...e, stage }));
}
function finish(state, id, reply) {
  return patch(state, id, (e) => ({ ...e, phase: 'done', reply: isObj(reply) ? reply : { ok: false, reason: 'bad-reply' }, places: placesOf(reply) || e.places }));
}
function select(state, id) {
  return find(state, id) ? { ...state, currentId: id } : state;
}

const current = (state) => find(state, state.currentId);
const history = (state) => [...state.entries].reverse();

function trail(state) {
  const out = [];
  const seen = new Set();
  for (let e = current(state); e && !seen.has(e.id); e = e.parent === null ? null : find(state, e.parent)) {
    seen.add(e.id);
    out.unshift({ id: e.id, label: e.label });
  }
  return out;
}

function viewOf(state, profile) {
  if (!profile || profile.named !== true) return 'naming';
  const e = current(state);
  if (!e) return 'empty';
  if (e.phase === 'waiting') return 'waiting';
  return e.reply && e.reply.ok === true ? 'answer' : 'note';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function stagesOf(entry, modelId) {
  const e = entry || {};
  const claude = CLAUDE_NAMES[modelId];
  const verb = e.kind === 'explain' ? 'the explanation' : 'the answer';
  const searched = e.stage !== 'searching';
  const n = Array.isArray(e.places) ? e.places.length : 0;
  const found = !searched ? 'searching the repo'
    : (n === 0 ? 'found no places' : `found ${plural(n, 'place', 'places')}`);
  const middle = claude ? `asking ${claude}` : 'loading the model (~4 s)';
  const at = { searching: 0, loading: 1, writing: 2 }[e.stage] ?? 0;
  const stateOf = (i) => (i < at ? 'done' : i === at ? 'active' : 'todo');
  return [
    { id: 'found', text: found, state: stateOf(0) },
    { id: 'loading', text: middle, state: stateOf(1) },
    { id: 'writing', text: `writing ${verb}`, state: stateOf(2) },
  ];
}

const ACT = Object.freeze({
  startOllama: { id: 'start-ollama', label: 'Start Ollama' },
  askClaude: { id: 'ask-claude', label: 'Ask Claude instead' },
});

/** The plain words for a failed ask, and the way out. Never blank: an unknown reason is still said. */
function noticeOf(reply, { name, kind, modelId, modelName, hasPlaces } = {}) {
  const r = isObj(reply) ? reply : {};
  const who = isStr(name) && name ? name : 'The explainer';
  const verb = kind === 'explain' ? 'explain' : 'answer';
  const tail = hasPlaces ? ' The places below come from the search alone.' : '';
  const local = modelId === undefined || modelId === 'local';
  const claudeWay = local ? [ACT.askClaude] : [];
  switch (r.reason) {
    case 'ollama-down':
      return { text: `Ollama isn't running, so ${who} can't ${verb} this yet.${tail}`, actions: [ACT.startOllama, ...claudeWay] };
    case 'model-missing':
      return { text: `${who}'s model (${isStr(r.model) ? r.model : modelName || 'the local model'}) isn't installed in Ollama, so it can't ${verb} this yet.${tail}`, actions: claudeWay };
    case 'timeout':
      return { text: `${who} took too long to ${verb} this.${tail}`, actions: claudeWay };
    case 'no-matches': {
      // while the first index is being built "nothing matched" is about the files read SO FAR, not the repo (PR #169 Dexter N1)
      const b = isObj(r.building) ? r.building : null;
      if (b) {
        const n = isCount(b.files) ? b.files : (isCount(b.done) ? b.done : null);
        const of = isCount(b.total) && b.total > 0 ? ` (of ${b.total})` : '';
        return { text: `Nothing matched in ${n === null ? 'the files' : `the ${n} file${n === 1 ? '' : 's'}`} read so far${of}; the rest are still being read. Ask again in a moment.`, actions: [] };
      }
      return { text: 'Nothing in this repo matched that. Try other words.', actions: [] };
    }
    case 'empty-question':
      return { text: 'Type a question first.', actions: [] };
    case 'index-failed':
      return { text: `Couldn't read this repo: ${isStr(r.error) && r.error ? r.error : 'unknown reason'}.`, actions: [] };
    case 'explainer-off':
      return { text: `${who} can't explain code yet on ${modelName || 'this model'}: it hasn't passed the quality check. Ask a question instead, or pick another model in ⚙.`, actions: [] };
    case 'claude-missing':
      return { text: `Claude isn't installed on this machine, so ${modelName || 'Claude'} can't answer.`, actions: [] };
    case 'not-signed-in':
      return { text: 'Claude isn\'t signed in. Open a terminal, run claude, sign in, then ask again.', actions: [] };
    case 'claude-failed':
      return { text: `Claude didn't answer: ${isStr(r.detail) && r.detail ? r.detail : 'it stopped without a reason'}.`, actions: [] };
    case 'bad-selection':
      return { text: `Couldn't read the selected code${isStr(r.detail) && r.detail ? ': ' + r.detail : ''}.`, actions: [] };
    case 'bad-reply':
    case 'http':
      return { text: `${who} gave an answer that couldn't be used. Ask again.${tail}`, actions: claudeWay };
    default:
      if (isStr(r.error) && r.error) return { text: r.error, actions: [] };
      return { text: `Something went wrong (${isStr(r.reason) && r.reason ? r.reason : 'no reason given'}).${tail}`, actions: [] };
  }
}

function indexLine(index) {
  if (!isObj(index)) return { text: 'checking this repo…', busy: false };
  if (index.state === 'partial' && index.running !== true) {
    // nothing is building it: not "N of N files", which would look finished
    const n = isCount(index.files) ? `${index.files} files` : 'some files';
    return { text: `the saved index is incomplete (${n} read) and nothing is building it; opening the panel again resumes it`, busy: false };
  }
  if (index.state === 'building' || index.state === 'partial') {
    const p = isObj(index.progress) ? index.progress : {};
    if (p.done === 0 || !isCount(p.done)) return { text: 'starting to read this repo for the first time; ask again in a moment', busy: true };
    const where = isCount(p.total) && p.total > 0 ? `${p.done} of ${p.total} files` : `${p.done} files`;
    return { text: `reading this repo for the first time: ${where}. Questions work meanwhile, from the files read so far.`, busy: true };
  }
  if (index.state === 'failed') return { text: `couldn't read this repo: ${isStr(index.error) && index.error ? index.error : 'unknown reason'}`, busy: false };
  if (index.state === 'none') return { text: 'this repo is not read yet; opening the panel starts it', busy: false };
  const files = isCount(index.files) ? `${index.files} files` : 'files';
  return { text: `${files} read${index.keywordOnly === true ? ', keywords only (no embedding model)' : ''}`, busy: false };
}

function statusLine(host, modelId) {
  const h = isObj(host) ? host : {};
  const models = Array.isArray(h.models) ? h.models : [];
  const m = models.find(x => isObj(x) && x.id === (modelId || 'local'));
  const model = m && isStr(m.model) ? m.model : 'the local model';
  return `${model} · ${indexLine(h.index).text}${m && m.explainer === false ? ' · explaining code is off on this model' : ''}`;
}

function canExplain(host, modelId) {
  const models = isObj(host) && Array.isArray(host.models) ? host.models : [];
  const m = models.find(x => isObj(x) && x.id === modelId);
  return !!m && m.explainer === true;
}

function examplesOf(host) {
  const list = isObj(host) && Array.isArray(host.examples) ? host.examples.filter(x => isStr(x) && x.trim()).slice(0, 3) : [];
  return list.length ? list : [...GENERIC_EXAMPLES];
}

// Replies that are a verdict about the INPUT or about readiness, not a failure of the explainer: the page answers each with words and no way
// out, and none has its cause in a model, Ollama or a sign-in. The explainer's roster state (host/ask-explainer.js) does not frown at them.
const INPUT_VERDICTS = Object.freeze(['no-matches', 'empty-question', 'bad-selection', 'explainer-off', 'index-building']);

const API = {
  INPUT_VERDICTS, HISTORY_MAX, create, begin, setPlaces, setStage, finish, select, current, history, trail, viewOf, stagesOf, noticeOf,
  indexLine, statusLine, canExplain, examplesOf, ACT,
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.askPanelState = API;

})(typeof window !== 'undefined' ? window : globalThis);
