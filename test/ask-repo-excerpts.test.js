'use strict';
/** host/ask-repo.js excerptsFor() (BACKLOG #33): the retrieval half of the explainer and of the panel's early "where to look" cards. */
const test = require('node:test');
const assert = require('node:assert');
const { createAskRepo } = require('../host/ask-repo');

const WT = 'C:\\proj\\wt';
const chunk = (start, end, text, vec) => ({ start, end, ownStart: start, text, vec: vec ? Float32Array.from(vec) : null });
const DATA = {
  embedModel: 'e', builtAt: 1,
  files: [
    { rel: 'host/file-lock.js', size: 1, mtimeMs: 1, lines: 200, chunks: [chunk(1, 40, 'function withFileLock(path) {\n  acquire lock\n}', [1, 0]), chunk(41, 80, 'function releaseFileLock(path) {\n  release lock\n}', [0.9, 0.1])] },
    { rel: 'app/toolbar.js', size: 1, mtimeMs: 1, lines: 50, chunks: [chunk(1, 30, 'renders the toolbar buttons', [0, 1])] },
  ],
};

function build({ data = DATA, check = { ok: true, answer: true, embed: true }, embed, running = false, progressImpl, generate, snapshot } = {}) {
  const calls = { embed: [], generate: [] };
  const index = {
    load: async () => data, get: () => data, isRunning: () => running,
    progress: () => (progressImpl ? progressImpl() : { state: data ? 'ready' : 'building', done: 1, total: 4 }),
    refresh: async () => ({ ok: true }),
    ...(snapshot ? { snapshot: () => snapshot } : {}),
  };
  const ollama = {
    answerModel: 'm', embedModel: 'e', check: async () => check,
    embed: embed || (async (t) => { calls.embed.push(t); return { ok: true, vectors: t.map(() => [1, 0]) }; }),
    generate: generate || (async (a) => { calls.generate.push(a); return { ok: true, text: 'x' }; }),
  };
  return { repo: createAskRepo({ index, ollama, k: 8, staleWaitMs: 30 }), calls };
}

test('excerptsFor: numbered excerpts, the ranges they hold, the files\' line counts, and the model status', async () => {
  const { repo } = build();
  const r = await repo.excerptsFor(WT, 'withFileLock acquire lock');
  assert.strictEqual(r.ok, true);
  assert.match(r.body, /### host\/file-lock\.js:1-3\n1: function withFileLock/);
  assert.ok(r.sent.some(s => s.file === 'host/file-lock.js' && s.start === 1));
  assert.strictEqual(r.lineCounts.get('host/file-lock.js'), 200);
  assert.deepStrictEqual(r.ollamaStatus, { ok: true, answer: true, embed: true });
  assert.strictEqual(r.keywordOnly, false);
});

test('excerptsFor: the selection\'s own lines are left out, so the excerpts say where ELSE it shows up', async () => {
  const { repo } = build();
  const r = await repo.excerptsFor(WT, 'lock', { exclude: { file: 'host/file-lock.js', start: 1, end: 40 } });
  assert.ok(!r.sent.some(s => s.file === 'host/file-lock.js' && s.start === 1), 'the chunk holding the selection is gone');
  assert.ok(r.sent.some(s => s.file === 'host/file-lock.js' && s.start === 41), 'a neighbouring chunk stays');
});

test('excerptsFor: a chunk that only touches the selection by one line is excluded, one beside it is not', async () => {
  const { repo } = build();
  const touch = await repo.excerptsFor(WT, 'lock', { exclude: { file: 'host/file-lock.js', start: 40, end: 41 } });
  assert.ok(!touch.sent.some(s => s.file === 'host/file-lock.js'), 'both chunks overlap lines 40-41');
  const beside = await repo.excerptsFor(WT, 'lock', { exclude: { file: 'host/file-lock.js', start: 81, end: 90 } });
  assert.strictEqual(beside.sent.filter(s => s.file === 'host/file-lock.js').length, 2);
});

test('excerptsFor: k limits how many chunks are offered', async () => {
  const { repo } = build();
  const r = await repo.excerptsFor(WT, 'lock', { k: 1 });
  assert.strictEqual(r.sent.length, 1);
});

test('excerptsFor: nothing matching is ok with an empty body (an explanation can still be written from the selection)', async () => {
  const { repo } = build({ data: { embedModel: 'e', builtAt: 1, files: [] } });
  const r = await repo.excerptsFor(WT, 'anything');
  assert.deepStrictEqual([r.ok, r.body, r.sent], [true, '', []]);
});

test('excerptsFor: an empty query is refused; the index still building is the same failure ask() gives, with its progress', async () => {
  assert.strictEqual((await build().repo.excerptsFor(WT, '  ')).reason, 'empty-question');
  const building = build({ data: null, running: true, progressImpl: () => ({ state: 'building', done: 5, total: 20 }) });
  const r = await building.repo.excerptsFor(WT, 'q');
  assert.deepStrictEqual([r.ok, r.reason, r.progress], [false, 'index-building', { state: 'building', done: 5, total: 20 }]);
});

test('excerptsFor: Ollama down is not a failure of the search: keywords answer and the status says why', async () => {
  const { repo, calls } = build({ check: { ok: false, reason: 'ollama-down' } });
  const r = await repo.excerptsFor(WT, 'withFileLock');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.keywordOnly, true);
  assert.deepStrictEqual(r.ollamaStatus, { ok: false, reason: 'ollama-down' });
  assert.strictEqual(calls.embed.length, 0);
});

test('excerptsFor never asks a model to write anything', async () => {
  const { repo, calls } = build();
  await repo.excerptsFor(WT, 'lock');
  assert.strictEqual(calls.generate.length, 0);
});

const SNAP = { embedModel: 'e', builtAt: 1, files: [DATA.files[0]] };
const building = (over = {}) => build({ data: null, running: true, progressImpl: () => ({ state: 'building', done: 1, total: 9, partial: false }), ...over });

test('PR #169 Dexter 3 (Round 7): while the first index is being built, a question is answered from the files indexed so far, and says so', async () => {
  const { repo } = building({ snapshot: SNAP });
  const r = await repo.ask(WT, 'where is withFileLock defined?');
  assert.strictEqual(r.ok, true, 'not a refusal');
  assert.deepStrictEqual(r.building, { state: 'building', done: 1, total: 9, partial: false, files: 1 }, 'how many files this answer could see');
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.sources[0].file, 'host/file-lock.js');
});

test('the same for an explanation\'s excerpts and the places preview', async () => {
  const { repo } = building({ snapshot: SNAP });
  const r = await repo.excerptsFor(WT, 'withFileLock');
  assert.strictEqual(r.ok, true);
  assert.ok(r.building);
  assert.ok(r.sent.some(s => s.file === 'host/file-lock.js'));
});

test('PR #169 Dexter N1: nothing found in a partial index is still a partial-index answer: it carries how much was read, and which index it read', async () => {
  const { repo } = building({ snapshot: SNAP, check: { ok: true, answer: true, embed: false } });   // keywords only
  const r = await repo.ask(WT, 'zzzqqq nonexistentterm');
  assert.deepStrictEqual([r.ok, r.reason], [false, 'no-matches']);
  assert.deepStrictEqual([r.building.files, r.building.total], [1, 9]);
  assert.strictEqual(r._data, SNAP, 'the index THIS answer was computed from (the card previews read it)');
});

test('with nothing indexed yet (no file so far) it is still "building", with its progress', async () => {
  for (const snapshot of [undefined, { embedModel: 'e', builtAt: 1, files: [] }, null]) {
    const { repo } = building({ snapshot });
    const r = await repo.ask(WT, 'anything');
    assert.deepStrictEqual([r.ok, r.reason, r.progress.done], [false, 'index-building', 1]);
  }
});

test('a finished index is not marked as building', async () => {
  const { repo } = build({ snapshot: SNAP });
  const r = await repo.ask(WT, 'where is withFileLock defined?');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.building, undefined);
});

test('ask: a model failure carries the answerer\'s own words (a Claude run says why), not just a reason', async () => {
  const { repo } = build({ generate: async () => ({ ok: false, reason: 'claude-failed', detail: 'Overloaded' }) });
  const r = await repo.ask(WT, 'withFileLock');
  assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, 'claude-failed', 'Overloaded']);
  assert.ok(Array.isArray(r.hits) && r.hits.length > 0, 'the places the search found still come back');
});

// ---- one retrieval per ask (PR #169 El Gordo 1, Miguel Y10), against a REAL index over a fake file world ----
const { createIndex } = require('../host/ask-index');
const { tmpDir } = require('./tmp-dir');

function realRepo() {
  const files = new Map([['lib/lock.js', { text: 'function releaseLock(path) {\n  // the lock is released here\n}\n', mtimeMs: 1 }], ['lib/bar.js', { text: 'function toolbar() {}\n', mtimeMs: 1 }]]);
  const calls = { refresh: 0, embed: 0, generate: 0 };
  const index = createIndex({
    dir: tmpDir(), embedModel: 'e',
    listFiles: async () => [...files.keys()].sort(),
    statFile: async (_w, rel) => { const f = files.get(rel); return f ? { size: f.text.length, mtimeMs: f.mtimeMs } : null; },
    readFile: async (_w, rel) => files.get(rel).text,
    embed: async (texts) => { calls.embed += 1; return { ok: true, vectors: texts.map(() => [1, 0]) }; },
  });
  const realRefresh = index.refresh;
  index.refresh = (wt) => { calls.refresh += 1; return realRefresh(wt); };
  const ollama = {
    answerModel: 'm', embedModel: 'e', check: async () => ({ ok: true, answer: true, embed: true }),
    embed: async (t) => { calls.embed += 1; return { ok: true, vectors: t.map(() => [1, 0]) }; },
    generate: async () => { calls.generate += 1; return { ok: true, text: 'It is in lib/lock.js:2.' }; },
  };
  return { repo: createAskRepo({ index, ollama, k: 8 }), calls, index };
}

test('a fresh index gives NO "index may be a little behind" note: places then the answer on the same hits is one retrieval, one freshness check', async () => {
  const { repo, calls, index } = realRepo();
  await index.refresh(WT);
  const refreshesBefore = calls.refresh;
  const embedsBefore = calls.embed;
  const ex = await repo.excerptsFor(WT, 'where is the lock released?');
  assert.strictEqual(ex.ok, true);
  assert.strictEqual(ex.stale, false);
  const r = await repo.ask(WT, 'where is the lock released?', { prepared: ex.prepared });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stale, false, 'no stale note on a fresh index');
  assert.strictEqual(calls.refresh - refreshesBefore, 1, 'one freshness check for the whole ask');
  assert.strictEqual(calls.embed - embedsBefore, 1, 'one query embedding for the whole ask');
  assert.deepStrictEqual(r.sources, ex.sent.map(s => ({ file: s.file, line: s.start, endLine: s.end })), 'the answer used the places\' own hits');
});

test('prepared retrieval is used as given: ask() does not search again, and a prepared miss is still no-matches', async () => {
  const { repo, calls } = realRepo();
  const none = { data: { files: [] }, stale: false, status: { ok: true }, top: [], keywordOnly: false };
  const r = await repo.ask(WT, 'whatever', { prepared: none });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'no-matches']);
  assert.strictEqual(calls.refresh, 0);
  assert.strictEqual(calls.embed, 0);
});

// --- kill tests for the release-176 survivors (BACKLOG #94, M5) --------------------------------------------------------

const lineData = (rel, lines, start = 100) => ({
  embedModel: 'e', builtAt: 1,
  files: [{ rel, size: 1, mtimeMs: 1, lines: start + lines.length, chunks: [chunk(start, start + lines.length - 1, lines.join('\n'), [1, 0])] }],
});
const needle = (n) => 'needle ' + 'y'.repeat(Math.max(0, n - 'needle '.length));
const rowsOf = (body) => body.split('\n').slice(1);

test('M5: a chunk is shown line by line until the next row would pass 2000 characters, counting a newline after each', async () => {
  // rows are "100: " + text, so a text of 94 characters is a 99-character row and costs 100
  const lines99 = Array.from({ length: 22 }, (_, i) => needle(94).replace(/y$/, String(i % 10)));
  const a = await build({ data: lineData('f.js', lines99) }).repo.excerptsFor(WT, 'needle');
  assert.strictEqual(rowsOf(a.body).length, 20, 'twenty rows of 100 fill 2000 exactly, and a twenty-first does not fit');
  assert.strictEqual(a.sent[0].end, 119);
  // nineteen rows of 100, then a row of 100 characters: 1900 + 101 = 2001, one over
  const mixed = [...Array.from({ length: 19 }, () => needle(94)), needle(95), needle(94)];
  const b = await build({ data: lineData('f.js', mixed) }).repo.excerptsFor(WT, 'needle');
  assert.strictEqual(rowsOf(b.body).length, 19);
  assert.strictEqual(b.sent[0].end, 118);
  // a 99-character row after 19 of them still fits: 1900 + 100 = 2000
  const fits = [...Array.from({ length: 19 }, () => needle(94)), needle(94)];
  const c = await build({ data: lineData('f.js', fits) }).repo.excerptsFor(WT, 'needle');
  assert.strictEqual(rowsOf(c.body).length, 20);
});

test('M5: a line is cut after 300 characters and says so; 300 exactly is whole', async () => {
  const rowFor = async (text) => rowsOf((await build({ data: lineData('f.js', [text]) }).repo.excerptsFor(WT, 'needle')).body)[0];
  assert.strictEqual(await rowFor('x'.repeat(293) + ' needle'), '100: ' + 'x'.repeat(293) + ' needle', '300 characters stay whole');
  assert.strictEqual(await rowFor('x'.repeat(294) + ' needle'), '100: ' + 'x'.repeat(294) + ' needl' + ' ...[line cut]', '301 is cut to 300 and marked');
});

test('M5: the excerpts of one prompt stop before they pass 12000 characters, counting two for the gap between them', async () => {
  const mk = (n, bodyLen) => {
    const files = [];
    for (let i = 0; i < n; i++) {
      const rel = `f${String(i).padStart(2, '0')}.js`;
      // four lines: the body is the header "### rel:100-103", a newline, and four rows of "1xx: " + text joined by newlines
      const total = bodyLen - `### ${rel}:100-103`.length - 1 - 3 - 4 * 5;
      const lens = [0, 1, 2, 3].map(j => Math.floor(total / 4) + (j < total % 4 ? 1 : 0));
      const lines = lens.map(len => needle(len));
      files.push({ rel, size: 1, mtimeMs: 1, lines: 200, chunks: [chunk(100, 103, lines.join('\n'), [1, 0])] });
    }
    return { embedModel: 'e', builtAt: 1, files };
  };
  // 998 characters of body + 2 = 1000 each: twelve fit in 12000 exactly, a thirteenth does not
  const twelve = await build({ data: mk(14, 998) }).repo.excerptsFor(WT, 'needle', { k: 14 });
  assert.strictEqual(twelve.sent.length, 12);
  assert.ok(twelve.body.split('\n\n').every(p => p.length === 998), twelve.body.split('\n\n').map(p => p.length).join(','));
  // 999 + 2 = 1001: eleven fit (11011), a twelfth would be 12012
  const eleven = await build({ data: mk(14, 999) }).repo.excerptsFor(WT, 'needle', { k: 14 });
  assert.strictEqual(eleven.sent.length, 11);
  // 997 + 2 = 999: twelve fit (11988) and so does a thirteenth would be 12987: no
  const again = await build({ data: mk(14, 997) }).repo.excerptsFor(WT, 'needle', { k: 14 });
  assert.strictEqual(again.sent.length, 12);
  assert.strictEqual(again.body.split('\n\n').length, 12, 'joined by a blank line');
});

test('M5: excerptsFor: only a whole positive number asks for more or fewer chunks; the selection excluded is the one in ITS file', async () => {
  const files = [];
  for (let i = 0; i < 12; i++) files.push({ rel: `g${i}.js`, size: 1, mtimeMs: 1, lines: 50, chunks: [chunk(1, 3, 'needle ' + i, [1, 0])] });
  const data = { embedModel: 'e', builtAt: 1, files };
  const count = async (k) => (await build({ data }).repo.excerptsFor(WT, 'needle', { k })).sent.length;
  assert.strictEqual(await count(3), 3);
  assert.strictEqual(await count(undefined), 8, 'the default');
  for (const bad of [0, -1, 2.5, '3', NaN, null]) assert.strictEqual(await count(bad), 8, String(bad));
  const ex = await build({ data }).repo.excerptsFor(WT, 'needle', { exclude: { file: 'g0.js', start: 1, end: 3 } });
  assert.ok(!ex.sent.some(s => s.file === 'g0.js'));
  assert.ok(ex.sent.some(s => s.file === 'g1.js'), 'the same line numbers in another file are not the selection');
});

test('M5: a question is trimmed and cut to 500 characters before anything sees it; a non-string is no question', async () => {
  const seen = [];
  const { repo } = build({ embed: async (t) => { seen.push(t[0]); return { ok: true, vectors: [[1, 0]] }; } });
  await repo.excerptsFor(WT, '  ' + 'lock '.repeat(200) + '  ');
  assert.strictEqual(seen[0].length, 500);
  assert.strictEqual(seen[0], ('lock '.repeat(200)).slice(0, 500));
  for (const bad of [5, null, undefined, {}, ['lock'], '', '   ']) assert.deepStrictEqual(await repo.excerptsFor(WT, bad), { ok: false, reason: 'empty-question' }, String(bad));
  assert.deepStrictEqual(await repo.ask(WT, 7), { ok: false, reason: 'empty-question' });
  const seen2 = [];
  const b2 = build({ embed: async (t) => { seen2.push(t[0]); return { ok: true, vectors: [[1, 0]] }; } });
  await b2.repo.ask(WT, '  ' + 'lock '.repeat(200));
  assert.strictEqual(seen2[0].length, 500);
});

test('M5: the embedder is used when it is up, or when only the ANSWER model is missing and the embedder is not', async () => {
  const used = async (check) => { const { repo, calls } = build({ check }); const r = await repo.excerptsFor(WT, 'lock'); return [calls.embed.length, r.keywordOnly]; };
  assert.deepStrictEqual(await used({ ok: true, answer: true, embed: true }), [1, false]);
  assert.deepStrictEqual(await used({ ok: true, answer: true, embed: false }), [0, true]);
  assert.deepStrictEqual(await used({ ok: false, reason: 'model-missing', model: 'm', embed: true }), [1, false]);
  assert.deepStrictEqual(await used({ ok: false, reason: 'model-missing', model: 'm', embed: false }), [0, true]);
  assert.deepStrictEqual(await used({ ok: false, reason: 'model-missing', model: 'm' }), [0, true]);
  assert.deepStrictEqual(await used({ ok: false, reason: 'ollama-down', embed: true }), [0, true]);
  assert.deepStrictEqual(await used({ ok: true, answer: true }), [1, false], 'an embed flag that is not exactly false means up');
});

test('M5: a chunk without a vector makes the whole answer keywords-only, and status says so too', async () => {
  const mixed = { embedModel: 'e', builtAt: 1, files: [
    { rel: 'a.js', size: 1, mtimeMs: 1, lines: 9, chunks: [chunk(1, 3, 'lock one', [1, 0])] },
    { rel: 'b.js', size: 1, mtimeMs: 1, lines: 9, chunks: [chunk(1, 3, 'lock two', [1, 0]), chunk(4, 6, 'lock three', null)] },
  ] };
  const { repo } = build({ data: mixed });
  assert.strictEqual((await repo.excerptsFor(WT, 'lock')).keywordOnly, true);
  assert.strictEqual((await repo.status(WT)).keywordOnly, true);
  const full = build({ data: { ...mixed, files: [mixed.files[0]] } });
  assert.strictEqual((await full.repo.excerptsFor(WT, 'lock')).keywordOnly, false);
  assert.strictEqual((await full.repo.status(WT)).keywordOnly, false);
  const none = build({ data: { embedModel: 'e', builtAt: 1, files: [] } });
  assert.strictEqual((await none.repo.status(WT)).keywordOnly, false);
});

test('M5: status: building with nothing indexed is building; building over a saved index is partial or ready; no index at all is none, or what it says', async () => {
  const st = async (data, progressImpl) => (await build({ data, progressImpl }).repo.status(WT));
  const saved = DATA;
  assert.strictEqual((await st(null, () => ({ state: 'building', done: 1, total: 4 }))).state, 'building');
  assert.strictEqual((await st(saved, () => ({ state: 'building', partial: true }))).state, 'partial');
  assert.strictEqual((await st(saved, () => ({ state: 'building' }))).state, 'ready');
  assert.strictEqual((await st(saved, () => ({ state: 'ready' }))).state, 'ready');
  assert.strictEqual((await st(null, () => ({ state: 'ready' }))).state, 'none');
  assert.strictEqual((await st(null, () => ({ state: 'failed', error: 'boom' }))).state, 'failed');
  assert.strictEqual((await st(null, () => ({ state: 'failed', error: 'boom' }))).error, 'boom');
  const empty = await st(null, () => ({ state: 'none' }));
  assert.deepStrictEqual([empty.state, empty.files, empty.chunks, empty.builtAt, empty.keywordOnly, empty.model], ['none', 0, 0, null, false, 'm']);
  const full = await st(saved, () => ({ state: 'ready' }));
  assert.deepStrictEqual([full.files, full.chunks, full.builtAt, full.model], [2, 3, 1, 'm']);
  assert.strictEqual('error' in full, false);
});

test('M5: a build that failed is named for exactly the backoff, then tried again', async () => {
  let t = 10_000;
  let refreshes = 0;
  const failed = { state: 'failed', error: 'boom', failedAt: 10_000 };
  const index = { load: async () => null, get: () => null, isRunning: () => false, progress: () => failed, refresh: async () => { refreshes += 1; throw new Error('still boom'); } };
  const ollama = { answerModel: 'm', embedModel: 'e', check: async () => ({ ok: true, embed: true }), embed: async () => ({ ok: true, vectors: [[1, 0]] }), generate: async () => ({ ok: true, text: 'x' }) };
  const repo = createAskRepo({ index, ollama, now: () => t, retryAfterMs: 1000, buildProbeMs: 50 });
  t = 10_999;
  assert.deepStrictEqual(await repo.ask(WT, 'lock'), { ok: false, reason: 'index-failed', error: 'boom', partial: false });
  assert.strictEqual(refreshes, 0, 'inside the backoff nothing is restarted');
  t = 11_000;
  const again = await repo.ask(WT, 'lock');
  assert.strictEqual(refreshes, 1, 'at exactly the backoff it tries again');
  assert.deepStrictEqual([again.reason, again.error], ['index-failed', 'still boom']);
  t = 10_500;
  index.progress = () => ({ state: 'failed', error: 'boom', failedAt: 'x' });
  await repo.ask(WT, 'lock');
  assert.strictEqual(refreshes, 2, 'a failure with no time is not remembered');
  index.progress = () => ({ state: 'failed', failedAt: 10_000 });
  await repo.ask(WT, 'lock');
  assert.strictEqual(refreshes, 3, 'nor one with no error');
});

test('M5: a refresh that finishes before the probe hands over the NEW index; one that fails or runs late leaves the saved one, marked stale', async () => {
  const OLD = lineData('old.js', ['needle old']);
  const NEW = lineData('new.js', ['needle new']);
  let current = OLD;
  const mk = (refresh, opts = {}) => {
    const index = { load: async () => OLD, get: () => current, isRunning: () => false, progress: () => ({ state: 'ready' }), refresh };
    const ollama = { answerModel: 'm', embedModel: 'e', check: async () => ({ ok: true, embed: true }), embed: async () => ({ ok: true, vectors: [[1, 0]] }), generate: async () => ({ ok: true, text: 'x' }) };
    return createAskRepo({ index, ollama, staleWaitMs: 40, ...opts });
  };
  current = OLD;
  const done = await mk(async () => { current = NEW; return {}; }).excerptsFor(WT, 'needle');
  assert.deepStrictEqual([done.sent[0].file, done.stale], ['new.js', false]);
  current = OLD;
  const failed = await mk(async () => { throw new Error('refresh broke'); }).excerptsFor(WT, 'needle');
  assert.deepStrictEqual([failed.sent[0].file, failed.stale, failed.refreshError], ['old.js', true, 'refresh broke']);
  current = OLD;
  const late = await mk(() => new Promise(() => {})).excerptsFor(WT, 'needle');
  assert.deepStrictEqual([late.sent[0].file, late.stale], ['old.js', true]);
  assert.strictEqual('refreshError' in late, false);
  const running = await (() => {
    const index = { load: async () => OLD, get: () => OLD, isRunning: () => true, progress: () => ({ state: 'ready' }), refresh: async () => { throw new Error('must not start'); } };
    const ollama = { answerModel: 'm', embedModel: 'e', check: async () => ({ ok: true, embed: true }), embed: async () => ({ ok: true, vectors: [[1, 0]] }) };
    return createAskRepo({ index, ollama }).excerptsFor(WT, 'needle');
  })();
  assert.strictEqual(running.stale, true, 'a build in progress means the figures may move');
});

test('M5: ask: how long it took is never negative, and a failed generate names its model, status and detail', async () => {
  const marks = [5000, 5300];
  const ok = build({});
  const repo = createAskRepo({ index: { load: async () => DATA, get: () => DATA, isRunning: () => false, progress: () => ({ state: 'ready' }), refresh: async () => ({}) },
    ollama: { answerModel: 'm', embedModel: 'e', check: async () => ({ ok: true, embed: true }), embed: async () => ({ ok: true, vectors: [[1, 0]] }), generate: async () => ({ ok: true, text: 'x' }) }, now: () => marks.shift() ?? 5300, staleWaitMs: 20 });
  assert.strictEqual((await repo.ask(WT, 'lock')).ms, 300);
  const back = [5000, 4000];
  const repo2 = createAskRepo({ index: { load: async () => DATA, get: () => DATA, isRunning: () => false, progress: () => ({ state: 'ready' }), refresh: async () => ({}) },
    ollama: { answerModel: 'm', embedModel: 'e', check: async () => ({ ok: true, embed: true }), embed: async () => ({ ok: true, vectors: [[1, 0]] }), generate: async () => ({ ok: true, text: 'x' }) }, now: () => back.shift() ?? 4000, staleWaitMs: 20 });
  assert.strictEqual((await repo2.ask(WT, 'lock')).ms, 0);
  const g = build({ generate: async () => ({ ok: false, reason: 'http', status: 503, model: 'mm', detail: 'busy' }) });
  const r = await g.repo.ask(WT, 'lock');
  assert.deepStrictEqual([r.ok, r.reason, r.status, r.model, r.detail], [false, 'http', 503, 'mm', 'busy']);
  const g2 = build({ generate: async () => ({ ok: false, reason: 'timeout' }) });
  const r2 = await g2.repo.ask(WT, 'lock');
  assert.deepStrictEqual(['status' in r2, 'model' in r2, 'detail' in r2], [false, false, false]);
  assert.ok(ok);
});

test('M5: the 12000-character budget counts the two characters between excerpts on the one that would not fit', async () => {
  const body = (rel, n) => {
    const total = n - `### ${rel}:100-103`.length - 1 - 3 - 4 * 5;
    const lens = [0, 1, 2, 3].map(j => Math.floor(total / 4) + (j < total % 4 ? 1 : 0));
    return chunk(100, 103, lens.map(len => needle(len)).join('\n'), [1, 0]);
  };
  const files = Array.from({ length: 13 }, (_, i) => {
    const rel = `f${String(i).padStart(2, '0')}.js`;
    return { rel, size: 1, mtimeMs: 1, lines: 200, chunks: [body(rel, i === 11 ? 999 : 998)] };
  });
  const r = await build({ data: { embedModel: 'e', builtAt: 1, files } }).repo.excerptsFor(WT, 'needle', { k: 13 });
  assert.deepStrictEqual(r.body.split('\n\n').map(p => p.length), Array(11).fill(998));
  assert.strictEqual(r.sent.length, 11, '11 x 1000 = 11000, and a 999-character body + 2 would make 12001');
});

test('M5: an index that was still empty is read again after the build finishes in the probe window, and answers from it', async () => {
  let current = null;
  const index = { load: async () => null, get: () => current, isRunning: () => false, progress: () => ({ state: current ? 'ready' : 'building', done: 0, total: 1 }),
    refresh: async () => { current = DATA; return {}; } };
  const ollama = { answerModel: 'm', embedModel: 'e', check: async () => ({ ok: true, embed: true }), embed: async () => ({ ok: true, vectors: [[1, 0]] }), generate: async () => ({ ok: true, text: 'host/file-lock.js:2' }) };
  const r = await createAskRepo({ index, ollama, buildProbeMs: 200, staleWaitMs: 20 }).ask(WT, 'lock');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual('building' in r, false);
  const never = { ...index, refresh: () => new Promise(() => {}), get: () => null };
  const building = await createAskRepo({ index: never, ollama, buildProbeMs: 20 }).ask(WT, 'lock');
  assert.deepStrictEqual([building.ok, building.reason], [false, 'index-building']);
});

test('M5: a build that is already running is not restarted when the saved index is read', async () => {
  const index = { load: async () => DATA, get: () => DATA, isRunning: () => true, progress: () => ({ state: 'ready' }), refresh: async () => { throw new Error('must not start'); } };
  const ollama = { answerModel: 'm', embedModel: 'e', check: async () => ({ ok: true, embed: true }), embed: async () => ({ ok: true, vectors: [[1, 0]] }) };
  const r = await createAskRepo({ index, ollama }).excerptsFor(WT, 'lock');
  assert.strictEqual(r.stale, true);
  assert.strictEqual('refreshError' in r, false, 'no refresh was started, so none failed');
});

test('M5: every range of a file that was sent counts for citations, not only the last one', async () => {
  const { repo } = build({ generate: async () => ({ ok: true, text: 'The first part is host/file-lock.js:2 and the second is host/file-lock.js:42.' }) });
  const r = await repo.ask(WT, 'lock');
  assert.deepStrictEqual(r.citations.map(c => c.line).sort((a, b) => a - b), [2, 42]);
  assert.deepStrictEqual(r.dropped, []);
});
