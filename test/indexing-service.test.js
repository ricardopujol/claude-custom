'use strict';
/**
 * The indexing assistant's service (host/indexing-service.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Claude's call"
 * 4-7 and the accuracy gate). Real journal and writer on temp fixture docs; a fake model, GPU slot and power probe.
 *   - a note is journaled before anything else and files when it can (Ollama off, battery, a busy slot: it waits)
 *   - propose mode, or a "not sure" answer, asks instead of writing; a choice then writes
 *   - Undo is exact or refuses; Move = Undo + file to the picked target
 *   - another window's service never files the same note twice
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { createIndexingService, HOLD_MS } = require('../host/indexing-service');
const { createJournal } = require('../host/indexing-journal');
const writer = require('../host/indexing-writer');

const BACKLOG = '# P — Backlog\n\n## 61. Wand buttons run the skill, not just type it\nbody\n\n## 63. A resource panel: CPU and memory\nmore\n';
const HISTORY = '# P — History\n\n- 2026-10-04 [note] old\n';

function setup({ mode = 'direct', replies = [], battery = null, slotFree = true, writerImpl = writer } = {}) {
  const dir = tmpDir('cc-is-');
  const dev = path.join(dir, 'proj');
  const docsDir = path.join(dev, 'documentation');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'P_BUILD_LOG.md'), '# log\n');
  fs.writeFileSync(path.join(docsDir, 'P_BACKLOG.md'), BACKLOG);
  fs.writeFileSync(path.join(docsDir, 'P_HISTORY.md'), HISTORY);
  const journal = createJournal({ file: path.join(dir, 'state', 'indexing-notes.jsonl') });
  let clock = Date.UTC(2026, 9, 5, 15, 0, 0);
  const calls = { generate: 0, acquire: 0, release: 0, broadcast: 0 };
  const queue = [...replies];
  const ollama = {
    generate: async () => {
      calls.generate += 1;
      const r = queue.shift();
      if (r === undefined) throw new Error('no reply queued');
      const v = typeof r === 'function' ? r() : r;
      return typeof v === 'string' ? { ok: true, text: v, ms: 1 } : v;
    },
  };
  const slot = {
    free: slotFree,
    tryAcquire() { calls.acquire += 1; return this.free; },
    release() { calls.release += 1; },
    lastError: () => '',
  };
  const power = { value: battery };
  const state = { mode };
  const svc = createIndexingService({
    journal, ollama, slot, writer: writerImpl,
    onBattery: async () => power.value,
    docsFor: () => writer.docsOf({ root: dev, dev }),
    mode: () => state.mode,
    now: () => clock,
    broadcast: () => { calls.broadcast += 1; },
  });
  return {
    svc, journal, calls, slot, power, state, queue, project: dev,
    backlog: path.join(docsDir, 'P_BACKLOG.md'), history: path.join(docsDir, 'P_HISTORY.md'),
    advance: (ms) => { clock += ms; },
  };
}

const read = (f) => fs.readFileSync(f, 'utf8');
const KIND = (l) => `{"answer":"${l}"}`;

test('submit journals the note first: it is waiting before the model is asked anything', () => {
  const t = setup();
  const r = t.svc.submit(t.project, '  tabs should glow  ');
  assert.strictEqual(r.ok, true);
  const snap = t.svc.snapshot(t.project);
  assert.strictEqual(snap.list.length, 1);
  assert.strictEqual(snap.list[0].state, 'waiting');
  assert.strictEqual(snap.list[0].text, 'tabs should glow');
  assert.strictEqual(t.calls.generate, 0);
  assert.ok(t.calls.broadcast >= 1);
});

test('submit refuses an empty note and writes nothing', () => {
  const t = setup();
  assert.deepStrictEqual(t.svc.submit(t.project, '   '), { ok: false, reason: 'empty' });
  assert.deepStrictEqual(t.journal.read(), []);
});

test('direct mode: a sure answer is filed, holding the GPU slot, and released after', async () => {
  const t = setup({ replies: [KIND('A'), '{"title":"Tabs glow"}'] });
  t.svc.submit(t.project, 'tabs should glow when a session needs me');
  await t.svc.tick();
  const n = t.svc.snapshot(t.project).list[0];
  assert.strictEqual(n.state, 'filed');
  assert.deepStrictEqual(n.where, { target: 'new', kind: 'idea', title: 'Tabs glow', n: 64, file: 'P_BACKLOG.md' });
  assert.ok(read(t.backlog).includes('## 64. Tabs glow (captured 2026-10-05, indexing assistant)\nRicardo: "tabs should glow when a session needs me"'));
  assert.deepStrictEqual([t.calls.acquire, t.calls.release], [1, 1]);
  assert.deepStrictEqual(t.svc.snapshot(t.project).counts, { filed: 1, waiting: 0, asking: 0 });
});

test('a decision goes to the history', async () => {
  const t = setup({ replies: [KIND('C')] });
  t.svc.submit(t.project, 'we keep the journal as JSONL');
  await t.svc.tick();
  assert.ok(read(t.history).endsWith('- 2026-10-05 [decision] we keep the journal as JSONL\n'));
});

test('propose mode asks even when the answer is sure, and writes nothing', async () => {
  const t = setup({ mode: 'propose', replies: [KIND('A')] });
  t.svc.submit(t.project, 'wand buttons should run skills mid-turn');
  await t.svc.tick();
  const n = t.svc.snapshot(t.project).list[0];
  assert.strictEqual(n.state, 'asking');
  assert.deepStrictEqual(n.guess, { kind: 'idea', target: 61, title: null, sure: true });
  assert.strictEqual(n.options[0], 61);
  assert.ok(n.options.length <= 3);
  assert.strictEqual(read(t.backlog), BACKLOG);
});

test('direct mode: not sure asks, and writes nothing', async () => {
  const t = setup({ replies: [KIND('Z')] });
  t.svc.submit(t.project, 'hmm');
  await t.svc.tick();
  assert.strictEqual(t.svc.snapshot(t.project).list[0].state, 'asking');
  assert.strictEqual(read(t.backlog), BACKLOG);
});

test('choose files an asking note where it was picked, without the model', async () => {
  const t = setup({ mode: 'propose', replies: [KIND('A')] });
  const { id } = t.svc.submit(t.project, 'wand buttons should run skills mid-turn');
  await t.svc.tick();
  const r = t.svc.choose(id, { target: 61 });
  assert.strictEqual(r.ok, true);
  assert.ok(read(t.backlog).includes('- **Note (2026-10-05, indexing assistant):** wand buttons should run skills mid-turn'));
  assert.strictEqual(t.calls.generate, 1);
  assert.strictEqual(t.svc.snapshot(t.project).list[0].state, 'filed');
});

test('choose: a new item uses the model\'s title, else the note\'s first words; history takes the kind asked for', async () => {
  const t = setup({ mode: 'propose', replies: [KIND('A'), '{"title":"Glowing tabs"}', KIND('B'), '{"title":""}', KIND('A'), '{"title":"Stash"}'] });
  const a = t.svc.submit(t.project, 'tabs should glow').id;
  await t.svc.tick();
  t.svc.choose(a, { target: 'new' });
  assert.ok(read(t.backlog).includes('## 64. Glowing tabs'));
  const b = t.svc.submit(t.project, 'the strip flickers on resize').id;
  await t.svc.tick();
  t.svc.choose(b, { target: 'new' });
  assert.ok(read(t.backlog).includes('## 65. the strip flickers on resize'));
  const c = t.svc.submit(t.project, 'git stash is shared by worktrees').id;
  await t.svc.tick();
  t.svc.choose(c, { target: 'history', kind: 'learning' });
  assert.ok(read(t.history).endsWith('- 2026-10-05 [learning] git stash is shared by worktrees\n'));
});

test('choose refuses a note that is not asking, or a target that is not one', async () => {
  const t = setup({ replies: [KIND('C')] });
  const { id } = t.svc.submit(t.project, 'x decision');
  assert.deepStrictEqual(t.svc.choose(id, { target: 61 }), { ok: false, reason: 'not-asking' });
  assert.deepStrictEqual(t.svc.choose('nope', { target: 61 }), { ok: false, reason: 'not-asking' });
  t.state.mode = 'propose';
  await t.svc.tick();
  assert.deepStrictEqual(t.svc.choose(id, { target: 'build-log' }), { ok: false, reason: 'bad-target' });
  assert.deepStrictEqual(t.svc.choose(id, { target: 99 }), { ok: false, reason: 'no-item' });
});

// --- waiting ---------------------------------------------------------------------------------------------------------

test('Ollama off: the note waits with the reason, the slot is released, and it is retried after the hold', async () => {
  const t = setup({ replies: [{ ok: false, reason: 'unreachable' }, KIND('C')] });
  t.svc.submit(t.project, 'a decision');
  await t.svc.tick();
  let n = t.svc.snapshot(t.project).list[0];
  assert.deepStrictEqual([n.state, n.reason], ['waiting', 'ollama-down']);
  assert.strictEqual(t.calls.release, t.calls.acquire);
  await t.svc.tick();
  assert.strictEqual(t.calls.generate, 1, 'held: not asked again at once');
  t.advance(HOLD_MS['ollama-down']);
  await t.svc.tick();
  n = t.svc.snapshot(t.project).list[0];
  assert.strictEqual(n.state, 'filed');
});

test('a model call that throws: the note waits with a reason and a hold, and the slot is released', async () => {
  const t = setup({ replies: [() => { throw new Error('boom'); }] });
  t.svc.submit(t.project, 'x');
  await t.svc.tick();
  const n = t.svc.snapshot(t.project).list[0];
  assert.deepStrictEqual([n.state, n.reason], ['waiting', 'error']);
  assert.strictEqual(t.calls.release, 1);
  await t.svc.tick();
  assert.strictEqual(t.calls.generate, 1, 'held, not retried on every tick');
});

test('on battery: it waits, and the model is never asked', async () => {
  const t = setup({ battery: true, replies: [KIND('C')] });
  t.svc.submit(t.project, 'a decision');
  await t.svc.tick();
  const n = t.svc.snapshot(t.project).list[0];
  assert.deepStrictEqual([n.state, n.reason], ['waiting', 'battery']);
  assert.strictEqual(t.calls.generate, 0);
  t.power.value = null;                     // unknown power runs, as #105's scheduler does
  t.advance(HOLD_MS.battery);
  await t.svc.tick();
  assert.strictEqual(t.svc.snapshot(t.project).list[0].state, 'filed');
});

test('the GPU slot busy (a summary job, another window): it waits, briefly', async () => {
  const t = setup({ slotFree: false, replies: [KIND('C')] });
  t.svc.submit(t.project, 'a decision');
  await t.svc.tick();
  assert.strictEqual(t.svc.snapshot(t.project).list[0].reason, 'busy');
  assert.strictEqual(t.calls.generate, 0);
  assert.strictEqual(t.calls.release, 0, 'nothing to release: it was never ours');
  t.slot.free = true;
  t.advance(HOLD_MS.busy);
  await t.svc.tick();
  assert.strictEqual(t.svc.snapshot(t.project).list[0].state, 'filed');
});

test('a reason already recorded is not journaled again on every retry', async () => {
  const t = setup({ slotFree: false });
  t.svc.submit(t.project, 'x');
  for (let i = 0; i < 5; i++) { await t.svc.tick(); t.advance(HOLD_MS.busy); }
  assert.strictEqual(t.journal.read().filter(e => e.ev === 'waiting').length, 1);
});

test('a backlog edited under the write twice: the note waits with conflict, and nothing is lost', async () => {
  // A session that edits the backlog between every read and rename.
  let k = 0;
  const busyWriter = {
    ...writer,
    fileNote: (args) => writer.fileNote({ ...args, beforeRename: () => fs.appendFileSync(args.docs.backlog, `edit ${k++}\n`) }),
  };
  const t = setup({ replies: [KIND('A'), '{"title":"T"}'], writerImpl: busyWriter });
  t.svc.submit(t.project, 'tabs glow');
  await t.svc.tick();
  const n = t.svc.snapshot(t.project).list[0];
  assert.deepStrictEqual([n.state, n.reason], ['waiting', 'conflict']);
  assert.ok(!read(t.backlog).includes('Ricardo: "tabs glow"'));
});

test('waiting notes file oldest first, one per tick', async () => {
  const t = setup({ replies: [KIND('C'), KIND('D')] });
  t.svc.submit(t.project, 'first');
  t.advance(1000);
  t.svc.submit(t.project, 'second');
  await t.svc.tick();
  assert.ok(read(t.history).endsWith('[decision] first\n'));
  await t.svc.tick();
  assert.ok(read(t.history).endsWith('[learning] second\n'));
});

test('a note another window filed while this one was asking the model is not filed again', async () => {
  let id = null;
  const t = setup({ replies: [() => {
    t.journal.append({ ev: 'filed', id, at: 1, where: { file: 'x', target: 'history', kind: 'decision', title: null, n: null }, record: { offset: 0, inserted: 'x', prefixHash: 'h' } });
    return KIND('C');
  }] });
  id = t.svc.submit(t.project, 'a decision').id;
  await t.svc.tick();
  assert.strictEqual(t.journal.read().filter(e => e.ev === 'filed').length, 1);
  assert.strictEqual(read(t.history), HISTORY);
});

test('a note another window already filed is not even classified', async () => {
  const t = setup();
  const { id } = t.svc.submit(t.project, 'a decision');
  t.journal.append({ ev: 'filed', id, at: 1, where: { file: 'x', target: 'history', kind: 'decision', title: null, n: null }, record: { offset: 0, inserted: 'x', prefixHash: 'h' } });
  await t.svc.tick();
  assert.strictEqual(t.calls.generate, 0);
});

// --- undo and move ---------------------------------------------------------------------------------------------------

test('undo removes exactly the filed text; the list shows it undone', async () => {
  const t = setup({ replies: [KIND('A'), '{"title":"Glow"}'] });
  const { id } = t.svc.submit(t.project, 'tabs glow');
  await t.svc.tick();
  assert.strictEqual(t.svc.snapshot(t.project).list[0].undoable, true);
  assert.deepStrictEqual(t.svc.undo(id), { ok: true });
  assert.strictEqual(read(t.backlog), BACKLOG);
  const n = t.svc.snapshot(t.project).list[0];
  assert.strictEqual(n.state, 'undone');
  assert.strictEqual(n.undoable, false);
});

test('undo refuses when the backlog changed above the note, names the file, and removes nothing', async () => {
  const t = setup({ replies: [KIND('A')] });
  const { id } = t.svc.submit(t.project, 'resource panel CPU memory history');
  await t.svc.tick();
  const edited = read(t.backlog).replace('## 61. Wand', '## 61. The wand');
  fs.writeFileSync(t.backlog, edited);
  assert.strictEqual(t.svc.snapshot(t.project).list[0].undoable, false, 'the list says so before a click');
  assert.deepStrictEqual(t.svc.undo(id), { ok: false, reason: 'changed', file: t.backlog });
  assert.strictEqual(read(t.backlog), edited);
  assert.strictEqual(t.svc.snapshot(t.project).list[0].state, 'filed');
});

test('move = undo + file to the picked target', async () => {
  const t = setup({ replies: [KIND('A'), '{"title":"Glow"}'] });
  const { id } = t.svc.submit(t.project, 'tabs glow');
  await t.svc.tick();
  assert.deepStrictEqual(t.svc.move(id, { target: 63 }), { ok: true });
  const text = read(t.backlog);
  assert.ok(!text.includes('## 64. Glow'));
  assert.ok(text.includes('more\n- **Note (2026-10-05, indexing assistant):** tabs glow\n'));
  assert.strictEqual(t.svc.snapshot(t.project).list[0].where.target, 63);
});

test('move that cannot undo moves nothing', async () => {
  const t = setup({ replies: [KIND('C')] });
  const { id } = t.svc.submit(t.project, 'a decision');
  await t.svc.tick();
  fs.writeFileSync(t.history, 'rewritten\n' + read(t.history));
  assert.deepStrictEqual(t.svc.move(id, { target: 61 }), { ok: false, reason: 'changed', file: t.history });
  assert.strictEqual(read(t.backlog), BACKLOG);
});

test('move whose new place refuses: the note is asked again, never lost', async () => {
  const t = setup({ replies: [KIND('C')] });
  const { id } = t.svc.submit(t.project, 'a decision');
  await t.svc.tick();
  const r = t.svc.move(id, { target: 99 });
  assert.deepStrictEqual(r, { ok: false, reason: 'no-item' });
  const n = t.svc.snapshot(t.project).list[0];
  assert.strictEqual(n.state, 'asking');
  assert.strictEqual(read(t.history), HISTORY);
});

test('snapshot: mode, counts and the list; another project\'s notes are not in it', async () => {
  const t = setup({ mode: 'propose' });
  t.svc.submit(t.project, 'mine');
  t.svc.submit('C:\\somewhere\\else', 'theirs');
  const s = t.svc.snapshot(t.project);
  assert.strictEqual(s.mode, 'propose');
  assert.deepStrictEqual(s.counts, { filed: 0, waiting: 1, asking: 0 });
  assert.deepStrictEqual(s.list.map(n => n.text), ['mine']);
});

test('a tick never throws, and two ticks at once run one job', async () => {
  const t = setup({ replies: [KIND('C')] });
  t.svc.submit(t.project, 'a decision');
  await Promise.all([t.svc.tick(), t.svc.tick()]);
  assert.strictEqual(t.calls.generate, 1);
  const broken = createIndexingService({
    journal: { read() { throw new Error('disk'); }, withLock() { throw new Error('disk'); }, append() { throw new Error('disk'); }, newId: () => 'x' },
    ollama: {}, slot: {}, docsFor: () => ({ ok: false }), mode: () => 'direct', log: () => {},
  });
  await broken.tick();
  assert.deepStrictEqual(broken.submit('C:\\p', 'x'), { ok: false, reason: 'journal-failed' });
});
