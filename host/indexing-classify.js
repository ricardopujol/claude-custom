'use strict';
/**
 * The indexing assistant's classifier: the prompt and the reply (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md
 * "Claude's call" 3 and 4). Pure: no network, no files; host/indexing-service.js asks the model.
 *
 *   buildPrompt(note, backlogText)  -> the whole prompt: the backlog's `## N. title` lines, the note, the instruction last
 *   parseReply(raw, items)          -> { sure, kind, target, title }   items: host/indexing-doc.js parseBacklog().items
 *   candidates(note, items, k)      -> up to k item numbers for the "Where should this go?" picker
 *   fallbackTitle(note)             -> a title made from the note's first words, for a new item picked by hand
 *
 * WHAT THE MODEL SEES: the note and the title lines only (about 70 lines, inside the 8k context), never an item's body.
 * WHAT IT ANSWERS: `{ kind, target: "new" | N | "history", title?, sure }`. Kinds: idea and bug go to the backlog,
 * decision and learning to the history. Not sure, with the guess kept where it can be, when:
 *   - the reply has no JSON object in it, or the object has no known kind and no usable target (no guess at all)
 *   - `sure` is anything but a real `true`
 *   - the target is an item that doesn't exist, or exists twice (then there is no target guess)
 *   - the kind doesn't go where the target is (a decision on a backlog item, an idea in the history): the swap the
 *     accuracy gate counts as wrong is never filed without asking
 *   - a new item has no usable title
 * The item number of a NEW item is never the model's: host/indexing-doc.js computes it.
 */

const { titleLines } = require('./indexing-doc');

const KINDS = ['idea', 'bug', 'decision', 'learning'];
const BACKLOG_KINDS = ['idea', 'bug'];
const KIND_ALIASES = { problem: 'bug', fix: 'bug' };
const TITLE_MAX = 80;
const FALLBACK_WORDS = 8;

const INSTRUCTION = [
  '---',
  'You file notes into a software project\'s documentation. Above are the backlog\'s items (number and title) and one note.',
  'Decide what the note is and where it belongs.',
  'kind: "idea" (a feature or change someone wants), "bug" (something broken or wrong), "decision" (a choice that was made), or "learning" (something found out, a lesson).',
  'target: the number of an existing item when the note adds to that item; "new" when it is an idea or bug that no item covers; "history" for a decision or a learning.',
  'title: only when target is "new": a short title, at most 8 words, in the style of the item titles.',
  'sure: true only when you are confident of both kind and target.',
  'Answer with JSON only, in exactly this shape:',
  '{"kind": "idea", "target": "new", "title": "...", "sure": true}',
].join('\n');

function buildPrompt(note, backlogText) {
  const titles = titleLines(backlogText);
  return [
    'Backlog items:',
    titles.length ? titles.join('\n') : '(none yet)',
    '',
    'Note:',
    '"""',
    String(note == null ? '' : note).trim(),
    '"""',
    '',
    INSTRUCTION,
  ].join('\n');
}

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/** The first JSON object in the reply: the whole reply, or from its first `{` to its last `}`. */
function objectIn(raw) {
  if (typeof raw !== 'string') return null;
  const tries = [raw];
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(raw.slice(a, b + 1));
  for (const t of tries) {
    try { const o = JSON.parse(t); if (isObject(o)) return o; } catch { /* next */ }
  }
  return null;
}

function kindOf(v) {
  if (typeof v !== 'string') return null;
  const k = v.trim().toLowerCase();
  if (KINDS.includes(k)) return k;
  return KIND_ALIASES[k] || null;
}

/** 'new' | 'history' | an item number as written (not yet checked against the items) | null. */
function targetOf(v) {
  if (Number.isInteger(v) && v > 0) return v;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'new' || s === 'history') return s;
  const m = /^#?\s*(\d{1,6})$/.exec(s);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

function cleanTitle(v) {
  if (typeof v !== 'string') return null;
  let s = v.replace(/\s+/g, ' ').trim();
  s = s.replace(/^#+\s*/, '').replace(/^\d{1,6}\.\s*/, '').trim();
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX - 1).trimEnd() + '…';
  return s === '' ? null : s;
}

function parseReply(raw, items) {
  const none = { sure: false, kind: null, target: null, title: null };
  const o = objectIn(raw);
  if (!o) return none;
  const kind = kindOf(o.kind);
  let target = targetOf(o.target);
  if (Number.isInteger(target)) {
    const found = (Array.isArray(items) ? items : []).filter(i => i && i.n === target);
    if (found.length !== 1) target = null;
  }
  if (kind === null && target === null) return none;
  const title = target === 'new' ? cleanTitle(o.title) : null;
  const goesThere = kind !== null && target !== null
    && (target === 'history' ? !BACKLOG_KINDS.includes(kind) : BACKLOG_KINDS.includes(kind));
  const sure = o.sure === true && goesThere && (target !== 'new' || title !== null);
  return { sure, kind, target, title };
}

const STOP = new Set(('the a an and or but of to in on at for with from by as is are was were be been it its this that these '
  + 'those there their them they we you i me my our your he she his her not no so if then than when what which who how all '
  + 'any can could should would will just also only into out up down more most some such very too do does did done has have '
  + 'had one two new').split(' '));

function wordsOf(text) {
  const out = new Set();
  for (const w of String(text == null ? '' : text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
  }
  return out;
}

function candidates(note, items, k = 3) {
  const unique = (Array.isArray(items) ? items : []).filter(i => i && !i.dup);
  const want = wordsOf(note);
  const scored = unique.map(i => {
    let score = 0;
    for (const w of wordsOf(i.title)) if (want.has(w)) score += 1;
    return { n: i.n, score };
  });
  scored.sort((x, y) => (y.score - x.score) || (y.n - x.n));
  return scored.slice(0, Math.max(0, k)).map(s => s.n);
}

function fallbackTitle(note) {
  const words = String(note == null ? '' : note).trim().split(/\s+/).filter(Boolean);
  const head = words.slice(0, FALLBACK_WORDS).join(' ');
  return words.length > FALLBACK_WORDS ? head + '…' : head;
}

module.exports = { buildPrompt, parseReply, candidates, fallbackTitle, KINDS, BACKLOG_KINDS, INSTRUCTION };
