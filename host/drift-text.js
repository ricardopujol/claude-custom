'use strict';
/**
 * The text side of "docs drift" (BACKLOG #39 job 2: after a merge into develop, a local model flags sentences in the
 * docs that the merge's diff now contradicts). Pure: no files, no network, no clock.
 *
 *   redact(text)                          -> text with secret-shaped strings replaced by "[redacted]"
 *   trimDiff(diff, { maxChars, perFile }) -> the diff without secret/noise files, redacted, capped per file and in total
 *   changedFilesOf(diff)                  -> the b-side paths of a diff, once each
 *   buildLogNow(text, cap)                -> the build log's "Now" section, or null
 *   candidateDocs({ changedFiles, docs, max, excerptChars }) -> [{ rel, excerpt, score }]  the design/plan docs that
 *                                            name something the merge changed, best first
 *   buildPrompt({ subject, sha, diff, now, docs }) -> { system, prompt, docs }   `docs` is what the model was SHOWN
 *   parseReply(text, shownDocs)           -> [{ doc, sentence, why }] | null   null: the reply was not a JSON list
 *
 * WHAT GOES IN. Only what a human would read to judge the merge: the diff (no .env/key/lock/minified/binary files, cut
 * per file and in total, secret-shaped strings redacted), the build log's "Now" and short excerpts of at most two design
 * docs that name a changed file. The whole prompt is bounded (PROMPT_MAX_CHARS, well inside the 8192-token window).
 *
 * WHAT COMES BACK IS CHECKED. A 4B model invents. A flag survives only if the sentence it quotes is really in the excerpt of
 * the doc it names (whitespace-insensitive) and it gives a reason; everything else is dropped. The notes therefore always
 * point at real words in a real doc.
 */

const DIFF_MAX_CHARS = 9_000;
const DIFF_PER_FILE = 2_500;
const NOW_MAX_CHARS = 2_500;
const EXCERPT_CHARS = 2_500;
const PROMPT_MAX_CHARS = 20_000;
const MAX_FLAGS = 3;
const MAX_DOCS = 2;
const SENTENCE_MAX = 400;
const SENTENCE_MIN = 8;
const WHY_MAX = 300;
const CUT = '\n[diff cut]\n';
const BUILD_LOG = 'CLAUDECUSTOM_BUILD_LOG.md';
const BUILD_LOG_SECTION_CHARS = 200_000;

const REDACTIONS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];
const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
const ASSIGNED = /(\b(?:password|passwd|secret|token|api[_-]?key|authorization|auth)\b\s*[:=]\s*)(["']?)[^\s"',;]{4,}\2/gi;

const EXCLUDED_FILE = [
  /(^|\/)\.env(\.|$)/i, /(^|\/)package-lock\.json$/i, /(^|\/)(yarn\.lock|pnpm-lock\.yaml)$/i, /\.min\.(js|css)$/i,
  /\.(pem|key|p12|pfx|crt|cer)$/i, /(^|\/)secrets?(\.|\/|$)/i, /(^|\/)node_modules\//i,
  /\.(png|jpe?g|gif|webp|ico|mp4|webm|mp3|wav|zip|exe|dll|woff2?|ttf|pdf|map)$/i,
];

const isStr = (s) => typeof s === 'string';
const squash = (s) => s.replace(/\s+/g, ' ').trim();

function redact(text) {
  if (!isStr(text)) return '';
  let out = text;
  for (const re of REDACTIONS) out = out.replace(re, '[redacted]');
  out = out.replace(BEARER, '$1[redacted]');
  return out.replace(ASSIGNED, '$1$2[redacted]$2');
}

const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);

function pathOfChunk(chunk) {
  const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
  return m ? m[2] : null;
}

function trimDiff(diff, { maxChars = DIFF_MAX_CHARS, perFile = DIFF_PER_FILE } = {}) {
  if (!isStr(diff) || diff === '') return '';
  const chunks = diff.split(/^(?=diff --git )/m);
  let out = '';
  for (const raw of chunks) {
    if (raw === '') continue;
    const file = pathOfChunk(raw);
    if (file !== null && EXCLUDED_FILE.some(re => re.test(file))) continue;
    let chunk = redact(cap(raw, 200_000));
    if (chunk.length > perFile) chunk = chunk.slice(0, perFile) + CUT;
    if (out.length + chunk.length > maxChars) {
      const room = maxChars - out.length;
      if (room > 0) out += chunk.slice(0, room);
      return out + CUT;
    }
    out += chunk;
  }
  return out;
}

function changedFilesOf(diff) {
  if (!isStr(diff)) return [];
  const seen = new Set();
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let m;
  while ((m = re.exec(diff)) !== null) seen.add(m[2]);
  return [...seen];
}

function buildLogNow(text, capChars = NOW_MAX_CHARS) {
  if (!isStr(text)) return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^##\s+Now\b/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
  const body = cap(lines.slice(start + 1, end).join('\n').trim(), BUILD_LOG_SECTION_CHARS);
  return body === '' ? null : cap(body, capChars);
}

const ELIGIBLE_DOC = /^(?:DESIGN|PLAN|FEATURES)_[^/\\]*\.md$/i;

// A changed file is named by its full path, or by its stem when that is long enough not to be a common word ("index").
function termsOf(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const stem = base.replace(/\.[^.]+$/, '');
  return stem.length >= 8 && stem !== file ? [file, stem] : [file];
}

const occurrences = (text, term) => text.split(term).length - 1;

function excerptOf(text, terms, budget) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  lines.forEach((l, i) => { if (terms.some(t => l.includes(t))) hits.push(i); });
  const order = [...hits];
  for (const i of hits) { if (i > 0) order.push(i - 1); if (i + 1 < lines.length) order.push(i + 1); }
  const chosen = new Set();
  let used = 0;
  for (const i of order) {
    if (chosen.has(i)) continue;
    const cost = lines[i].length + 1;
    if (used + cost > budget) continue;
    chosen.add(i);
    used += cost;
  }
  if (chosen.size === 0 && hits.length) return cap(lines[hits[0]], budget);
  return [...chosen].sort((a, b) => a - b).map(i => lines[i]).join('\n');
}

function candidateDocs({ changedFiles, docs, max = MAX_DOCS, excerptChars = EXCERPT_CHARS }) {
  const files = Array.isArray(changedFiles) ? changedFiles.filter(isStr) : [];
  const terms = [...new Set(files.flatMap(termsOf))];
  const scored = [];
  for (const d of Array.isArray(docs) ? docs : []) {
    if (!d || !isStr(d.rel) || !isStr(d.text) || !ELIGIBLE_DOC.test(d.rel)) continue;
    // per changed file: the path's mentions, else the stem's (never both for one file)
    const score = files.reduce((n, f) => {
      const [path, stem] = termsOf(f);
      const byPath = occurrences(d.text, path);
      return n + (byPath > 0 || stem === undefined ? byPath : occurrences(d.text, stem));
    }, 0);
    if (score > 0) scored.push({ rel: d.rel, text: d.text, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : 1));
  return scored.slice(0, Math.max(0, max)).map(d => ({
    rel: d.rel, score: d.score, excerpt: excerptOf(d.text, terms.filter(t => d.text.includes(t)), excerptChars),
  }));
}

const SYSTEM = 'You check whether project documentation still matches the code. You get one merged change (a diff) and excerpts '
  + 'of documents. Flag a sentence ONLY when the diff clearly makes it false: a name, number, behaviour or rule that the '
  + 'diff changed or removed. Do not flag sentences that are merely incomplete, or about things the diff does not touch. '
  + 'Copy the sentence EXACTLY as it appears in the excerpt. Reply with ONLY a JSON array of at most 3 items, each '
  + '{"doc": "<file name>", "sentence": "<the exact sentence>", "why": "<one short sentence: what the diff changed>"}. '
  + 'If nothing is contradicted, reply [].';

function buildPrompt({ subject, sha, diff, now, docs }) {
  const shown = [];
  if (isStr(now) && now.trim() !== '') shown.push({ rel: BUILD_LOG, label: `${BUILD_LOG} (section "Now")`, excerpt: cap(redact(now), NOW_MAX_CHARS) });
  for (const d of Array.isArray(docs) ? docs.slice(0, MAX_DOCS) : []) {
    if (d && isStr(d.rel) && isStr(d.excerpt)) shown.push({ rel: cap(d.rel, 120), label: cap(d.rel, 120), excerpt: cap(redact(d.excerpt), EXCERPT_CHARS) });
  }
  const head = `Merged commit ${isStr(sha) ? cap(sha, 40) : ''}: ${isStr(subject) ? cap(redact(squash(subject)), 200) : ''}`;
  const body = trimDiff(diff, { maxChars: DIFF_MAX_CHARS, perFile: DIFF_PER_FILE });
  const parts = [head, '', 'DIFF:', body, '', ...shown.flatMap(d => [`DOCUMENT ${d.label}:`, d.excerpt, ''])];
  parts.push('Which sentences in the documents above does this diff now contradict? Reply with the JSON array only.');
  const prompt = cap(parts.join('\n'), PROMPT_MAX_CHARS - SYSTEM.length);
  return { system: SYSTEM, prompt, docs: shown.map(({ rel, excerpt }) => ({ rel, excerpt })) };
}

function extractJson(text) {
  const s = text.replace(/```(?:json)?/gi, '');
  const open = s.indexOf('[');
  const close = s.lastIndexOf(']');
  if (open < 0 || close < open) return null;
  try { const v = JSON.parse(s.slice(open, close + 1)); return Array.isArray(v) ? v : null; } catch { return null; }
}

function parseReply(text, shownDocs) {
  if (!isStr(text) || text.trim() === '') return null;
  const items = extractJson(text);
  if (items === null) return null;
  const byRel = new Map((Array.isArray(shownDocs) ? shownDocs : []).filter(d => d && isStr(d.rel) && isStr(d.excerpt)).map(d => [d.rel, squash(d.excerpt)]));
  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (out.length >= MAX_FLAGS) break;
    if (it === null || typeof it !== 'object' || Array.isArray(it)) continue;
    if (!isStr(it.doc) || !isStr(it.sentence) || !isStr(it.why)) continue;
    const hay = byRel.get(it.doc);
    const sentence = squash(it.sentence);
    const why = squash(it.why);
    if (hay === undefined || why === '' || sentence.length < SENTENCE_MIN || sentence.length > SENTENCE_MAX) continue;
    if (!hay.includes(sentence)) continue;
    const key = it.doc + '\0' + sentence;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ doc: it.doc, sentence, why: cap(why, WHY_MAX) });
  }
  return out;
}

module.exports = {
  redact, trimDiff, changedFilesOf, buildLogNow, candidateDocs, buildPrompt, parseReply,
  DIFF_MAX_CHARS, PROMPT_MAX_CHARS, MAX_FLAGS, BUILD_LOG, SYSTEM,
};
