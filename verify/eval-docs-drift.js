'use strict';
/**
 * Evaluation of "docs drift" (BACKLOG #39 job 2) over real merges: runs the same analysis the host runs (host/drift-service.js
 * analyzeMerge) over the last N first-parent merges of a repository's develop, against a documentation folder, with the LOCAL
 * Ollama only, then unloads the model. It writes nothing but one JSON file of the results, and never touches the documents.
 *
 *   node verify/eval-docs-drift.js --repo <dir> --docs <dir> [--n 10] [--out <file>] [--branch develop]
 *
 * Run it under the heavy-work lock (~\.claude\scripts\heavy-lock.ps1): it keeps the GPU busy for a few minutes.
 * The flags are then judged by a person who reads the docs: this script only counts how many it raised.
 *
 * WHAT THIS DOES NOT MEASURE. The documents are read as they are TODAY, against merges that are usually older: by now they have
 * mostly caught up with those merges, or been rewritten by later ones. There is no ground truth here, so no precision or recall
 * comes out of it; it shows what the model raises, how long it takes, and how often a reply is unusable. It uses the host's own
 * answer timeout (GENERATE_TIMEOUT_MS), so a merge that would time out in the app times out here.
 */

const fs = require('fs');
const path = require('path');
const { createAskOllama } = require('../host/ask-ollama');
const { createDriftGit } = require('../host/drift-git');
const { readDocsDir } = require('../host/drift-docs-fs');
const { analyzeMerge, GENERATE_TIMEOUT_MS } = require('../host/drift-service');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const repo = arg('repo');
  const docsDir = arg('docs');
  const n = Number(arg('n', '10'));
  if (!Number.isInteger(n) || n < 1 || n > 100) { console.error('--n must be a whole number from 1 to 100'); process.exit(2); }
  const branch = arg('branch', 'develop');
  const out = arg('out', path.join(process.env.TEMP || '.', 'docs-drift-eval.json'));
  if (!repo || !docsDir) { console.error('usage: node verify/eval-docs-drift.js --repo <dir> --docs <dir> [--n 10] [--out file]'); process.exit(2); }

  const git = createDriftGit({ cwd: repo, branch });
  const ollama = createAskOllama({ generateTimeoutMs: GENERATE_TIMEOUT_MS });
  const status = await ollama.check();
  if (!status.ok) { console.error('Ollama is not ready:', JSON.stringify(status)); process.exit(1); }

  const head = await git.head();
  // the last n merges: walk back from the tip through first-parent merges
  const { execFileSync } = require('child_process');
  const rows = execFileSync('git', ['log', '--first-parent', '--merges', `-${n}`, '--format=%H%x09%s', `refs/heads/${branch}`], { cwd: repo, encoding: 'utf8', windowsHide: true })
    .split('\n').filter(Boolean).map(l => ({ sha: l.split('\t')[0], subject: l.split('\t').slice(1).join('\t') })).reverse();
  console.log(`develop tip ${head && head.slice(0, 12)}; ${rows.length} merges; model ${ollama.answerModel}`);

  const results = [];
  for (const m of rows) {
    const t = Date.now();
    let r;
    try { r = await analyzeMerge({ git, readDocs: () => readDocsDir(docsDir), ollama }, m); } catch (err) { r = { ok: false, reason: 'threw', detail: String(err && err.message) }; }
    const ms = Date.now() - t;
    results.push({ sha: m.sha, subject: m.subject, ms, ...r });
    const raised = r.ok ? (String(r.reply).match(/"sentence"/g) || []).length : 0;
    console.log(`${m.sha.slice(0, 9)} ${String(ms).padStart(6)} ms  ${r.ok ? raised + ' raised, ' + r.flags.length + ' kept' : 'FAILED ' + r.reason}  ${m.subject.slice(0, 70)}`);
  }
  await ollama.unload();
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log('results written to', out, '; model unloaded');
}

main().catch((err) => { console.error(err); process.exit(1); });
