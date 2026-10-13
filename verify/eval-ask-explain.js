'use strict';
/**
 * Re-runnable quality measurement for the "Ask the repo" explainer (BACKLOG #33, DESIGN_ASK_REPO.md, round 6):
 * 10 real code selections from this repo x 2 levels (New to coding, Comfortable) = 20 answers on a local model.
 * It saves EVERY raw answer (plus the citations the engine's own checker kept or dropped) so a person can grade them:
 * "right" (no false claim about the code, citations real) and "pitched at the level". Pass = 8/10 per level.
 *
 *   node verify/eval-ask-explain.js [--model qwen3.5:4b] [--out <raw json>] [--dir <index folder>] [--only 1,4]
 *
 * HEAVY: the GPU. Take ~/.claude/scripts/heavy-lock.ps1 first. It builds (or reuses) the index in --dir, runs the model with
 * thinking off, and unloads it when done. It never starts or installs anything; Ollama down exits 2.
 * The prompt below is the explainer prompt the panel will ship (host/ask-explain.js takes it from here once the bar is met).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIndex } = require('../host/ask-index');
const { createAskOllama } = require('../host/ask-ollama');
const { buildPrompt } = require('../host/ask-repo');
const { tokenize, hybridRank } = require('../host/ask-retrieve');
const { extractCitations } = require('../host/ask-citations');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const wt = path.resolve(__dirname, '..');
const model = opt('model', 'qwen3.5:4b');
const dir = opt('dir', path.join(os.tmpdir(), 'claude-custom-ask-explain-index'));
const out = opt('out', path.join(os.homedir(), '.claude', 'reviews', 'claude-custom', `2026-10-13-ask-explain-raw-${model.replace(/[^\w.-]/g, '_')}.json`));
const only = opt('only', '') ? opt('only', '').split(',').map(Number) : null;
const K = 8;

// [id, kind, file, first line, last line]
const SELECTIONS = [
  [1, 'lane assignment loop', 'host/git-graph.js', 63, 81],
  [2, 'regex + URL validation', 'host/canvas-origin.js', 17, 27],
  [3, 'async retry with backoff', 'host/atomic-write.js', 185, 203],
  [4, 'regex building + matchAll', 'host/ask-citations.js', 29, 44],
  [5, 'IPC wiring (ipcMain.handle)', 'app/avatar-bridge.js', 130, 156],
  [6, 'CSS grid rule', 'app/renderer.html', 1033, 1036],
  [7, 'reduce over a dotted path', 'host/payload-contract.js', 219, 220],
  [8, 'rank fusion', 'host/ask-retrieve.js', 68, 80],
  [9, 'file lock loop', 'host/file-lock.js', 140, 165],
  [10, 'async race with a timer', 'host/ask-repo.js', 101, 111],
];

const LEVELS = {
  new: 'New to coding',
  comfortable: 'Comfortable',
};

const BASE = 'You explain code from a repository to its owner, using ONLY the selected code and the numbered excerpts provided. '
  + 'Never claim anything about the code that the selected code or the excerpts do not show; if something is not visible, say you cannot see it. '
  + 'Write: (1) the idea in plain words, 3 to 5 sentences, then (2) a short list headed "Where it shows up" with real file:line places taken '
  + 'from the excerpt headers (written like path/to/file.ext:123), each with a few words on why. If no excerpt shows it, leave that list out. '
  + 'Do not repeat the code back line by line.';
const LEVEL_RULES = {
  new: 'The reader has never programmed. Use everyday words and one comparison from daily life. Do not use any programming term '
    + 'without explaining it in plain words right there. Short sentences.',
  comfortable: 'The reader codes comfortably in general but does not know this codebase. Skip the basics (what a loop, a regex or a promise is). '
    + 'Say what the code does, why it is written this way, and anything non-obvious. Programming terms are fine.',
};

function selectedText(rel, a, b) {
  const lines = fs.readFileSync(path.join(wt, rel), 'utf8').split(/\r?\n/);
  return lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`).join('\n');
}

(async () => {
  const ollama = createAskOllama({ answerModel: model });
  const status = await ollama.check();
  console.log('ollama:', JSON.stringify(status));
  if (!status.ok && status.reason === 'ollama-down') { console.log('Ollama is not running: nothing to measure.'); process.exit(2); }
  if (!status.ok) { console.log('Model missing:', JSON.stringify(status)); process.exit(3); }

  const index = createIndex({ dir, embed: (t) => ollama.embed(t), embedModel: ollama.embedModel });
  const t0 = Date.now();
  const timer = setInterval(() => console.log('  index', JSON.stringify(index.progress(wt)), `${Math.round((Date.now() - t0) / 1000)}s`), 30_000);
  const built = await index.refresh(wt);
  clearInterval(timer);
  console.log('index:', JSON.stringify(built), `${Math.round((Date.now() - t0) / 1000)}s`);
  const data = index.get(wt);
  const entries = [];
  const refs = [];
  for (const f of data.files) for (const c of f.chunks) { entries.push({ id: refs.length, tokens: tokenize(`${f.rel} ${c.text}`), vec: c.vec }); refs.push({ rel: f.rel, chunk: c }); }
  const lineCounts = new Map(data.files.map(f => [f.rel, f.lines]));

  const results = [];
  for (const [id, kind, rel, a, b] of SELECTIONS) {
    if (only && !only.includes(id)) continue;
    const code = selectedText(rel, a, b);
    const query = code.replace(/^\d+: /gm, '').slice(0, 500);
    const e = await ollama.embed([query]);
    const ranked = hybridRank({ question: query, queryVec: e.ok ? e.vectors[0] : null, entries, k: K + 4 }).map(i => refs[i]);
    // the selection's own chunks add nothing: the excerpts are for "where else this shows up"
    const top = ranked.filter(r => !(r.rel === rel && r.chunk.start <= b && r.chunk.end >= a)).slice(0, K);
    const { prompt: excerpts, sent } = buildPrompt('', top);
    const body = excerpts.split('\n\nQuestion:')[0];
    for (const [lvl, label] of Object.entries(LEVELS)) {
      const system = `${BASE}\n\nReader level: ${label}. ${LEVEL_RULES[lvl]}`;
      const prompt = `Selected code (${rel}, lines ${a}-${b}):\n${code}\n\nExcerpts from elsewhere in the repository:\n\n${body}\n\nExplain what the selected code is doing.`;
      const t1 = Date.now();
      const g = await ollama.generate({ system, prompt, numPredict: 450 });
      const ms = Date.now() - t1;
      // citations may point into the selection too: its own range is "shown"
      const ranges = new Map();
      for (const s of [...sent, { file: rel, start: a, end: b }]) { if (!ranges.has(s.file)) ranges.set(s.file, []); ranges.get(s.file).push([s.start, s.end]); }
      const cit = g.ok ? extractCitations(g.text, lineCounts, { ranges }) : { citations: [], dropped: [] };
      results.push({ id, kind, level: lvl, file: rel, range: [a, b], ms, ok: g.ok, text: g.ok ? g.text : null, reason: g.ok ? null : g.reason, citations: cit.citations, dropped: cit.dropped, sources: sent });
      console.log(`#${id} ${lvl} ${ms} ms ${g.ok ? '' : 'FAILED ' + g.reason} cited=${cit.citations.length} dropped=${cit.dropped.length}`);
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out + '.tmp', JSON.stringify({ model, k: K, at: new Date().toISOString(), results }, null, 2));
  fs.renameSync(out + '.tmp', out);
  console.log('saved', out);
  await ollama.unload();
})().catch((err) => { console.error(err); process.exit(1); });
