'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { createDriftService, analyzeMerge, RETRY_MS, REPLY_TOKENS, GENERATE_TIMEOUT_MS, MAX_ATTEMPTS } = require('../host/drift-service');
const { createDriftStore } = require('../host/drift-store');
const { STALE_MS } = require('../host/summary-slot');
const { TIMEOUT_MS: GIT_TIMEOUT_MS } = require('../host/drift-git');

const H = (c) => c.repeat(40);
const DOC_TEXT = 'The index refreshes before each question.\nIt lives in host/ask-index.js.\n';
const DOCS = {
  buildLog: '# Log\n\n## Now\n\nThe ask-index refreshes first.\n\n## Other\n\nx\n',
  docs: [{ rel: 'DESIGN_ASK_REPO.md', text: DOC_TEXT }, { rel: 'DESIGN_WAND.md', text: 'wand only' }],
};
const DIFF = 'diff --git a/host/ask-index.js b/host/ask-index.js\n--- a/host/ask-index.js\n+++ b/host/ask-index.js\n@@ -1 +1 @@\n-refresh();\n+// refresh moved\n';
const GOOD = JSON.stringify([{ doc: 'DESIGN_ASK_REPO.md', sentence: 'The index refreshes before each question.', evidence: '+// refresh moved', why: 'The refresh moved out of the question path.' }]);

function rig({ head = H('b'), processed = H('a'), merges = [{ sha: H('c'), subject: 'Merge pull request #7' }], reply = { ok: true, text: GOOD }, check = { ok: true }, slotFree = true, docs = DOCS } = {}) {
  const dir = tmpDir('drift-svc-');
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

test('the model is given room for a whole reply (the default cut a real one off mid-list)', async () => {
  const { svc, calls } = rig();
  await svc.tick();
  assert.strictEqual(calls.prompts[0].numPredict, REPLY_TOKENS);
  assert.ok(REPLY_TOKENS >= 600);
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

test('a reply that is not a JSON list is retried, and after MAX_ATTEMPTS the merge is let go as a note, not retried forever', async () => {
  const { svc, store, calls, t } = rig({ reply: { ok: true, text: 'The docs look fine to me.' } });
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) { await svc.tick(); t.now += RETRY_MS + 1; }
  assert.strictEqual(calls.generate, MAX_ATTEMPTS);
  assert.strictEqual(store.read().processed, H('b'));
  assert.strictEqual(svc.snapshot().off, null, 'it is a note (R2-2), not an off line the next tick would wipe');
  assert.match(svc.snapshot().notes[0].doc, /not checked/);
});

test('two replies that are not lists and then a good one: the merge is read and its notes stored, nothing let go', async () => {
  const { svc, store, calls, r, t } = rig({ reply: { ok: true, text: 'not a list' } });
  await svc.tick(); t.now += RETRY_MS + 1;
  await svc.tick(); t.now += RETRY_MS + 1;
  assert.strictEqual(store.read().processed, H('a'), 'still waiting after two');
  r.reply = { ok: true, text: GOOD };
  await svc.tick();
  assert.strictEqual(calls.generate, 3);
  assert.strictEqual(store.read().processed, H('b'));
  const notes = svc.snapshot().notes;
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].doc, 'DESIGN_ASK_REPO.md');
});

test('bad replies and timeouts do not add up: only the merge\'s own bad replies count, and a good answer resets nothing it should not', async () => {
  const { svc, store, r, t } = rig({ reply: { ok: true, text: 'not a list' } });
  await svc.tick(); t.now += RETRY_MS + 1;
  r.reply = { ok: false, reason: 'timeout' };
  for (let i = 0; i < 5; i++) { await svc.tick(); t.now += RETRY_MS + 1; }
  assert.strictEqual(store.read().processed, H('a'), 'timeouts never count');
  r.reply = { ok: true, text: 'not a list' };
  await svc.tick(); t.now += RETRY_MS + 1;
  assert.strictEqual(store.read().processed, H('a'), 'two bad replies so far');
  await svc.tick();
  assert.strictEqual(store.read().processed, H('b'), 'the third lets it go');
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

test('one job (the host gives the model 60 s, see test/host-drift-wiring.test.js) fits inside the stale time of the GPU slot, or another host could take the slot over mid-job', () => {
  assert.ok(GENERATE_TIMEOUT_MS + GIT_TIMEOUT_MS < STALE_MS, 'the answer plus a diff that took its whole timeout');
});

// ---- PR #153 review fixes ----------------------------------------------------------------------------------------

function failingDiff(err) {
  const base = rig();
  const svc = createDriftService({
    git: { head: async () => H('b'), merges: async () => [{ sha: H('c'), subject: 's' }], diff: async () => { base.calls.diff++; throw err; } },
    readDocs: async () => DOCS, ollama: { answerModel: 'm', check: async () => ({ ok: true }), generate: async () => { base.calls.generate++; return { ok: true, text: '[]' }; } },
    store: base.store, slot: { tryAcquire: () => { base.calls.acquire++; return true; }, release: () => { base.calls.release++; } }, now: () => base.t.now, broadcast() {}, log() {},
  });
  return { ...base, svc };
}

// What a process answers with: an exit status (the merge's own failure), vs what stops it (infrastructure).
const OWN = () => Object.assign(new Error('fatal: bad object'), { code: 128, killed: false, signal: null });
const KILLED = () => Object.assign(new Error('Command failed: git diff'), { code: null, killed: true, signal: 'SIGTERM' });
const LETGO_NOTE = /not checked/;

test('a merge whose diff git itself refuses (its OWN failure) is let go after MAX_ATTEMPTS, and never takes the GPU slot again (PR #153 Dexter 1)', async () => {
  const { svc, store, calls, t } = failingDiff(OWN());
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) { await svc.tick(); t.now += RETRY_MS + 1; }
  assert.strictEqual(calls.acquire, MAX_ATTEMPTS, 'one slot hold per attempt, then none');
  assert.strictEqual(calls.release, calls.acquire);
  assert.strictEqual(store.read().processed, H('b'), 'the mark moved past the bad merge');
});

test('infrastructure never counts against a merge: a git that is killed / times out / is missing / has a full buffer keeps the mark however long it lasts (R2-1)', async () => {
  for (const err of [KILLED(), Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), new Error('plain')]) {
    const { svc, store, t } = failingDiff(err);
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) { await svc.tick(); t.now += RETRY_MS + 1; }
    assert.strictEqual(store.read().processed, H('a'), String(err.message));
    assert.strictEqual(svc.snapshot().notes.length, 0);
  }
});

test('Ollama timing out or answering 5xx never counts against a merge; when it recovers the merge is read, not skipped (R2-1)', async () => {
  for (const reason of ['timeout', 'http']) {
    const { svc, store, calls, r, t } = rig({ reply: { ok: false, reason } });
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) { await svc.tick(); t.now += RETRY_MS + 1; }
    assert.strictEqual(store.read().processed, H('a'), reason);
    assert.strictEqual(calls.generate, MAX_ATTEMPTS + 3, 'it keeps trying, one job a minute');
    r.reply = { ok: true, text: GOOD };
    await svc.tick();
    assert.strictEqual(store.read().processed, H('b'), reason);
    assert.ok(svc.snapshot().notes.some(n => n.doc === 'DESIGN_ASK_REPO.md'), 'the merge was read');
  }
});

test('a held GPU slot never counts against a merge either', async () => {
  const { svc, store, r, t } = rig({ slotFree: false });
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) { await svc.tick(); t.now += RETRY_MS + 1; }
  assert.strictEqual(store.read().processed, H('a'));
  r.slotFree = true;
  await svc.tick();
  assert.strictEqual(store.read().processed, H('b'));
});

test('a reply that is not a list on a valid diff is the merge\'s own failure: after MAX_ATTEMPTS it is let go, and said (R2-1)', async () => {
  const { svc, store, t } = rig({ reply: { ok: true, text: 'The docs look fine to me.' } });
  for (let i = 0; i < MAX_ATTEMPTS; i++) { await svc.tick(); t.now += RETRY_MS + 1; }
  assert.strictEqual(store.read().processed, H('b'));
  assert.match(svc.snapshot().notes[0].doc + svc.snapshot().notes[0].sentence, LETGO_NOTE);
});

test('a merge that was let go is reported durably: it is a note, so it survives the next tick and the next merge\'s success until it is dismissed (R2-2)', async () => {
  const { svc, store, r, t } = failingDiff(OWN());
  for (let i = 0; i < MAX_ATTEMPTS; i++) { await svc.tick(); t.now += RETRY_MS + 1; }
  const first = svc.snapshot().notes;
  assert.strictEqual(first.length, 1);
  assert.match(first[0].doc + first[0].sentence, LETGO_NOTE);
  assert.match(first[0].sentence, /Merge pull request|s/);
  assert.strictEqual(first[0].commit, H('c').slice(0, 12));
  await svc.tick();
  t.now += RETRY_MS + 1;
  await svc.tick();
  assert.strictEqual(svc.snapshot().notes.length, 1, 'the next ticks do not wipe it');
  assert.ok(first[0].id);
  // a later merge that is read fine does not erase it
  const ok = rig();
  ok.store.addNotes({ sha: H('c'), subject: 's' }, [{ doc: '(merge not checked)', sentence: 'x'.repeat(20), why: 'w' }], 1);
  ok.r.head = H('b');
  await ok.svc.tick();
  assert.ok(ok.svc.snapshot().notes.some(n => n.doc === '(merge not checked)'));
  assert.ok(ok.svc.snapshot().notes.length >= 2);
  assert.ok(store && r);
});

test('with two pending merges, the first let go and the second read, the let-go note is still there (R2-2)', async () => {
  const dir = tmpDir('drift-two-merges-');
  const store = createDriftStore({ file: path.join(dir, 'p.json') });
  store.setProcessed(H('a'));
  let clock = 1_000_000;
  const svc = createDriftService({
    git: { head: async () => H('b'), merges: async () => [{ sha: H('1'), subject: 'one' }, { sha: H('2'), subject: 'two' }], diff: async (sha) => { if (sha === H('1')) throw OWN(); return DIFF; } },
    readDocs: async () => DOCS, ollama: { answerModel: 'm', check: async () => ({ ok: true }), generate: async () => ({ ok: true, text: GOOD }) },
    store, slot: { tryAcquire: () => true, release() {} }, now: () => (clock += RETRY_MS + 1), broadcast() {}, log() {},
  });
  for (let i = 0; i < MAX_ATTEMPTS; i++) await svc.tick();
  const notes = svc.snapshot().notes;
  assert.ok(notes.some(n => LETGO_NOTE.test(n.doc + n.sentence) && n.commit === H('1').slice(0, 12)), JSON.stringify(notes));
  assert.ok(notes.some(n => n.doc === 'DESIGN_ASK_REPO.md' && n.commit === H('2').slice(0, 12)));
});

test('an unreadable notes file keeps the last good list on screen, never an empty one (R2-7)', async () => {
  const dir = tmpDir('drift-keep-');
  const file = path.join(dir, 'p.json');
  const good = createDriftStore({ file });
  good.setProcessed(H('b'));
  good.addNotes({ sha: H('c'), subject: 's' }, [{ doc: 'DESIGN_X.md', sentence: 'Sentence number 1 here.', why: 'w' }], 1);
  let broken = false;
  const store = createDriftStore({ file, sleep: () => {}, fsImpl: { ...fs, readFileSync: (...a) => { if (broken) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return fs.readFileSync(...a); } } });
  const sent = [];
  const svc = createDriftService({ git: { head: async () => H('b') }, readDocs: async () => DOCS, ollama: { answerModel: 'm' }, store, slot: { tryAcquire: () => true, release() {} }, now: () => 1, broadcast: (m) => sent.push(m), log() {} });
  assert.strictEqual(svc.snapshot().notes.length, 1);
  broken = true;
  const id = svc.snapshot().notes[0].id;
  svc.dismiss(id);
  assert.strictEqual(svc.snapshot().notes.length, 1, 'still shown');
  assert.match(svc.snapshot().off.detail, /unreadable/);
  assert.ok(sent.every(m => m.notes.length === 1), JSON.stringify(sent.map(m => m.notes.length)));
  broken = false;
  svc.dismiss(id);
  assert.strictEqual(svc.snapshot().notes.length, 0);
  assert.strictEqual(svc.snapshot().off, null);
});

test('Ollama being down or the model missing never counts against a merge', async () => {
  const { svc, store, calls, r, t } = rig({ check: { ok: false, reason: 'ollama-down' } });
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) { await svc.tick(); t.now += RETRY_MS + 1; }
  assert.strictEqual(store.read().processed, H('a'), 'down for a long while: nothing is given up on');
  r.check = { ok: true };
  await svc.tick();
  assert.strictEqual(store.read().processed, H('b'));
  assert.strictEqual(calls.generate, 1);
});

test('the off line is cleared on every path that finds nothing left to do: another host read it, only direct commits, develop rewound (Dexter 2, Miguel I3)', async () => {
  for (const after of [{ processed: H('b') }, { merges: [] }, { merges: null }]) {
    const { svc, store, r, t } = rig({ check: { ok: false, reason: 'ollama-down' } });
    await svc.tick();
    assert.strictEqual(svc.snapshot().off.reason, 'ollama-down');
    if (after.processed) store.setProcessed(after.processed);
    if ('merges' in after) r.merges = after.merges;
    t.now += RETRY_MS + 1;
    await svc.tick();
    assert.strictEqual(svc.snapshot().off, null, JSON.stringify(after));
  }
});

test('two hosts over one store: the one that was off stops saying so once the other has read the merge', async () => {
  const dir = tmpDir('drift-two-');
  const store = createDriftStore({ file: path.join(dir, 'p.json') });
  store.setProcessed(H('a'));
  let clock = 1_000_000;
  const mk = (check) => createDriftService({
    git: { head: async () => H('b'), merges: async () => [{ sha: H('c'), subject: 's' }], diff: async () => DIFF },
    readDocs: async () => DOCS, ollama: { answerModel: 'm', check: async () => check, generate: async () => ({ ok: true, text: '[]' }) },
    store, slot: { tryAcquire: () => true, release() {} }, now: () => (clock += 100_000), broadcast() {}, log() {},
  });
  const A = mk({ ok: false, reason: 'ollama-down' });
  const B = mk({ ok: true });
  await A.tick();
  assert.strictEqual(A.snapshot().off.reason, 'ollama-down');
  await B.tick();
  await A.tick();
  assert.strictEqual(A.snapshot().off, null);
});

test('a project with no documentation: said, and no diff, no model, no GPU slot until documents exist (Dexter 3)', async () => {
  const { svc, calls, store, r, t } = rig({ docs: { buildLog: null, buildLogName: null, docs: [] } });
  for (let i = 0; i < 4; i++) { await svc.tick(); t.now += RETRY_MS + 1; }
  assert.deepStrictEqual([calls.diff, calls.acquire, calls.generate, calls.check], [0, 0, 0, 0]);
  assert.strictEqual(svc.snapshot().off.reason, 'no-docs');
  assert.strictEqual(store.read().processed, H('a'));
  r.docs = DOCS;
  await svc.tick();
  assert.strictEqual(calls.generate, 1);
  assert.strictEqual(svc.snapshot().off, null);
});

test('an unreadable notes file is not a first look and not an empty store: nothing is marked, it is said, and it recovers when readable (Dexter 6)', async () => {
  const dir = tmpDir('drift-unread-');
  const file = path.join(dir, 'p.json');
  createDriftStore({ file }).setProcessed(H('a'));
  let broken = true;
  const store = createDriftStore({ file, sleep: () => {}, fsImpl: { ...fs, readFileSync: (...a) => { if (broken) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return fs.readFileSync(...a); } } });
  const calls = { generate: 0 };
  const svc = createDriftService({
    git: { head: async () => H('b'), merges: async () => [{ sha: H('c'), subject: 's' }], diff: async () => DIFF },
    readDocs: async () => DOCS, ollama: { answerModel: 'm', check: async () => ({ ok: true }), generate: async () => { calls.generate++; return { ok: true, text: '[]' }; } },
    store, slot: { tryAcquire: () => true, release() {} }, now: () => 5_000_000, broadcast() {}, log() {},
  });
  await svc.tick();
  assert.strictEqual(calls.generate, 0);
  assert.match(svc.snapshot().off.detail, /unreadable/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).processed, H('a'), 'the mark was not jumped to the tip');
  broken = false;
  await svc.tick();
  assert.strictEqual(calls.generate, 1);
  assert.strictEqual(svc.snapshot().off, null);
});

test('a git that times out is said and keeps the mark; it is never "no develop" or "rewound" (PR #153 B1)', async () => {
  const { store, t } = rig();
  const TIMEOUT = Object.assign(new Error('Command failed: git merge-base'), { code: null, killed: true, signal: 'SIGTERM' });
  let fail = true;
  const svc = createDriftService({
    git: { head: async () => H('b'), merges: async () => { if (fail) throw TIMEOUT; return [{ sha: H('c'), subject: 's' }]; }, diff: async () => DIFF },
    readDocs: async () => DOCS, ollama: { answerModel: 'm', check: async () => ({ ok: true }), generate: async () => ({ ok: true, text: '[]' }) },
    store, slot: { tryAcquire: () => true, release() {} }, now: () => t.now, broadcast() {}, log() {},
  });
  await svc.tick();
  assert.strictEqual(svc.snapshot().off.reason, 'failed');
  assert.match(svc.snapshot().off.detail, /Command failed/);
  assert.strictEqual(store.read().processed, H('a'));
  fail = false;
  await svc.tick();
  assert.strictEqual(store.read().processed, H('b'));
  assert.strictEqual(svc.snapshot().off, null);
});

test('the build log\'s own name goes to the model (Dexter 8)', async () => {
  const { svc, calls } = rig({ docs: { buildLog: '## Now\n\nfb now text\n', buildLogName: 'FACEBOOKDEALS_BUILD_LOG.md', docs: DOCS.docs } });
  await svc.tick();
  assert.match(calls.prompts[0].prompt, /FILE FACEBOOKDEALS_BUILD_LOG\.md \(its "Now" section\)/);
  assert.match(calls.prompts[0].prompt, /fb now text/);
});

test('dismiss hands back what the store said, so a failed write can be told (Miguel I4)', () => {
  const failing = createDriftService({
    git: { head: async () => H('b') }, readDocs: async () => DOCS, ollama: { answerModel: 'm' },
    store: { open: () => [], read: () => ({ processed: H('b'), notes: [] }), dismiss: () => ({ ok: false, error: 'disk says no' }) },
    slot: { tryAcquire: () => true, release() {} }, now: () => 1, broadcast() {}, log() {},
  });
  assert.deepStrictEqual(failing.dismiss('x'), { ok: false, error: 'disk says no' });
});

test('the host and the eval give the model the same time to answer', () => {
  assert.strictEqual(GENERATE_TIMEOUT_MS, 60_000);
});
