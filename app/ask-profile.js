'use strict';
/**
 * Who "Ask the repo"'s explainer is, who it explains for and which model it uses (BACKLOG #33, DESIGN_ASK_REPO.md rounds 4-6, 8).
 *
 *   load(storage) -> profile { named, name, portrait, level, aboutMe, model }       never throws; defaults for anything unreadable
 *   save(storage, profile) -> boolean
 *   name(profile, text, portrait) -> { ok, profile } | { ok: false, reason }        the naming card's Save
 *   setLevel / setAboutMe / setModel (profile, value) -> profile                    strict: an unknown value changes nothing
 *
 * One profile per person, user-wide: every tab's page shares one localStorage, so the key does not name a tab. The level starts at
 * Comfortable and is never asked (round 4); the explainer is named once, on first use (round 5). The PORTRAIT is the AGENTS' picker's (Ricardo,
 * 2026-10-13): either one of the agents' generated pictures ({ kind: 'agent', agent }), or the picture the person uploaded for the explainer
 * through the agents' own upload ({ kind: 'upload' }, kept by the host under the agent name `ask-explainer`, so the profile holds no image).
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `askProfile`.
 */
(function (root) {

const KEY = 'askRepoProfile';
const NAME_SUGGESTIONS = Object.freeze(['Professor Byte', 'Ada', 'Echo', 'Sage', 'Tutor']);
const DEFAULT_NAME = NAME_SUGGESTIONS[0];
const LEVEL_IDS = Object.freeze(['new', 'learning', 'comfortable', 'expert']);
const MODEL_IDS = Object.freeze(['local', 'haiku', 'sonnet']);
const NAME_MAX = 24;
const ABOUT_ME_MAX = 600;
// An agent's name is a file name on the host's side: the same rule host/bubble-voice.js holds names to.
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const defaults = () => ({
  named: false, name: '', portrait: { kind: 'upload' }, level: 'comfortable', aboutMe: '', model: 'local',
});
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const oneLine = (s, max) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function cleanPortrait(p) {
  if (isObj(p) && p.kind === 'agent' && typeof p.agent === 'string' && AGENT_RE.test(p.agent)) return { kind: 'agent', agent: p.agent };
  return { kind: 'upload' };
}

function clean(raw) {
  const d = defaults();
  if (!isObj(raw)) return d;
  const nm = typeof raw.name === 'string' ? oneLine(raw.name, NAME_MAX) : '';
  return {
    named: raw.named === true && nm !== '',
    name: nm,
    portrait: cleanPortrait(raw.portrait),
    level: LEVEL_IDS.includes(raw.level) ? raw.level : d.level,
    aboutMe: typeof raw.aboutMe === 'string' ? raw.aboutMe.trim().slice(0, ABOUT_ME_MAX) : '',
    model: MODEL_IDS.includes(raw.model) ? raw.model : d.model,
  };
}

function load(storage) {
  try {
    const text = storage && storage.getItem(KEY);
    return text ? clean(JSON.parse(text)) : defaults();
  } catch { return defaults(); }
}

function save(storage, profile) {
  try {
    if (!storage) return false;
    storage.setItem(KEY, JSON.stringify(clean(profile)));
    return true;
  } catch { return false; }
}

function name(profile, text, portrait) {
  const nm = typeof text === 'string' ? oneLine(text, NAME_MAX) : '';
  if (!nm) return { ok: false, reason: 'empty-name' };
  return { ok: true, profile: { ...profile, named: true, name: nm, portrait: cleanPortrait(portrait) } };
}

const setLevel = (p, level) => (LEVEL_IDS.includes(level) ? { ...p, level } : p);
const setAboutMe = (p, text) => ({ ...p, aboutMe: typeof text === 'string' ? text.trim().slice(0, ABOUT_ME_MAX) : p.aboutMe });
const setModel = (p, model) => ({ ...p, model: MODEL_IDS.includes(model) ? model : 'local' });

const API = {
  KEY, NAME_SUGGESTIONS, DEFAULT_NAME, LEVEL_IDS, MODEL_IDS, NAME_MAX, ABOUT_ME_MAX,
  load, save, name, setLevel, setAboutMe, setModel,
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.askProfile = API;

})(typeof window !== 'undefined' ? window : globalThis);
