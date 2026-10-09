'use strict';
/**
 * Re-runnable probe for "ask the repo" (BACKLOG #33): the REAL pipeline (git ls-files -> chunks -> Ollama embeddings -> hybrid
 * retrieval -> the answer model -> checked citations) against a real worktree, with 10 questions whose right files are known.
 *
 *   node verify/probe-ask-repo.js [--wt <worktree>] [--dir <index folder>] [--model <answer model>] [--k 8]
 *
 * HEAVY: it uses the GPU (embedding a whole repo took 7-10 minutes on 2026-10-03) and loads a 7B model. Take
 * ~/.claude/scripts/heavy-lock.ps1 first, and it unloads the answer model when done (keep_alive 0). The index goes to --dir
 * (default: the OS temp folder), never into the worktree. It never starts, stops or installs anything: if Ollama is down it
 * says so and exits 2.
 *
 * Grading here is by FILE (the line numbers of a moving codebase drift), printed with the model's own words so a person can
 * judge the rest: the measurement report is test-time evidence, not a pass/fail gate.
 */
const os = require('os');
const path = require('path');
const { createIndex } = require('../host/ask-index');
const { createAskOllama } = require('../host/ask-ollama');
const { createAskRepo } = require('../host/ask-repo');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const wt = path.resolve(opt('wt', path.join(__dirname, '..')));
const dir = opt('dir', path.join(os.tmpdir(), 'claude-custom-ask-probe'));
const model = opt('model', undefined);
const k = Number(opt('k', 8));

const QUESTIONS = [
  ['Where is the session lock released?', ['host/session-lock.js', 'host/host.js']],
  ['What calls stripModel?', ['app/tab-shell.js']],
  ['Where does typeAndCheck live and who calls it?', ['app/renderer.js']],
  ['What does turn-state track?', ['host/turn-state.js']],
  ['Where does a bedtime night end?', ['host/bedtime-state.js']],
  ['What does the tab show when Ollama is not running or the summary model is missing?', ['app/summary-display.js', 'host/summary-ollama.js']],
  ['How does the lock breaker decide a stale lock can be broken safely?', ['host/lock-breaker.js']],
  ['Where is withFileLock defined?', ['host/file-lock.js']],
  ['How is a bedtime loop prompt recognised?', ['host/bedtime-state.js']],
  ['Where is the session lock acquired when the host starts?', ['host/host.js', 'host/session-lock.js']],
];

(async () => {
  const ollama = createAskOllama(model ? { answerModel: model } : {});
  const status = await ollama.check();
  console.log('ollama:', JSON.stringify(status));
  if (!status.ok && status.reason === 'ollama-down') { console.log('Ollama is not running: nothing to probe.'); process.exit(2); }
  const index = createIndex({ dir, embed: (t) => ollama.embed(t), embedModel: ollama.embedModel });
  const t0 = Date.now();
  const timer = setInterval(() => console.log('  index', JSON.stringify(index.progress(wt)), `${Math.round((Date.now() - t0) / 1000)}s`), 30_000);
  const built = await index.refresh(wt);
  clearInterval(timer);
  console.log('index:', JSON.stringify(built), `${Math.round((Date.now() - t0) / 1000)}s`, 'dir:', dir);
  const ask = createAskRepo({ index, ollama, k });
  let fileHits = 0;
  for (const [q, files] of QUESTIONS) {
    const r = await ask.ask(wt, q);
    const cited = r.ok ? [...new Set(r.citations.map(c => c.file))] : [];
    const hit = cited.some(f => files.includes(f));
    if (hit) fileHits++;
    console.log(`\nQ: ${q}\n  ${r.ok ? `${r.ms} ms, cited ${JSON.stringify(r.citations)} dropped ${JSON.stringify(r.dropped)}` : `FAILED ${r.reason}`}  file-hit=${hit}`);
    console.log('  sources:', JSON.stringify((r.sources || r.hits || []).slice(0, 3)));
    if (r.ok) console.log('  A:', r.text.replace(/\n/g, ' | '));
  }
  console.log(`\nfile-hit ${fileHits}/${QUESTIONS.length} (k=${k}, model ${ollama.answerModel})`);
  await ollama.unload();
})().catch((err) => { console.error(err); process.exit(1); });
