'use strict';
/**
 * Kill tests for host/summary-service.js, from Mortimer's gate on release PR #109 (survivor 5): the scheduler
 * bookkeeping around a job. Remove the fail() after a thrown job and a failing Ollama is retried on every tick with the
 * GPU slot taken each time (here: the scheduler is never told the job ended, so it never runs another); remove the
 * clean() after a confirmed summary and a finished session is stuck "running" forever.
 *
 * The rig is the one in test/summary-service.test.js, copied small: every dependency injected, a fake clock.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { createSummaryService, RETRY_MS } = require('../host/summary-service');
const { createScheduler, QUIET_MS } = require('../host/summary-scheduler');
const { createSummaryStore } = require('../host/summary-store');

const SID = 'sess-1';
const jl = (...objs) => objs.map(o => JSON.stringify(o)).join('\n');
const userLine = (uuid, text) => ({ type: 'user', uuid, message: { role: 'user', content: text } });
const asstLine = (uuid, text) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });

function rig(over = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const broadcasts = [];
  const file = { mtimeMs: 1, text: jl(userLine('u1', 'fix the drawer'), asstLine('a1', 'Looking at the drawer now.')) };
  const cfg = { check: { ok: true }, summarize: { ok: true, text: 'Working on: the drawer', ms: 1 }, battery: false, throws: false, ...over };
  const calls = { check: 0, summarize: 0, acquire: 0 };
  const deps = {
    now,
    sessionId: () => SID,
    transcriptFile: (sid) => path.join('X', sid + '.jsonl'),
    stat: () => ({ size: file.text.length, mtimeMs: file.mtimeMs }),
    readFrom: (f, offset) => file.text.slice(offset),
    readTail: () => file.text,
    ollama: {
      check: async () => { calls.check += 1; return cfg.check; },
      summarize: async () => { calls.summarize += 1; if (cfg.throws) throw new Error('boom'); return cfg.summarize; },
    },
    store: over.store || createSummaryStore({ dir: tmpDir('svc-kills-') }),
    scheduler: createScheduler(),
    slot: { tryAcquire: () => { calls.acquire += 1; return true; }, release: () => {}, lastError: () => '' },
    onBattery: async () => cfg.battery,
    broadcast: (m) => broadcasts.push(m),
    log: () => {},
  };
  const svc = createSummaryService(deps);
  const advance = (ms) => { clock.t += ms; };
  const settle = async () => { await svc.tick(); advance(QUIET_MS); await svc.tick(); };
  const grow = (line) => { file.text += '\n' + line; file.mtimeMs += 1; };
  return { svc, cfg, calls, clock, advance, broadcasts, deps, settle, grow };
}

/** Record every call to scheduler[name] (and still make it). */
function spy(scheduler, name) {
  const orig = scheduler[name].bind(scheduler);
  const seen = [];
  scheduler[name] = (...a) => { seen.push(a); return orig(...a); };
  return seen;
}

test('a job that throws tells the scheduler (fail, with RETRY_MS) and is retried after the minute, not before and not never', async () => {
  const r = rig({ throws: true });
  const fails = spy(r.deps.scheduler, 'fail');
  await r.svc.tick();
  r.advance(QUIET_MS);
  const at = r.clock.t;
  await r.svc.tick();
  assert.strictEqual(r.calls.summarize, 1);
  assert.deepStrictEqual(fails, [[SID, at, RETRY_MS]]);
  assert.strictEqual(r.deps.scheduler.running(), null, 'the scheduler was told the job is over');

  r.advance(RETRY_MS - 1); await r.svc.tick();
  assert.strictEqual(r.calls.summarize, 1, 'held off for the minute');
  r.cfg.throws = false;
  r.advance(1); await r.svc.tick();
  assert.strictEqual(r.calls.summarize, 2, 'and then tried again');
  assert.strictEqual(r.svc.snapshot().off, null);
});

test('a summary that was already true (nothing new said) tells the scheduler it is clean and spends no cap', async () => {
  const dir = tmpDir('svc-kills-');
  createSummaryStore({ dir }).put(SID, { text: 'Working on: old', model: 'llama3.2:3b', turnsSeen: 2, newestKey: 'a1' }, 500);
  const r = rig({ store: createSummaryStore({ dir }) });
  const cleans = spy(r.deps.scheduler, 'clean');
  await r.svc.tick();
  r.advance(QUIET_MS);
  const at = r.clock.t;
  await r.svc.tick();
  assert.strictEqual(r.calls.summarize, 0, 'confirmed, not re-summarised');
  assert.deepStrictEqual(cleans, [[SID, at]]);
  assert.strictEqual(r.deps.scheduler.running(), null);

  // The next real message is summarised after the quiet period alone: the confirmation gave the 2 minute cap back.
  r.grow(jl(userLine('u2', 'a real message')));
  r.advance(1000); await r.svc.tick();
  r.advance(QUIET_MS); await r.svc.tick();
  assert.strictEqual(r.calls.summarize, 1);
});

test('Ollama down: the job backs off with RETRY_MS and nothing is summarised or taken from the GPU slot', async () => {
  const r = rig({ check: { ok: false, reason: 'unreachable' } });
  const fails = spy(r.deps.scheduler, 'fail');
  await r.svc.tick();
  r.advance(QUIET_MS);
  const at = r.clock.t;
  await r.svc.tick();
  assert.strictEqual(r.calls.summarize, 0);
  assert.strictEqual(r.calls.acquire, 0);
  assert.deepStrictEqual(fails, [[SID, at, RETRY_MS]]);
  assert.strictEqual(r.svc.snapshot().off.reason, 'ollama-down');
});

test('a healthy Ollama check does not wipe a "failed" note: only a down or missing Ollama note is cleared by it', async () => {
  const r = rig({ summarize: { ok: false, reason: 'bad-reply' } });
  await r.settle();
  assert.strictEqual(r.svc.snapshot().off.reason, 'failed');
  r.advance(RETRY_MS); await r.svc.tick();       // the next job re-checks Ollama (healthy) before failing again
  assert.strictEqual(r.calls.summarize, 2);
  assert.ok(r.broadcasts.length >= 1);
  assert.ok(r.broadcasts.every(m => m.off !== null && m.off.reason === 'failed'),
    'no window ever saw the note disappear in between: ' + JSON.stringify(r.broadcasts.map(m => m.off)));
});

test('on battery the scheduler is never asked to start a job', async () => {
  const r = rig({ battery: true });
  const starts = spy(r.deps.scheduler, 'start');
  await r.settle();
  r.advance(10 * QUIET_MS); await r.svc.tick();
  assert.deepStrictEqual(starts, []);
  assert.strictEqual(r.calls.summarize, 0);
});

test('Ollama coming back clears its "down" note on the minute check alone, even when no job is due (battery)', async () => {
  const r = rig({ check: { ok: false, reason: 'unreachable' } });
  await r.settle();
  assert.strictEqual(r.svc.snapshot().off.reason, 'ollama-down');
  r.cfg.check = { ok: true };
  r.cfg.battery = true;
  r.advance(RETRY_MS); await r.svc.tick();
  assert.strictEqual(r.calls.summarize, 0, 'on battery: no job');
  assert.strictEqual(r.svc.snapshot().off, null, 'but the window no longer says Ollama is down');
  assert.strictEqual(r.broadcasts[r.broadcasts.length - 1].off, null);
});

test('Ollama dying after a failed job is noticed by the job\'s own check: the job stops there and says ollama-down', async () => {
  const r = rig({ summarize: { ok: false, reason: 'bad-reply' } });
  await r.settle();
  assert.strictEqual(r.svc.snapshot().off.reason, 'failed');
  assert.strictEqual(r.calls.summarize, 1);
  r.cfg.check = { ok: false, reason: 'unreachable' };      // the minute check is not run while the note is "failed"
  r.advance(RETRY_MS); await r.svc.tick();
  assert.strictEqual(r.calls.summarize, 1, 'the job found Ollama down and went no further');
  assert.strictEqual(r.calls.acquire, 1, 'no second slot taken');
  assert.strictEqual(r.svc.snapshot().off.reason, 'ollama-down');
});
