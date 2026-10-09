'use strict';
/**
 * Retrieval for "ask the repo" (BACKLOG #33): a keyword rank and a vector rank, fused by reciprocal rank (the "hybrid" of
 * the 2026-10-03 measurement, which scored 9-10 of 10 at k=8 once test/ and verify/ were left out of the index).
 *
 *   tokenize(text)                                  -> lowercase word pieces (camelCase / snake_case / path split)
 *   cosine(a, b)                                    -> -1..1, and 0 for a zero vector or a length mismatch
 *   hybridRank({ question, queryVec, entries, k })  -> up to k entry ids, best first
 *
 * `entries` are `{ id, tokens, vec }`. No `queryVec` (the embedder is down) is not an error here: the keyword rank
 * alone is returned, and the caller says the answer ran on keywords only.
 */

const STOP = new Set([
  'the', 'is', 'are', 'was', 'were', 'what', 'where', 'which', 'who', 'when', 'how', 'why', 'does', 'do', 'did', 'it', 'its',
  'in', 'on', 'of', 'to', 'for', 'and', 'or', 'an', 'at', 'by', 'be', 'this', 'that', 'from', 'there', 'not',
]);
const RRF_K = 60;

function tokenize(text) {
  const out = [];
  const words = String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^A-Za-z0-9]+/);
  for (const w of words) {
    const t = w.toLowerCase();
    if (t.length < 2 || STOP.has(t)) continue;
    out.push(t);
  }
  return out;
}

function cosine(a, b) {
  if (!Array.isArray(a) && !ArrayBuffer.isView(a)) return 0;
  if (!Array.isArray(b) && !ArrayBuffer.isView(b)) return 0;
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Best first; ties keep index order so the result is deterministic. Entries scoring 0 are not ranked at all. */
function rankBy(entries, score) {
  const scored = [];
  for (let i = 0; i < entries.length; i++) {
    const s = score(entries[i]);
    if (Number.isFinite(s) && s > 0) scored.push([entries[i].id, s, i]);
  }
  scored.sort((x, y) => (y[1] - x[1]) || (x[2] - y[2]));
  return scored.map(x => x[0]);
}

function keywordRank(question, entries) {
  const q = [...new Set(tokenize(question))];
  if (!q.length) return [];
  const df = new Map();
  for (const e of entries) for (const t of new Set(e.tokens)) df.set(t, (df.get(t) || 0) + 1);
  const n = entries.length;
  const idf = (t) => Math.log(1 + n / (1 + (df.get(t) || 0)));
  return rankBy(entries, (e) => {
    const tf = new Map();
    for (const t of e.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of q) { const c = tf.get(t); if (c) s += idf(t) * (1 + Math.log(c)); }
    return s;
  });
}

function hybridRank({ question, queryVec, entries, k }) {
  const want = Number.isInteger(k) && k > 0 ? k : 0;
  if (!want || !Array.isArray(entries) || !entries.length) return [];
  const lists = [keywordRank(question, entries)];
  if (queryVec) lists.push(rankBy(entries, (e) => cosine(queryVec, e.vec)));
  const fused = new Map();
  for (const list of lists) list.forEach((id, rank) => fused.set(id, (fused.get(id) || 0) + 1 / (RRF_K + rank + 1)));
  const order = new Map(entries.map((e, i) => [e.id, i]));
  return [...fused.entries()]
    .sort((x, y) => (y[1] - x[1]) || (order.get(x[0]) - order.get(y[0])))
    .slice(0, want)
    .map(x => x[0]);
}

module.exports = { tokenize, cosine, hybridRank, keywordRank };
