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
