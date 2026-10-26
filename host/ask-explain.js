'use strict';
/**
 * The explainer prompt for "Ask the repo" (BACKLOG #33, DESIGN_ASK_REPO.md): "What's this?" on selected code, a level, an optional
 * "About me", Simpler / Deeper, and the drill-down on highlighted words of an earlier answer. Pure: it builds the text; the service
 * (host/ask-service.js) finds the excerpts and a model (local Ollama or a Claude model) answers.
 *
 *   buildExplain({ file, start, end, lines, excerpts, level, aboutMe, direction, term, answer }) -> { system, prompt }
 *   clipSelection({ file, start, end, lines }) -> { file, start, end, lines, clipped }
 *   LEVELS, DEFAULT_LEVEL, levelOf(id)
 *
 * THE WORDING IS A MEASURED THING. BASE and the `new` / `comfortable` rules are the prompt "v1" graded on 2026-10-13
 * (reviews/claude-custom/2026-10-13-ask-explain-measure.md, 10 selections x 2 levels). A tuned v2/v3 was tried on a hold-out set and
 * scored WORSE on qwen3.5:4b, so v1 stays. Changing these sentences is a new measurement, not an edit. `learning` and `expert` are
 * not measured; an explainer is switched on per model only after its measurement passed (host/ask-models.js).
 */

const LEVELS = Object.freeze([
  Object.freeze({ id: 'new', label: 'New to coding' }),
  Object.freeze({ id: 'learning', label: 'Learning this language' }),
  Object.freeze({ id: 'comfortable', label: 'Comfortable' }),
  Object.freeze({ id: 'expert', label: 'Expert' }),
]);
const DEFAULT_LEVEL = 'comfortable';
const SELECTION_MAX_LINES = 60;
const SELECTION_MAX_CHARS = 300;
const ABOUT_ME_MAX_CHARS = 600;
const TERM_MAX_CHARS = 120;
const ANSWER_MAX_CHARS = 2000;

const BASE = 'You explain code from a repository to its owner, using ONLY the selected code and the numbered excerpts provided. '
  + 'Never claim anything about the code that the selected code or the excerpts do not show; if something is not visible, say you cannot see it. '
  + 'Write: (1) the idea in plain words, 3 to 5 sentences, then (2) a short list headed "Where it shows up" with real file:line places taken '
  + 'from the excerpt headers (written like path/to/file.ext:123), each with a few words on why. If no excerpt shows it, leave that list out. '
  + 'Do not repeat the code back line by line.';

const LEVEL_RULES = Object.freeze({
  new: 'The reader has never programmed. Use everyday words and one comparison from daily life. Do not use any programming term '
    + 'without explaining it in plain words right there. Short sentences.',
  learning: 'The reader is learning this language: they know programming in general. Explain what is specific to this language and to how it is '
    + 'used here, and relate it to the general idea they already know. Explain a term of the language the first time it appears.',
  comfortable: 'The reader codes comfortably in general but does not know this codebase. Skip the basics (what a loop, a regex or a promise is). '
    + 'Say what the code does, why it is written this way, and anything non-obvious. Programming terms are fine.',
  expert: 'The reader is an expert. Be terse. Say only what is non-obvious: the subtle behaviour, the edge cases, and why it is written this way. '
    + 'No basics.',
});

const DIRECTIONS = Object.freeze({
  simpler: ' Make this explanation simpler than you normally would for this reader: fewer terms, shorter, one concrete picture.',
  deeper: ' Go one level deeper than you normally would for this reader: the mechanism and the edge cases, still only what the code shows.',
});

const levelOf = (id) => LEVELS.find(l => l.id === id) || LEVELS.find(l => l.id === DEFAULT_LEVEL);

const oneLine = (s, max) => String(s).replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim().slice(0, max);

/** A selection cut to a line cap and a width cap, so one huge selection can't push the instructions out of the model's window. */
function clipSelection({ file, start, end, lines }) {
  let clipped = false;
  let kept = Array.isArray(lines) ? lines.slice() : [];
  if (kept.length > SELECTION_MAX_LINES) { kept = kept.slice(0, SELECTION_MAX_LINES); clipped = true; }
  kept = kept.map((l) => {
    const s = String(l);
    if (s.length <= SELECTION_MAX_CHARS) return s;
    clipped = true;
    return s.slice(0, SELECTION_MAX_CHARS) + ' ...[line cut]';
  });
  return { file, start, end: clipped && kept.length < (end - start + 1) ? start + kept.length - 1 : end, lines: kept, clipped };
}

function buildExplain({ file, start, end, lines, excerpts, level, aboutMe, direction, term, answer } = {}) {
  const lv = levelOf(level);
  let system = `${BASE}\n\nReader level: ${lv.label}. ${LEVEL_RULES[lv.id]}`;
  const me = typeof aboutMe === 'string' ? aboutMe.trim().slice(0, ABOUT_ME_MAX_CHARS) : '';
  if (me) system += `\n\nAbout the reader (use it only for a comparison that helps; never claim it about the code): ${me}`;
  if (Object.prototype.hasOwnProperty.call(DIRECTIONS, direction)) system += DIRECTIONS[direction];

  const code = (Array.isArray(lines) ? lines : []).map((l, i) => `${start + i}: ${l}`).join('\n');
  const body = typeof excerpts === 'string' && excerpts.trim() ? excerpts.trim() : '(no other excerpt was found)';
  let ask = 'Explain what the selected code is doing.';
  let lead = '';
  const t = typeof term === 'string' ? oneLine(term, TERM_MAX_CHARS) : '';
  if (t) {
    const earlier = typeof answer === 'string' ? answer.trim().slice(0, ANSWER_MAX_CHARS) : '';
    lead = `The reader highlighted "${t}" in this earlier explanation:\n${earlier}\n\n`;
    ask = `Explain what "${t}" is, in the same way, as it is used in this code.`;
  }
  const prompt = `${lead}Selected code (${file}, lines ${start}-${end}):\n${code}\n\nExcerpts from elsewhere in the repository:\n\n${body}\n\n${ask}`;
  return { system, prompt };
}

module.exports = {
  buildExplain, clipSelection, LEVELS, DEFAULT_LEVEL, levelOf, BASE, LEVEL_RULES,
  SELECTION_MAX_LINES, SELECTION_MAX_CHARS, ABOUT_ME_MAX_CHARS, TERM_MAX_CHARS,
};
