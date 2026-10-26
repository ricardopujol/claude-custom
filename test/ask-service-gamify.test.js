'use strict';
/**
 * BACKLOG #33 gamification, the host's side: what the Ask service tells the explainer's live state and its counts.
 * A search is "reading", the words are "writing"; a good typed question or What's this? counts as a question answered (drill-down
 * steps do not); opening a place counts and makes it happy; a failed answer stresses it; a refusal of bad input does neither.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createAskService } = require('../host/ask-service');
const { createModels } = require('../host/ask-models');

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const PASS = { 'qwen3.5:4b': { new: 9, comfortable: 9, of: 10 } };

function rig(over = {}) {
  const log = [];
  let token = 0;
  const explainer = {
    begin: () => { const t = ++token; log.push(['begin', t]); return t; },
    stage: (t, s) => log.push(['stage', t, s]),
    end: (t, r) => log.push(['end', t, r.ok, r.reason]),
    placeOpened: () => log.push(['opened']),
  };
  const counts = { addQuestion: () => { log.push(['q']); return { ok: true }; }, addPlace: () => { log.push(['p']); return { ok: true }; } };
  const data = { files: [{ rel: 'host/a.js', lines: 30, chunks: [{ start: 1, end: 30, text: lines(30).join('\n') }] }] };
  const ex = over.ex || {
    ok: true, body: 'b', sent: [{ file: 'host/a.js', start: 1, end: 30 }], lineCounts: new Map([['host/a.js', 30]]),
    keywordOnly: false, stale: false, ollamaStatus: { ok: true, answer: true, embed: true }, prepared: { data },
  };
  const repo = {
    ask: async () => over.askResult || { ok: true, text: 'See host/a.js:3-4.', citations: [{ file: 'host/a.js', line: 3, endLine: 4 }], dropped: [], sources: [], model: 'm', ms: 1 },
    excerptsFor: async () => ex,
    status: async () => ({ state: 'ready', files: 1, chunks: 1 }),
  };
  const svc = createAskService({
    cwd: 'C:\\proj',
    index: { get: () => data, refresh: async () => ({}), isRunning: () => false },
    ollama: { answerModel: 'qwen3.5:4b', check: async () => ({ ok: true, answer: true, embed: true }), generate: async () => over.generate || { ok: true, text: 'The idea. See host/a.js:3-4.' } },
    claude: { generate: async () => ({ ok: true, text: 'x' }) },
    models: createModels({ localModel: 'qwen3.5:4b', readRecord: () => JSON.stringify({ passed: PASS }) }),
    repoFor: () => repo,
    readSelection: async () => ({ ok: true, text: lines(30).join('\n') }),
    ...(over.noGamify ? {} : { explainer, counts, onCounts: () => log.push(['counts-changed']) }),
  });
  return { svc, log };
}
const ASK = { type: 'ask', seq: 1 };
const SEL = { file: 'host/a.js', start: 3, end: 5, model: 'local' };

test('a typed question: searching starts a run, the answer reuses it (via the retrieval id), and a good answer counts one question', async () => {
  const { svc, log } = rig();
  const p = await svc.handle({ ...ASK, op: 'places', question: 'where is x?' });
  assert.deepStrictEqual(log, [['begin', 1], ['stage', 1, 'queued']]);
  await svc.handle({ ...ASK, op: 'ask', question: 'where is x?', retrieval: p.retrieval });
  assert.deepStrictEqual(log.slice(2), [['stage', 1, 'writing'], ['end', 1, true, undefined], ['q'], ['counts-changed']]);
});

test('an answer asked for without a search of its own (no retrieval id) starts its own run', async () => {
  const { svc, log } = rig();
  await svc.handle({ ...ASK, op: 'ask', question: 'q' });
  assert.deepStrictEqual(log.slice(0, 3), [['begin', 1], ['stage', 1, 'writing'], ['end', 1, true, undefined]]);
});

test('a retrieval id is spent once: the next answer with the same id starts a new run', async () => {
  const { svc, log } = rig();
  const p = await svc.handle({ ...ASK, op: 'places', question: 'q' });
  await svc.handle({ ...ASK, op: 'ask', question: 'q', retrieval: p.retrieval });
  log.length = 0;
  await svc.handle({ ...ASK, op: 'ask', question: 'q', retrieval: p.retrieval });
  assert.strictEqual(log[0][0], 'begin');
});

test('What\'s this? on a selection counts one question; a drill-down step (a term, or step: true) counts none', async () => {
  const a = rig();
  await a.svc.handle({ ...ASK, op: 'explain', ...SEL });
  assert.strictEqual(a.log.filter(e => e[0] === 'q').length, 1);
  const b = rig();
  await b.svc.handle({ ...ASK, op: 'explain', ...SEL, term: 'thing', answer: 'earlier' });
  assert.strictEqual(b.log.filter(e => e[0] === 'q').length, 0);
  assert.ok(b.log.some(e => e[0] === 'end' && e[2] === true), 'but the run still ended well');
  const c = rig();
  await c.svc.handle({ ...ASK, op: 'ask', question: 'What is thing?', step: true });
  assert.strictEqual(c.log.filter(e => e[0] === 'q').length, 0);
  const d = rig();
  await d.svc.handle({ ...ASK, op: 'explain', ...SEL, term: '   ' });
  assert.strictEqual(d.log.filter(e => e[0] === 'q').length, 1, 'a blank term is not a drill-down');
});

test('a failed answer counts nothing and ends the run with its reason', async () => {
  const { svc, log } = rig({ askResult: { ok: false, reason: 'ollama-down' } });
  const r = await svc.handle({ ...ASK, op: 'ask', question: 'q' });
  assert.strictEqual(r.ok, false);
  assert.ok(log.some(e => e[0] === 'end' && e[2] === false && e[3] === 'ollama-down'));
  assert.ok(!log.some(e => e[0] === 'q' || e[0] === 'counts-changed'));
});

test('a failed explain (the model call failed) is the same: no count, ended with the reason', async () => {
  const { svc, log } = rig({ generate: { ok: false, reason: 'timeout' } });
  await svc.handle({ ...ASK, op: 'explain', ...SEL });
  assert.ok(log.some(e => e[0] === 'end' && e[2] === false && e[3] === 'timeout'));
  assert.ok(!log.some(e => e[0] === 'q'));
});

test('a search that fails ends its run at once with the reason (no answer request follows it)', async () => {
  const { svc, log } = rig({ ex: { ok: false, reason: 'index-building' } });
  await svc.handle({ ...ASK, op: 'places', question: 'q' });
  assert.deepStrictEqual(log, [['begin', 1], ['end', 1, false, 'index-building']]);
});

test('an op that throws still ends its run, as a failure', async () => {
  const { svc, log } = rig({ ex: { ok: true, get sent() { throw new Error('boom'); } } });
  const r = await svc.handle({ ...ASK, op: 'places', question: 'q' });
  assert.strictEqual(r.reason, 'host-error');
  assert.deepStrictEqual(log.at(-1), ['end', 1, false, 'host-error']);
});

test('opened: counts a place and tells the explainer, answers ok', async () => {
  const { svc, log } = rig();
  const r = await svc.handle({ ...ASK, op: 'opened' });
  assert.deepStrictEqual([r.type, r.op, r.seq, r.ok], ['ask', 'opened', 1, true]);
  assert.deepStrictEqual(log, [['opened'], ['p'], ['counts-changed']], 'the explainer is told first, so the counts frame already shows it happy');
});

test('a count that could not be written does not stop the answer or the happy flash, and the refusal is LOGGED and returned (PR #178 Dexter F3)', async () => {
  const log = [];
  const said = [];
  const bad = createAskService({
    log: (...a) => said.push(a.join(' ')),
    cwd: 'C:\\proj', index: { get: () => ({ files: [] }), isRunning: () => false }, ollama: { check: async () => ({ ok: true }) }, claude: {},
    models: createModels({ localModel: 'm', readRecord: () => '{}' }), repoFor: () => ({ ask: async () => ({ ok: true, text: 't', citations: [], sources: [] }), status: async () => ({}) }),
    counts: { addQuestion: () => { throw new Error('locked'); }, addPlace: () => ({ ok: false, reason: 'unreadable' }) },
    explainer: { begin: () => 1, stage() {}, end() {}, placeOpened: () => log.push(['opened']) },
  });
  assert.strictEqual((await bad.handle({ ...ASK, op: 'ask', question: 'q' })).ok, true);
  const o = await bad.handle({ ...ASK, op: 'opened' });
  assert.deepStrictEqual([o.ok, o.reason], [false, 'unreadable'], 'opened returns the failure');
  assert.ok(log.some(e => e[0] === 'opened'), 'but the explainer was still happy');
  assert.ok(said.some(s => /question/.test(s) && /locked/.test(s)), 'a thrown count is logged');
  assert.ok(said.some(s => /place/.test(s) && /unreadable/.test(s)), 'a refused count is logged with its reason');
});

test('PR #178 Dexter F3: a refused question count (EBUSY, newer-version) is logged with its reason, once per refusal, and the answer is still given', async () => {
  const said = [];
  const mk = (reason) => createAskService({
    cwd: 'C:proj', index: { get: () => ({ files: [] }), isRunning: () => false }, ollama: { check: async () => ({ ok: true }) }, claude: {},
    models: createModels({ localModel: 'm', readRecord: () => '{}' }), repoFor: () => ({ ask: async () => ({ ok: true, text: 't', citations: [], sources: [] }), status: async () => ({}) }),
    counts: { addQuestion: () => ({ ok: false, reason }), addPlace: () => ({ ok: true }) }, log: (...a) => said.push(a.join(' ')),
  });
  for (const reason of ['unreadable', 'newer-version', 'write-failed', 'busy']) {
    const r = await mk(reason).handle({ ...ASK, op: 'ask', question: 'q' });
    assert.strictEqual(r.ok, true);
    assert.ok(said.some(s => s.includes(reason)), reason);
  }
  assert.strictEqual(said.length, 4);
});

test('PR #178 Miguel I1: an answer whose run the explainer has forgotten starts a fresh run, so writing and a failure still register', async () => {
  const log = [];
  let n = 0;
  const known = new Set();
  const explainer = {
    begin: () => { const t = ++n; known.add(t); log.push(['begin', t]); return t; },
    stage: (t, s) => { const ok = known.has(t); log.push(['stage', t, s, ok]); return ok; },
    end: (t, r) => { log.push(['end', t, r.ok, r.reason]); known.delete(t); },
    placeOpened() {},
  };
  const s2 = createAskService({
    cwd: 'C:proj', index: { get: () => ({ files: [] }), isRunning: () => false }, ollama: { check: async () => ({ ok: true }) }, claude: {},
    models: createModels({ localModel: 'm', readRecord: () => '{}' }),
    repoFor: () => ({ excerptsFor: async () => ({ ok: true, sent: [], prepared: {}, lineCounts: new Map() }), ask: async () => ({ ok: false, reason: 'ollama-down' }), status: async () => ({}) }),
    explainer,
  });
  const p = await s2.handle({ ...ASK, op: 'places', question: 'q' });
  known.clear();                                   // the explainer dropped the queued run (its clock ran out)
  await s2.handle({ ...ASK, op: 'ask', question: 'q', retrieval: p.retrieval });
  assert.deepStrictEqual(log.slice(2), [['stage', 1, 'writing', false], ['begin', 2], ['stage', 2, 'writing', true], ['end', 2, false, 'ollama-down']]);
});

test('without a counts store or an explainer the service behaves as before (and "opened" is still answered)', async () => {
  const { svc } = rig({ noGamify: true });
  assert.strictEqual((await svc.handle({ ...ASK, op: 'ask', question: 'q' })).ok, true);
  assert.strictEqual((await svc.handle({ ...ASK, op: 'places', question: 'q' })).ok, true);
  assert.strictEqual((await svc.handle({ ...ASK, op: 'opened' })).ok, true);
});
