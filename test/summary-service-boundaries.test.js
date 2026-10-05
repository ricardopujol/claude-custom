'use strict';
/**
 * Boundary kill tests for host/summary-service.js, from Mortimer's gate on release PR #109 (survivors 6 and 7):
 *   6. the transcript reader's window arithmetic (at `bytes`, at `bytes + 1`, a newline just before the window), that every
 *      file descriptor it opens is closed (after a read, after a failed read), and the tail-size ladder the service climbs;
 *   7. a state is broadcast once, a session switch forgets the old session, a shrunk transcript counts as activity and a
 *      same-size one does not, and the reachability answer is reused only inside its window.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const {
  createSummaryService, readTailFile, readFromFile, TAIL_SIZES, CHECK_REUSE_MS, RETRY_MS, SLOT_RETRY_MS,
} = require('../host/summary-service');
const { createScheduler, QUIET_MS } = require('../host/summary-scheduler');
const { createSummaryStore } = require('../host/summary-store');

const writeTmp = (name, text) => { const f = path.join(tmpDir('svc-bounds-'), name); fs.writeFileSync(f, text); return f; };

// ---------- survivor 6: the reader ----------

test('readTailFile: a file exactly the window size is returned whole, no line dropped', () => {
  const f = writeTmp('a.jsonl', 'abcd\nefghij');                  // 11 bytes
  assert.strictEqual(readTailFile(f, 11), 'abcd\nefghij');
  assert.strictEqual(readTailFile(writeTmp('e.jsonl', ''), 0), '');
});

test('readTailFile: one byte over the window drops the cut first line, and only that one', () => {
  const f = writeTmp('a.jsonl', 'abcd\nefghij');                  // 11 bytes, window 10 starts mid-line
  assert.strictEqual(readTailFile(f, 10), 'efghij');
  const g = writeTmp('b.jsonl', 'ab\ncd\nefghij');                // 12 bytes, window 10 = 'b\ncd\nefghij'
  assert.strictEqual(readTailFile(g, 10), 'cd\nefghij');
});

test('readTailFile: a window that starts exactly on a line start keeps that whole line', () => {
  const f = writeTmp('a.jsonl', 'xy\nabcd\nefgh');                // 12 bytes: a 9 byte window's extra byte is the newline
  assert.strictEqual(readTailFile(f, 9), 'abcd\nefgh');           // the byte before the window is '\n': nothing is cut
  const g = writeTmp('b.jsonl', 'xy\nabcd\nefgh');
  assert.strictEqual(readTailFile(g, 8), 'efgh');                 // ... but a window starting inside 'abcd' loses its partial line
});

test('readTailFile: a window holding only a partial line has no whole line to give', () => {
  assert.strictEqual(readTailFile(writeTmp('a.jsonl', 'abcdefghijk'), 10), '');
});

test('readTailFile: a directory or a missing file is null, not an empty text', () => {
  assert.strictEqual(readTailFile(tmpDir('svc-bounds-'), 10), null);
  assert.strictEqual(readTailFile(path.join(tmpDir('svc-bounds-'), 'nope.jsonl'), 10), null);
});

test('readFromFile: from a line start, from mid-line, from 0, and with the size cap', () => {
  const text = 'line1\nline2\nline3\n';                          // 18 bytes
  const f = writeTmp('a.jsonl', text);
  assert.strictEqual(readFromFile(f, 0), text, 'from the very start: everything');
  assert.strictEqual(readFromFile(f, 6), 'line2\nline3\n', 'the byte before is a newline: the line is whole');
  assert.strictEqual(readFromFile(f, 8), 'line3\n', 'mid-line: the partial line is dropped');
  assert.strictEqual(readFromFile(f, 18), '', 'nothing appended');
  assert.strictEqual(readFromFile(f, 99), '', 'a file shorter than the offset');
  assert.strictEqual(readFromFile(f, 0, 6), 'line3\n', 'cap = exactly the last line');
  assert.strictEqual(readFromFile(f, 0, 7), 'line3\n', 'cap landing inside the previous line drops its tail');
  assert.strictEqual(readFromFile(f, 0, 12), 'line2\nline3\n');
  assert.strictEqual(readFromFile(f, 0, 100), text);
  assert.strictEqual(readFromFile(writeTmp('b.jsonl', 'only one partial'), 5), '', 'no newline after a mid-line start');
  assert.strictEqual(readFromFile(tmpDir('svc-bounds-'), 0), null);
  assert.strictEqual(readFromFile(path.join(tmpDir('svc-bounds-'), 'nope'), 0), null);
});

/** Every fd the reader opens must be the one it closes, however the read ends. */
function watchFds(t) {
  const open = t.mock.method(fs, 'openSync');
  const close = t.mock.method(fs, 'closeSync');
  return () => ({
    opened: open.mock.calls.map(c => c.result),
    closed: close.mock.calls.map(c => c.arguments[0]),
  });
}

test('the readers close every file they open: a whole read, a cut read, a read from an offset', (t) => {
  const small = writeTmp('s.jsonl', 'abcd\nefghij');
  const seen = watchFds(t);
  readTailFile(small, 11);
  readTailFile(small, 5);
  readFromFile(small, 3);
  readFromFile(small, 99);
  const { opened, closed } = seen();
  assert.strictEqual(opened.length, 4);
  assert.deepStrictEqual(closed, opened);
});

test('the readers close the file when the read fails: a directory, and a stat that throws', (t) => {
  const dir = tmpDir('svc-bounds-');
  const f = writeTmp('s.jsonl', 'abcd\nefghij');
  const seen = watchFds(t);
  readTailFile(dir, 5);
  readFromFile(dir, 0);
  t.mock.method(fs, 'fstatSync', () => { throw new Error('boom'); });
  assert.strictEqual(readTailFile(f, 5), null);
  assert.strictEqual(readFromFile(f, 0), null);
  const { opened, closed } = seen();
  assert.ok(opened.length >= 2);
  assert.deepStrictEqual(closed, opened);
});

// ---------- the service rig ----------

const SID = 'sess-1';
const jl = (...objs) => objs.map(o => JSON.stringify(o)).join('\n');
const userLine = (uuid, text) => ({ type: 'user', uuid, message: { role: 'user', content: text } });

function rig(over = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const broadcasts = [];
  const file = { mtimeMs: 1, size: null, added: null, text: jl(userLine('u1', 'fix the drawer'), userLine('u2', 'and the lid')) };
  const cfg = { check: { ok: true }, slot: true, sid: SID, ...over };
  delete cfg.store;
  const calls = { check: 0, summarize: 0, tail: [] };
  const deps = {
    now,
    sessionId: () => cfg.sid,
    transcriptFile: (sid) => path.join('X', sid + '.jsonl'),
    stat: () => ({ size: file.size === null ? file.text.length : file.size, mtimeMs: file.mtimeMs }),
    readFrom: (f, offset) => (file.added !== null ? file.added : file.text.slice(offset)),
    readTail: (f, bytes) => { calls.tail.push(bytes); return file.text; },
    ollama: {
      check: async () => { calls.check += 1; return cfg.check; },
      summarize: async () => { calls.summarize += 1; return { ok: true, text: 'Working on: the drawer', ms: 1 }; },
    },
    store: over.store || createSummaryStore({ dir: tmpDir('svc-bounds-') }),
    scheduler: createScheduler(),
    slot: { tryAcquire: () => cfg.slot, release: () => {}, lastError: () => '' },
    onBattery: async () => false,
    broadcast: (m) => broadcasts.push(m),
    log: () => {},
  };
  const svc = createSummaryService(deps);
  const advance = (ms) => { clock.t += ms; };
  const settle = async () => { await svc.tick(); advance(QUIET_MS); await svc.tick(); };
  const grow = (line) => { file.text += '\n' + line; file.added = line; file.mtimeMs += 1; if (file.size !== null) file.size += line.length; };
  return { svc, cfg, calls, clock, advance, broadcasts, deps, settle, grow, file };
}

function spy(scheduler, name) {
  const orig = scheduler[name].bind(scheduler);
  const seen = [];
  scheduler[name] = (...a) => { seen.push(a); return orig(...a); };
  return seen;
}

/** Three user messages whose flattened transcript is `chars` long: 3 x ('User: ' + text) + 2 separators. */
function transcriptOf(chars) {
  const total = chars - 4 - 3 * 6;                              // the texts' combined length
  const each = Math.floor(total / 3);
  const lens = [each, each, total - 2 * each];
  return jl(...lens.map((n, i) => userLine('m' + i, String.fromCharCode(97 + i).repeat(n))));
}

// ---------- survivor 6: the tail-size ladder ----------

test('a flattened transcript of exactly ENOUGH_CHARS stops the ladder at the first size; one char less climbs on', async () => {
  const enough = rig();
  enough.file.size = 10 * 1024 * 1024;
  enough.file.text = transcriptOf(4000);
  await enough.settle();
  assert.strictEqual(enough.calls.summarize, 1);
  assert.deepStrictEqual(enough.calls.tail, [TAIL_SIZES[0]]);

  const short = rig();
  short.file.size = 10 * 1024 * 1024;
  short.file.text = transcriptOf(3999);
  await short.settle();
  assert.deepStrictEqual(short.calls.tail, TAIL_SIZES);
});

test('a transcript no bigger than the window ends the ladder there: exactly the window, and one byte over', async () => {
  const exact = rig();
  exact.file.size = TAIL_SIZES[0];
  await exact.settle();
  assert.deepStrictEqual(exact.calls.tail, [TAIL_SIZES[0]]);

  const over = rig();
  over.file.size = TAIL_SIZES[0] + 1;
  await over.settle();
  assert.deepStrictEqual(over.calls.tail, [TAIL_SIZES[0], TAIL_SIZES[1]]);
});

test('the next job of a session starts at the size that was enough last time, and never past the largest', async () => {
  const r = rig();
  r.file.size = 10 * 1024 * 1024;                                // bigger than every window, and the text is short
  await r.settle();
  assert.deepStrictEqual(r.calls.tail, TAIL_SIZES);
  r.calls.tail.length = 0;
  r.grow(jl(userLine('u3', 'one more')));
  r.advance(200_000); await r.svc.tick();
  r.advance(200_000); await r.svc.tick(); console.log("DBG", r.calls, r.deps.scheduler.state(SID), r.deps.scheduler.ready(r.clock.t, {}));
  assert.strictEqual(r.calls.summarize, 2);
  assert.deepStrictEqual(r.calls.tail, [TAIL_SIZES[TAIL_SIZES.length - 1]]);
});

// ---------- survivor 7 ----------

test('an unchanged state is broadcast once: a confirmed summary and a repeated "Ollama is down" say nothing new', async () => {
  const store = createSummaryStore({ dir: tmpDir('svc-bounds-') });
  store.put(SID, { text: 'Working on: old', model: 'llama3.2:3b', turnsSeen: 2, newestKey: 'u2' }, 500);
  const same = rig({ store });
  await same.settle();
  assert.strictEqual(same.calls.summarize, 0, 'confirmed, not re-summarised');
  assert.deepStrictEqual(same.broadcasts, [], 'the window already shows this very summary');

  const down = rig({ check: { ok: false, reason: 'unreachable' } });
  await down.settle();
  down.advance(RETRY_MS); await down.svc.tick();                  // the minute check says "down" again
  assert.strictEqual(down.calls.check, 2);
  assert.strictEqual(down.broadcasts.length, 1);
  assert.strictEqual(down.broadcasts[0].off.reason, 'ollama-down');
});

test('switching session forgets the old one in the scheduler, and its tail ladder starts over when it returns', async () => {
  const r = rig();
  const forgets = spy(r.deps.scheduler, 'forget');
  r.file.size = 10 * 1024 * 1024;
  await r.settle();
  assert.deepStrictEqual(forgets, [], 'the first session is not a switch');
  assert.deepStrictEqual(r.calls.tail, TAIL_SIZES);

  r.cfg.sid = 'sess-2';
  await r.svc.tick();
  assert.deepStrictEqual(forgets, [[SID]]);
  r.cfg.sid = SID;
  await r.svc.tick();
  assert.deepStrictEqual(forgets, [[SID], ['sess-2']]);

  r.calls.tail.length = 0;
  r.advance(200_000); await r.svc.tick();
  r.advance(QUIET_MS); await r.svc.tick();
  assert.deepStrictEqual(r.calls.tail, TAIL_SIZES, 'back from the start, not from the size that was enough before the switch');
});

test('a transcript that shrank is activity; one that only changed in time is not', async () => {
  const r = rig();
  const acts = spy(r.deps.scheduler, 'activity');
  await r.settle();
  assert.strictEqual(acts.length, 1, 'the first look');

  r.file.mtimeMs += 5;                                            // touched, same size, nothing appended
  await r.svc.tick();
  assert.strictEqual(acts.length, 1, 'same size is not a turn');

  r.file.text = jl(userLine('u9', 'rewritten'));                  // smaller: rewritten
  r.file.mtimeMs += 5;
  await r.svc.tick();
  assert.strictEqual(acts.length, 2, 'a smaller transcript counts');
});

test('the reachability answer is asked again at exactly CHECK_REUSE_MS, and shared inside the same tick', async () => {
  assert.strictEqual(CHECK_REUSE_MS, SLOT_RETRY_MS);              // the slot-busy retry lands exactly on the boundary
  const r = rig({ slot: false });
  await r.settle();                                               // check 1 (start) and check 2 (the job's, 25 s later)
  assert.strictEqual(r.calls.check, 2);
  r.advance(SLOT_RETRY_MS - 1); await r.svc.tick();               // still held off
  assert.strictEqual(r.calls.check, 2);
  r.advance(1); await r.svc.tick();                               // the retry: the last answer is exactly CHECK_REUSE_MS old
  assert.strictEqual(r.calls.check, 3, 'an answer exactly CHECK_REUSE_MS old is not reused');

  const down = rig({ check: { ok: false, reason: 'unreachable' } });
  await down.settle();
  assert.strictEqual(down.calls.check, 1, 'the job reused the "down" answer from 25 s ago');
  down.cfg.check = { ok: true };
  down.advance(RETRY_MS); await down.svc.tick();
  assert.strictEqual(down.calls.summarize, 1);
  assert.strictEqual(down.calls.check, 2, 'the minute check and the job right behind it share one answer');
});
