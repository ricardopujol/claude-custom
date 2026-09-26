'use strict';
/**
 * The top-bar control panel's pure decisions: which model FAMILY an id
 * belongs to, what colour that family gets, and whether a pending /model or
 * /effort switch has been confirmed, refused, or timed out.
 *
 * Kept out of renderer.js for the reason app/quota-display.js and
 * app/career-display.js are: a decision living inside a browser script is a
 * decision nothing can test. See test/renderer-scope.test.js for the IIFE/
 * global-scope contract this file must also satisfy.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  modelFamily, cueColour, pendingResolver, topBarState, topBarDisplay,
  MODEL_CHOICES, EFFORT_LEVELS, PENDING_TIMEOUT_MS,
} = require('../app/top-bar-display');

// --- modelFamily -------------------------------------------------------------

test('modelFamily recognises the three Anthropic families by substring, case-insensitive', () => {
  assert.strictEqual(modelFamily('opus'), 'opus');
  assert.strictEqual(modelFamily('claude-opus-5'), 'opus');
  assert.strictEqual(modelFamily('CLAUDE-OPUS-5'), 'opus');
  assert.strictEqual(modelFamily('sonnet'), 'sonnet');
  assert.strictEqual(modelFamily('sonnet[1m]'), 'sonnet');
  assert.strictEqual(modelFamily('claude-sonnet-4-5-20250929'), 'sonnet');
  assert.strictEqual(modelFamily('haiku'), 'haiku');
  assert.strictEqual(modelFamily('claude-haiku-4'), 'haiku');
});

test('modelFamily maps anything non-Anthropic to "other"', () => {
  assert.strictEqual(modelFamily('gpt-5'), 'other');
  assert.strictEqual(modelFamily('gemini-2.5-pro'), 'other');
  assert.strictEqual(modelFamily('some-custom-id'), 'other');
});

test('modelFamily is null for absence, never a guess', () => {
  assert.strictEqual(modelFamily(null), null);
  assert.strictEqual(modelFamily(undefined), null);
  assert.strictEqual(modelFamily(''), null);
});

test('modelFamily is TOTAL and never throws on garbage', () => {
  // Property: whatever arrives, this returns one of the five known answers
  // and never raises. `model` is read off a hook payload PR-A has not
  // shipped yet, and this file must survive its shape being wrong.
  const garbage = [
    0, 1, -1, NaN, Infinity, -Infinity, true, false,
    {}, [], [1, 2], () => {}, Symbol('x'), new Date(), /re/,
    '   ', '\n\t', 'OPUS'.repeat(1000), null, undefined,
  ];
  const allowed = new Set(['opus', 'sonnet', 'haiku', 'other', null]);
  for (const g of garbage) {
    let result;
    assert.doesNotThrow(() => { result = modelFamily(g); }, `threw on ${String(g)}`);
    assert.ok(allowed.has(result), `modelFamily(${String(g)}) returned ${String(result)}`);
  }
});

// --- cueColour ---------------------------------------------------------------

const THEME = { chrome: { accent: '#d08c4a' } };

test('cueColour maps each known family to its fixed colour, independent of theme', () => {
  const opus = cueColour('opus', THEME);
  const sonnet = cueColour('sonnet', THEME);
  const haiku = cueColour('haiku', THEME);
  const other = cueColour('other', THEME);
  // All four are distinct, and none of them is the theme's accent -- the cue
  // is supposed to mean the same thing in every project.
  const set = new Set([opus, sonnet, haiku, other]);
  assert.strictEqual(set.size, 4, 'the four family colours must be distinct');
  for (const c of set) assert.notStrictEqual(c, THEME.chrome.accent);
});

test('cueColour for unknown is the theme default accent, BYTE-EQUAL', () => {
  assert.strictEqual(cueColour(null, THEME), THEME.chrome.accent);
  const other = { chrome: { accent: '#123456' } };
  assert.strictEqual(cueColour(null, other), '#123456');
});

test('cueColour never throws when the theme is missing or malformed', () => {
  assert.doesNotThrow(() => cueColour(null, null));
  assert.doesNotThrow(() => cueColour(null, {}));
  assert.doesNotThrow(() => cueColour('opus', undefined));
  assert.strictEqual(typeof cueColour(null, undefined), 'string');
});

// --- pendingResolver -----------------------------------------------------------

test('a matching truth message resolves pending to "applied"', () => {
  const pending = { kind: 'model', value: 'sonnet', startedAt: 1000 };
  const res = pendingResolver(pending, { type: 'truth', kind: 'model', matches: true });
  assert.strictEqual(res.result, 'applied');
  assert.strictEqual(res.pending, null);
});

test('a non-matching truth message resolves pending to "rejected", not silently kept', () => {
  const pending = { kind: 'model', value: 'sonnet', startedAt: 1000 };
  const res = pendingResolver(pending, { type: 'truth', kind: 'model', matches: false });
  assert.strictEqual(res.result, 'rejected');
  assert.strictEqual(res.pending, null);
});

test('a truth message for a DIFFERENT kind does not touch this pending switch', () => {
  const pending = { kind: 'model', value: 'sonnet', startedAt: 1000 };
  const res = pendingResolver(pending, { type: 'truth', kind: 'effort', matches: true });
  assert.strictEqual(res.result, null);
  assert.strictEqual(res.pending, pending);
});

test('a timeout before the deadline changes nothing', () => {
  const pending = { kind: 'effort', value: 'high', startedAt: 1000 };
  const res = pendingResolver(pending, { type: 'timeout', kind: 'effort', now: 1000 + PENDING_TIMEOUT_MS - 1, timeoutMs: PENDING_TIMEOUT_MS });
  assert.strictEqual(res.result, null);
  assert.strictEqual(res.pending, pending);
});

test('a timeout at or past the deadline resolves to "timeout", never "applied"', () => {
  const pending = { kind: 'effort', value: 'high', startedAt: 1000 };
  const res = pendingResolver(pending, { type: 'timeout', kind: 'effort', now: 1000 + PENDING_TIMEOUT_MS, timeoutMs: PENDING_TIMEOUT_MS });
  assert.strictEqual(res.result, 'timeout');
  assert.strictEqual(res.pending, null);
});

test('nothing pending is a no-op, whatever event arrives', () => {
  assert.deepStrictEqual(pendingResolver(null, { type: 'truth', kind: 'model', matches: true }), { pending: null, result: null });
  assert.deepStrictEqual(pendingResolver(null, { type: 'timeout', kind: 'model', now: 999999, timeoutMs: 1 }), { pending: null, result: null });
});

test('PROPERTY: pending never resolves to "applied" from a timeout event, whatever the timing', () => {
  // This is the property the picker's "never flips optimistically" rule
  // depends on: the ONLY route to "applied" is an explicit truth message that
  // matches. A generous sweep of clock values must never find a counterexample.
  const pending = { kind: 'model', value: 'opus', startedAt: 5000 };
  for (let now = 0; now <= 5000 + PENDING_TIMEOUT_MS * 3; now += 137) {
    for (const timeoutMs of [0, 1, PENDING_TIMEOUT_MS, PENDING_TIMEOUT_MS * 2]) {
      const res = pendingResolver(pending, { type: 'timeout', kind: 'model', now, timeoutMs });
      assert.notStrictEqual(res.result, 'applied', `now=${now} timeoutMs=${timeoutMs}`);
    }
  }
});

test('PROPERTY: a truth event only ever produces "applied" or "rejected", never "timeout"', () => {
  for (const matches of [true, false]) {
    for (const kind of ['model', 'effort']) {
      const pending = { kind, value: 'x', startedAt: 0 };
      const res = pendingResolver(pending, { type: 'truth', kind, matches });
      assert.notStrictEqual(res.result, 'timeout');
      assert.strictEqual(res.result, matches ? 'applied' : 'rejected');
    }
  }
});

// --- topBarState ---------------------------------------------------------------

test('topBarState renders "—" for a model and effort that are not known yet', () => {
  const s = topBarState({ model: null, effort: null, theme: THEME });
  assert.strictEqual(s.model.label, '—');
  assert.strictEqual(s.model.family, null);
  assert.strictEqual(s.effort.label, '—');
  assert.strictEqual(s.model.pending, false);
  assert.strictEqual(s.effort.pending, false);
});

test('topBarState carries the known model and effort through unchanged', () => {
  const s = topBarState({ model: 'claude-opus-5', effort: 'high', theme: THEME });
  assert.strictEqual(s.model.label, 'claude-opus-5');
  assert.strictEqual(s.model.family, 'opus');
  assert.strictEqual(s.effort.label, 'high');
});

test('topBarState marks a chip pending and carries the REQUESTED value as the label', () => {
  const pendingModel = { kind: 'model', value: 'sonnet', startedAt: 0 };
  const s = topBarState({ model: 'claude-opus-5', effort: null, pendingModel, theme: THEME });
  assert.strictEqual(s.model.pending, true);
  assert.strictEqual(s.model.pendingLabel, 'sonnet');
  // The truth is not overwritten by the request -- "never flips
  // optimistically" means the last KNOWN value stays available too.
  assert.strictEqual(s.model.label, 'claude-opus-5');
});

test('topBarState computes the accent from the CURRENT model, not a pending one', () => {
  const pendingModel = { kind: 'model', value: 'opus', startedAt: 0 };
  const s = topBarState({ model: 'claude-sonnet-4-5', effort: null, pendingModel, theme: THEME });
  assert.strictEqual(s.accent, cueColour('sonnet', THEME));
});

test('topBarState never throws on a missing theme', () => {
  assert.doesNotThrow(() => topBarState({}));
  assert.doesNotThrow(() => topBarState());
});

// --- topBarDisplay (DOM writer, exercised against a fake element) --------------

function fakeChip() {
  const classes = new Set();
  return {
    textContent: '',
    title: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      has: (c) => classes.has(c),
    },
  };
}

test('topBarDisplay writes the label and adds a pending class only while pending', () => {
  const modelEl = fakeChip();
  const effortEl = fakeChip();
  const known = topBarState({ model: 'claude-sonnet-4-5', effort: 'high', theme: THEME });
  topBarDisplay({ modelEl, effortEl }, known);
  assert.strictEqual(modelEl.textContent, 'claude-sonnet-4-5');
  assert.strictEqual(modelEl.classList.has('pending'), false);
  assert.strictEqual(effortEl.textContent, 'high');

  const pendingModel = { kind: 'model', value: 'opus', startedAt: 0 };
  const pending = topBarState({ model: 'claude-sonnet-4-5', effort: 'high', pendingModel, theme: THEME });
  topBarDisplay({ modelEl, effortEl }, pending);
  assert.strictEqual(modelEl.classList.has('pending'), true);
  assert.match(modelEl.textContent, /opus/);
});

test('topBarDisplay tolerates missing elements, e.g. before the DOM is ready', () => {
  assert.doesNotThrow(() => topBarDisplay({}, topBarState({})));
  assert.doesNotThrow(() => topBarDisplay(null, topBarState({})));
});

// --- the vocabulary the picker offers -------------------------------------------

test('MODEL_CHOICES and EFFORT_LEVELS are the measured, in-session vocabularies', () => {
  // Measured 2026-09-23 against claude 2.1.280: aliases opus/sonnet/haiku plus
  // a free-text id for /model; the six /effort levels (ultracode is gated and
  // deliberately excluded here).
  assert.deepStrictEqual(MODEL_CHOICES, ['opus', 'sonnet', 'haiku']);
  assert.deepStrictEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
});

test('every model choice maps to its own family, not "other"', () => {
  for (const choice of MODEL_CHOICES) {
    assert.strictEqual(modelFamily(choice), choice);
  }
});

// --- the real sessionModel contract (PR #34, merged 185ebd4) ------------------
//
// FF12 was written before #34 merged and assumed `sessionModel.model`. The real
// shape is `{ session: { model, at }, agents, errors }` -- on hello's
// `sessionModel` AND on the `sessionModel` broadcast, which carries the same
// fields at top level. Reading the assumed shape left the chip at "—" forever.

const { mainModelOf } = require('../app/top-bar-display');

test('mainModelOf: reads session.model from the real #34 shape', () => {
  assert.strictEqual(mainModelOf({ session: { model: 'claude-opus-5', at: 't' }, agents: {}, errors: 0 }), 'claude-opus-5');
  // the broadcast message: same fields, plus `type`
  assert.strictEqual(mainModelOf({ type: 'sessionModel', session: { model: 'claude-sonnet-5' } }), 'claude-sonnet-5');
});

test('mainModelOf: the OLD assumed shape is not the contract -- null, not a match', () => {
  assert.strictEqual(mainModelOf({ model: 'claude-opus-5' }), null);
});

test('mainModelOf: absence is null, never a guessed or empty model', () => {
  for (const x of [undefined, null, {}, { session: null }, { session: {} },
    { session: { model: null } }, { session: { model: '' } }, { session: { model: 42 } }, 'claude-opus-5']) {
    assert.strictEqual(mainModelOf(x), null, JSON.stringify(x));
  }
});
