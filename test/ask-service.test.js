'use strict';
/**
 * host/ask-service.js (BACKLOG #33): the host's side of the `ask` protocol. Every op answers (never rejects); a failure is named; the
 * explainer is refused for a model without a passed record; a selection can only come from inside the worktree; the page's
 * numbers are never trusted.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createAskService, EXPLAINER_AGENT, createSpawnOllama, serveEnv, whyFor, placesFromCitations, examplesFrom } = require('../host/ask-service');
const { createModels } = require('../host/ask-models');

const CWD = 'C:\\proj';
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

function rig(over = {}) {
  const calls = { ask: [], excerpts: [], generate: [], claude: [], spawn: 0, refresh: 0, askOpts: undefined };
  const data = {
    files: [{ rel: 'host/a.js', lines: 30, chunks: [{ start: 1, end: 30, text: lines(30).join('\n') }] }],
  };
  const ex = over.ex || {
    ok: true, body: '### host/a.js:1-30\n1: line 1', sent: [{ file: 'host/a.js', start: 1, end: 30 }],
    lineCounts: new Map([['host/a.js', 30]]), keywordOnly: false, stale: false, ollamaStatus: { ok: true, answer: true, embed: true },
    prepared: { marker: 'the places\' own hits' },
  };
  const repo = {
    ask: async (cwd, q, opts) => { calls.ask.push([cwd, q]); calls.askOpts = opts; return over.askResult || { ok: true, text: 'It is in host/a.js:3-4.', citations: [{ file: 'host/a.js', line: 3, endLine: 4 }], dropped: [], sources: [{ file: 'host/a.js', line: 1, endLine: 30 }], model: 'qwen3.5:4b', keywordOnly: false, stale: false, ms: 5 }; },
    excerptsFor: async (cwd, query, opts) => { calls.excerpts.push([cwd, query, opts]); return typeof ex === 'function' ? ex(query, opts) : ex; },
    status: async () => ({ state: 'ready', files: 1, chunks: 1, builtAt: 1, keywordOnly: false, progress: { state: 'ready', done: 1, total: 1 } }),
  };
  const svc = createAskService({
    cwd: CWD,
    index: { get: () => data, load: async () => data, refresh: async () => { calls.refresh += 1; return {}; }, progress: () => ({ state: 'none' }), isRunning: () => false },
    ollama: {
      answerModel: 'qwen3.5:4b',
      check: async () => over.check || { ok: true, answer: true, embed: true },
      generate: async (o) => { calls.generate.push(o); return over.generate || { ok: true, text: 'The idea. See host/a.js:3-4.' }; },
    },
    claude: { generate: async (o) => { calls.claude.push(o); return over.claude || { ok: true, text: 'Claude says host/a.js:5.' }; } },
    models: over.models || createModels({ localModel: 'qwen3.5:4b', readRecord: () => JSON.stringify({ passed: over.passed || {} }) }),
    repoFor: () => repo,
    readSelection: over.readSelection || (async () => ({ ok: true, text: lines(30).join('\n') })),
    spawnOllama: async () => { calls.spawn += 1; return over.spawn || { ok: true }; },
    portraitOf: over.portraitOf, forgeAgents: over.forgeAgents, now: over.now,
  });
  return { svc, calls };
}
const PASS = { 'qwen3.5:4b': { new: 9, comfortable: 9, of: 10 }, haiku: { new: 9, comfortable: 9, of: 10 } };

test('every reply names its op and seq, and a non-object or unknown op is a named failure, not a throw', async () => {
  const { svc } = rig();
  const r = await svc.handle({ type: 'ask', op: 'status', seq: 7 });
  assert.strictEqual(r.type, 'ask');
  assert.strictEqual(r.op, 'status');
  assert.strictEqual(r.seq, 7);
  assert.deepStrictEqual(await svc.handle({ type: 'ask', op: 'wat', seq: 1 }), { type: 'ask', op: 'wat', seq: 1, ok: false, reason: 'unknown-op' });
  assert.strictEqual((await svc.handle(null)).ok, false);
});

test('a throw inside an op becomes host-error, said once', async () => {
  const { svc } = rig({ ex: () => { throw new Error('boom'); } });
  const r = await svc.handle({ type: 'ask', op: 'places', seq: 2, question: 'x' });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'host-error']);
  assert.match(r.error, /boom/);
});

test('status: index, Ollama, the three models with where they run, examples; warm starts the first index', async () => {
  const { svc, calls } = rig({ passed: PASS });
  const r = await svc.handle({ type: 'ask', op: 'status', seq: 1, warm: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.index.state, 'ready');
  assert.deepStrictEqual(r.ollama, { ok: true });
  assert.deepStrictEqual(r.models.map(m => [m.id, m.where, m.explainer]), [
    ['local', 'qwen3.5:4b · local', true], ['haiku', 'Haiku · Claude, uses your plan', true], ['sonnet', 'Sonnet · Claude, uses your plan', false],
  ]);
  assert.ok(Array.isArray(r.examples) && r.examples.length <= 3);
  assert.strictEqual(calls.refresh, 0, 'a ready index is not rebuilt by opening the panel');
});

const forge = (agent) => ({ kind: 'file', tier: 'forge', agent, state: 'sleeping', path: 'C:\\p\\' + agent + '.png', media: 'image', mtimeMs: 1 });

test('status: the explainer\'s own picture and the agents\' generated pictures to choose from (the agents\' picker)', async () => {
  const asked = [];
  const { svc } = rig({
    forgeAgents: () => ['ada', 'bea', 'cy', 'dee', 'eve', 'fay', 'gus', 'hal', 'ivy', 'jo'],
    portraitOf: (agent, state) => { asked.push([agent, state]); return agent === EXPLAINER_AGENT ? { kind: 'file', tier: 'uploaded', agent, path: 'C:\\u\\x.png' } : forge(agent); },
  });
  const r = await svc.handle({ type: 'ask', op: 'status', seq: 1 });
  assert.strictEqual(EXPLAINER_AGENT, 'ask-explainer');
  assert.strictEqual(r.portraits.own.tier, 'uploaded');
  assert.deepStrictEqual(r.portraits.suggestions.map(s => s.agent), ['ada', 'bea', 'cy', 'dee', 'eve', 'fay', 'gus', 'hal'], 'eight, in the forge\'s order');
  assert.ok(asked.every(([, state]) => state === 'sleeping'));
});

test('status: only a generated picture is a suggestion (an agent with a placeholder is not offered); no pictures at all is an honest empty list', async () => {
  const { svc } = rig({
    forgeAgents: () => ['ada', 'bea'],
    portraitOf: (agent) => (agent === 'ada' ? forge('ada') : { kind: 'text', tier: 'text', initials: 'B', hue: 3 }),
  });
  const r = await svc.handle({ type: 'ask', op: 'status', seq: 1 });
  assert.deepStrictEqual(r.portraits.suggestions.map(s => s.agent), ['ada']);
  assert.strictEqual(r.portraits.own.tier, 'text');
  const none = await rig({}).svc.handle({ type: 'ask', op: 'status', seq: 1 });
  assert.deepStrictEqual(none.portraits, { own: null, suggestions: [] });
});

test('status: a portrait lookup that throws is no picture, never a failed status', async () => {
  const { svc } = rig({ forgeAgents: () => { throw new Error('EACCES'); }, portraitOf: () => { throw new Error('boom'); } });
  const r = await svc.handle({ type: 'ask', op: 'status', seq: 1 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.portraits, { own: null, suggestions: [] });
});

const BUILDING = { state: 'building', done: 5, total: 120, files: 5 };

test('PR #169 Dexter N3: "answered from the files read so far" crosses the service unchanged, for ask, places and explain (and for a no-match)', async () => {
  const ask = rig({ askResult: { ok: true, text: 'x', citations: [], dropped: [], sources: [], model: 'm', keywordOnly: false, stale: true, building: BUILDING, ms: 1 } });
  assert.deepStrictEqual((await ask.svc.handle({ type: 'ask', op: 'ask', seq: 1, question: 'q' })).building, BUILDING);
  const none = rig({ askResult: { ok: false, reason: 'no-matches', building: BUILDING, keywordOnly: true, stale: true } });
  const nm = await none.svc.handle({ type: 'ask', op: 'ask', seq: 1, question: 'q' });
  assert.deepStrictEqual([nm.ok, nm.reason, nm.building], [false, 'no-matches', BUILDING]);
  const plain = rig({ ex: { ok: true, body: '', sent: [], lineCounts: new Map(), keywordOnly: true, stale: true, building: BUILDING, ollamaStatus: { ok: true }, prepared: {} } });
  assert.deepStrictEqual((await plain.svc.handle({ type: 'ask', op: 'places', seq: 1, question: 'q' })).building, BUILDING);
  const expl = rig({ passed: PASS, ex: { ok: true, body: 'b', sent: [], lineCounts: new Map(), keywordOnly: true, stale: true, building: BUILDING, ollamaStatus: { ok: true }, prepared: {} } });
  assert.deepStrictEqual((await expl.svc.handle({ type: 'ask', op: 'explain', seq: 1, file: 'host/a.js', start: 3, end: 5, model: 'local' })).building, BUILDING);
  const finished = await rig().svc.handle({ type: 'ask', op: 'ask', seq: 1, question: 'q' });
  assert.strictEqual(finished.building, undefined);
});

test('PR #169 Dexter N2: the card previews are the lines of the index the ANSWER used, not of the build as it moves on; the data never travels in the reply', async () => {
  const used = { files: [{ rel: 'host/a.js', lines: 30, chunks: [{ start: 1, end: 30, text: Array.from({ length: 30 }, (_, i) => 'OLD ' + (i + 1)).join('\n') }] }] };
  const { svc } = rig({ askResult: { ok: true, text: 'It is in host/a.js:3-4.', citations: [{ file: 'host/a.js', line: 3, endLine: 4 }], dropped: [], sources: [], model: 'm', keywordOnly: false, stale: false, ms: 1, _data: used } });
  const r = await svc.handle({ type: 'ask', op: 'ask', seq: 1, question: 'q' });
  assert.deepStrictEqual(r.places[0].lines, [{ n: 3, text: 'OLD 3' }, { n: 4, text: 'OLD 4' }], 'not the live build\'s line 3');
  assert.strictEqual(JSON.stringify(r).includes('OLD 30'), false, 'no index in the reply');
  assert.strictEqual('_data' in r, false);
  const pl = rig({ ex: { ok: true, body: '', sent: [{ file: 'host/a.js', start: 1, end: 30 }], lineCounts: new Map(), keywordOnly: false, stale: false, ollamaStatus: { ok: true }, prepared: { data: used } } });
  const p = await pl.svc.handle({ type: 'ask', op: 'places', seq: 1, question: 'q' });
  assert.strictEqual(p.places[0].lines[0].text, 'OLD 1');
});

test('PR #169 El Gordo 1: one ask is one retrieval: places keeps its hits under an id, and the answer that names the id uses them (the engine is not asked to search again)', async () => {
  const { svc, calls } = rig();
  const p = await svc.handle({ type: 'ask', op: 'places', seq: 1, question: 'where is a?', model: 'local' });
  assert.match(p.retrieval, /^\d+$/);
  await svc.handle({ type: 'ask', op: 'ask', seq: 2, question: 'where is a?', model: 'local', retrieval: p.retrieval });
  assert.deepStrictEqual(calls.askOpts, { prepared: { marker: 'the places\' own hits' } });
  assert.strictEqual(calls.excerpts.length, 1, 'searched once');
});

test('a retrieval is used once, only for the same question and model, and only while fresh', async () => {
  let t = 1000;
  const { svc, calls } = rig({ now: () => t });
  const take = async (over) => {
    const p = await svc.handle({ type: 'ask', op: 'places', seq: 1, question: 'where is a?', model: 'local' });
    await svc.handle({ type: 'ask', op: 'ask', seq: 2, question: 'where is a?', model: 'local', retrieval: p.retrieval, ...over });
    return calls.askOpts;
  };
  assert.ok(await take({}), 'same question, same model');
  const p = await svc.handle({ type: 'ask', op: 'places', seq: 1, question: 'where is a?', model: 'local' });
  await svc.handle({ type: 'ask', op: 'ask', seq: 2, question: 'where is a?', model: 'local', retrieval: p.retrieval });
  await svc.handle({ type: 'ask', op: 'ask', seq: 3, question: 'where is a?', model: 'local', retrieval: p.retrieval });
  assert.strictEqual(calls.askOpts, undefined, 'the second use of the same id searches again');
  assert.strictEqual(await take({ question: 'something else' }), undefined, 'another question');
  assert.strictEqual(await take({ model: 'haiku' }), undefined, 'another model');
  assert.strictEqual(await take({ retrieval: 'nope' }), undefined, 'an unknown id');
  const q = await svc.handle({ type: 'ask', op: 'places', seq: 1, question: 'where is a?', model: 'local' });
  t += 61_000;
  await svc.handle({ type: 'ask', op: 'ask', seq: 2, question: 'where is a?', model: 'local', retrieval: q.retrieval });
  assert.strictEqual(calls.askOpts, undefined, 'a retrieval older than a minute is stale');
});

test('an explanation reuses its places\' retrieval too (no second excerptsFor)', async () => {
  const { svc, calls } = rig({ passed: PASS });
  const sel = { file: 'host/a.js', start: 3, end: 5, model: 'local', level: 'comfortable' };
  const p = await svc.handle({ type: 'ask', op: 'places', seq: 1, ...sel });
  const r = await svc.handle({ type: 'ask', op: 'explain', seq: 2, ...sel, retrieval: p.retrieval });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.excerpts.length, 1);
  await svc.handle({ type: 'ask', op: 'explain', seq: 3, ...sel, end: 6, retrieval: p.retrieval });
  assert.strictEqual(calls.excerpts.length, 2, 'another selection searches');
});

test('PR #169 Dexter 5: a missing Ollama model is named by its own name, not by "local"', async () => {
  const { svc } = rig({ askResult: { ok: false, reason: 'model-missing', model: 'qwen3.5:4b', hits: [] } });
  const r = await svc.handle({ type: 'ask', op: 'ask', seq: 1, question: 'q', model: 'local' });
  assert.deepStrictEqual([r.reason, r.model], ['model-missing', 'qwen3.5:4b']);
  const other = rig({ askResult: { ok: false, reason: 'ollama-down', hits: [] } });
  assert.strictEqual((await other.svc.handle({ type: 'ask', op: 'ask', seq: 1, question: 'q', model: 'local' })).model, 'local', 'where the engine names none, the choice');
});

test('PR #169 Miguel Y8: an explanation that cites nothing gets NO cards (a pure idea has no place); a typed question keeps the search hits', async () => {
  const { svc } = rig({ passed: PASS, generate: { ok: true, text: 'A lock file is a marker. It has no place in the code.' } });
  const r = await svc.handle({ type: 'ask', op: 'explain', seq: 1, file: 'host/a.js', start: 3, end: 5, model: 'local', term: 'lock file', answer: 'x' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.places, []);
  const q = await rig({ askResult: { ok: true, text: 'Nothing cited.', citations: [], dropped: [], sources: [{ file: 'host/a.js', line: 1, endLine: 30 }], model: 'm', keywordOnly: false, stale: false, ms: 1 } }).svc.handle({ type: 'ask', op: 'ask', seq: 1, question: 'q' });
  assert.ok(q.places.length >= 1);
});

test('PR #169 Miguel Y5: an interrupted (partial) index is resumed by the first status, like a missing one; the status says whether a build is running', async () => {
  let started = 0;
  let running = false;
  const svc = createAskService({
    cwd: CWD,
    index: { get: () => null, load: async () => null, refresh: () => { started += 1; running = true; return new Promise(() => {}); }, progress: () => ({}), isRunning: () => running },
    ollama: { answerModel: 'm', check: async () => ({ ok: true }) }, claude: { generate: async () => ({ ok: false }) },
    models: createModels({ localModel: 'm', readRecord: () => '{}' }),
    repoFor: () => ({ status: async () => ({ state: running ? 'building' : 'partial', files: 12 }) }),
    readSelection: async () => ({ ok: false }), spawnOllama: async () => ({ ok: true }),
  });
  const a = await svc.handle({ type: 'ask', op: 'status', seq: 1, warm: true });
  assert.strictEqual(started, 1);
  assert.strictEqual(a.index.running, true);
  await svc.handle({ type: 'ask', op: 'status', seq: 2, warm: true });
  assert.strictEqual(started, 1, 'not started twice');
  const idle = createAskService({
    cwd: CWD, index: { get: () => null, load: async () => null, refresh: async () => ({}), progress: () => ({}), isRunning: () => false },
    ollama: { answerModel: 'm', check: async () => ({ ok: true }) }, claude: { generate: async () => ({ ok: false }) }, models: createModels({ localModel: 'm', readRecord: () => '{}' }),
    repoFor: () => ({ status: async () => ({ state: 'partial', files: 12 }) }), readSelection: async () => ({ ok: false }), spawnOllama: async () => ({ ok: true }),
  });
  assert.strictEqual((await idle.handle({ type: 'ask', op: 'status', seq: 1 })).index.running, false, 'not warm: it is only reported');
});

test('PR #169 Miguel Y11: the agents\' pictures are read from disk at most once in ten seconds, unless a new upload asks for them fresh', async () => {
  let t = 5000;
  let reads = 0;
  const { svc } = rig({ now: () => t, forgeAgents: () => { reads += 1; return ['ada']; }, portraitOf: () => forge('ada') });
  const status = (extra) => svc.handle({ type: 'ask', op: 'status', seq: 1, ...extra });
  await status({}); await status({}); await status({});
  assert.strictEqual(reads, 1);
  await status({ fresh: true });
  assert.strictEqual(reads, 2, 'a new upload is read at once');
  t += 10_001;
  await status({});
  assert.strictEqual(reads, 3, 'and the cache expires');
});

test('PR #169 Miguel Y10: example questions cover the languages this repo has, fall back to the files themselves, and are never invented', () => {
  const f = (rel, text, size = 100) => ({ rel, size, chunks: [{ text }] });
  const py = examplesFrom({ files: [f('tools/a.py', 'import os\n\ndef rebuild_index(path):\n    pass\n', 300), f('tools/b.py', 'class IndexWriter:\n    pass\n', 200)] });
  assert.match(py[0], /rebuild_index/);
  assert.match(py[1], /IndexWriter/);
  assert.match(examplesFrom({ files: [f('s/x.ps1', 'function Get-Thing {\n}\n')] })[0], /Get-Thing/);
  assert.match(examplesFrom({ files: [f('m/x.go', 'func (s *Server) Handle(w int) {\n}\n')] })[0], /Handle/);
  assert.match(examplesFrom({ files: [f('m/x.rs', 'pub async fn run_loop(x: u8) {\n}\n')] })[0], /run_loop/);
  const none = examplesFrom({ files: [f('docs/readme.md', '# Title\n\nSome prose.\n', 500), f('config.yml', 'a: 1\n', 100)] });
  assert.deepStrictEqual(none, ['What is docs/readme.md for?', 'What is config.yml for?'], 'file-based, from the repo\'s own files');
  assert.deepStrictEqual(examplesFrom({ files: [] }), []);
  const same = { files: [f('a.js', 'function alpha() {}\n')] };
  assert.strictEqual(examplesFrom(same), examplesFrom(same), 'computed once per index');
});

test('PR #169 Miguel G8: ollama serve is started without the harness\'s own markers, as a detached process', async () => {
  assert.deepStrictEqual(serveEnv({ PATH: 'p', OLLAMA_HOST: 'h', ELECTRON_RUN_AS_NODE: '1', claude_custom_port: '1', CLAUDE_CUSTOM_CWD: 'c' }), { PATH: 'p', OLLAMA_HOST: 'h' });
  const seen = [];
  const { EventEmitter } = require('events');
  const spawn = (bin, args, opts) => { seen.push([bin, args, opts]); const c = new EventEmitter(); c.unref = () => {}; return c; };
  const r = await createSpawnOllama({ spawn, env: { PATH: 'p', ELECTRON_RUN_AS_NODE: '1' }, settleMs: 1 })();
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(seen[0][0], 'ollama');
  assert.deepStrictEqual(seen[0][1], ['serve']);
  assert.strictEqual(seen[0][2].detached, true);
  assert.deepStrictEqual(seen[0][2].env, { PATH: 'p' });
  const missing = await createSpawnOllama({ spawn: () => { const c = new EventEmitter(); c.unref = () => {}; setImmediate(() => { const e = new Error('x'); e.code = 'ENOENT'; c.emit('error', e); }); return c; }, env: {}, settleMs: 50 })();
  assert.deepStrictEqual(missing, { ok: false, reason: 'ollama-not-installed' });
});

test('status on a worktree with no index starts building it, once, without waiting for it', async () => {
  let started = 0;
  let statusCalls = 0;
  const { svc } = rig();
  const svc2 = createAskService({
    cwd: CWD,
    index: { get: () => null, load: async () => null, refresh: () => { started += 1; return new Promise(() => {}); }, progress: () => ({ state: 'building', done: 3, total: 10 }), isRunning: () => false },
    ollama: { answerModel: 'm', check: async () => ({ ok: false, reason: 'ollama-down' }) },
    claude: { generate: async () => ({ ok: false }) },
    models: createModels({ localModel: 'm', readRecord: () => '{}' }),
    repoFor: () => ({ status: async () => { statusCalls += 1; return { state: 'none', files: 0, progress: { state: 'building', done: 3, total: 10 } }; } }),
    readSelection: async () => ({ ok: false }),
    spawnOllama: async () => ({ ok: true }),
  });
  const a = await svc2.handle({ type: 'ask', op: 'status', seq: 1, warm: true });
  assert.strictEqual(a.ok, true);
  assert.deepStrictEqual(a.ollama, { ok: false, reason: 'ollama-down' });
  assert.strictEqual(started, 1);
  assert.strictEqual(statusCalls, 2, 'the status is read again after the build is started, so the page hears "building"');
  await svc2.handle({ type: 'ask', op: 'status', seq: 2 });
  assert.strictEqual(started, 1, 'only warm starts a build');
  void svc;
});

test('ask on the local model: the engine\'s answer with its places as cards (the lines, and why from the answer)', async () => {
  const { svc, calls } = rig();
  const r = await svc.handle({ type: 'ask', op: 'ask', seq: 3, question: 'where is a?', model: 'local' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'It is in host/a.js:3-4.');
  assert.deepStrictEqual(calls.ask, [[CWD, 'where is a?']]);
  assert.strictEqual(r.places.length, 1);
  assert.deepStrictEqual([r.places[0].file, r.places[0].line, r.places[0].endLine], ['host/a.js', 3, 4]);
  assert.deepStrictEqual(r.places[0].lines, [{ n: 3, text: 'line 3' }, { n: 4, text: 'line 4' }]);
  assert.strictEqual(r.model, 'local');
});

test('ask: an empty or non-string question is refused before anything runs', async () => {
  const { svc, calls } = rig();
  assert.strictEqual((await svc.handle({ type: 'ask', op: 'ask', seq: 1, question: '   ' })).reason, 'empty-question');
  assert.strictEqual((await svc.handle({ type: 'ask', op: 'ask', seq: 1, question: 5 })).reason, 'empty-question');
  assert.strictEqual(calls.ask.length, 0);
});

test('ask with no citations falls back to the best sources, never an empty "where to look" for a real answer', async () => {
  const { svc } = rig({ askResult: { ok: true, text: 'Nothing cited.', citations: [], dropped: [], sources: [{ file: 'host/a.js', line: 1, endLine: 30 }, { file: 'host/a.js', line: 40, endLine: 60 }], model: 'm', keywordOnly: false, stale: false, ms: 1 } });
  const r = await svc.handle({ type: 'ask', op: 'ask', seq: 1, question: 'q' });
  assert.ok(r.places.length >= 1);
});

test('ask failing keeps its reason and the places it found (hits)', async () => {
  const { svc } = rig({ askResult: { ok: false, reason: 'ollama-down', hits: [{ file: 'host/a.js', line: 1, endLine: 30 }], keywordOnly: false, stale: false } });
  const r = await svc.handle({ type: 'ask', op: 'ask', seq: 1, question: 'q' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'ollama-down');
  assert.strictEqual(r.places.length, 1);
});

test('the first index: index-building comes back with its progress', async () => {
  const { svc } = rig({ askResult: { ok: false, reason: 'index-building', progress: { state: 'building', done: 5, total: 20 }, partial: false } });
  const r = await svc.handle({ type: 'ask', op: 'ask', seq: 1, question: 'q' });
  assert.deepStrictEqual([r.ok, r.reason, r.progress], [false, 'index-building', { state: 'building', done: 5, total: 20 }]);
});

test('ask on a Claude model goes through the Claude repo, with that model named', async () => {
  const seen = [];
  const { svc } = rig();
  const svc2 = createAskService({
    ...{ cwd: CWD }, index: { get: () => ({ files: [] }), load: async () => ({ files: [] }), refresh: async () => ({}), progress: () => ({}), isRunning: () => false },
    ollama: { answerModel: 'm', check: async () => ({ ok: true, answer: true, embed: true }) },
    claude: { generate: async () => ({ ok: true, text: 'x' }) },
    models: createModels({ localModel: 'm', readRecord: () => '{}' }),
    repoFor: (id) => { seen.push(id); return { ask: async () => ({ ok: true, text: 't', citations: [], dropped: [], sources: [], model: id, keywordOnly: false, stale: false, ms: 1 }) }; },
    readSelection: async () => ({ ok: false }), spawnOllama: async () => ({ ok: true }),
  });
  const r = await svc2.handle({ type: 'ask', op: 'ask', seq: 1, question: 'q', model: 'haiku' });
  assert.deepStrictEqual(seen, ['haiku']);
  assert.strictEqual(r.model, 'haiku');
  void svc;
});

test('an unknown model name from the page is the local model, never a command', async () => {
  const seen = [];
  const { svc } = rig();
  void svc;
  const svc2 = createAskService({
    cwd: CWD, index: { get: () => null, load: async () => null, refresh: async () => ({}), progress: () => ({}), isRunning: () => false },
    ollama: { answerModel: 'm', check: async () => ({ ok: true }) }, claude: { generate: async () => ({ ok: true, text: 'x' }) },
    models: createModels({ localModel: 'm', readRecord: () => '{}' }),
    repoFor: (id) => { seen.push(id); return { ask: async () => ({ ok: false, reason: 'no-matches' }) }; },
    readSelection: async () => ({ ok: false }), spawnOllama: async () => ({ ok: true }),
  });
  await svc2.handle({ type: 'ask', op: 'ask', seq: 1, question: 'q', model: '--dangerously-skip-permissions' });
  assert.deepStrictEqual(seen, ['local']);
});

test('explain is refused for a model with no passed record (the explainer is built and off)', async () => {
  const { svc, calls } = rig();
  const r = await svc.handle({ type: 'ask', op: 'explain', seq: 1, file: 'host/a.js', start: 3, end: 5, model: 'local', level: 'comfortable' });
  assert.deepStrictEqual([r.ok, r.reason, r.model], [false, 'explainer-off', 'local']);
  assert.strictEqual(calls.generate.length, 0);
  assert.strictEqual(calls.excerpts.length, 0);
});

test('explain on a passed local model: the selection is read, excerpts found around it (not itself), the level and About me reach the prompt', async () => {
  const { svc, calls } = rig({ passed: PASS });
  const r = await svc.handle({ type: 'ask', op: 'explain', seq: 1, file: 'host/a.js', start: 3, end: 5, model: 'local', level: 'new', aboutMe: 'C# audio person' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'The idea. See host/a.js:3-4.');
  assert.deepStrictEqual(calls.excerpts[0][2].exclude, { file: 'host/a.js', start: 3, end: 5 });
  assert.match(calls.excerpts[0][1], /line 3/);
  const g = calls.generate[0];
  assert.match(g.system, /Reader level: New to coding/);
  assert.match(g.system, /C# audio person/);
  assert.match(g.prompt, /Selected code \(host\/a\.js, lines 3-5\):\n3: line 3\n4: line 4\n5: line 5/);
  assert.strictEqual(r.places[0].file, 'host/a.js');
});

test('explain on a passed Claude model goes to the Claude answerer, not Ollama', async () => {
  const { svc, calls } = rig({ passed: PASS });
  const r = await svc.handle({ type: 'ask', op: 'explain', seq: 1, file: 'host/a.js', start: 3, end: 5, model: 'haiku', level: 'comfortable' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'Claude says host/a.js:5.');
  assert.strictEqual(calls.generate.length, 0);
  assert.strictEqual(calls.claude[0].model, 'haiku');
});

test('explain with Ollama down: named, with the places the search found', async () => {
  const { svc } = rig({ passed: PASS, ex: { ok: true, body: 'b', sent: [{ file: 'host/a.js', start: 1, end: 30 }], lineCounts: new Map([['host/a.js', 30]]), keywordOnly: true, stale: false, ollamaStatus: { ok: false, reason: 'ollama-down' } } });
  const r = await svc.handle({ type: 'ask', op: 'explain', seq: 1, file: 'host/a.js', start: 3, end: 5, model: 'local' });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'ollama-down']);
  assert.ok(r.places.length >= 1);
});

test('explain: a failed model run keeps the reason (and the CLI\'s words for a Claude model)', async () => {
  const { svc } = rig({ passed: PASS, claude: { ok: false, reason: 'claude-failed', detail: 'Overloaded' } });
  const r = await svc.handle({ type: 'ask', op: 'explain', seq: 1, file: 'host/a.js', start: 3, end: 5, model: 'haiku' });
  assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, 'claude-failed', 'Overloaded']);
});

test('explain: the index still being built is index-building with progress', async () => {
  const { svc } = rig({ passed: PASS, ex: { ok: false, reason: 'index-building', progress: { done: 1, total: 9 } } });
  const r = await svc.handle({ type: 'ask', op: 'explain', seq: 1, file: 'host/a.js', start: 3, end: 5, model: 'local' });
  assert.deepStrictEqual([r.reason, r.progress], ['index-building', { done: 1, total: 9 }]);
});

test('explain: a selection must be whole line numbers inside the file, and the read is the guard\'s, not the page\'s say-so', async () => {
  const { svc, calls } = rig({ passed: PASS });
  for (const bad of [{ start: 0, end: 3 }, { start: 5, end: 3 }, { start: 1.5, end: 3 }, { start: '1', end: 3 }, { start: 1, end: 99 }, { start: 1, end: 100000 }]) {
    const r = await svc.handle({ type: 'ask', op: 'explain', seq: 1, file: 'host/a.js', model: 'local', ...bad });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'bad-selection'], JSON.stringify(bad));
  }
  const r2 = await svc.handle({ type: 'ask', op: 'explain', seq: 1, file: 5, start: 1, end: 2, model: 'local' });
  assert.strictEqual(r2.reason, 'bad-selection');
  assert.strictEqual(calls.generate.length, 0);
});

test('explain: a file outside the worktree or unreadable is bad-selection with the guard\'s reason', async () => {
  const { svc } = rig({ passed: PASS, readSelection: async () => ({ ok: false, why: 'outside the worktree' }) });
  const r = await svc.handle({ type: 'ask', op: 'explain', seq: 1, file: '..\\..\\secrets.txt', start: 1, end: 2, model: 'local' });
  assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, 'bad-selection', 'outside the worktree']);
});

test('explain: a drill-down names the highlighted words and the answer; the excerpts are looked up by the words', async () => {
  const { svc, calls } = rig({ passed: PASS });
  await svc.handle({ type: 'ask', op: 'explain', seq: 1, file: 'host/a.js', start: 3, end: 5, model: 'local', term: 'HTTP request', answer: 'It sends an HTTP request.' });
  assert.match(calls.generate[0].prompt, /highlighted "HTTP request"/);
  assert.match(calls.excerpts[0][1], /HTTP request/);
});

test('places: the search alone, the best few ranges as cards (no model is asked)', async () => {
  const { svc, calls } = rig();
  const r = await svc.handle({ type: 'ask', op: 'places', seq: 4, question: 'where is a?' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.places[0].file, 'host/a.js');
  assert.strictEqual(calls.generate.length, 0);
  assert.strictEqual(calls.claude.length, 0);
  assert.strictEqual((await svc.handle({ type: 'ask', op: 'places', seq: 4, question: '' })).reason, 'empty-question');
});

test('places for a selection excludes the selection itself', async () => {
  const { svc, calls } = rig();
  await svc.handle({ type: 'ask', op: 'places', seq: 4, file: 'host/a.js', start: 3, end: 5 });
  assert.deepStrictEqual(calls.excerpts[0][2].exclude, { file: 'host/a.js', start: 3, end: 5 });
});

test('start-ollama: starts it once; if it is already answering, says so and starts nothing', async () => {
  const { svc, calls } = rig({ check: { ok: false, reason: 'ollama-down' } });
  assert.deepStrictEqual((await svc.handle({ type: 'ask', op: 'start-ollama', seq: 1 })).ok, true);
  assert.strictEqual(calls.spawn, 1);
  const up = rig();
  const r = await up.svc.handle({ type: 'ask', op: 'start-ollama', seq: 1 });
  assert.deepStrictEqual([r.ok, r.already], [true, true]);
  assert.strictEqual(up.calls.spawn, 0);
  const fail = rig({ check: { ok: false, reason: 'ollama-down' }, spawn: { ok: false, reason: 'ollama-not-installed' } });
  assert.deepStrictEqual((await fail.svc.handle({ type: 'ask', op: 'start-ollama', seq: 1 })).reason, 'ollama-not-installed');
});

// ---- the pure helpers -------------------------------------------------------------------------------------------------------

test('whyFor: the sentence around a citation, without the citation or the bullet', () => {
  const text = 'It checks the lock.\n- host/a.js:3-4: releases the lock when the host stops.\n- host/b.js:9 holds it.';
  assert.strictEqual(whyFor(text, { file: 'host/a.js', line: 3, endLine: 4 }), 'releases the lock when the host stops');
  assert.strictEqual(whyFor(text, { file: 'host/b.js', line: 9 }), 'holds it');
  assert.strictEqual(whyFor('see host/a.js:3', { file: 'host/a.js', line: 3 }), '');
  assert.strictEqual(whyFor(text, { file: 'host/zzz.js', line: 1 }), '');
  assert.ok(whyFor('x '.repeat(500) + ' host/a.js:3', { file: 'host/a.js', line: 3 }).length <= 160);
});

test('placesFromCitations: deduped, capped, with the real lines of the file', () => {
  const data = { files: [{ rel: 'host/a.js', lines: 30, chunks: [{ start: 1, end: 30, text: lines(30).join('\n') }] }] };
  const cits = [{ file: 'host/a.js', line: 3, endLine: 9 }, { file: 'host/a.js', line: 3, endLine: 9 }, ...Array.from({ length: 10 }, (_, i) => ({ file: 'host/a.js', line: 10 + i }))];
  const p = placesFromCitations('text', cits, data);
  assert.ok(p.length <= 6);
  assert.strictEqual(p.filter(x => x.line === 3).length, 1);
  assert.deepStrictEqual(p[0].lines.map(l => l.n), [3, 4, 5, 6]);
  assert.deepStrictEqual(placesFromCitations('t', [{ file: 'nope.js', line: 1 }], data)[0].lines, []);
});

test('examplesFrom: three questions about real functions of three different files, the same every time', () => {
  const data = { files: [
    { rel: 'host/a.js', size: 900, chunks: [{ text: 'function alpha() {}\nfunction beta() {}' }] },
    { rel: 'host/b.js', size: 800, chunks: [{ text: 'async function gamma() {}' }] },
    { rel: 'app/c.js', size: 700, chunks: [{ text: 'function delta() {}' }] },
    { rel: 'app/d.js', size: 600, chunks: [{ text: 'function epsilon() {}' }] },
  ] };
  const a = examplesFrom(data);
  assert.deepStrictEqual(a, examplesFrom(data));
  assert.strictEqual(a.length, 3);
  assert.match(a[0], /alpha/);
  assert.match(a[1], /gamma/);
  assert.match(a[2], /delta/);
  assert.deepStrictEqual(examplesFrom(null), []);
  assert.deepStrictEqual(examplesFrom({ files: [] }), []);
});

// --- kill tests for the release-176 survivors (BACKLOG #94) ----------------------

const killAs = require('../host/ask-service');
const killFs = require('fs');
const killPath = require('path');
const { tmpDir: killTmpDir } = require('./tmp-dir');

const D = (files) => ({ files });
const FILE = (rel, text, start = 1, extra = {}) => ({ rel, ...extra, chunks: [{ start, end: start + text.split('\n').length - 1, text }] });

test('M1: linesOf gives each real line once, in order, cut to 200 characters, and nothing for what the index does not hold', () => {
  const data = D([{ rel: 'a.js', chunks: [{ start: 3, text: 'c\nd\ne' }, { start: 1, text: 'a\nb\nOTHER-c' }, { text: 'no start' }, { start: 9, text: 7 }] }]);
  assert.deepStrictEqual(killAs.linesOf(data, 'a.js', 1, 4), [{ n: 1, text: 'a' }, { n: 2, text: 'b' }, { n: 3, text: 'c' }, { n: 4, text: 'd' }]);
  assert.deepStrictEqual(killAs.linesOf(data, 'a.js', 2, 3).map(x => x.n), [2, 3], 'both ends are inclusive');
  assert.deepStrictEqual(killAs.linesOf(data, 'a.js', 1, 99).map(x => x.n), [1, 2, 3, 4, 5], 'a range that runs past the last chunk ends with it');
  assert.strictEqual(killAs.linesOf(D([FILE('long.js', 'x'.repeat(300))]), 'long.js', 1, 1)[0].text.length, 200);
  for (const junk of [null, undefined, 'x', [], {}, { files: 'no' }, D([])]) assert.deepStrictEqual(killAs.linesOf(junk, 'a.js', 1, 9), []);
  assert.deepStrictEqual(killAs.linesOf(D([{ rel: 'a.js' }]), 'a.js', 1, 9), [], 'a file with no chunks');
  assert.deepStrictEqual(killAs.linesOf(data, 'other.js', 1, 9), []);
});

test('M1: whyFor takes the answer\'s own words for a citation: the bullet, the citation and the edges of the sentence go', () => {
  const cit = { file: 'host/a.js', line: 3 };
  assert.strictEqual(killAs.whyFor('- The loop retries on failure host/a.js:3-4.', cit), 'The loop retries on failure');
  assert.strictEqual(killAs.whyFor('12) Retries three times (host/a.js:3)', cit), 'Retries three times');
  assert.strictEqual(killAs.whyFor('  \u2022  Retries   with   backoff `host/a.js:3` **now**', cit), 'Retries with backoff now');
  assert.strictEqual(killAs.whyFor('Handles retries - three of them host/a.js:3', cit), 'Handles retries - three of them', 'a dash inside is not a bullet');
  assert.strictEqual(killAs.whyFor('3. host/a.js:3 \u2014 opens the socket; ', cit), 'opens the socket');
  assert.strictEqual(killAs.whyFor('see host/a.js:3 \u2013 host/a.js:5 for the pool', cit), 'see \u2013 for the pool');
  assert.strictEqual(killAs.whyFor('intro\nIt opens the pool host/a.js:3\noutro', cit), 'It opens the pool', 'only the line that carries the citation');
  assert.strictEqual(killAs.whyFor('line one\r\nIt opens the pool host/a.js:3\r\nline three', cit), 'It opens the pool');
});

test('M1: whyFor is empty for nothing useful, keeps 8 characters, and cuts at 160', () => {
  const cit = { file: 'f.js', line: 1 };
  assert.strictEqual(killAs.whyFor(null, cit), '');
  assert.strictEqual(killAs.whyFor('text f.js:1', null), '');
  assert.strictEqual(killAs.whyFor(7, cit), '');
  assert.strictEqual(killAs.whyFor('no citation here', cit), '');
  assert.strictEqual(killAs.whyFor('1234567 f.js:1', cit), '', '7 characters is too little');
  assert.strictEqual(killAs.whyFor('12345678 f.js:1', cit), '12345678', '8 is enough');
  const exact = 'a'.repeat(160);
  assert.strictEqual(killAs.whyFor(`${exact} f.js:1`, cit), exact, '160 stays whole');
  const over = 'b'.repeat(161);
  assert.strictEqual(killAs.whyFor(`${over} f.js:1`, cit), 'b'.repeat(159) + '\u2026');
});

test('M1: placesFromCitations: one card per place, capped at six, junk skipped, endLine never before the line', () => {
  const data = D([FILE('a.js', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8')]);
  const cits = [
    null, 'x', { file: 'a.js' }, { line: 2 }, { file: 'a.js', line: 2.5 }, { file: 5, line: 1 },
    { file: 'a.js', line: 1, endLine: 2 }, { file: 'a.js', line: 1, endLine: 9 }, { file: 'a.js', line: 3, endLine: 3 },
    { file: 'a.js', line: 4, endLine: 2 }, { file: 'a.js', line: 5, endLine: 'x' }, { file: 'a.js', line: 6 }, { file: 'a.js', line: 7 }, { file: 'a.js', line: 8 },
  ];
  const got = killAs.placesFromCitations('text', cits, data);
  assert.deepStrictEqual(got.map(c => [c.line, c.endLine]), [[1, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]], 'deduplicated by file and line, six at most');
  assert.deepStrictEqual(got[0].lines.map(l => l.n), [1, 2]);
  assert.deepStrictEqual(killAs.placesFromCitations('t', [{ file: 'a.js', line: 1, endLine: 8 }], data)[0].lines.map(l => l.n), [1, 2, 3, 4], 'a card shows four lines at most');
  assert.deepStrictEqual(killAs.placesFromCitations('t', 'nope', data), []);
});

test('M1: placesFromRanges reads line/start and endLine/end, shows no "why", and stops at max', () => {
  const data = D([FILE('a.js', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9')]);
  const ranges = [{ file: 'a.js', start: 1, end: 2 }, { file: 'a.js', line: 3, endLine: 5 }, { file: 'a.js', line: 4, endLine: 1 }, { file: 'a.js', start: 5 },
    { file: 7, start: 1 }, { file: 'a.js', start: 'x' }, { file: 'a.js', start: 6, end: 6 }, { file: 'a.js', start: 7 }, { file: 'a.js', start: 8 }, { file: 'a.js', start: 9 }];
  const got = killAs.placesFromRanges(ranges, data);
  assert.deepStrictEqual(got.map(c => [c.line, c.endLine, c.why]), [[1, 2, ''], [3, 5, ''], [4, 4, ''], [5, 5, ''], [6, 6, '']], 'five by default');
  assert.deepStrictEqual(killAs.placesFromRanges(ranges, data, 2).length, 2);
  assert.deepStrictEqual(killAs.placesFromRanges(ranges, data, 3).length, 3);
  assert.deepStrictEqual(got[1].lines.map(l => l.n), [3, 4, 5, 6], 'four lines from the first');
  assert.deepStrictEqual(killAs.placesFromRanges(null, data), []);
});

test('M1: examplesFrom: three questions about real definitions, biggest files first, one per file, the same every time', () => {
  const files = [
    FILE('small.js', 'function tinyHelper() {}', 1, { size: 10 }),
    FILE('big.js', 'function bigThing(a) {}', 1, { size: 900 }),
    FILE('mid.py', 'def mid_thing(x):\n  pass', 1, { size: 500 }),
    FILE('cls.js', 'class Widget {}', 1, { size: 300 }),
    FILE('dup.js', 'function bigThing(b) {}', 1, { size: 800 }),
  ];
  const data = D(files);
  const got = killAs.examplesFrom(data);
  assert.deepStrictEqual(got, ['What does bigThing do?', 'Where is mid_thing defined, and what calls it?', 'How does Widget work?']);
  assert.strictEqual(killAs.examplesFrom(data), got, 'cached per index object');
  assert.deepStrictEqual(killAs.examplesFrom(D(files.slice(0, 1))), ['What does tinyHelper do?']);
});

test('M1: examplesFrom reads each language\'s definitions and skips names too short to be real', () => {
  const one = (rel, text) => killAs.examplesFrom(D([FILE(rel, text, 1, { size: 1 })]));
  assert.deepStrictEqual(one('a.ts', 'export default async function fetchAll(x) {}'), ['What does fetchAll do?']);
  assert.deepStrictEqual(one('a.ps1', 'function Get-Thing {\n}'), ['What does Get-Thing do?']);
  assert.deepStrictEqual(one('a.py', 'async def load_all(self):'), ['What does load_all do?']);
  assert.deepStrictEqual(one('a.go', 'func (s *Server) Handle(w int) {}'), ['What does Handle do?']);
  assert.deepStrictEqual(one('a.rs', 'pub async fn run_all<T>() {}'), ['What does run_all do?']);
  assert.deepStrictEqual(one('a.cs', 'class Program {}'), ['What does Program do?']);
  assert.deepStrictEqual(one('a.js', 'function abc() {}'), ['What is a.js for?'], 'a 3-letter name is no definition');
});

test('M1: examplesFrom with no definitions asks about the biggest files themselves, three at most, and never invents', () => {
  const data = D([FILE('docs/a.md', 'just words', 1, { size: 5 }), FILE('docs/b.md', 'more words', 1, { size: 50 }), FILE('docs/c.md', 'x', 1, { size: 20 }), FILE('docs/d.md', 'y', 1, { size: 1 }), { rel: '', chunks: [], size: 99 }]);
  assert.deepStrictEqual(killAs.examplesFrom(data), ['What is docs/b.md for?', 'What is docs/c.md for?'], 'the biggest are taken first; one with no name is not a question');
  for (const junk of [null, {}, { files: 'x' }, D([])]) assert.deepStrictEqual(killAs.examplesFrom(junk), []);
});

test('M1: the default selection reader stays inside the worktree and reads the real lines', async () => {
  const wt = killTmpDir('cc-ask-sel-');
  killFs.writeFileSync(killPath.join(wt, 'a.js'), 'one\ntwo\nthree\r\nfour\n');
  killFs.writeFileSync(killPath.join(killPath.dirname(wt), 'outside.txt'), 'secret\n');
  const seen = [];
  const svc = killAs.createAskService({
    cwd: wt, index: { get: () => null },
    ollama: { check: async () => ({ ok: true }) },
    models: { choose: () => 'local', explainerOn: () => true, list: () => [] },
    repoFor: () => ({ excerptsFor: async (c, q, o) => { seen.push([q, o]); return { ok: true, sent: [], keywordOnly: false, stale: false, prepared: null }; } }),
  });
  const bad = await svc.handle({ op: 'places', file: '../outside.txt', start: 1, end: 1 });
  assert.deepStrictEqual([bad.ok, bad.reason], [false, 'bad-selection']);
  assert.ok(bad.detail && bad.detail !== 'the file could not be read', bad.detail);
  assert.deepStrictEqual(seen, [], 'nothing outside the worktree was read');
  const gone = await svc.handle({ op: 'places', file: 'nope.js', start: 1, end: 1 });
  assert.deepStrictEqual([gone.ok, gone.reason, gone.detail], [false, 'bad-selection', 'gone']);
  const ok = await svc.handle({ op: 'places', file: 'a.js', start: 2, end: 3 });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(seen[0][0], 'two\nthree', 'the selection\'s own text is the query');
  killFs.writeFileSync(killPath.join(wt, 'bin.dat'), Buffer.from([65, 0, 66]));
  killFs.mkdirSync(killPath.join(wt, 'adir'));
  const bin = await svc.handle({ op: 'places', file: 'bin.dat', start: 1, end: 1 });
  assert.deepStrictEqual([bin.reason, bin.detail], ['bad-selection', 'binary']);
  const dir = await svc.handle({ op: 'places', file: 'adir', start: 1, end: 1 });
  assert.deepStrictEqual([dir.reason, dir.detail], ['bad-selection', 'not-a-file']);
  const tooFar = await svc.handle({ op: 'places', file: 'a.js', start: 1, end: 9 });
  assert.deepStrictEqual([tooFar.reason, tooFar.detail], ['bad-selection', 'the file has only 5 lines']);
});

function mkSvc(over = {}) {
  const calls = { excerpts: [], ask: [], generate: [], claude: [], portrait: 0, forge: 0 };
  const ex = { ok: true, body: 'B', sent: [{ file: 'a.js', start: 1, end: 3 }], lineCounts: new Map([['a.js', 5]]), keywordOnly: false, stale: false, ollamaStatus: { ok: true }, prepared: { data: D([FILE('a.js', 'l1\nl2\nl3\nl4\nl5')]), marker: 1 } };
  const repo = {
    excerptsFor: async (c, q, o) => { calls.excerpts.push([q, o]); return ex; },
    ask: async (c, q, opts) => { calls.ask.push(opts); return { ok: true, text: 'answer a.js:2', citations: [{ file: 'a.js', line: 2 }], sources: [], dropped: [], ms: 1 }; },
    status: async () => over.repoStatus || { state: 'ready' },
  };
  const svc = killAs.createAskService({
    cwd: 'C:\\w', index: over.index || { get: () => null, isRunning: () => !!over.running, refresh: async () => { calls.refresh = (calls.refresh || 0) + 1; } },
    ollama: { check: async () => over.check || { ok: true }, generate: async (o) => { calls.generate.push(o); return { ok: true, text: 'g a.js:2' }; } },
    claude: { generate: async (o) => { calls.claude.push(o); return { ok: true, text: 'c a.js:2' }; } },
    models: over.models || { choose: (m) => m || 'local', explainerOn: () => true, list: () => [{ id: 'local' }] },
    repoFor: () => repo, readSelection: async () => ({ ok: true, text: ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n') }),
    now: over.now, portraitOf: (a) => { calls.portrait += 1; return over.portraitOf ? over.portraitOf(a) : null; },
    forgeAgents: () => { calls.forge += 1; if (over.forgeThrows) throw new Error('x'); return over.forge || []; },
  });
  return { svc, calls };
}

test('M2: one retrieval is kept per places call, taken once, and only by the same question, kind and model', async () => {
  const { svc, calls } = mkSvc();
  const p = await svc.handle({ op: 'places', question: ' what? ' });
  assert.ok(p.retrieval);
  await svc.handle({ op: 'ask', question: 'what?', retrieval: p.retrieval });
  assert.ok(calls.ask[0] && calls.ask[0].prepared.marker === 1, 'the places\' own hits were reused');
  await svc.handle({ op: 'ask', question: 'what?', retrieval: p.retrieval });
  assert.strictEqual(calls.ask[1], undefined, 'taken once');
  const q = await svc.handle({ op: 'places', question: 'what?' });
  await svc.handle({ op: 'ask', question: 'another?', retrieval: q.retrieval });
  assert.strictEqual(calls.ask[2], undefined, 'another question');
  const q2 = await svc.handle({ op: 'places', question: 'what?', model: 'local' });
  await svc.handle({ op: 'ask', question: 'what?', model: 'haiku', retrieval: q2.retrieval });
  assert.strictEqual(calls.ask[3], undefined, 'another model');
  await svc.handle({ op: 'ask', question: 'what?', retrieval: 12345 });
  assert.strictEqual(calls.ask[4], undefined, 'a retrieval id that is not a string');
  await svc.handle({ op: 'ask', question: 'what?', retrieval: 'nope' });
  assert.strictEqual(calls.ask[5], undefined);
});

test('M2: a selection\'s retrieval is for explain, not for a question, and is keyed by file, range and trimmed term', async () => {
  const { svc, calls } = mkSvc();
  const sel = { file: 'a.js', start: 1, end: 2 };
  const p = await svc.handle({ op: 'places', ...sel, term: '  foo  ' });
  const before = calls.excerpts.length;
  await svc.handle({ op: 'explain', ...sel, term: 'foo', retrieval: p.retrieval });
  assert.strictEqual(calls.excerpts.length, before, 'the same selection (term trimmed) reuses the places');
  const p2 = await svc.handle({ op: 'places', ...sel });
  await svc.handle({ op: 'ask', question: 'a.js', retrieval: p2.retrieval });
  assert.strictEqual(calls.ask[0], undefined, 'a selection\'s retrieval is not a question\'s');
  const p4 = await svc.handle({ op: 'places', ...sel });
  await svc.handle({ op: 'ask', question: 'a.js:1-2:', retrieval: p4.retrieval });
  assert.strictEqual(calls.ask[1], undefined, 'even a question that spells the key of a selection is not that selection');
  const p3 = await svc.handle({ op: 'places', ...sel });
  const n = calls.excerpts.length;
  await svc.handle({ op: 'explain', file: 'a.js', start: 1, end: 3, retrieval: p3.retrieval });
  assert.strictEqual(calls.excerpts.length, n + 1, 'another range does not reuse it');
});

test('M2: a retrieval is good for exactly 60 s, and only the last eight are kept', async () => {
  let t = 1000;
  const { svc, calls } = mkSvc({ now: () => t });
  const p = await svc.handle({ op: 'places', question: 'q' });
  t += 60_000;
  await svc.handle({ op: 'ask', question: 'q', retrieval: p.retrieval });
  assert.ok(calls.ask[0], 'at exactly the TTL it is still served');
  const p2 = await svc.handle({ op: 'places', question: 'q' });
  t += 60_001;
  await svc.handle({ op: 'ask', question: 'q', retrieval: p2.retrieval });
  assert.strictEqual(calls.ask[1], undefined, 'one ms later it is not');

  const ids = [];
  for (let i = 0; i < 8; i++) ids.push((await svc.handle({ op: 'places', question: 'q' })).retrieval);
  await svc.handle({ op: 'ask', question: 'q', retrieval: ids[0] });
  assert.ok(calls.ask[2], 'eight kept: the first of eight is still there');
  ids.length = 0;
  for (let i = 0; i < 9; i++) ids.push((await svc.handle({ op: 'places', question: 'q' })).retrieval);
  await svc.handle({ op: 'ask', question: 'q', retrieval: ids[0] });
  assert.strictEqual(calls.ask[3], undefined, 'nine made: the oldest is gone');
  await svc.handle({ op: 'ask', question: 'q', retrieval: ids[8] });
  assert.ok(calls.ask[4]);
});

test('M2: the agents\' pictures are looked up at most every 10 s, unless a fresh read is asked for', async () => {
  let t = 5000;
  const { svc, calls } = mkSvc({ now: () => t });
  await svc.handle({ op: 'status' });
  t += 10_000;
  await svc.handle({ op: 'status' });
  assert.strictEqual(calls.forge, 1, 'at exactly 10 s the cache still stands');
  t += 1;
  await svc.handle({ op: 'status' });
  assert.strictEqual(calls.forge, 2);
  await svc.handle({ op: 'status', fresh: true });
  assert.strictEqual(calls.forge, 3);
  await svc.handle({ op: 'status', fresh: 'yes' });
  assert.strictEqual(calls.forge, 3, 'only a real true asks for a fresh read');
});

test('M2: portraits: the explainer\'s own, and up to eight generated pictures of the forge tier, a throwing lookup being no picture', async () => {
  const pic = (agent, over = {}) => ({ kind: 'file', tier: 'forge', agent, ...over });
  const forge = Array.from({ length: 12 }, (_, i) => `ag${i}`);
  const { svc } = mkSvc({ forge, portraitOf: (a) => (a === 'ag1' ? pic(a, { tier: 'stock' }) : a === 'ag2' ? pic(a, { kind: 'color' }) : a === 'ag3' ? null : a === 'ag4' ? (() => { throw new Error('x'); })() : pic(a)) });
  const r = await svc.handle({ op: 'status' });
  assert.deepStrictEqual(r.portraits.suggestions.map(s => s.agent), ['ag0', 'ag5', 'ag6', 'ag7', 'ag8', 'ag9', 'ag10', 'ag11'].slice(0, 8));
  assert.strictEqual(r.portraits.suggestions.length, 8);
  assert.deepStrictEqual(r.portraits.own, { kind: 'file', tier: 'forge', agent: killAs.EXPLAINER_AGENT });
  const { svc: bad } = mkSvc({ forgeThrows: true, portraitOf: () => ({ kind: 'file', tier: 'forge' }) });
  const r2 = await bad.handle({ op: 'status' });
  assert.deepStrictEqual(r2.portraits.suggestions, []);
  assert.deepStrictEqual(r2.portraits.own, { kind: 'file', tier: 'forge' });
});

test('M2: status: a build that never started is started once, only on warm, only when nothing is running', async () => {
  for (const [state, running, warm, want] of [['none', false, true, 1], ['partial', false, true, 1], ['ready', false, true, 0], ['none', true, true, 0], ['none', false, false, 0], ['none', false, 'yes', 0]]) {
    const { svc, calls } = mkSvc({ repoStatus: { state }, running });
    const r = await svc.handle({ op: 'status', warm });
    assert.strictEqual(calls.refresh || 0, want, `${state} running=${running} warm=${warm}`);
    assert.strictEqual(r.index.running, running);
  }
  const { svc } = mkSvc({ repoStatus: 'none-at-all' });
  assert.strictEqual((await svc.handle({ op: 'status' })).index, 'none-at-all', 'a status that is not an object is passed through as it is');
});

test('M2: status: Ollama trouble is named with its model, and at most three examples go out', async () => {
  const { svc } = mkSvc({ check: { ok: false, reason: 'model-missing', model: 'qwen:x' } });
  assert.deepStrictEqual((await svc.handle({ op: 'status' })).ollama, { ok: false, reason: 'model-missing', model: 'qwen:x' });
  const { svc: s2 } = mkSvc({ check: { ok: false, reason: 'ollama-down' } });
  assert.deepStrictEqual((await s2.handle({ op: 'status' })).ollama, { ok: false, reason: 'ollama-down' });
  const files = Array.from({ length: 6 }, (_, i) => FILE(`f${i}.js`, `function thing${i}x() {}`, 1, { size: 10 - i }));
  const { svc: s3 } = mkSvc({ index: { get: () => D(files), isRunning: () => false } });
  assert.strictEqual((await s3.handle({ op: 'status' })).examples.length, 3);
  const { svc: s4 } = mkSvc({ index: { snapshot: () => D(files.slice(0, 1)), get: () => D(files), isRunning: () => false } });
  assert.strictEqual((await s4.handle({ op: 'status' })).examples.length, 1, 'the snapshot, while a build runs, wins over the finished index');
});

test('M3: a selection must be whole lines inside 1..400, in order, from a file name', async () => {
  const { svc } = mkSvc();
  const bad = async (m) => (await svc.handle({ op: 'places', file: 'a.js', start: 1, end: 1, ...m }));
  for (const m of [{ start: 0 }, { start: -1 }, { start: 1.5 }, { end: 0.5 }, { start: 3, end: 2 }, { file: '' }, { file: 5 }, { start: '1' }, { end: '1' }]) {
    const r = await bad(m);
    if (m.file === 5 || m.file === '') continue;
    assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, 'bad-selection', 'that is not a range of lines'], JSON.stringify(m));
  }
  assert.strictEqual((await bad({ start: 2, end: 2 })).ok, true, 'one line is a range');
  const big = mkSvc();
  const lines = Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n');
  const svc2 = killAs.createAskService({ cwd: 'C:\\w', index: { get: () => null }, ollama: { check: async () => ({ ok: true }) }, models: { choose: () => 'local', explainerOn: () => true, list: () => [] },
    repoFor: () => ({ excerptsFor: async () => ({ ok: true, sent: [], prepared: null }) }), readSelection: async () => ({ ok: true, text: lines }) });
  assert.strictEqual((await svc2.handle({ op: 'places', file: 'a.js', start: 1, end: 400 })).ok, true, '400 lines is allowed');
  const over = await svc2.handle({ op: 'places', file: 'a.js', start: 1, end: 401 });
  assert.deepStrictEqual([over.reason, over.detail], ['bad-selection', 'that is too many lines at once']);
  assert.ok(big.svc);
});

test('M3: the selection\'s own words are the query when there is no term, and the term (trimmed) when there is; both cut to 500', async () => {
  const seen = [];
  const svc = killAs.createAskService({ cwd: 'C:\\w', index: { get: () => null }, ollama: { check: async () => ({ ok: true }) }, models: { choose: () => 'local', explainerOn: () => true, list: () => [] },
    repoFor: () => ({ excerptsFor: async (c, q) => { seen.push(q); return { ok: true, sent: [], prepared: null }; } }),
    readSelection: async () => ({ ok: true, text: `${Array.from({ length: 30 }, () => 'abcdefghi '.repeat(4)).join('\n')}\nsecond` }) });
  await svc.handle({ op: 'places', file: 'a.js', start: 1, end: 30 });
  await svc.handle({ op: 'places', file: 'a.js', start: 1, end: 30, term: '  hot  ' });
  await svc.handle({ op: 'places', file: 'a.js', start: 1, end: 30, term: '   ' });
  await svc.handle({ op: 'places', file: 'a.js', start: 1, end: 30, term: 'y'.repeat(700) });
  assert.strictEqual(seen[0].length, 500);
  assert.strictEqual(seen[1], 'hot');
  assert.strictEqual(seen[2].length, 500, 'a blank term is no term');
  assert.strictEqual(seen[3], 'y'.repeat(500));
});

test('M3: a reader that fails says why, or says the file could not be read', async () => {
  const mk = (readSelection) => killAs.createAskService({ cwd: 'C:\\w', index: { get: () => null }, ollama: {}, models: { choose: () => 'local', list: () => [] }, repoFor: () => ({}), readSelection });
  const q = { op: 'places', file: 'a.js', start: 1, end: 1 };
  assert.deepStrictEqual((await mk(async () => ({ ok: false, why: 'binary' })).handle(q)).detail, 'binary');
  assert.deepStrictEqual((await mk(async () => ({ ok: false })).handle(q)).detail, 'the file could not be read');
  assert.deepStrictEqual((await mk(async () => null).handle(q)).detail, 'the file could not be read');
  assert.deepStrictEqual((await mk(async () => ({ ok: 'yes', text: 'x' })).handle(q)).detail, 'the file could not be read', 'only a real true is a read');
  const crlf = await mk(async () => ({ ok: true, text: 'a\r\nb' })).handle({ ...q, end: 3 });
  assert.strictEqual(crlf.detail, 'the file has only 2 lines');
});

test('M3: an explanation goes to the local model for "local" and to Claude for any other, with the model named', async () => {
  const { svc, calls } = mkSvc();
  const sel = { file: 'a.js', start: 1, end: 2 };
  const local = await svc.handle({ op: 'explain', ...sel, model: 'local' });
  assert.strictEqual(local.ok, true);
  assert.strictEqual(calls.generate.length, 1);
  assert.strictEqual(calls.generate[0].numPredict, 450);
  assert.strictEqual(calls.claude.length, 0);
  const claude = await svc.handle({ op: 'explain', ...sel, model: 'haiku' });
  assert.strictEqual(claude.ok, true);
  assert.strictEqual(calls.claude.length, 1);
  assert.strictEqual(calls.claude[0].model, 'haiku');
  assert.strictEqual(calls.generate.length, 1);
});

test('M3: an explainer that is off for the model is refused before anything is read', async () => {
  const { svc, calls } = mkSvc({ models: { choose: (m) => m || 'local', explainerOn: (m) => m === 'haiku', list: () => [] } });
  const r = await svc.handle({ op: 'explain', file: 'a.js', start: 1, end: 2, model: 'sonnet' });
  assert.deepStrictEqual(r, { type: 'ask', op: 'explain', seq: undefined, ok: false, reason: 'explainer-off', model: 'sonnet' });
  assert.strictEqual(calls.excerpts.length, 0);
});

test('M3: claudeAsOllama: the Claude model answers, the local embedder is only the embedder', async () => {
  const sent = [];
  const mk = (status) => killAs.claudeAsOllama({
    ollama: { embedModel: 'emb', check: async () => status, embed: async (t) => ({ ok: true, vectors: [t] }) },
    claude: { generate: async (o) => { sent.push(o); return { ok: true, text: 'c' }; } }, modelId: 'haiku',
  });
  const a = mk({ ok: true });
  assert.deepStrictEqual([a.answerModel, a.embedModel], ['haiku', 'emb']);
  assert.deepStrictEqual(await a.check(), { ok: true, answer: true, embed: true });
  assert.deepStrictEqual(await mk({ ok: true, embed: false }).check(), { ok: true, answer: true, embed: false });
  assert.deepStrictEqual(await mk({ ok: true, embed: true }).check(), { ok: true, answer: true, embed: true });
  assert.deepStrictEqual(await mk({ ok: false, reason: 'model-missing', embed: true }).check(), { ok: true, answer: true, embed: true });
  assert.deepStrictEqual(await mk({ ok: false, reason: 'model-missing', embed: false }).check(), { ok: true, answer: true, embed: false });
  assert.deepStrictEqual(await mk({ ok: false, reason: 'model-missing' }).check(), { ok: true, answer: true, embed: false });
  assert.deepStrictEqual(await mk({ ok: false, reason: 'ollama-down', embed: true }).check(), { ok: true, answer: true, embed: false });
  assert.deepStrictEqual(await a.embed(['t']), { ok: true, vectors: [['t']] });
  assert.deepStrictEqual(await a.generate({ system: 's', prompt: 'p', numPredict: 9 }), { ok: true, text: 'c' });
  assert.deepStrictEqual(sent, [{ model: 'haiku', system: 's', prompt: 'p' }]);
});

test('M3: createRepoFactory: one engine per model over the same index; "local" answers from Ollama, any other from Claude', async () => {
  const index = { load: async () => null, progress: () => ({ state: 'none', done: 0, total: 0 }), isRunning: () => false };
  const ollama = { answerModel: 'qwen-local', embedModel: 'emb', check: async () => ({ ok: true }), embed: async () => ({ ok: true, vectors: [] }), generate: async () => ({ ok: true, text: 'o' }) };
  const repoFor = killAs.createRepoFactory({ index, ollama, claude: { generate: async () => ({ ok: true, text: 'c' }) } });
  assert.strictEqual(repoFor('local'), repoFor('local'), 'built once');
  assert.notStrictEqual(repoFor('local'), repoFor('haiku'));
  assert.strictEqual((await repoFor('local').status('C:\\w')).model, 'qwen-local');
  assert.strictEqual((await repoFor('haiku').status('C:\\w')).model, 'haiku');
  assert.strictEqual((await repoFor('sonnet').status('C:\\w')).model, 'sonnet');
});

test('M3: start-ollama: already there is already; otherwise it is started, and why not is named', async () => {
  const mk = (check, spawn) => {
    let spawned = 0;
    const svc = killAs.createAskService({ cwd: 'C:\\w', index: { get: () => null }, ollama: { check: async () => check }, models: { choose: () => 'local', list: () => [] }, repoFor: () => ({}),
      spawnOllama: async () => { spawned += 1; return spawn; } });
    return { svc, spawned: () => spawned };
  };
  const a = mk({ ok: true }, { ok: true });
  assert.deepStrictEqual(await a.svc.handle({ op: 'start-ollama', seq: 1 }), { type: 'ask', op: 'start-ollama', seq: 1, ok: true, already: true });
  assert.strictEqual(a.spawned(), 0);
  const b = mk({ ok: false, reason: 'model-missing' }, { ok: true });
  assert.strictEqual((await b.svc.handle({ op: 'start-ollama' })).already, true);
  assert.strictEqual(b.spawned(), 0, 'a missing model is not a missing server');
  const c = mk({ ok: false, reason: 'ollama-down' }, { ok: true });
  const rc = await c.svc.handle({ op: 'start-ollama' });
  assert.deepStrictEqual([rc.ok, rc.already], [true, undefined]);
  assert.strictEqual(c.spawned(), 1);
  assert.strictEqual((await mk({ ok: false, reason: 'x' }, { ok: false, reason: 'ollama-not-installed' }).svc.handle({ op: 'start-ollama' })).reason, 'ollama-not-installed');
  assert.strictEqual((await mk({ ok: false, reason: 'x' }, { ok: false }).svc.handle({ op: 'start-ollama' })).reason, 'spawn-failed');
  assert.strictEqual((await mk({ ok: false, reason: 'x' }, null).svc.handle({ op: 'start-ollama' })).reason, 'spawn-failed');
  assert.strictEqual((await mk({ ok: false, reason: 'x' }, { ok: 'yes' }).svc.handle({ op: 'start-ollama' })).ok, false, 'only a real true is a start');
});

test('M3: createSpawnOllama: starts `ollama serve` detached with the harness markers removed, and names why it could not', async () => {
  const mk = (behave) => {
    const calls = [];
    const spawn = (bin, args, opts) => {
      calls.push([bin, args, opts]);
      const child = new (require('events'))();
      child.unref = () => { child.unrefed = true; };
      calls.child = child;
      behave(child);
      return child;
    };
    return { run: killAs.createSpawnOllama({ spawn, env: { PATH: 'p', ELECTRON_RUN_AS_NODE: '1', claude_custom_port: '1', Keep: 'k' }, settleMs: 5 }), calls };
  };
  const ok = mk(() => {});
  assert.deepStrictEqual(await ok.run(), { ok: true });
  assert.deepStrictEqual(ok.calls[0][0], 'ollama');
  assert.deepStrictEqual(ok.calls[0][1], ['serve']);
  assert.deepStrictEqual(ok.calls[0][2], { detached: true, stdio: 'ignore', windowsHide: true, env: { PATH: 'p', Keep: 'k' } });
  assert.strictEqual(ok.calls.child.unrefed, true, 'it outlives this host');
  const missing = mk((c) => setImmediate(() => c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))));
  assert.deepStrictEqual(await missing.run(), { ok: false, reason: 'ollama-not-installed' });
  const other = mk((c) => setImmediate(() => c.emit('error', Object.assign(new Error('x'), { code: 'EACCES' }))));
  assert.deepStrictEqual(await other.run(), { ok: false, reason: 'spawn-failed' });
  const bare = mk((c) => setImmediate(() => c.emit('error', null)));
  assert.deepStrictEqual(await bare.run(), { ok: false, reason: 'spawn-failed' });
  const throws = killAs.createSpawnOllama({ spawn: () => { throw new Error('boom'); }, env: {}, settleMs: 5 });
  assert.deepStrictEqual(await throws(), { ok: false, reason: 'spawn-failed' });
  const late = mk((c) => setTimeout(() => c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })), 30));
  assert.deepStrictEqual(await late.run(), { ok: true }, 'it answered before the late error, and answers once');
});

test('M3: serveEnv drops the harness markers in any case and keeps the rest as it is', () => {
  assert.deepStrictEqual(killAs.serveEnv({ PATH: 'p', Electron_Run_As_Node: '1', CLAUDE_CUSTOM_PORT: '1', claude_custom_x: '2', CLAUDE_CODE: 'k', OLLAMA_HOST: 'h' }), { PATH: 'p', CLAUDE_CODE: 'k', OLLAMA_HOST: 'h' });
  assert.deepStrictEqual(killAs.serveEnv(null), {});
  assert.deepStrictEqual(killAs.serveEnv(undefined), {});
});
