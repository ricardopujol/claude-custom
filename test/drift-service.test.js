'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDriftService, analyzeMerge, RETRY_MS } = require('../host/drift-service');
const { createDriftStore } = require('../host/drift-store');

const H = (c) => c.repeat(40);
const DOC_TEXT = 'The index refreshes before each question.\nIt lives in host/ask-index.js.\n';
const DOCS = {
  buildLog: '# Log\n\n## Now\n\nThe ask-index refreshes first.\n\n## Other\n\nx\n',
  docs: [{ rel: 'DESIGN_ASK_REPO.md', text: DOC_TEXT }, { rel: 'DESIGN_WAND.md', text: 'wand only' }],
};
const DIFF = 'diff --git a/host/ask-index.js b/host/ask-index.js\n--- a/host/ask-index.js\n+++ b/host/ask-index.js\n@@ -1 +1 @@\n-refresh();\n+// refresh moved\n';
const GOOD = JSON.stringify([{ doc: 'DESIGN_ASK_REPO.md', sentence: 'The index refreshes before each question.', why: 'The refresh moved out of the question path.' }]);

function rig({ head = H('b'), processed = H('a'), merges = [{ sha: H('c'), subject: 'Merge pull request #7' }], reply = { ok: true, text: GOOD }, check = { ok: true }, slotFree = true, docs = DOCS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-svc-'));
  const store = createDriftStore({ file: path.join(dir, 'p.json') });
  if (processed) store.setProcessed(processed);
  const calls = { generate: 0, diff: 0, check: 0, acquire: 0, release: 0, prompts: [], broadcasts: [] };
  const r = { head, merges, reply, check, slotFree, docs };
  const t = { now: 1_000_000 };
  const svc = createDriftService({
    git: {
      head: async () => r.head,
      merges: async () => r.merges,
      diff: async () => { calls.diff++; return DIFF; },
    },
    readDocs: async () => r.docs,
    ollama: {
      answerModel: 'qwen3.5:4b',
      check: async () => { calls.check++; return r.check; },
      generate: async (p) => { calls.generate++; calls.prompts.push(p); return typeof r.reply === 'function' ? r.reply() : r.reply; },
    },
    store,
    slot: { tryAcquire: () => { calls.acquire++; return r.slotFree; }, release: () => { calls.release++; }, lastError: () => '' },
    now: () => t.now,
    broadcast: (m) => calls.broadcasts.push(m),
    log: () => {},
  });
  return { svc, store, calls, r, t };
}

test('the first look only records where develop is; it analyses nothing already merged', async () => {
  const { svc, store, calls } = rig({ processed: null });
  await svc.tick();
  assert.strictEqual(store.read().processed, H('b'));
  assert.strictEqual(calls.generate, 0);
  assert.strictEqual(calls.check, 0);
});

test('develop has not moved: no model, no slot, no diff', async () => {
  const { svc, calls } = rig({ head: H('a'), processed: H('a') });
  await svc.tick();
  assert.deepStrictEqual([calls.generate, calls.acquire, calls.diff, calls.check], [0, 0, 0, 0]);
});

test('a merge: the model is asked, a verified flag becomes a note, the merge is marked processed, the slot is returned', async () => {
  const { svc, store, calls } = rig();
  await svc.tick();
  assert.strictEqual(calls.generate, 1);
  assert.strictEqual(store.read().processed, H('b'));
  const [n] = svc.snapshot().notes;
  assert.strictEqual(n.doc, 'DESIGN_ASK_REPO.md');
  assert.strictEqual(n.commit, H('c').slice(0, 12));
  assert.strictEqual(n.subject, 'Merge pull request #7');
  assert.deepStrictEqual([calls.acquire, calls.release], [1, 1]);
  assert.ok(calls.broadcasts.some(m => m.type === 'docs-drift' && m.notes.length === 1));
});

test('the prompt carries the diff and the doc that names the changed file, not the unrelated one', async () => {
  const { svc, calls } = rig();
  await svc.tick();
  const { prompt } = calls.prompts[0];
  assert.match(prompt, /host\/ask-index\.js/);
  assert.match(prompt, /DESIGN_ASK_REPO\.md/);
  assert.doesNotMatch(prompt, /DESIGN_WAND\.md/);
  assert.match(prompt, /ask-index refreshes first/);
});

test('a reply that quotes a sentence that is not in the doc makes no note, and the merge is still done', async () => {
  const bad = JSON.stringify([{ doc: 'DESIGN_ASK_REPO.md', sentence: 'The index is rebuilt nightly by cron.', why: 'x' }]);
  const { svc, store } = rig({ reply: { ok: true, text: bad } });
  await svc.tick();
  assert.deepStrictEqual(svc.snapshot().notes, []);
  assert.strictEqual(store.read().processed, H('b'));
});

test('an empty list from the model is a clean merge: nothing shown, no off note', async () => {
  const { svc } = rig({ reply: { ok: true, text: '[]' } });
  await svc.tick();
  assert.deepStrictEqual(svc.snapshot(), { notes: [], off: null });
});

test('Ollama down: said plainly, nothing marked processed, nothing generated; retried only after RETRY_MS', async () => {
  const { svc, store, calls, r, t } = rig({ check: { ok: false, reason: 'ollama-down' } });
  await svc.tick();
  assert.deepStrictEqual(svc.snapshot().off, { reason: 'ollama-down', model: 'qwen3.5:4b' });
  assert.strictEqual(store.read().processed, H('a'));
  assert.strictEqual(calls.generate, 0);
  await svc.tick();
  assert.strictEqual(calls.check, 1, 'a down Ollama is not hammered');
  t.now += RETRY_MS + 1;
  r.check = { ok: true };
  await svc.tick();
  assert.strictEqual(svc.snapshot().off, null);
  assert.strictEqual(store.read().processed, H('b'));
  assert.strictEqual(svc.snapshot().notes.length, 1);
});

test('model not installed: named, never pulled', async () => {
  const { svc } = rig({ check: { ok: false, reason: 'model-missing', model: 'qwen3.5:4b' } });
  await svc.tick();
  assert.deepStrictEqual(svc.snapshot().off, { reason: 'model-missing', model: 'qwen3.5:4b' });
});

test('a generate that fails (timeout) is said, leaves the merge unprocessed, and is retried later', async () => {
  const { svc, store, r, t } = rig({ reply: { ok: false, reason: 'timeout' } });
  await svc.tick();
  assert.strictEqual(svc.snapshot().off.reason, 'failed');
  assert.strictEqual(svc.snapshot().off.detail, 'timeout');
  assert.strictEqual(store.read().processed, H('a'));
  t.now += RETRY_MS + 1;
  r.reply = { ok: true, text: GOOD };
  await svc.tick();
  assert.strictEqual(svc.snapshot().off, null);
  assert.strictEqual(store.read().processed, H('b'));
});

test('a reply that is not a JSON list is dropped for that merge and said once, not retried forever', async () => {
  const { svc, store, calls } = rig({ reply: { ok: true, text: 'The docs look fine to me.' } });
  await svc.tick();
  assert.strictEqual(store.read().processed, H('b'));
  assert.strictEqual(svc.snapshot().off.detail, 'bad-reply');
  await svc.tick();
  assert.strictEqual(calls.generate, 1);
});

test('the queue drops when busy: a held GPU slot means no job now, no note lost, tried again next tick', async () => {
  const { svc, store, calls, r } = rig({ slotFree: false });
  await svc.tick();
  assert.strictEqual(calls.generate, 0);
  assert.strictEqual(calls.release, 0);
  assert.strictEqual(store.read().processed, H('a'));
  r.slotFree = true;
  await svc.tick();
  assert.strictEqual(calls.generate, 1);
});

test('a tick while the last one is still running does not start a second job', async () => {
  let release;
  const gate = new Promise(res => { release = res; });
  const { svc, calls } = rig({ reply: () => gate.then(() => ({ ok: true, text: '[]' })) });
  const first = svc.tick();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const second = svc.tick();
  release();
  await Promise.all([first, second]);
  assert.strictEqual(calls.generate, 1);
});

test('another host handled the merge while this one waited for the slot: this one does not do it twice', async () => {
  const { svc, store, calls } = rig();
  const real = store.read;
  let reads = 0;
  store.read = () => { reads++; const s = real(); return reads >= 2 ? { ...s, processed: H('b') } : s; };
  await svc.tick();
  assert.strictEqual(calls.generate, 0);
  assert.strictEqual(calls.release, calls.acquire);
});

test('only the newest merges are analysed after a long gap (the limit), and the rest are not queued', async () => {
  const many = ['1', '2', '3'].map(c => ({ sha: H(c), subject: 'm' + c }));
  const { svc, calls } = rig({ merges: many, reply: { ok: true, text: '[]' } });
  await svc.tick();
  assert.strictEqual(calls.generate, 3);
});

test('develop rewound (from is no ancestor): jump to the new tip without analysing', async () => {
  const { svc, store, calls } = rig({ merges: null });
  await svc.tick();
  assert.strictEqual(store.read().processed, H('b'));
  assert.strictEqual(calls.generate, 0);
});

test('commits that are not merges move the mark without a model call', async () => {
  const { svc, store, calls } = rig({ merges: [] });
  await svc.tick();
  assert.strictEqual(store.read().processed, H('b'));
  assert.strictEqual(calls.check, 0);
  assert.strictEqual(calls.generate, 0);
});

test('no develop branch, no documentation folder, a git that throws: each is said, none throws out of tick', async () => {
  const a = rig({ head: null });
  await a.svc.tick();
  assert.strictEqual(a.svc.snapshot().off.reason, 'no-develop');
  const b = rig({ docs: { buildLog: null, docs: [] } });
  await b.svc.tick();
  assert.strictEqual(b.svc.snapshot().off.reason, 'no-docs');
  assert.strictEqual(b.store.read().processed, H('a'));
  assert.strictEqual(b.calls.generate, 0);
  assert.strictEqual(b.calls.release, b.calls.acquire);
  const c = rig();
  c.r.head = undefined;
  const svc = createDriftService({ git: { head: async () => { throw new Error('git is not installed'); } }, readDocs: async () => DOCS, ollama: { answerModel: 'm' }, store: c.store, slot: { tryAcquire: () => true, release() {} }, now: () => 1, broadcast() {}, log() {} });
  await svc.tick();
  assert.strictEqual(svc.snapshot().off.reason, 'failed');
  assert.match(svc.snapshot().off.detail, /git is not installed/);
});

test('a diff that cannot be read is said, frees the slot, and is retried only after RETRY_MS', async () => {
  const { store, calls, t } = rig();
  let diffs = 0;
  const svc = createDriftService({
    git: { head: async () => H('b'), merges: async () => [{ sha: H('c'), subject: 's' }], diff: async () => { diffs++; throw new Error('git diff failed'); } },
    readDocs: async () => DOCS, ollama: { answerModel: 'm', check: async () => ({ ok: true }), generate: async () => ({ ok: true, text: '[]' }) },
    store, slot: { tryAcquire: () => { calls.acquire++; return true; }, release: () => { calls.release++; } }, now: () => t.now, broadcast() {}, log() {},
  });
  await svc.tick();
  await svc.tick();
  assert.strictEqual(diffs, 1);
  assert.deepStrictEqual(svc.snapshot().off, { reason: 'failed', model: 'm', detail: 'error' });
  assert.strictEqual(calls.release, calls.acquire);
  assert.strictEqual(store.read().processed, H('a'));
});

test('dismiss: the note leaves the snapshot, is broadcast, and stays gone', async () => {
  const { svc, calls } = rig();
  await svc.tick();
  const id = svc.snapshot().notes[0].id;
  assert.deepStrictEqual(svc.dismiss(id), { ok: true });
  assert.deepStrictEqual(svc.snapshot().notes, []);
  assert.deepStrictEqual(calls.broadcasts.at(-1).notes, []);
  assert.strictEqual(svc.dismiss('nope').ok, false);
});

test('a snapshot sees a dismissal made through another host on the same file', async () => {
  const { svc, store } = rig();
  await svc.tick();
  store.dismiss(svc.snapshot().notes[0].id);
  assert.deepStrictEqual(svc.snapshot().notes, []);
});

test('analyzeMerge is the shared core: flags and what the model was shown, writing nothing', async () => {
  const out = await analyzeMerge({
    git: { diff: async () => DIFF }, readDocs: async () => DOCS,
    ollama: { generate: async () => ({ ok: true, text: GOOD }) },
  }, { sha: H('c'), subject: 's' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.flags.length, 1);
  assert.deepStrictEqual(out.shown.map(d => d.rel), ['CLAUDECUSTOM_BUILD_LOG.md', 'DESIGN_ASK_REPO.md']);
});
