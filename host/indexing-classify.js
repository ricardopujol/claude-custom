'use strict';
/**
 * The indexing assistant's classifier (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md "Claude's call" 3 and 4).
 * Pure apart from `classifyNote`, which calls the model through an injected `generate` (host/summary-ollama.js).
 *
 *   classifyNote({ note, backlogText, generate }) -> { ok: true, result: { sure, kind, target, title } }
 *                                                  | { ok: false, reason }   (the model call failed: the note waits)
 *   buildKindPrompt(note) / parseKindReply(raw)        the kind: idea | bug | decision | learning | null
 *   matchTarget(note, items)                           -> { target: N | 'new', score, next }
 *   buildTitlePrompt(note, backlogText) / parseTitleReply(raw)   a new item's title
 *   candidates(note, items, k), overlap(note, title), fallbackTitle(note)   the picker's helpers
 *
 * WHY IT'S SPLIT THIS WAY (measured, verify/probe-indexing-accuracy.js on 2026-10-05, 46 real notes): asked for the
 * design's one JSON reply `{kind, target, title, sure}` with the title lines, llama3.2:3b scored 15% with 12
 * history/backlog swaps (it said "learning, new" to almost everything). Sorting the note from four LETTERED choices is
 * what it does well; deciding whether a note is "the same item" as a title it can't do at all (every phrasing either
 * always attached the note to some item or never did), and shared words did better. So:
 *   1. the model answers the KIND (the note only, nothing from the backlog);
 *   2. decision and learning go to the history, by code: the swap the gate forbids can't come from a target answer;
 *   3. idea and bug go to the item sharing at least MATCH_MIN meaningful words with the note, if exactly one leads, else
 *      to a new item (code: matchTarget);
 *   4. a new item's title is the model's (the note and five recent titles as examples of the style).
 * The item number of a new item is never the model's: host/indexing-doc.js computes it.
 *
 * NOT SURE (it then asks, "Claude's call" 4) when the kind can't be read (no guess at all), or a new item has no
 * usable title (the note's first words stand in). The kind call's reply carries no confidence the 3B model can be
 * trusted with, so "sure" here means "every answer was usable".
 */

const { parseBacklog, titleLines } = require('./indexing-doc');

const KINDS = ['idea', 'bug', 'decision', 'learning'];
const BACKLOG_KINDS = ['idea', 'bug'];
const LETTERS = { a: 'idea', b: 'bug', c: 'decision', d: 'learning' };
const KIND_ALIASES = { problem: 'bug', fix: 'bug', feature: 'idea', lesson: 'learning' };
const MATCH_MIN = 3;
const TITLE_EXAMPLES = 5;
const TITLE_MAX = 80;
const FALLBACK_WORDS = 8;
// How the model is asked (host/summary-ollama.js generate): a JSON reply, no sampling noise, room for a title.
const GENERATE_OPTIONS = Object.freeze({ format: 'json', numPredict: 120, temperature: 0 });
// The indexing client's per-try timeout. A classification is up to two calls (kind, then a new item's title), each tried
// twice by the client, all inside one hold of the shared GPU slot: 4 x this must stay under host/summary-slot.js's
// STALE_MS or another tab could take the slot mid-job. Measured: ~0.3 s a note warm; a cold model load is seconds.
const GENERATE_TIMEOUT_MS = 20_000;

function buildKindPrompt(note) {
  return [
    `A developer wrote this note: "${String(note == null ? '' : note).trim()}"`,
    'Which describes it best?',
    'A) A feature or change they want added to the app.',
    'B) A bug: something in the app is broken or wrong.',
    'C) A decision: how something is done was settled (a choice, a rule).',
    'D) A lesson: a fact or gotcha they found out about a tool, a library, the OS or the process.',
    'Answer with JSON only: {"answer": "A"} (or B, C, D)',
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

function parseKindReply(raw) {
  const o = objectIn(raw);
  if (!o) return null;
  const v = typeof o.answer === 'string' ? o.answer : o.kind;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/\)$/, '').trim();
  if (Object.prototype.hasOwnProperty.call(LETTERS, s)) return LETTERS[s];
  if (KINDS.includes(s)) return s;
  return Object.prototype.hasOwnProperty.call(KIND_ALIASES, s) ? KIND_ALIASES[s] : null;
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

/** How many meaningful words a note and a title share. */
function overlap(note, title) {
  const want = wordsOf(note);
  let score = 0;
  for (const w of wordsOf(title)) if (want.has(w)) score += 1;
  return score;
}

/** Unique items by shared words, the most first, the newer first on a tie. */
function ranked(note, items) {
  const unique = (Array.isArray(items) ? items : []).filter(i => i && Number.isInteger(i.n) && !i.dup);
  return unique.map(i => ({ n: i.n, score: overlap(note, i.title) })).sort((x, y) => (y.score - x.score) || (y.n - x.n));
}

function matchTarget(note, items) {
  const r = ranked(note, items);
  const score = r.length ? r[0].score : 0;
  const next = r.length > 1 ? r[1].score : 0;
  return { target: score >= MATCH_MIN && score > next ? r[0].n : 'new', score, next };
}

const candidates = (note, items, k = 3) => ranked(note, items).slice(0, Math.max(0, k)).map(s => s.n);

function buildTitlePrompt(note, backlogText) {
  const unique = parseBacklog(backlogText).items.filter(i => !i.dup);
  const examples = unique.slice(-TITLE_EXAMPLES).map(i => `- ${i.title}`);
  const style = examples.length ? ['Titles of other items, for the style:', ...examples] : [];
  return [
    'Write a short title, at most 8 words, for a new backlog item made from this note.',
    ...style,
    '',
    `Note: "${String(note == null ? '' : note).trim()}"`,
    'Answer with JSON only: {"title": "..."}',
  ].join('\n');
}

function cleanTitle(v) {
  if (typeof v !== 'string') return null;
  let s = v.replace(/\s+/g, ' ').trim();
  s = s.replace(/^#+\s*/, '').replace(/^\d{1,6}\.\s*/, '').trim();
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX - 1).trimEnd() + '…';
  return s === '' ? null : s;
}

function parseTitleReply(raw) {
  const o = objectIn(raw);
  return o ? cleanTitle(o.title) : null;
}

function fallbackTitle(note) {
  const words = String(note == null ? '' : note).trim().split(/\s+/).filter(Boolean);
  const head = words.slice(0, FALLBACK_WORDS).join(' ');
  return words.length > FALLBACK_WORDS ? head + '…' : head;
}

async function classifyNote({ note, backlogText, generate }) {
  const k = await generate(buildKindPrompt(note), GENERATE_OPTIONS);
  if (!k || k.ok !== true) return { ok: false, reason: (k && k.reason) || 'failed' };
  const kind = parseKindReply(k.text);
  if (kind === null) return { ok: true, result: { sure: false, kind: null, target: null, title: null } };
  if (!BACKLOG_KINDS.includes(kind)) return { ok: true, result: { sure: true, kind, target: 'history', title: null } };
  const { target } = matchTarget(note, parseBacklog(backlogText).items);
  if (target !== 'new') return { ok: true, result: { sure: true, kind, target, title: null } };
  const t = await generate(buildTitlePrompt(note, backlogText), GENERATE_OPTIONS);
  if (!t || t.ok !== true) return { ok: false, reason: (t && t.reason) || 'failed' };
  const title = parseTitleReply(t.text);
  return { ok: true, result: title === null
    ? { sure: false, kind, target: 'new', title: fallbackTitle(note) }
    : { sure: true, kind, target: 'new', title } };
}

module.exports = {
  classifyNote, buildKindPrompt, parseKindReply, matchTarget, buildTitlePrompt, parseTitleReply,
  candidates, overlap, fallbackTitle, titleLines, KINDS, BACKLOG_KINDS, MATCH_MIN, GENERATE_OPTIONS, GENERATE_TIMEOUT_MS,
};
