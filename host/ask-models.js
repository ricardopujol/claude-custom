'use strict';
/**
 * The models "Ask the repo" can answer with (BACKLOG #33, DESIGN_ASK_REPO.md Round 8): Local (Ollama, the default), Haiku and Sonnet
 * (Claude, through the real `claude` CLI on the person's plan: host/ask-claude.js).
 *
 *   createModels({ localModel, readRecord }) ->
 *     list()               -> [{ id, kind: 'ollama' | 'claude', name, model, explainer: boolean }]
 *     choose(id)           -> a known id, else 'local'
 *     label(id, givenName) -> "Professor Byte · qwen3.5:4b · local" | "Professor Byte · Haiku · Claude, uses your plan"
 *     explainerOn(id)      -> has THIS model passed the bar?
 *
 * THE EXPLAINER IS SWITCHED ON PER MODEL, BY A RECORD, NOT BY A FLAG. qwen3.5:4b explaining code missed the bar (graded 9/10 and 7/10 by
 * the first grader, 7/10 and 3/10 by the blind second one), so for it "What's this?" is built and off. host/ask-explainer-record.json
 * holds, per model, how many of the 10 measured selections were graded right and pitched at each of the two levels. It is DATA read at
 * run time and the bar is re-checked here, so an entry that doesn't meet it (or a record that can't be read) turns nothing on. The local
 * entry is keyed by the Ollama model's name: swapping the local model switches the explainer off until that model is measured.
 */

const fs = require('fs');
const path = require('path');

const CHOICES = Object.freeze(['local', 'haiku', 'sonnet']);
const DEFAULT_MODEL = 'local';
const BAR = Object.freeze({ min: 8, of: 10 });
const RECORD_FILE = path.join(__dirname, 'ask-explainer-record.json');

const CLAUDE_NAMES = Object.freeze({ haiku: 'Haiku', sonnet: 'Sonnet' });

const isCount = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** 8 of 10 right and pitched at New to coding AND at Comfortable. Strict about types: "9" and null pass nothing. */
function passesBar(entry) {
  if (entry === null || typeof entry !== 'object') return false;
  if (entry.of !== BAR.of) return false;
  return isCount(entry.new) && isCount(entry.comfortable) && entry.new >= BAR.min && entry.comfortable >= BAR.min;
}

/** The record text -> { modelKey: entry } with a null prototype; anything unreadable is an empty record. */
function parseRecord(text) {
  const out = Object.create(null);
  let j = null;
  try { j = JSON.parse(text); } catch { return out; }
  const passed = j !== null && typeof j === 'object' && !Array.isArray(j) ? j.passed : null;
  if (passed === null || typeof passed !== 'object' || Array.isArray(passed)) return out;
  for (const key of Object.keys(passed)) {
    const e = passed[key];
    if (e !== null && typeof e === 'object') out[key] = e;
  }
  return out;
}

function createModels({ localModel = 'qwen3.5:4b', readRecord = () => fs.readFileSync(RECORD_FILE, 'utf8') } = {}) {
  const load = () => {
    try { return parseRecord(readRecord()); } catch { return Object.create(null); }
  };
  const keyOf = (id) => (id === 'local' ? localModel : id);
  const nameOf = (id) => (id === 'local' ? localModel : CLAUDE_NAMES[id]);

  const whereOf = (id) => (id === 'local' ? `${nameOf('local')} · local` : `${nameOf(id)} · Claude, uses your plan`);
  const explainerOn = (id) => CHOICES.includes(id) && passesBar(load()[keyOf(id)]);

  return {
    list() {
      const rec = load();
      return CHOICES.map(id => ({
        id, kind: id === 'local' ? 'ollama' : 'claude', name: id === 'local' ? 'Local' : CLAUDE_NAMES[id], model: nameOf(id),
        explainer: passesBar(rec[keyOf(id)]),
        where: whereOf(id),
      }));
    },
    choose: (id) => (CHOICES.includes(id) ? id : DEFAULT_MODEL),
    label(id, givenName) {
      const where = whereOf(id);
      const who = typeof givenName === 'string' ? givenName.trim() : '';
      return who ? `${who} · ${where}` : where;
    },
    explainerOn,
  };
}

module.exports = { createModels, parseRecord, passesBar, BAR, DEFAULT_MODEL, CHOICES, RECORD_FILE };
