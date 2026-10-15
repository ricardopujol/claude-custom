'use strict';
/**
 * app/ask-panel-state.js (BACKLOG #33, DESIGN_ASK_REPO.md "The design, in full"): what the "Ask the repo" panel shows, as pure state:
 * the naming card, the empty panel, the waiting stages, an answer, the breadcrumb drill-down, Ollama down, the first index, history.
 */
const test = require('node:test');
const assert = require('node:assert');
const S = require('../app/ask-panel-state');

const named = { named: true, name: 'Professor Byte', level: 'comfortable', model: 'local', aboutMe: '' };
const place = (file, line) => ({ file, line, endLine: line + 2, why: 'because', lines: [{ n: line, text: 'x' }] });

test('before the explainer is named, the panel shows the naming card, whatever else is going on', () => {
  const st = S.begin(S.create(), { kind: 'question', label: 'q', request: {} });
  assert.strictEqual(S.viewOf(st, { named: false }), 'naming');
  assert.strictEqual(S.viewOf(S.create(), { named: false }), 'naming');
});

test('named, with nothing asked, the panel is empty (two steps, a box, examples)', () => {
  assert.strictEqual(S.viewOf(S.create(), named), 'empty');
});

test('asking starts a waiting entry and makes it current; ids count up', () => {
  let st = S.begin(S.create(), { kind: 'question', label: 'where is the lock?', request: { question: 'where is the lock?' }, model: 'local' });
  assert.strictEqual(S.current(st).id, 1);
  assert.strictEqual(S.current(st).phase, 'waiting');
  assert.strictEqual(S.current(st).stage, 'searching');
  assert.strictEqual(S.viewOf(st, named), 'waiting');
  st = S.begin(st, { kind: 'question', label: 'second', request: {} });
  assert.strictEqual(S.current(st).id, 2);
  assert.strictEqual(S.history(st).length, 2);
});

test('the places arrive first: cards show while the words are still being written (round 7: places first)', () => {
  let st = S.begin(S.create(), { kind: 'question', label: 'q', request: {} });
  st = S.setPlaces(st, 1, { ok: true, places: [place('a.js', 1), place('b.js', 5)] });
  const e = S.current(st);
  assert.strictEqual(e.stage, 'loading');
  assert.strictEqual(e.places.length, 2);
  assert.strictEqual(S.viewOf(st, named), 'waiting');
  assert.deepStrictEqual(S.stagesOf(e, 'local').map(s => [s.id, s.state]), [['found', 'done'], ['loading', 'active'], ['writing', 'todo']]);
  assert.match(S.stagesOf(e, 'local')[0].text, /found 2 places/);
  assert.match(S.stagesOf(e, 'local')[1].text, /loading the model/);
  st = S.setStage(st, 1, 'writing');
  assert.deepStrictEqual(S.stagesOf(S.current(st), 'local').map(s => s.state), ['done', 'done', 'active']);
});

test('before the search returns, no stage is done; for a Claude model the middle step says it is asking Claude', () => {
  const st = S.begin(S.create(), { kind: 'question', label: 'q', request: {} });
  const stages = S.stagesOf(S.current(st), 'haiku');
  assert.deepStrictEqual(stages.map(s => s.state), ['active', 'todo', 'todo']);
  assert.match(stages[1].text, /asking Haiku/i);
  assert.match(S.stagesOf(S.current(st), 'local')[0].text, /searching/i);
});

test('one place is "1 place", not "1 places"; none found is said', () => {
  let st = S.begin(S.create(), { kind: 'question', label: 'q', request: {} });
  st = S.setPlaces(st, 1, { ok: true, places: [place('a.js', 1)] });
  assert.match(S.stagesOf(S.current(st), 'local')[0].text, /found 1 place\b/);
  st = S.begin(S.create(), { kind: 'question', label: 'q', request: {} });
  st = S.setPlaces(st, 1, { ok: true, places: [] });
  assert.match(S.stagesOf(S.current(st), 'local')[0].text, /found no places/);
});

test('an answer finishes the entry; its places are the answer\'s own', () => {
  let st = S.begin(S.create(), { kind: 'question', label: 'q', request: {} });
  st = S.finish(st, 1, { ok: true, text: 'It is here.', places: [place('a.js', 1)], model: 'local' });
  assert.strictEqual(S.viewOf(st, named), 'answer');
  assert.strictEqual(S.current(st).reply.text, 'It is here.');
  assert.strictEqual(S.current(st).places.length, 1);
});

test('a failure keeps the places the search found (they come back as hits) and is a note, never an empty answer', () => {
  let st = S.begin(S.create(), { kind: 'question', label: 'q', request: {} });
  st = S.finish(st, 1, { ok: false, reason: 'ollama-down', places: [place('a.js', 1)] });
  assert.strictEqual(S.viewOf(st, named), 'note');
  assert.strictEqual(S.current(st).places.length, 1);
});

test('a stage or places that change nothing return the very same state (so a late timer repaints nothing)', () => {
  let st = S.begin(S.create(), { kind: 'question', label: 'q', request: {} });
  st = S.finish(st, 1, { ok: true, text: 'x', places: [] });
  assert.strictEqual(S.setStage(st, 1, 'writing'), st, 'a finished entry has no stage to move');
  assert.strictEqual(S.setPlaces(st, 1, { ok: true, places: [place('a.js', 1)] }), st);
  const waiting = S.begin(S.create(), { kind: 'question', label: 'q', request: {} });
  assert.strictEqual(S.setStage(waiting, 1, 'nonsense'), waiting);
  assert.notStrictEqual(S.setStage(waiting, 1, 'writing'), waiting);
});

test('a reply for an entry that no longer exists is ignored', () => {
  const st = S.begin(S.create(), { kind: 'question', label: 'q', request: {} });
  assert.strictEqual(S.finish(st, 99, { ok: true, text: 'x' }), st);
  assert.strictEqual(S.setPlaces(st, 99, { ok: true, places: [] }), st);
  assert.strictEqual(S.setStage(st, 99, 'writing'), st);
});

test('the drill-down: one step at a time, the breadcrumb is the chain of parents, any step is clickable', () => {
  let st = S.begin(S.create(), { kind: 'explain', label: 'This code', request: {} });
  st = S.finish(st, 1, { ok: true, text: 'a', places: [] });
  st = S.begin(st, { kind: 'explain', label: 'HTTP request', request: {}, parent: 1 });
  st = S.finish(st, 2, { ok: true, text: 'b', places: [] });
  st = S.begin(st, { kind: 'explain', label: 'Ollama', request: {}, parent: 2 });
  st = S.finish(st, 3, { ok: true, text: 'c', places: [] });
  assert.deepStrictEqual(S.trail(st).map(t => t.label), ['This code', 'HTTP request', 'Ollama']);
  st = S.select(st, 1);
  assert.strictEqual(S.current(st).label, 'This code');
  assert.deepStrictEqual(S.trail(st).map(t => t.label), ['This code']);
  st = S.begin(st, { kind: 'explain', label: 'Other', request: {}, parent: 1 });
  assert.deepStrictEqual(S.trail(st).map(t => t.label), ['This code', 'Other'], 'a new step from an earlier one is a sibling, not a continuation');
  assert.strictEqual(S.history(st).length, 4, 'nothing asked is forgotten');
});

test('select ignores an unknown id; a parent that does not exist starts a new trail', () => {
  let st = S.begin(S.create(), { kind: 'question', label: 'q', request: {} });
  assert.strictEqual(S.select(st, 42), st);
  st = S.begin(st, { kind: 'explain', label: 'x', request: {}, parent: 77 });
  assert.deepStrictEqual(S.trail(st).map(t => t.label), ['x']);
});

test('history is this session only and newest first, capped', () => {
  let st = S.create();
  for (let i = 0; i < S.HISTORY_MAX + 5; i++) st = S.begin(st, { kind: 'question', label: `q${i}`, request: {} });
  const h = S.history(st);
  assert.strictEqual(h.length, S.HISTORY_MAX);
  assert.strictEqual(h[0].label, `q${S.HISTORY_MAX + 4}`);
});

test('a step whose parent was capped out of the history still has a trail (it stops where the record does)', () => {
  let st = S.begin(S.create(), { kind: 'question', label: 'root', request: {} });
  for (let i = 0; i < S.HISTORY_MAX; i++) st = S.begin(st, { kind: 'question', label: 'f' + i, request: {} });
  st = S.begin(st, { kind: 'explain', label: 'child', request: {}, parent: 1 });
  assert.strictEqual(S.history(st).some(e => e.id === 1), false);
  assert.deepStrictEqual(S.trail(st).map(t => t.label), ['child']);
});

test('notices say what is wrong in plain words and offer the way out', () => {
  const n = (reply, extra) => S.noticeOf(reply, { name: 'Professor Byte', kind: 'explain', modelId: 'local', modelName: 'qwen3.5:4b', hasPlaces: true, ...extra });
  const down = n({ ok: false, reason: 'ollama-down' });
  assert.strictEqual(down.text, "Ollama isn't running, so Professor Byte can't explain this yet. The places below come from the search alone.");
  assert.deepStrictEqual(down.actions.map(a => a.id), ['start-ollama', 'ask-claude']);
  const ask = n({ ok: false, reason: 'ollama-down' }, { kind: 'question' });
  assert.match(ask.text, /can't answer this yet/);
  const missing = n({ ok: false, reason: 'model-missing', model: 'qwen3.5:4b' });
  assert.match(missing.text, /qwen3\.5:4b/);
  assert.match(missing.text, /isn't installed/);
  assert.deepStrictEqual(missing.actions.map(a => a.id), ['ask-claude']);
  assert.match(n({ ok: false, reason: 'timeout' }).text, /took too long/);
  assert.match(n({ ok: false, reason: 'no-matches' }).text, /nothing in this repo matched/i);
  assert.match(n({ ok: false, reason: 'index-failed', error: 'git missing' }).text, /git missing/);
  assert.match(n({ ok: false, reason: 'explainer-off' }).text, /hasn't passed the quality check/);
  assert.match(n({ ok: false, reason: 'claude-missing' }).text, /isn't installed/);
  assert.match(n({ ok: false, reason: 'not-signed-in' }).text, /sign in/i);
  assert.match(n({ ok: false, reason: 'claude-failed', detail: 'Overloaded' }).text, /Overloaded/);
  assert.match(n({ ok: false, error: 'The session did not answer in time.' }).text, /did not answer in time/);
  assert.match(n({ ok: false, reason: 'something-new' }).text, /something-new/, 'an unknown reason is still said, never blank');
});

test('PR #169 Dexter N1: "no matches" over a partial index is about the files read so far, never "nothing in this repo"', () => {
  const n = S.noticeOf({ ok: false, reason: 'no-matches', building: { files: 40, done: 38, total: 2000 } }, { name: 'Ada', kind: 'question' });
  assert.strictEqual(n.text, 'Nothing matched in the 40 files read so far (of 2000); the rest are still being read. Ask again in a moment.');
  assert.doesNotMatch(n.text, /in this repo/);
  assert.match(S.noticeOf({ ok: false, reason: 'no-matches', building: { files: 1, total: 9 } }, {}).text, /in the 1 file read so far/);
  assert.match(S.noticeOf({ ok: false, reason: 'no-matches', building: {} }, {}).text, /Nothing matched in the files read so far; the rest/);
  assert.match(S.noticeOf({ ok: false, reason: 'no-matches' }, {}).text, /Nothing in this repo matched that/, 'a finished index: the plain sentence');
});

test('PR #169 Dexter N4: with nothing read yet it is starting up, and does not say questions work meanwhile', () => {
  for (const progress of [{ done: 0, total: 120 }, {}, undefined]) {
    const l = S.indexLine({ state: 'building', progress });
    assert.match(l.text, /starting to read this repo for the first time; ask again in a moment/);
    assert.doesNotMatch(l.text, /Questions work meanwhile/);
    assert.strictEqual(l.busy, true);
  }
  assert.match(S.indexLine({ state: 'building', progress: { done: 3, total: 120 } }).text, /3 of 120 files\. Questions work meanwhile/);
});

test('Ollama-down is a local-model problem: for a Claude model it is not offered Start Ollama', () => {
  const a = S.noticeOf({ ok: false, reason: 'claude-failed', detail: 'x' }, { name: 'Ada', kind: 'explain', modelId: 'haiku', modelName: 'Haiku' });
  assert.ok(!a.actions.some(x => x.id === 'start-ollama'));
});

test('the first index: a progress line and the honest note that keywords answer meanwhile', () => {
  const p = S.indexLine({ state: 'building', files: 0, progress: { done: 59, total: 318 } });
  assert.match(p.text, /59 of 318 files/);
  assert.strictEqual(p.busy, true);
  assert.strictEqual(S.indexLine({ state: 'ready', files: 318, chunks: 3540, keywordOnly: false }).busy, false);
  assert.match(S.indexLine({ state: 'ready', files: 318, chunks: 3540, keywordOnly: true }).text, /keywords only/i);
  assert.match(S.indexLine({ state: 'none' }).text, /not read yet/i);
  assert.match(S.indexLine({ state: 'failed', error: 'no git' }).text, /no git/);
  assert.match(S.indexLine(null).text, /checking/i);
});

test('the status line names the model and the index, and says when the explainer is off', () => {
  const line = S.statusLine({ index: { state: 'ready', files: 318, chunks: 3540 }, models: [{ id: 'local', model: 'qwen3.5:4b', explainer: false }], ollama: { ok: true } }, 'local');
  assert.match(line, /qwen3\.5:4b/);
  assert.match(line, /318 files/);
});

test('canExplain: only a model with a passed record, and the host\'s say-so wins over the page\'s', () => {
  const host = { models: [{ id: 'local', explainer: false }, { id: 'haiku', explainer: true }] };
  assert.strictEqual(S.canExplain(host, 'local'), false);
  assert.strictEqual(S.canExplain(host, 'haiku'), true);
  assert.strictEqual(S.canExplain(host, 'sonnet'), false);
  assert.strictEqual(S.canExplain(null, 'haiku'), false);
  assert.strictEqual(S.canExplain({ models: 'x' }, 'haiku'), false);
});

test('examples: three real example questions from the host, or the generic ones, never more than three', () => {
  assert.deepStrictEqual(S.examplesOf({ examples: ['a', 'b', 'c', 'd'] }), ['a', 'b', 'c']);
  assert.strictEqual(S.examplesOf(null).length, 3);
  assert.strictEqual(S.examplesOf({ examples: [] }).length, 3);
  assert.deepStrictEqual(S.examplesOf({ examples: ['ok', 5, null, '  '] }), ['ok']);
});

// --- kill tests for the release-176 survivors (BACKLOG #94, M8) --------------------------------------------------------

const NONE = [];
const A = S.ACT;
const note = (reply, ctx) => S.noticeOf(reply, ctx);

test('M8: every reason has its exact words and its way out', () => {
  const claudeWay = [A.askClaude];
  const cases = [
    [{ reason: 'ollama-down' }, {}, "Ollama isn't running, so The explainer can't answer this yet.", [A.startOllama, A.askClaude]],
    [{ reason: 'ollama-down' }, { name: 'Prof', kind: 'explain', modelId: 'haiku', hasPlaces: true }, "Ollama isn't running, so Prof can't explain this yet. The places below come from the search alone.", [A.startOllama]],
    [{ reason: 'model-missing', model: 'qwen:x' }, { modelName: 'ignored' }, "The explainer's model (qwen:x) isn't installed in Ollama, so it can't answer this yet.", claudeWay],
    [{ reason: 'model-missing' }, { modelName: 'qwen3.5:4b' }, "The explainer's model (qwen3.5:4b) isn't installed in Ollama, so it can't answer this yet.", claudeWay],
    [{ reason: 'model-missing' }, {}, "The explainer's model (the local model) isn't installed in Ollama, so it can't answer this yet.", claudeWay],
    [{ reason: 'timeout' }, { modelId: 'local' }, 'The explainer took too long to answer this.', claudeWay],
    [{ reason: 'timeout' }, { modelId: 'sonnet', kind: 'explain', hasPlaces: true }, 'The explainer took too long to explain this. The places below come from the search alone.', NONE],
    [{ reason: 'empty-question' }, {}, 'Type a question first.', NONE],
    [{ reason: 'no-matches' }, {}, 'Nothing in this repo matched that. Try other words.', NONE],
    [{ reason: 'index-failed', error: 'disk full' }, {}, "Couldn't read this repo: disk full.", NONE],
    [{ reason: 'index-failed' }, {}, "Couldn't read this repo: unknown reason.", NONE],
    [{ reason: 'index-failed', error: '' }, {}, "Couldn't read this repo: unknown reason.", NONE],
    [{ reason: 'index-failed', error: 5 }, {}, "Couldn't read this repo: unknown reason.", NONE],
    [{ reason: 'explainer-off' }, { modelName: 'Haiku' }, "The explainer can't explain code yet on Haiku: it hasn't passed the quality check. Ask a question instead, or pick another model in ⚙.", NONE],
    [{ reason: 'explainer-off' }, {}, "The explainer can't explain code yet on this model: it hasn't passed the quality check. Ask a question instead, or pick another model in ⚙.", NONE],
    [{ reason: 'claude-missing' }, { modelName: 'Haiku' }, "Claude isn't installed on this machine, so Haiku can't answer.", NONE],
    [{ reason: 'claude-missing' }, {}, "Claude isn't installed on this machine, so Claude can't answer.", NONE],
    [{ reason: 'not-signed-in' }, {}, "Claude isn't signed in. Open a terminal, run claude, sign in, then ask again.", NONE],
    [{ reason: 'claude-failed', detail: 'rate limited' }, {}, "Claude didn't answer: rate limited.", NONE],
    [{ reason: 'claude-failed' }, {}, "Claude didn't answer: it stopped without a reason.", NONE],
    [{ reason: 'claude-failed', detail: '' }, {}, "Claude didn't answer: it stopped without a reason.", NONE],
    [{ reason: 'bad-selection', detail: 'binary' }, {}, "Couldn't read the selected code: binary.", NONE],
    [{ reason: 'bad-selection' }, {}, "Couldn't read the selected code.", NONE],
    [{ reason: 'bad-selection', detail: '' }, {}, "Couldn't read the selected code.", NONE],
    [{ reason: 'bad-reply' }, {}, "The explainer gave an answer that couldn't be used. Ask again.", claudeWay],
    [{ reason: 'http' }, { name: 'Prof', hasPlaces: true, modelId: 'local' }, "Prof gave an answer that couldn't be used. Ask again. The places below come from the search alone.", claudeWay],
    [{ reason: 'http' }, { modelId: 'haiku' }, "The explainer gave an answer that couldn't be used. Ask again.", NONE],
    [{ reason: 'who-knows', error: 'a sentence' }, {}, 'a sentence', NONE],
    [{ reason: 'who-knows', error: '' }, {}, 'Something went wrong (who-knows).', NONE],
    [{ reason: 'who-knows' }, { hasPlaces: true }, 'Something went wrong (who-knows). The places below come from the search alone.', NONE],
    [{}, {}, 'Something went wrong (no reason given).', NONE],
    [{ reason: '' }, {}, 'Something went wrong (no reason given).', NONE],
    [null, undefined, 'Something went wrong (no reason given).', NONE],
    ['x', {}, 'Something went wrong (no reason given).', NONE],
  ];
  for (const [reply, ctx, text, actions] of cases) assert.deepStrictEqual(note(reply, ctx), { text, actions }, JSON.stringify([reply, ctx]));
});

test('M8: the "Ask Claude instead" way out is offered for the local model (or none named) only, and "name" must be a non-empty string', () => {
  assert.deepStrictEqual(note({ reason: 'timeout' }, { modelId: undefined }).actions, [A.askClaude]);
  assert.deepStrictEqual(note({ reason: 'timeout' }, { modelId: 'local' }).actions, [A.askClaude]);
  assert.deepStrictEqual(note({ reason: 'timeout' }, { modelId: 'haiku' }).actions, []);
  assert.deepStrictEqual(note({ reason: 'timeout' }, { modelId: '' }).actions, [], 'an empty id is not local');
  assert.strictEqual(note({ reason: 'timeout' }, { name: '' }).text, 'The explainer took too long to answer this.');
  assert.strictEqual(note({ reason: 'timeout' }, { name: 5 }).text, 'The explainer took too long to answer this.');
});

test('M8: no matches while the first index is building speaks of the files read so far', () => {
  const t = (building) => note({ reason: 'no-matches', building }, {}).text;
  const tail = '; the rest are still being read. Ask again in a moment.';
  assert.strictEqual(t({ files: 12, total: 40 }), `Nothing matched in the 12 files read so far (of 40)${tail}`);
  assert.strictEqual(t({ files: 1, total: 40 }), `Nothing matched in the 1 file read so far (of 40)${tail}`);
  assert.strictEqual(t({ done: 0, total: 0 }), `Nothing matched in the 0 files read so far${tail}`);
  assert.strictEqual(t({ files: 3 }), `Nothing matched in the 3 files read so far${tail}`);
  assert.strictEqual(t({ done: 7, total: 9 }), `Nothing matched in the 7 files read so far (of 9)${tail}`);
  assert.strictEqual(t({ files: -1, done: 4 }), `Nothing matched in the 4 files read so far${tail}`);
  assert.strictEqual(t({}), `Nothing matched in the files read so far${tail}`);
  assert.strictEqual(t({ files: 5, total: 0 }), `Nothing matched in the 5 files read so far${tail}`);
  assert.strictEqual(t({ files: 5, total: -3 }), `Nothing matched in the 5 files read so far${tail}`);
  assert.strictEqual(t({ files: 5, total: 'x' }), `Nothing matched in the 5 files read so far${tail}`);
  assert.strictEqual(t([]), 'Nothing in this repo matched that. Try other words.', 'a list is not a progress report');
  assert.strictEqual(t(null), 'Nothing in this repo matched that. Try other words.');
});

test('M8: indexLine: every state in its own words', () => {
  const L = S.indexLine;
  assert.deepStrictEqual(L(null), { text: 'checking this repo…', busy: false });
  assert.deepStrictEqual(L('x'), { text: 'checking this repo…', busy: false });
  assert.deepStrictEqual(L([]), { text: 'checking this repo…', busy: false });
  assert.deepStrictEqual(L({ state: 'partial', running: false, files: 12 }), { text: 'the saved index is incomplete (12 files read) and nothing is building it; opening the panel again resumes it', busy: false });
  assert.deepStrictEqual(L({ state: 'partial', files: 0 }), { text: 'the saved index is incomplete (0 files read) and nothing is building it; opening the panel again resumes it', busy: false });
  assert.deepStrictEqual(L({ state: 'partial' }), { text: 'the saved index is incomplete (some files read) and nothing is building it; opening the panel again resumes it', busy: false });
  assert.deepStrictEqual(L({ state: 'partial', running: 'yes', progress: { done: 3, total: 9 } }), { text: 'the saved index is incomplete (some files read) and nothing is building it; opening the panel again resumes it', busy: false }, 'only a real true is running');
  assert.deepStrictEqual(L({ state: 'partial', running: true, progress: { done: 3, total: 9 } }), { text: 'reading this repo for the first time: 3 of 9 files. Questions work meanwhile, from the files read so far.', busy: true });
  assert.deepStrictEqual(L({ state: 'building', progress: { done: 3, total: 9 } }), { text: 'reading this repo for the first time: 3 of 9 files. Questions work meanwhile, from the files read so far.', busy: true });
  assert.deepStrictEqual(L({ state: 'building', progress: { done: 3, total: 0 } }), { text: 'reading this repo for the first time: 3 files. Questions work meanwhile, from the files read so far.', busy: true });
  assert.deepStrictEqual(L({ state: 'building', progress: { done: 3 } }), { text: 'reading this repo for the first time: 3 files. Questions work meanwhile, from the files read so far.', busy: true });
  assert.deepStrictEqual(L({ state: 'building', progress: { done: 3, total: 'x' } }), { text: 'reading this repo for the first time: 3 files. Questions work meanwhile, from the files read so far.', busy: true });
  for (const progress of [{ done: 0, total: 9 }, {}, null, 'x', { done: 'x' }, { done: -1 }, undefined]) {
    assert.deepStrictEqual(L({ state: 'building', progress }), { text: 'starting to read this repo for the first time; ask again in a moment', busy: true }, JSON.stringify(progress));
  }
  assert.deepStrictEqual(L({ state: 'failed', error: 'boom' }), { text: "couldn't read this repo: boom", busy: false });
  assert.deepStrictEqual(L({ state: 'failed' }), { text: "couldn't read this repo: unknown reason", busy: false });
  assert.deepStrictEqual(L({ state: 'failed', error: '' }), { text: "couldn't read this repo: unknown reason", busy: false });
  assert.deepStrictEqual(L({ state: 'none' }), { text: 'this repo is not read yet; opening the panel starts it', busy: false });
  assert.deepStrictEqual(L({ state: 'ready', files: 40 }), { text: '40 files read', busy: false });
  assert.deepStrictEqual(L({ state: 'ready', files: 0 }), { text: '0 files read', busy: false });
  assert.deepStrictEqual(L({ state: 'ready' }), { text: 'files read', busy: false });
  assert.deepStrictEqual(L({ state: 'ready', files: 40, keywordOnly: true }), { text: '40 files read, keywords only (no embedding model)', busy: false });
  assert.deepStrictEqual(L({ state: 'ready', files: 40, keywordOnly: 'yes' }), { text: '40 files read', busy: false });
});

test('M8: statusLine names the model, the index and whether explaining is off', () => {
  const models = [{ id: 'local', model: 'qwen3.5:4b', explainer: true }, { id: 'haiku', model: 'Haiku', explainer: false }, { id: 'sonnet', explainer: true }, null, 'x'];
  const host = { index: { state: 'ready', files: 5 }, models };
  assert.strictEqual(S.statusLine(host), 'qwen3.5:4b · 5 files read');
  assert.strictEqual(S.statusLine(host, 'local'), 'qwen3.5:4b · 5 files read');
  assert.strictEqual(S.statusLine(host, ''), 'qwen3.5:4b · 5 files read');
  assert.strictEqual(S.statusLine(host, 'haiku'), 'Haiku · 5 files read · explaining code is off on this model');
  assert.strictEqual(S.statusLine(host, 'sonnet'), 'the local model · 5 files read', 'a model with no name');
  assert.strictEqual(S.statusLine(host, 'nope'), 'the local model · 5 files read');
  assert.strictEqual(S.statusLine({ models: [{ id: 'local', model: 'm', explainer: 0 }] }), 'm · checking this repo…', 'only a real false is "off"');
  assert.strictEqual(S.statusLine(null), 'the local model · checking this repo…');
  assert.strictEqual(S.statusLine({ models: 'x' }, 'haiku'), 'the local model · checking this repo…');
});

test('M8: canExplain is true only for a listed model whose explainer is exactly true', () => {
  const host = { models: [{ id: 'local', explainer: true }, { id: 'haiku', explainer: false }, { id: 'sonnet' }, { id: 'x', explainer: 1 }, null] };
  assert.strictEqual(S.canExplain(host, 'local'), true);
  for (const id of ['haiku', 'sonnet', 'x', 'nope', undefined]) assert.strictEqual(S.canExplain(host, id), false, String(id));
  assert.strictEqual(S.canExplain(null, 'local'), false);
  assert.strictEqual(S.canExplain({ models: 'x' }, 'local'), false);
});

test('M8: examplesOf: up to three real examples from the host, else the three generic ones', () => {
  const generic = ['Where is the login handled?', 'What does the main entry point do?', 'Where are errors logged?'];
  assert.deepStrictEqual(S.examplesOf({ examples: ['a?', 'b?', 'c?', 'd?'] }), ['a?', 'b?', 'c?']);
  assert.deepStrictEqual(S.examplesOf({ examples: ['a?', '', '   ', 5, null, 'b?'] }), ['a?', 'b?']);
  assert.deepStrictEqual(S.examplesOf({ examples: [] }), generic);
  assert.deepStrictEqual(S.examplesOf({ examples: ['', ' '] }), generic);
  for (const host of [null, {}, { examples: 'x' }, 'x', []]) assert.deepStrictEqual(S.examplesOf(host), generic);
  const a = S.examplesOf(null); a.push('mutated');
  assert.deepStrictEqual(S.examplesOf(null), generic, 'the generic list cannot be changed from outside');
});

test('M8: stagesOf: the three steps, with the Claude name when it asks Claude, and the right one active', () => {
  const stages = (e, id) => S.stagesOf(e, id).map(x => `${x.id}:${x.state}:${x.text}`);
  assert.deepStrictEqual(stages({ stage: 'searching' }, 'local'), ['found:active:searching the repo', 'loading:todo:loading the model (~4 s)', 'writing:todo:writing the answer']);
  assert.deepStrictEqual(stages({ stage: 'loading', places: [1, 2] }, 'haiku'), ['found:done:found 2 places', 'loading:active:asking Haiku', 'writing:todo:writing the answer']);
  assert.deepStrictEqual(stages({ stage: 'writing', kind: 'explain', places: [1] }, 'sonnet'), ['found:done:found 1 place', 'loading:done:asking Sonnet', 'writing:active:writing the explanation']);
  assert.deepStrictEqual(stages({ stage: 'loading', places: [] }, 'local'), ['found:done:found no places', 'loading:active:loading the model (~4 s)', 'writing:todo:writing the answer']);
  assert.deepStrictEqual(S.stagesOf({ stage: 'whatever' }, 'local').map(x => x.state), ['active', 'todo', 'todo'], 'an unknown stage reads as the first');
  assert.deepStrictEqual(stages(null, 'local')[0], 'found:active:found no places', 'no entry at all: nothing was searched for, nothing found');
});
