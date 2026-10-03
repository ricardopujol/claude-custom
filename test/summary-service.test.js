'use strict';
/**
 * The summary service (host/summary-service.js, backlog #39 job 1): the part that watches ONE session's transcript
 * and keeps its "where are we" summary. Every dependency is injected, so these tests drive it tick by tick on a
 * fake clock: stat, tail reader, Ollama, store, GPU slot, battery probe and broadcast.
 *
 * What is pinned: a job only runs for a tab with new turns after the quiet period; tool-only growth costs no GPU;
 * Ollama being down or the model being missing is SAID (never a silent empty state) and retried once a minute, not
 * hammered; a busy GPU slot is waited for and always released; nothing is ever written but the store.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { createSummaryService, readTailFile, readFromFile, RETRY_MS, SLOT_RETRY_MS, TAIL_SIZES } = require('../host/summary-service');
const { createScheduler, QUIET_MS } = require('../host/summary-scheduler');
const { createSummaryStore } = require('../host/summary-store');
const { INSTRUCTION } = require('../host/summary-text');

const SID = 'sess-1';
const jl = (...objs) => objs.map(o => JSON.stringify(o)).join('\n');
const userLine = (uuid, text) => ({ type: 'user', uuid, message: { role: 'user', content: text } });
const asstLine = (uuid, text) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolLine = (uuid) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });

function rig(over = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const log = [];
  const broadcasts = [];
  const file = { mtimeMs: 1, text: jl(userLine('u1', 'fix the drawer'), asstLine('a1', 'Looking at the drawer now.')) };
  const cfg = {
    sid: SID,
    check: { ok: true },
    summarize: { ok: true, text: 'Working on: the drawer\nWhere it stands: reading it\nNext: fix it', ms: 2500 },
    battery: false,
    slotFree: true,
    ...over,
  };
  const calls = { stat: 0, readTail: [], readFrom: [], check: 0, summarize: [], acquire: 0, release: 0, battery: 0 };
  const deps = {
    now,
    sessionId: () => cfg.sid,
    transcriptFile: (sid) => path.join('X', sid + '.jsonl'),
    stat: () => { calls.stat += 1; return file.missing ? null : { size: file.size !== undefined ? file.size : file.text.length, mtimeMs: file.mtimeMs }; },
    readFrom: (f, offset) => { calls.readFrom.push(offset); if (file.throws) throw new Error('disk gone'); return file.text.slice(offset); },
    readTail: (f, bytes) => { calls.readTail.push(bytes); if (file.throws) throw new Error('disk gone'); return file.text; },
    ollama: {
      check: async () => { calls.check += 1; return cfg.check; },
      summarize: async (prompt) => { calls.summarize.push(prompt); if (cfg.summarizeThrows) throw new Error('boom'); return cfg.summarize; },
    },
    store: over.store || createSummaryStore({ dir: tmpDir('svc-') }),
    scheduler: createScheduler(),
    slot: { tryAcquire: () => { calls.acquire += 1; return cfg.slotFree; }, release: () => { calls.release += 1; }, lastError: () => '' },
    onBattery: async () => { calls.battery += 1; return cfg.battery; },
    broadcast: (m) => broadcasts.push(m),
    log: (...a) => log.push(a.join(' ')),
  };
  const svc = createSummaryService(deps);
  const advance = (ms) => { clock.t += ms; };
  // the first tick sees the transcript (activity), the rest wait out the quiet period
  const settle = async () => { await svc.tick(); advance(QUIET_MS); await svc.tick(); };
  const grow = (line) => { file.text += '\n' + line; file.mtimeMs += 1; };
  return { svc, cfg, calls, file, clock, advance, broadcasts, log, deps, settle, grow };
}

const last = (r) => r.broadcasts[r.broadcasts.length - 1];

test('constants: a failed or off Ollama is retried once a minute; a busy slot every 5 s', () => {
  assert.strictEqual(RETRY_MS, 60_000);
  assert.strictEqual(SLOT_RETRY_MS, 5_000);
  assert.deepStrictEqual(TAIL_SIZES, [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]);
});

test('no session yet: nothing is read and nothing is asked of Ollama', async () => {
  const r = rig({ sid: null });
  await r.svc.tick();
  r.advance(10 * QUIET_MS);
  await r.svc.tick();
  assert.strictEqual(r.calls.stat, 0);
  assert.strictEqual(r.calls.summarize.length, 0);
  assert.deepStrictEqual(r.svc.snapshot(), { summary: null, off: null });
});

test('a session id that could name a path outside the transcript folder is no session', async () => {
  for (const sid of ['../../etc/x', 'a/b', 'a\\b', '', '.x', 'x'.repeat(200)]) {
    const r = rig({ sid });
    await r.settle();
    assert.strictEqual(r.calls.stat, 0, sid);
    assert.strictEqual(r.calls.summarize.length, 0, sid);
  }
});

test('a transcript with new turns is summarised once the quiet period has passed, not before', async () => {
  const r = rig();
  await r.svc.tick();
  r.advance(QUIET_MS - 1);
  await r.svc.tick();
  assert.strictEqual(r.calls.summarize.length, 0);
  r.advance(1);
  await r.svc.tick();
  assert.strictEqual(r.calls.summarize.length, 1);
});

test('the prompt is the flattened transcript first and the instruction last', async () => {
  const r = rig();
  await r.settle();
  const p = r.calls.summarize[0];
  assert.ok(p.startsWith('User: fix the drawer\n\nAssistant: Looking at the drawer now.'));
  assert.ok(p.endsWith(INSTRUCTION));
});

test('the summary is stored, labelled with its model and time, and broadcast', async () => {
  const r = rig();
  await r.settle();
  const at = r.clock.t;
  assert.deepStrictEqual(last(r), {
    type: 'summary',
    summary: { text: 'Working on: the drawer\nWhere it stands: reading it\nNext: fix it', model: 'llama3.2:3b', at, turnsSeen: 2, stale: false },
    off: null,
  });
  assert.deepStrictEqual(r.svc.snapshot(), { summary: last(r).summary, off: null });
  assert.strictEqual(r.deps.store.get(SID).newestKey, 'a1');
});

test('an unchanged transcript is never summarised again: an idle tab costs nothing', async () => {
  const r = rig();
  await r.settle();
  for (let i = 0; i < 10; i++) { r.advance(10 * 60_000); await r.svc.tick(); }
  assert.strictEqual(r.calls.summarize.length, 1);
  assert.strictEqual(r.calls.readTail.length, 1, 'not even read: only a stat per tick');
});

test('a transcript that grew only by tool calls costs no GPU job (the newest message is the one already summarised)', async () => {
  const r = rig();
  await r.settle();
  r.grow(jl(toolLine('t1')));
  r.advance(1000); await r.svc.tick();
  r.advance(120_000); await r.svc.tick();
  assert.strictEqual(r.calls.readTail.length, 1, 'not even a job: tool lines are not a turn (Dexter F1)');
  assert.strictEqual(r.calls.summarize.length, 1);
  assert.strictEqual(r.calls.acquire, 1, 'the slot is not taken for a no-op');
  r.grow(jl(userLine('u2', 'a real message')));
  r.advance(1000); await r.svc.tick();
  r.advance(QUIET_MS); await r.svc.tick();
  assert.strictEqual(r.calls.summarize.length, 2, 'and the no-op did not spend the cap');
});

test('a new message after the cap is summarised again, and not before the 2 minute cap', async () => {
  const r = rig();
  await r.settle();                                   // job 1 started at T0+25s
  r.grow(jl(userLine('u2', 'now the hover card')));
  r.advance(1000); await r.svc.tick();               // sees the change
  r.advance(QUIET_MS); await r.svc.tick();            // quiet, but inside the cap
  assert.strictEqual(r.calls.summarize.length, 1);
  r.advance(120_000); await r.svc.tick();
  assert.strictEqual(r.calls.summarize.length, 2);
  assert.strictEqual(r.deps.store.get(SID).newestKey, 'u2');
  assert.match(r.calls.summarize[1], /now the hover card/);
});

test('a stored summary from before a restart is dimmed, and confirmed fresh when nothing new was said since', async () => {
  const dir = tmpDir('svc-');
  createSummaryStore({ dir }).put(SID, { text: 'Working on: old', model: 'llama3.2:3b', turnsSeen: 2, newestKey: 'a1' }, 500);
  const r = rig({ store: createSummaryStore({ dir }) });
  assert.strictEqual(r.svc.snapshot().summary.stale, true);
  assert.strictEqual(r.svc.snapshot().summary.at, 500);
  await r.settle();
  assert.strictEqual(r.calls.summarize.length, 0, 'the newest message is the one it was built from');
  assert.strictEqual(r.svc.snapshot().summary.stale, false);
  assert.strictEqual(r.svc.snapshot().summary.at, 500, 'its age is when it was written, not when it was re-checked');
  assert.strictEqual(last(r).summary.stale, false);
});

test('a transcript with no conversation in it yet is no job and no summary', async () => {
  const r = rig();
  r.file.text = jl({ type: 'system' }, toolLine('t0'));
  await r.settle();
  assert.strictEqual(r.calls.summarize.length, 0);
  assert.deepStrictEqual(r.svc.snapshot(), { summary: null, off: null });
});

test('a transcript that is not there yet is waited for', async () => {
  const r = rig();
  r.file.missing = true;
  await r.settle();
  assert.strictEqual(r.calls.summarize.length, 0);
  r.file.missing = false;
  await r.settle();
  assert.strictEqual(r.calls.summarize.length, 1);
});

test('a thin tail widens the read until it holds a conversation', async () => {
  const r = rig();
  let n = 0;
  r.file.size = 50 * 1024 * 1024;
  r.deps.readTail = (f, bytes) => { r.calls.readTail.push(bytes); n += 1; return n < 3 ? jl(toolLine('t' + n)) : r.file.text; };
  const svc = createSummaryService(r.deps);
  await svc.tick(); r.advance(QUIET_MS); await svc.tick();
  assert.deepStrictEqual(r.calls.readTail, TAIL_SIZES);
  assert.strictEqual(r.calls.summarize.length, 1);
});

test('a tail that already covers the whole file is not read again at a larger size', async () => {
  const r = rig();
  r.file.size = 200;
  r.file.text = jl(toolLine('t1'));
  await r.settle();
  assert.deepStrictEqual(r.calls.readTail, [TAIL_SIZES[0]]);
  assert.strictEqual(r.calls.summarize.length, 0);
});

test('Ollama not running is SAID, the last summary is kept, and the retry waits a minute', async () => {
  const r = rig({ check: { ok: false, reason: 'unreachable', model: 'llama3.2:3b' } });
  await r.settle();
  assert.strictEqual(r.calls.summarize.length, 0);
  assert.deepStrictEqual(last(r), { type: 'summary', summary: null, off: { reason: 'ollama-down', model: 'llama3.2:3b' } });
  const checks = r.calls.check;
  r.grow(jl(userLine('u2', 'more')));
  r.advance(RETRY_MS - 1); await r.svc.tick();
  assert.strictEqual(r.calls.check, checks, 'not asked again inside the minute');
  r.advance(1); await r.svc.tick();
  assert.ok(r.calls.check > checks);
});

test('a model that is not installed is said, with the model named', async () => {
  const r = rig({ check: { ok: false, reason: 'model-missing', model: 'llama3.2:3b' } });
  await r.settle();
  assert.deepStrictEqual(last(r).off, { reason: 'model-missing', model: 'llama3.2:3b' });
});

test('Ollama coming back clears the note and the summary is made, with no new typing needed to notice', async () => {
  const r = rig({ check: { ok: false, reason: 'unreachable', model: 'llama3.2:3b' } });
  await r.settle();
  assert.strictEqual(r.svc.snapshot().off.reason, 'ollama-down');
  r.cfg.check = { ok: true };
  r.advance(RETRY_MS); await r.svc.tick();
  assert.strictEqual(r.svc.snapshot().off, null, 'recovery is seen by the minute check');
  assert.strictEqual(r.calls.summarize.length, 1, 'and the summary the tab was waiting for is made');
  assert.ok(r.svc.snapshot().summary);
});

test('a job that Ollama answers badly says it failed, with why, and is held off for a minute', async () => {
  const r = rig({ summarize: { ok: false, reason: 'bad-reply' } });
  await r.settle();
  assert.deepStrictEqual(last(r).off, { reason: 'failed', model: 'llama3.2:3b', detail: 'bad-reply' });
  r.advance(RETRY_MS - 1); await r.svc.tick();
  assert.strictEqual(r.calls.summarize.length, 1);
  r.advance(1); await r.svc.tick();
  assert.strictEqual(r.calls.summarize.length, 2);
});

test('a generate that says the model is missing or unreachable says that, not "failed"', async () => {
  const a = rig({ summarize: { ok: false, reason: 'model-missing' } });
  await a.settle();
  assert.strictEqual(last(a).off.reason, 'model-missing');
  const b = rig({ summarize: { ok: false, reason: 'unreachable' } });
  await b.settle();
  assert.strictEqual(last(b).off.reason, 'ollama-down');
  const c = rig({ summarize: { ok: false, reason: 'timeout' } });
  await c.settle();
  assert.deepStrictEqual(last(c).off, { reason: 'failed', model: 'llama3.2:3b', detail: 'timeout' });
});

test('a later success clears the failure note and a failure keeps the summary that was already there', async () => {
  const r = rig();
  await r.settle();
  const kept = r.svc.snapshot().summary;
  r.cfg.summarize = { ok: false, reason: 'timeout' };
  r.grow(jl(userLine('u2', 'again')));
  r.advance(1000); await r.svc.tick();
  r.advance(120_000); await r.svc.tick();
  assert.strictEqual(r.svc.snapshot().off.reason, 'failed');
  assert.deepStrictEqual(r.svc.snapshot().summary, kept, 'the last good summary is not thrown away');
  r.cfg.summarize = { ok: true, text: 'Working on: again', ms: 1 };
  r.advance(RETRY_MS); await r.svc.tick();
  assert.strictEqual(r.svc.snapshot().off, null);
  assert.strictEqual(r.svc.snapshot().summary.text, 'Working on: again');
});

test('a busy GPU slot is waited for (5 s), and the slot is released after a job', async () => {
  const r = rig({ slotFree: false });
  await r.settle();
  assert.strictEqual(r.calls.summarize.length, 0);
  assert.strictEqual(r.calls.release, 0, 'never held, never released');
  r.cfg.slotFree = true;
  r.advance(SLOT_RETRY_MS - 1); await r.svc.tick();
  assert.strictEqual(r.calls.summarize.length, 0);
  r.advance(1); await r.svc.tick();
  assert.strictEqual(r.calls.summarize.length, 1);
  assert.strictEqual(r.calls.release, 1);
  assert.strictEqual(r.svc.snapshot().off, null, 'a busy slot is not an error to show');
});

test('a slot that cannot be made at all is said once in the log; one that is merely held says nothing', async () => {
  const held = rig({ slotFree: false });
  await held.settle();
  assert.ok(!held.log.some(l => /GPU slot/.test(l)), 'held by another host: the ordinary case');
  const broken = rig({ slotFree: false });
  broken.deps.slot.lastError = () => 'EACCES: permission denied';
  const svc = createSummaryService(broken.deps);
  await svc.tick(); broken.advance(QUIET_MS); await svc.tick();
  broken.advance(SLOT_RETRY_MS); await svc.tick();
  broken.advance(SLOT_RETRY_MS); await svc.tick();
  assert.strictEqual(broken.log.filter(l => /GPU slot unavailable: EACCES/.test(l)).length, 1);
});

test('the slot is released even when the job throws, and tick never throws', async () => {
  const r = rig({ summarizeThrows: true });
  await r.settle();
  assert.strictEqual(r.calls.acquire, 1);
  assert.strictEqual(r.calls.release, 1);
  assert.ok(r.log.some(l => /boom/.test(l)));
  assert.strictEqual(r.svc.snapshot().off.reason, 'failed');
});

test('a transcript that cannot be read is a failed job held off a minute, never a crash', async () => {
  const r = rig();
  r.file.throws = true;
  await r.settle();
  assert.strictEqual(r.calls.summarize.length, 0);
  assert.strictEqual(r.calls.release, 0);
  assert.ok(r.log.some(l => /disk gone/.test(l)));
});

test('on battery nothing runs, and the probe is not even asked while nothing is due', async () => {
  const r = rig({ battery: true });
  await r.svc.tick();
  assert.strictEqual(r.calls.battery, 0, 'nothing due yet');
  r.advance(QUIET_MS); await r.svc.tick();
  assert.strictEqual(r.calls.battery, 1);
  assert.strictEqual(r.calls.summarize.length, 0);
  r.cfg.battery = false;
  r.advance(1000); await r.svc.tick();
  assert.strictEqual(r.calls.summarize.length, 1, 'plugged back in: it runs without further typing');
});

test('an unknown power state runs', async () => {
  const r = rig({ battery: null });
  await r.settle();
  assert.strictEqual(r.calls.summarize.length, 1);
});

test('the first tick asks Ollama once whether it is there, so an off Ollama shows before any job', async () => {
  const r = rig({ check: { ok: false, reason: 'unreachable', model: 'llama3.2:3b' } });
  r.file.missing = true;
  await r.svc.tick();
  assert.strictEqual(r.calls.check, 1);
  assert.strictEqual(r.svc.snapshot().off.reason, 'ollama-down');
  r.advance(1000); await r.svc.tick();
  assert.strictEqual(r.calls.check, 1, 'not again inside the minute');
});

test('a healthy Ollama is not polled: the check runs once, then only before a job', async () => {
  const r = rig();
  r.file.missing = true;
  for (let i = 0; i < 20; i++) { await r.svc.tick(); r.advance(RETRY_MS); }
  assert.strictEqual(r.calls.check, 1);
});

test('two ticks at once start one job', async () => {
  const r = rig();
  await r.svc.tick();
  r.advance(QUIET_MS);
  await Promise.all([r.svc.tick(), r.svc.tick(), r.svc.tick()]);
  assert.strictEqual(r.calls.summarize.length, 1);
});

test('a new session (/clear) starts clean: the old one is forgotten and the snapshot follows the new one', async () => {
  const r = rig();
  await r.settle();
  assert.ok(r.svc.snapshot().summary);
  r.cfg.sid = 'sess-2';
  r.file.mtimeMs += 1;
  r.file.text = jl(userLine('n1', 'a fresh start'));
  await r.svc.tick();
  assert.deepStrictEqual(r.svc.snapshot(), { summary: null, off: null });
  assert.deepStrictEqual(last(r), { type: 'summary', summary: null, off: null });
  r.advance(QUIET_MS); await r.svc.tick();
  assert.strictEqual(r.deps.store.get('sess-2').newestKey, 'n1');
  assert.strictEqual(r.deps.store.get(SID).newestKey, 'a1', 'the old session\'s summary is kept on disk');
});

test('a message is broadcast only when what the windows would see changed', async () => {
  const r = rig();
  await r.settle();
  const n = r.broadcasts.length;
  for (let i = 0; i < 5; i++) { r.advance(60_000); await r.svc.tick(); }
  assert.strictEqual(r.broadcasts.length, n);
});

test('a store that cannot persist still shows the summary, and says so in the log', async () => {
  const store = createSummaryStore({ dir: path.join(tmpDir('svc-'), 'x'), rename: () => { throw new Error('EPERM'); } });
  const r = rig({ store });
  await r.settle();
  assert.ok(r.svc.snapshot().summary);
  assert.ok(r.log.some(l => /EPERM/.test(l)));
});

test('the log never carries the conversation', async () => {
  const r = rig({ summarizeThrows: true });
  await r.settle();
  assert.ok(!r.log.some(l => /fix the drawer|Looking at the drawer/.test(l)));
});

// --- readTailFile: the only thing here that touches a transcript, read-only ------------------------------

const tmpFile = (content) => {
  const f = path.join(tmpDir('tail-'), 't.jsonl');
  fs.writeFileSync(f, content);
  return f;
};

test('readTailFile: a small file is read whole', () => {
  const f = tmpFile('line one\nline two\n');
  assert.strictEqual(readTailFile(f, 1024), 'line one\nline two\n');
});

test('readTailFile: a big file gives its last bytes, starting on a line boundary (the cut line is dropped)', () => {
  const lines = Array.from({ length: 200 }, (_, i) => 'row-' + String(i).padStart(4, '0') + '-' + 'x'.repeat(40));
  const f = tmpFile(lines.join('\n') + '\n');
  const out = readTailFile(f, 500);
  assert.ok(out.length <= 500);
  const got = out.split('\n').filter(Boolean);
  assert.ok(got.length >= 5);
  assert.strictEqual(got[got.length - 1], lines[199]);
  for (const g of got) assert.match(g, /^row-\d{4}-x{40}$/);
});

test('readTailFile: a missing or unreadable file is null, not an empty string', () => {
  assert.strictEqual(readTailFile(path.join(os.tmpdir(), 'no-such-dir-xyz', 'a.jsonl'), 100), null);
  assert.strictEqual(readTailFile(os.tmpdir(), 100), null);
});


// --- Dexter F1 (PR #105): the quiet period follows main-session TURNS, not transcript bytes -----------------------------

test('a transcript that grows only by tool lines never resets the quiet clock', async () => {
  const r = rig();
  await r.svc.tick();                                   // the session is seen: its first look counts as a turn
  for (let i = 0; i < 6; i++) { r.advance(10_000); r.grow(jl(toolLine('t' + i))); await r.svc.tick(); }
  assert.strictEqual(r.calls.summarize.length, 1, 'quiet since the first look, in spite of a tool line every 10 s');
});

test('what a change appended is read from where the last look ended, not the whole transcript', async () => {
  const r = rig();
  await r.svc.tick();
  const before = r.file.text.length;
  r.advance(5000); r.grow(jl(toolLine('t1'))); await r.svc.tick();
  assert.deepStrictEqual(r.calls.readFrom, [before]);
});

test('a run that writes a line every 20 s for 60 minutes gets at least one summary, and a new lane gets its first', async () => {
  const r = rig();
  r.file.text = jl(toolLine('t0'));                     // a new lane: nothing said yet
  await r.svc.tick();
  let said = false;
  for (let sec = 5; sec <= 3600; sec += 5) {
    r.advance(5000);
    if (sec % 20 === 0) {
      // a tool line every 20 s, and one assistant text in the middle of the hour
      r.grow(sec === 1800 ? jl(asstLine('mid', 'Halfway: the migration is done.')) : jl(toolLine('t' + sec)));
    }
    await r.svc.tick();
    if (r.svc.snapshot().summary) said = true;
  }
  assert.ok(said, 'a summary was made');
  assert.match(r.calls.summarize[0], /Halfway: the migration is done\./);
  assert.ok(r.calls.summarize.length >= 1);
});

test('even a conversation turn every 20 s for an hour is summarised: the quiet wait is bounded', async () => {
  const r = rig();
  await r.svc.tick();
  let n = 0;
  for (let sec = 5; sec <= 3600; sec += 5) {
    r.advance(5000);
    if (sec % 20 === 0) r.grow(jl(asstLine('m' + (n++), 'Step ' + n + ' done.')));
    await r.svc.tick();
  }
  assert.ok(r.calls.summarize.length >= 20, 'one about every 2 minutes, not none: ' + r.calls.summarize.length);
  assert.ok(r.calls.summarize.length <= 31, 'and never faster than the 2 minute cap: ' + r.calls.summarize.length);
});

test('a transcript that shrank (rewritten) counts as new: nothing can be said about what was appended', async () => {
  const r = rig();
  await r.settle();
  assert.strictEqual(r.calls.summarize.length, 1);
  r.file.text = jl(userLine('z1', 'a rewritten transcript'));
  r.file.mtimeMs += 1;
  r.advance(120_000); await r.svc.tick();
  r.advance(QUIET_MS); await r.svc.tick();
  assert.strictEqual(r.calls.summarize.length, 2);
});

test('readFromFile: what was appended after an offset, on a line boundary', () => {
  const a = 'first line\n';
  const f = tmpFile(a + 'second line\nthird line\n');
  assert.strictEqual(readFromFile(f, a.length), 'second line\nthird line\n');
  assert.strictEqual(readFromFile(f, 0), 'first line\nsecond line\nthird line\n');
  assert.strictEqual(readFromFile(f, a.length + 23), '', 'nothing new');
  assert.strictEqual(readFromFile(f, 10_000), '', 'an offset past the end (a shrunk file) is nothing, not an error');
});

test('readFromFile: an offset in the middle of a line drops that half line, never parses a fragment', () => {
  const f = tmpFile('first line\nsecond line\nthird line\n');
  assert.strictEqual(readFromFile(f, 14), 'third line\n');
});

test('readFromFile: a huge append is read from its last maxBytes, on a line boundary', () => {
  const rows = Array.from({ length: 100 }, (_, i) => 'row-' + String(i).padStart(3, '0') + '-' + 'x'.repeat(30));
  const f = tmpFile(rows.join('\n') + '\n');
  const out = readFromFile(f, 0, 500);
  assert.ok(out.length <= 500);
  const got = out.split('\n').filter(Boolean);
  assert.strictEqual(got[got.length - 1], rows[99]);
  for (const g of got) assert.match(g, /^row-\d{3}-x{30}$/);
});

test('readFromFile: a missing file or a directory is null', () => {
  assert.strictEqual(readFromFile(path.join(os.tmpdir(), 'no-such-dir-xyz', 'a.jsonl'), 0), null);
  assert.strictEqual(readFromFile(os.tmpdir(), 0), null);
});
