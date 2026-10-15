'use strict';
/**
 * BACKLOG #33 gamification: the Ask explainer's live state, in the agents' vocabulary (sleeping / working with a reading or writing
 * detail / happy / stressed) and on the mood machine's timings (idle 90 s, flash 8 s).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createExplainer } = require('../host/ask-explainer');
const mood = require('../host/mood-machine');

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}
function setup(opts = {}) {
  const c = clock();
  const e = createExplainer({ now: c.now, ...opts });
  const seen = [];
  e.on('change', (s) => seen.push(s));
  return { c, e, seen };
}
const look = (e) => { const s = e.snapshot(); return `${s.state}/${s.detail}`; };

test('it uses the mood machine\'s own idle and flash timings', () => {
  assert.strictEqual(mood.IDLE_MS, 90_000);
  assert.strictEqual(mood.FLASH_MS, 8_000);
  const { c, e } = setup();
  const t = e.begin();
  e.end(t, { ok: false, reason: 'ollama-down' });
  c.advance(mood.IDLE_MS);
  e.tick();
  assert.strictEqual(look(e), 'stressed/stressed', 'still stressed at exactly the idle limit');
  c.advance(1);
  e.tick();
  assert.strictEqual(look(e), 'sleeping/sleeping');
  e.placeOpened();
  c.advance(mood.FLASH_MS);
  assert.strictEqual(look(e), 'happy/happy');
  c.advance(1);
  assert.strictEqual(look(e), 'resting/resting');
});

test('a fresh explainer is asleep with no panel open', () => {
  assert.deepStrictEqual(setup().e.snapshot(), { state: 'sleeping', detail: 'sleeping', panels: 0 });
});

test('a search is working/reading; the wait for the answer and the answer itself are working/writing', () => {
  const { e } = setup();
  const t = e.begin();
  assert.strictEqual(look(e), 'working/reading');
  e.stage(t, 'queued');
  assert.strictEqual(look(e), 'working/writing');
  e.stage(t, 'writing');
  assert.strictEqual(look(e), 'working/writing');
  e.end(t, { ok: true });
  assert.strictEqual(look(e), 'resting/resting', 'a good answer is calm: happy is for opening a place');
});

test('writing outranks reading while two asks overlap', () => {
  const { e } = setup();
  const a = e.begin();
  const b = e.begin();
  e.stage(b, 'writing');
  assert.strictEqual(look(e), 'working/writing');
  e.end(b, { ok: true });
  assert.strictEqual(look(e), 'working/reading');
  e.end(a, { ok: true });
  assert.strictEqual(look(e), 'resting/resting');
});

test('opening a place makes it happy for 8 s, then it sleeps', () => {
  const { c, e } = setup();
  e.placeOpened();
  assert.strictEqual(look(e), 'happy/happy');
  c.advance(7_999);
  assert.strictEqual(look(e), 'happy/happy');
  c.advance(2);
  assert.strictEqual(look(e), 'resting/resting');
});

test('a failed answer is stressed until the next good answer', () => {
  const { c, e } = setup();
  const t = e.begin();
  e.stage(t, 'writing');
  e.end(t, { ok: false, reason: 'ollama-down' });
  assert.strictEqual(look(e), 'stressed/stressed');
  c.advance(60_000);
  assert.strictEqual(look(e), 'stressed/stressed');
  const t2 = e.begin();
  assert.strictEqual(look(e), 'working/reading', 'a new attempt is work, not stress');
  e.end(t2, { ok: true });
  assert.strictEqual(look(e), 'resting/resting');
});

test('stress also clears after 90 s idle, counted from the last activity', () => {
  const { c, e } = setup();
  e.end(e.begin(), { ok: false, reason: 'claude-failed' });
  c.advance(50_000);
  e.placeOpened();                // activity: the idle clock restarts
  c.advance(8_001);               // the flash is over
  c.advance(60_000);
  assert.strictEqual(look(e), 'stressed/stressed');
  c.advance(30_000);
  assert.strictEqual(look(e), 'sleeping/sleeping');
});

test('opening a place on a failed answer is happy for 8 s, then stressed again', () => {
  const { c, e } = setup();
  e.end(e.begin(), { ok: false, reason: 'ollama-down' });
  e.placeOpened();
  assert.strictEqual(look(e), 'happy/happy');
  c.advance(8_001);
  assert.strictEqual(look(e), 'stressed/stressed');
});

test('a refusal of bad input is not a failed answer', () => {
  for (const reason of ['empty-question', 'bad-selection', 'explainer-off', 'bad-message', 'unknown-op', 'index-building']) {
    const { e } = setup();
    e.end(e.begin(), { ok: false, reason });
    assert.strictEqual(look(e), 'resting/resting', reason);
  }
});

test('any other failure reason stresses it, including a missing reason', () => {
  for (const reason of ['not-signed-in', 'claude-failed', 'ollama-down', 'model-missing', 'host-error', undefined]) {
    const { e } = setup();
    e.end(e.begin(), { ok: false, reason });
    assert.strictEqual(look(e), 'stressed/stressed', String(reason));
  }
});

test('a search that was never followed by an answer request is dropped quietly after the retrieval\'s own 60 s', () => {
  const { c, e } = setup();
  const t = e.begin();
  e.stage(t, 'queued');
  c.advance(59_000);
  e.tick();
  assert.strictEqual(look(e), 'working/writing');
  c.advance(2_000);
  e.tick();
  assert.strictEqual(look(e), 'resting/resting');
  e.end(t, { ok: true });         // a late end for a dropped run changes nothing and doesn't throw
  assert.strictEqual(look(e), 'resting/resting');
});

test('a running answer is never expired by the queue clock', () => {
  const { c, e } = setup();
  const t = e.begin();
  e.stage(t, 'writing');
  c.advance(10 * 60_000);
  e.tick();
  assert.strictEqual(look(e), 'working/writing');
});

test('panels are counted per viewer, open and close are idempotent, and a dropped viewer stops counting', () => {
  const { e } = setup();
  const w1 = {};
  const w2 = {};
  e.setPanel(w1, true);
  e.setPanel(w1, true);
  e.setPanel(w2, true);
  assert.strictEqual(e.snapshot().panels, 2);
  e.setPanel(w1, false);
  e.setPanel(w1, false);
  assert.strictEqual(e.snapshot().panels, 1);
  e.dropViewer(w2);
  assert.strictEqual(e.snapshot().panels, 0);
});

test('it emits "change" only when what is shown changes', () => {
  const { c, e, seen } = setup();
  const t = e.begin();
  assert.strictEqual(seen.length, 1);
  e.stage(t, 'searching');                  // same look: no event
  assert.strictEqual(seen.length, 1);
  e.stage(t, 'writing');
  e.end(t, { ok: true });
  assert.deepStrictEqual(seen.map(s => s.detail), ['reading', 'writing', 'resting']);
  e.setPanel({}, true);
  assert.strictEqual(seen.at(-1).panels, 1);
  e.placeOpened();
  c.advance(9_000);
  e.tick();
  assert.deepStrictEqual(seen.slice(-2).map(s => s.state), ['happy', 'resting']);
});

test('ending an unknown token, or one twice, is harmless', () => {
  const { e } = setup();
  e.end(999, { ok: true });
  const t = e.begin();
  e.end(t, { ok: false, reason: 'ollama-down' });
  e.end(t, { ok: true });
  assert.strictEqual(look(e), 'stressed/stressed', 'the second end did not count as a good answer');
  e.stage(12345, 'writing');
  assert.strictEqual(look(e), 'stressed/stressed');
});

test('PROPERTY: whatever happens, the state is one of the four, the detail fits it, and everything settles to sleeping with time', () => {
  const OPS = ['begin', 'queue', 'write', 'ok', 'fail', 'open', 'tick', 'wait'];
  fc.assert(fc.property(fc.array(fc.constantFrom(...OPS), { maxLength: 60 }), (ops) => {
    const { c, e } = setup();
    const toks = [];
    const FITS = { sleeping: ['sleeping'], resting: ['resting'], happy: ['happy'], stressed: ['stressed'], working: ['reading', 'writing'] };
    for (const op of ops) {
      if (op === 'begin') toks.push(e.begin());
      else if (op === 'queue' && toks.length) e.stage(toks[0], 'queued');
      else if (op === 'write' && toks.length) e.stage(toks[0], 'writing');
      else if (op === 'ok' && toks.length) e.end(toks.shift(), { ok: true });
      else if (op === 'fail' && toks.length) e.end(toks.shift(), { ok: false, reason: 'ollama-down' });
      else if (op === 'open') e.placeOpened();
      else if (op === 'tick') e.tick();
      else if (op === 'wait') c.advance(20_000);
      const s = e.snapshot();
      assert.ok(Object.hasOwn(FITS, s.state), s.state);
      assert.ok(FITS[s.state].includes(s.detail), `${s.state}/${s.detail}`);
    }
    for (const t of toks) e.end(t, { ok: true });
    c.advance(5 * 60_000);
    e.tick();
    assert.strictEqual(look(e), 'sleeping/sleeping');
  }), { numRuns: 80 });
});

// --- PR #178 review fixes ----------------------------------------------------------------------------------------------------------

test('Miguel I4: after its work it stays awake (resting) and sleeps only after 90 s of idle; every new activity restarts the clock', () => {
  const { c, e } = setup();
  e.end(e.begin(), { ok: true });
  assert.strictEqual(look(e), 'resting/resting');
  c.advance(mood.IDLE_MS);
  assert.strictEqual(look(e), 'resting/resting', 'still awake at exactly the idle limit');
  c.advance(1);
  assert.strictEqual(look(e), 'sleeping/sleeping');
  e.end(e.begin(), { ok: true });
  c.advance(60_000);
  e.placeOpened();                   // activity
  c.advance(mood.FLASH_MS + 1);
  assert.strictEqual(look(e), 'resting/resting', 'the flash ends in the calm state, not in sleep');
  c.advance(mood.IDLE_MS);
  assert.strictEqual(look(e), 'sleeping/sleeping');
});

test('Dexter F2: a place opened while the answer is still being written plays its happy flash when the answer lands (8 s from the landing)', () => {
  const { c, e } = setup();
  const t = e.begin();
  e.stage(t, 'writing');
  c.advance(1_000);
  e.placeOpened();
  assert.strictEqual(look(e), 'working/writing', 'working outranks it while the answer is written');
  c.advance(11_000);
  e.end(t, { ok: true });
  assert.strictEqual(look(e), 'happy/happy');
  c.advance(mood.FLASH_MS);
  assert.strictEqual(look(e), 'happy/happy');
  c.advance(1);
  assert.strictEqual(look(e), 'resting/resting');
});

test('Dexter F2: the deferred flash also plays when the run is dropped by the queue clock, and when the answer failed (happy outranks stressed)', () => {
  const a = setup();
  const t = a.e.begin();
  a.e.stage(t, 'queued');
  a.e.placeOpened();
  a.c.advance(61_000);
  a.e.tick();
  assert.strictEqual(look(a.e), 'happy/happy');
  const b = setup();
  const u = b.e.begin();
  b.e.placeOpened();
  b.e.end(u, { ok: false, reason: 'ollama-down' });
  assert.strictEqual(look(b.e), 'happy/happy');
  b.c.advance(mood.FLASH_MS + 1);
  assert.strictEqual(look(b.e), 'stressed/stressed');
});

test('Dexter F2: a flash waits only once: a place opened while idle is happy at once, and the deferred one is spent', () => {
  const { c, e } = setup();
  e.placeOpened();
  c.advance(mood.FLASH_MS + 1);
  const t = e.begin();
  e.end(t, { ok: true });
  assert.strictEqual(look(e), 'resting/resting', 'nothing left over from the earlier flash');
});

test('Miguel I1: stage says whether the run was still known, and the queue clock is at least the retrieval\'s own TTL', () => {
  const { c, e } = setup();
  const t = e.begin();
  assert.strictEqual(e.stage(t, 'queued'), true);
  assert.strictEqual(e.stage(99999, 'writing'), false);
  assert.strictEqual(e.stage(t, 'nonsense'), false);
  c.advance(70_000);
  e.tick();
  assert.strictEqual(e.stage(t, 'writing'), false, 'dropped by then');
  const { QUEUED_MS } = require('../host/ask-explainer');
  const { RETRIEVAL_TTL_MS } = require('../host/ask-service');
  assert.ok(QUEUED_MS >= RETRIEVAL_TTL_MS, 'the explainer must not forget a run the service still remembers');
});

test('Dexter F1: a reply about the INPUT (no matches, with or without "building") is not a failed answer; the excuse is the page\'s own input-verdict class', () => {
  const S = require('../app/ask-panel-state');
  const { NOT_A_FAILURE } = require('../host/ask-explainer');
  for (const reason of ['no-matches', 'empty-question', 'bad-selection', 'explainer-off', 'index-building']) {
    assert.ok(S.INPUT_VERDICTS.includes(reason), reason);
    const { e } = setup();
    e.end(e.begin(), { ok: false, reason });
    assert.notStrictEqual(e.snapshot().state, 'stressed', reason);
  }
  for (const r of S.INPUT_VERDICTS) assert.ok(NOT_A_FAILURE.has(r), r);
  // the class is exactly the replies the page answers with no way out and no cause in a model, Ollama or sign-in
  for (const r of S.INPUT_VERDICTS) assert.deepStrictEqual(S.noticeOf({ reason: r }, {}).actions, [], r);
  for (const r of ['ollama-down', 'model-missing', 'timeout', 'not-signed-in', 'claude-failed', 'claude-missing', 'bad-reply', 'http', 'index-failed']) assert.ok(!NOT_A_FAILURE.has(r), r);
});
