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
 * Comfortable and is never asked (round 4); the explainer is named once, on first use (round 5); the portrait is an emoji or a small image
 * the person uploads (round 6: the agents' avatar picker is main-process machinery; the panel keeps its own picker, see the PR notes).
 * An uploaded image is stored as a data URL, so it is held to PNG / JPEG / WebP / GIF (SVG can carry script) and to a size cap.
 *
 * WRAPPED IN AN IIFE (see app/worktree-status-display.js). One name leaves it: `askProfile`.
 */
(function (root) {

const KEY = 'askRepoProfile';
const NAME_SUGGESTIONS = Object.freeze(['Professor Byte', 'Ada', 'Echo', 'Sage', 'Tutor']);
const DEFAULT_NAME = NAME_SUGGESTIONS[0];
const PORTRAITS = Object.freeze(['🦉', '🤖', '🦊', '🐙', '🧙', '🐢', '🦄', '🧑‍🏫']);
const LEVEL_IDS = Object.freeze(['new', 'learning', 'comfortable', 'expert']);
const MODEL_IDS = Object.freeze(['local', 'haiku', 'sonnet']);
const NAME_MAX = 24;
const ABOUT_ME_MAX = 600;
const IMAGE_MAX_CHARS = 150_000;
const IMAGE_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

const defaults = () => ({
  named: false, name: '', portrait: { kind: 'emoji', value: PORTRAITS[0] }, level: 'comfortable', aboutMe: '', model: 'local',
});
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const oneLine = (s, max) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function cleanPortrait(p) {
  if (isObj(p) && p.kind === 'image' && typeof p.dataUrl === 'string' && p.dataUrl.length <= IMAGE_MAX_CHARS && IMAGE_RE.test(p.dataUrl)) {
    return { kind: 'image', dataUrl: p.dataUrl };
  }
  if (isObj(p) && p.kind === 'emoji' && PORTRAITS.includes(p.value)) return { kind: 'emoji', value: p.value };
  return { kind: 'emoji', value: PORTRAITS[0] };
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
  KEY, NAME_SUGGESTIONS, DEFAULT_NAME, PORTRAITS, LEVEL_IDS, MODEL_IDS, NAME_MAX, ABOUT_ME_MAX, IMAGE_MAX_CHARS,
  load, save, name, setLevel, setAboutMe, setModel,
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.askProfile = API;

})(typeof window !== 'undefined' ? window : globalThis);
