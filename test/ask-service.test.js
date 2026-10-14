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
