'use strict';
/**
 * The indexing assistant's accuracy gate, measured (backlog #66, DESIGN_INDEXING_ASSISTANT.md "Accuracy gate").
 *
 *   node verify/probe-indexing-accuracy.js [--model llama3.2:3b] [--url http://127.0.0.1:11434] [--json out.json]
 *
 * Runs the real classifier (host/indexing-classify.js classifyNote, through host/summary-ollama.js's generate: the
 * same path the strip files with) over verify/fixtures/indexing-eval.json: real notes with the kind and target they actually got. Prints the score,
 * the swaps (history <-> backlog), every misfile and how many answers said "not sure". The bar: >= 85% on kind AND
 * target, and no swap. Below it, the strip ships in propose mode.
 *
 * Talks only to the given Ollama, never pulls a model, never touches Ollama's global settings, and writes nothing
 * unless --json names a file. The fixture's notes are Ricardo's own words from the backlog; nothing is sent elsewhere.
 *
 * Exit: 0 measured (pass or fail is in the output), 2 Ollama or the model isn't there.
 */

const fs = require('fs');
const path = require('path');
const { createOllamaClient, DEFAULT_URL, DEFAULT_MODEL } = require('../host/summary-ollama');
const { classifyNote } = require('../host/indexing-classify');
const { backlogFor, judge, summarize, BAR_PCT } = require('./lib/indexing-eval');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const show = (t) => (t === null || t === undefined ? '-' : Number.isInteger(t) ? `#${t}` : t);

async function main() {
  const model = arg('--model', DEFAULT_MODEL);
  const url = arg('--url', DEFAULT_URL);
  const out = arg('--json', null);
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'indexing-eval.json'), 'utf8'));
  const ollama = createOllamaClient({ baseUrl: url, model });
  const c = await ollama.check();
  if (!c.ok) { console.log(`Ollama not usable at ${url}: ${c.reason} (${model})`); process.exit(2); }

  const rows = [];
  for (const cs of fixture.cases) {
    const started = Date.now();
    const r = await classifyNote({ note: cs.text, backlogText: backlogFor(fixture.titles, cs), generate: ollama.generate });
    const ms = Date.now() - started;
    const got = r.ok ? r.result : { sure: false, kind: null, target: null, title: null, error: r.reason };
    const j = judge(cs, got);
    rows.push({ id: cs.id, expected: { kind: cs.kind, target: cs.target }, got, ms, ...j });
    process.stdout.write(j.right ? '.' : (j.swap ? 'S' : 'x'));
  }
  process.stdout.write('\n');

  const s = summarize(rows);
  const notSure = rows.filter(r => r.got.sure !== true).length;
  const wrongButSure = rows.filter(r => !r.right && r.got.sure === true).length;
  const times = rows.map(r => r.ms).filter(n => typeof n === 'number');
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  console.log(`model ${model}   score ${s.right}/${s.total} (${s.pct}%)   swaps ${s.swaps}   not sure ${notSure}   wrong-but-sure ${wrongButSure}   avg ${avg} ms`);
  for (const kind of ['new', 'item', 'history']) {
    const sub = rows.filter(r => (kind === 'item' ? Number.isInteger(r.expected.target) : r.expected.target === kind));
    console.log(`  ${kind.padEnd(8)} ${sub.filter(r => r.right).length}/${sub.length}`);
  }
  console.log(`gate (>= ${BAR_PCT}%, no swap): ${s.passed ? 'PASSED -> direct filing' : 'NOT PASSED -> propose mode'}`);
  const misses = rows.filter(r => !r.right);
  if (misses.length) console.log('\nmisfiles:');
  for (const r of misses) {
    console.log(`  ${r.id.padEnd(8)} want ${r.expected.kind} ${show(r.expected.target)}   got ${r.got.kind || '-'} ${show(r.got.target)}${r.got.sure ? ' (sure)' : ''}${r.swap ? '   SWAP' : ''}`);
  }
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), model, ...s, notSure, wrongButSure, avgMs: avg, rows }, null, 2));
    console.log(`\nwrote ${path.resolve(out)}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
