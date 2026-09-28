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
const fc = require('fast-check');

const {
  modelFamily, cueColour, pendingResolver, topBarState, topBarDisplay,
  MODEL_CHOICES, EFFORT_LEVELS, PENDING_TIMEOUT_MS,
  modelMatches, effortMatches, validModelInput, inputState, planSwitch, switchNotice,
  vimInsertShown, commandTyped, menuPlacement,
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
  const allowed = new Set(['fable', 'opus', 'sonnet', 'haiku', 'other', null]);
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
  const fable = cueColour('fable', THEME);
  // All five are distinct, and none of them is the theme's accent -- the cue
  // is supposed to mean the same thing in every project.
  const set = new Set([fable, opus, sonnet, haiku, other]);
  assert.strictEqual(set.size, 5, 'the five family colours must be distinct');
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

test('a matching truth message newer than the request resolves pending to "applied"', () => {
  const pending = { kind: 'model', value: 'sonnet', startedAt: 1000 };
  const res = pendingResolver(pending, { type: 'truth', kind: 'model', matches: true, at: 1500 });
  assert.strictEqual(res.result, 'applied');
  assert.strictEqual(res.pending, null);
});

test('a NON-matching truth keeps waiting: it may be a status that predates the switch', () => {
  // Dexter #2: a truth naming the OLD model used to resolve "rejected" on a
  // switch that then succeeded. The only honest failure is the timeout.
  const pending = { kind: 'model', value: 'sonnet', startedAt: 1000 };
  const res = pendingResolver(pending, { type: 'truth', kind: 'model', matches: false, at: 1500 });
  assert.strictEqual(res.result, null);
  assert.strictEqual(res.pending, pending);
});

test('a truth OLDER than the request cannot confirm it, even if it matches', () => {
  // Dexter #1: opus-4-5 -> opus-4-7, "confirmed" by a stale truth.
  const pending = { kind: 'model', value: 'sonnet', startedAt: 1000 };
  const res = pendingResolver(pending, { type: 'truth', kind: 'model', matches: true, at: 999 });
  assert.strictEqual(res.result, null);
  assert.strictEqual(res.pending, pending);
});

test('a truth with no timestamp cannot confirm anything: absence is not "newer"', () => {
  const pending = { kind: 'model', value: 'sonnet', startedAt: 1000 };
  for (const at of [undefined, null, '2000', NaN]) {
    const res = pendingResolver(pending, { type: 'truth', kind: 'model', matches: true, at });
    assert.strictEqual(res.result, null, String(at));
  }
});

test('a truth message for a DIFFERENT kind does not touch this pending switch', () => {
  const pending = { kind: 'model', value: 'sonnet', startedAt: 1000 };
  const res = pendingResolver(pending, { type: 'truth', kind: 'effort', matches: true, at: 2000 });
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

test('PROPERTY: a truth resolves "applied" exactly when it matches AND is not older than the request', () => {
  for (const matches of [true, false]) {
    for (const kind of ['model', 'effort']) {
      for (let at = 0; at <= 2000; at += 250) {
        const pending = { kind, value: 'x', startedAt: 1000 };
        const res = pendingResolver(pending, { type: 'truth', kind, matches, at });
        const applied = matches && at >= 1000;
        assert.strictEqual(res.result, applied ? 'applied' : null, `${kind} ${matches} at=${at}`);
        assert.strictEqual(res.pending, applied ? null : pending);
      }
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
  // deliberately excluded here). `fable` added 2026-09-28: claude 2.1.283
  // accepts it as an alias (verify/probe-model-list.js), newest first.
  assert.deepStrictEqual(MODEL_CHOICES, ['fable', 'opus', 'sonnet', 'haiku']);
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

// --- modelMatches / effortMatches ---------------------------------------------

test('an alias from the menu matches any id of its own family', () => {
  assert.strictEqual(modelMatches('claude-sonnet-5', 'sonnet'), true);
  assert.strictEqual(modelMatches('claude-opus-5-5', 'opus'), true);
  assert.strictEqual(modelMatches('claude-haiku-4-5-20251001', 'HAIKU'), true);
  assert.strictEqual(modelMatches('claude-opus-5-5', 'sonnet'), false);
});

// Miguel, PR #62, #1: modelMatches is what decides whether a switch to fable
// CONFIRMS. Without the fable family it read as 'other' and the switch timed
// out as refused although the CLI had made it.
test('a switch to fable confirms on a fable id, and on nothing else', () => {
  assert.strictEqual(modelMatches('claude-fable-5-1', 'fable'), true);
  assert.strictEqual(modelMatches('claude-fable-5-1', 'FABLE'), true);
  assert.strictEqual(modelMatches('claude-opus-5-5', 'fable'), false);
  assert.strictEqual(modelMatches('claude-fable-5-1', 'opus'), false);
});

test('a free-typed id matches only EXACTLY, never by family (Dexter #1, #5)', () => {
  assert.strictEqual(modelMatches('claude-opus-4-7', 'claude-opus-4-7'), true);
  assert.strictEqual(modelMatches('Claude-Opus-4-7', 'claude-opus-4-7'), true);
  assert.strictEqual(modelMatches('claude-opus-4-5', 'claude-opus-4-7'), false);
  assert.strictEqual(modelMatches('deepseek/deepseek-chat', 'moonshotai/kimi-k2'), false);
});

test('PROPERTY: two distinct non-menu ids never match each other', () => {
  const ids = ['gpt-5', 'moonshotai/kimi-k2', 'deepseek/deepseek-chat', 'claude-opus-4-5',
    'claude-opus-4-7', 'claude-sonnet-5', 'sonnet[1m]', 'x'];
  for (const a of ids) {
    for (const b of ids) {
      assert.strictEqual(modelMatches(a, b), a === b, `${a} vs ${b}`);
    }
  }
});

test('an absent truth never matches', () => {
  for (const t of [null, undefined, '', 7]) {
    assert.strictEqual(modelMatches(t, 'sonnet'), false, String(t));
    assert.strictEqual(effortMatches(t, 'high'), false, String(t));
  }
});

test('effort matches case-insensitively and exactly', () => {
  assert.strictEqual(effortMatches('high', 'HIGH'), true);
  assert.strictEqual(effortMatches('xhigh', 'high'), false);
});

// --- validModelInput (Miguel #1) ------------------------------------------------

test('a model id is accepted only from its own alphabet', () => {
  for (const ok of ['claude-opus-4-7', 'sonnet[1m]', 'moonshotai/kimi-k2', 'us.anthropic.claude-x:0',
    '  claude-sonnet-5  ']) {
    const r = validModelInput(ok);
    assert.strictEqual(r.ok, true, ok);
    assert.strictEqual(r.value, ok.trim());
  }
});

test('an embedded CR, LF or any control character refuses the whole value: no second command', () => {
  const bad = ['sonnet\r/permissions bypass', 'sonnet\n/exit', 'a\x1b[Zb', 'a\x15b',
    'a\x00b', 'a\tb', 'a b', 'a;b', 'a&b', 'a|b', 'a"b', "a'b", 'a`b', 'a$b', 'a b'];
  for (const v of bad) {
    const r = validModelInput(v);
    assert.strictEqual(r.ok, false, JSON.stringify(v));
    assert.ok(r.reason, 'a refusal says why');
  }
});

test('empty, overlong and non-string input is refused', () => {
  for (const v of ['', '   ', 'a'.repeat(101), null, undefined, 5, {}]) {
    assert.strictEqual(validModelInput(v).ok, false, String(v));
  }
});

test('aliases the truth cannot confirm are refused from free text (Dexter #5)', () => {
  // `default` names no family and `opusplan` runs sonnet outside plan mode, so
  // neither can be matched against the model that actually runs.
  for (const alias of ['default', 'DEFAULT', 'opusplan']) {
    assert.strictEqual(validModelInput(alias).ok, false, alias);
  }
});

test('PROPERTY: whatever validModelInput accepts is only the id alphabet', () => {
  for (let c = 0; c < 0x3000; c++) {
    const r = validModelInput('a' + String.fromCharCode(c) + 'b');
    if (r.ok) assert.ok(/^[A-Za-z0-9._/:\-[\]]+$/.test(r.value), `accepted U+${c.toString(16)}`);
  }
});

// --- inputState (Dexter #4) -----------------------------------------------------

const RULE = '─'.repeat(60);
const FOOT = ['  ⏵⏵ bypass permissions on (shift+tab to cycle)'];

test('an empty or single-line input box between the two rules is ready', () => {
  assert.strictEqual(inputState(['header', RULE, '❯ Try "how do I log an error?"', RULE, ...FOOT]), 'ready');
  assert.strictEqual(inputState(['header', RULE, '❯ draft words here', RULE, ...FOOT]), 'ready');
  assert.strictEqual(inputState(['header', RULE, '❯', RULE, ...FOOT]), 'ready');
});

test('a draft spanning more than one line is multiline: Ctrl-U would clear only the last', () => {
  assert.strictEqual(inputState(['h', RULE, '❯ first line', '  second line', RULE, ...FOOT]), 'multiline');
});

test('no input box on screen is a dialog: the command would land in it', () => {
  // Measured: bare /model's picker draws no ❯ box between rules.
  const dialog = ['❯ /model', '▔▔▔▔▔▔▔▔', '   Select model', '    ❯ 4.  Sonnet 5 ✔',
    '      5.  Haiku 4.5', '   Enter to set as default · s to use this session only · Esc to cancel'];
  assert.strictEqual(inputState(dialog), 'dialog');
});

test('scrollback prompts above the box do not count: only the LAST box is live', () => {
  const lines = ['❯ /model sonnet', '  ⎿  Set model to Sonnet 5', RULE, '❯', RULE, ...FOOT];
  assert.strictEqual(inputState(lines), 'ready');
});

test('with two boxes on screen, the LOWER one is the live input', () => {
  // A resize can leave an old box's rules in the visible scrollback. The
  // upper box below is multiline; judging it instead would refuse a click
  // (or, the other way round, type into a multiline draft).
  const lines = [RULE, '❯ old draft', '  second line', RULE, 'output', RULE, '❯', RULE, ...FOOT];
  assert.strictEqual(inputState(lines), 'ready');
  const flipped = [RULE, '❯', RULE, 'output', RULE, '❯ live draft', '  more', RULE, ...FOOT];
  assert.strictEqual(inputState(flipped), 'multiline');
});

test('garbage screens are never ready', () => {
  for (const g of [null, undefined, [], [''], 'text', [RULE], [RULE, RULE], [RULE, 'no prompt', RULE]]) {
    assert.notStrictEqual(inputState(g), 'ready', JSON.stringify(g));
  }
});

// --- planSwitch: everything decided before a key reaches the pty -----------------

const READY = { screen: 'ready', connected: true };

test('a valid model choice on a ready screen plans the /model command', () => {
  const p = planSwitch({ kind: 'model', raw: ' sonnet ', current: 'claude-opus-5-5', ...READY });
  assert.deepStrictEqual(p, { ok: true, value: 'sonnet', command: '/model sonnet', alreadyRunning: false, enterInsert: false });
});

test('a valid effort level plans the /effort command', () => {
  const p = planSwitch({ kind: 'effort', raw: 'HIGH', current: 'medium', ...READY });
  assert.deepStrictEqual(p, { ok: true, value: 'high', command: '/effort high', alreadyRunning: false, enterInsert: false });
});

test('choosing what is already running is marked, so it resolves at once (Dexter #6)', () => {
  // The truth is broadcast only on a CHANGE, so waiting would always time out.
  assert.strictEqual(planSwitch({ kind: 'effort', raw: 'high', current: 'high', ...READY }).alreadyRunning, true);
  assert.strictEqual(planSwitch({ kind: 'model', raw: 'sonnet', current: 'claude-sonnet-5', ...READY }).alreadyRunning, true);
  assert.strictEqual(planSwitch({ kind: 'model', raw: 'claude-opus-4-7', current: 'claude-opus-4-5', ...READY }).alreadyRunning, false);
  assert.strictEqual(planSwitch({ kind: 'effort', raw: 'high', current: null, ...READY }).alreadyRunning, false);
});

test('an effort level outside the measured vocabulary is refused', () => {
  for (const raw of ['ultracode', 'hi', '', 'high\r/exit', null]) {
    const p = planSwitch({ kind: 'effort', raw, current: null, ...READY });
    assert.strictEqual(p.ok, false, String(raw));
    assert.ok(p.notice);
  }
});

test('an unsafe model id is refused with the validator\'s reason (Miguel #1)', () => {
  const p = planSwitch({ kind: 'model', raw: 'sonnet\r/permissions', current: null, ...READY });
  assert.strictEqual(p.ok, false);
  assert.match(p.notice, /model id/);
});

test('nothing is sent unless the input box is ready (Dexter #4)', () => {
  for (const screen of ['dialog', 'multiline', 'unknown', undefined]) {
    const p = planSwitch({ kind: 'model', raw: 'sonnet', current: null, screen, connected: true });
    assert.strictEqual(p.ok, false, String(screen));
    assert.ok(p.notice, 'a refusal says why');
  }
});

test('nothing is sent while disconnected: refused at once, not after a 15s wait (Miguel #2)', () => {
  const p = planSwitch({ kind: 'model', raw: 'sonnet', current: null, screen: 'ready', connected: false });
  assert.strictEqual(p.ok, false);
  assert.match(p.notice, /connect/);
});

test('an unknown kind is refused', () => {
  assert.strictEqual(planSwitch({ kind: 'mode', raw: 'plan', ...READY }).ok, false);
});

test('PROPERTY: every planned command is one line of the id alphabet, whatever the input', () => {
  const raws = ['sonnet', 'opus', 'claude-x', 'a\rb', 'a\nb', '\x15', 'high', 'max', 'a b', '/exit', ''];
  for (const kind of ['model', 'effort']) {
    for (const raw of raws) {
      for (const screen of ['ready', 'dialog']) {
        const p = planSwitch({ kind, raw, current: null, screen, connected: true });
        if (p.ok) assert.ok(/^\/(model|effort) [A-Za-z0-9._/:\-[\]]+$/.test(p.command), JSON.stringify(p));
      }
    }
  }
});

// --- switchNotice (Dexter #9) ------------------------------------------------------

test('a timeout says the switch was not confirmed, and what is running instead', () => {
  const n = switchNotice({ kind: 'model', result: 'timeout', value: 'sonnet', current: 'claude-opus-5-5' });
  assert.match(n, /sonnet/);
  assert.match(n, /claude-opus-5-5/);
});

test('a timeout with nothing known running says so, not a guess', () => {
  const n = switchNotice({ kind: 'effort', result: 'timeout', value: 'high', current: null });
  assert.match(n, /high/);
  assert.ok(n.includes('—'));
});

test('applied, or no result, has no notice', () => {
  assert.strictEqual(switchNotice({ kind: 'model', result: 'applied', value: 'x', current: 'x' }), null);
  assert.strictEqual(switchNotice(null), null);
  assert.strictEqual(switchNotice({ kind: 'model', result: null }), null);
});

test('topBarState carries a notice onto its chip, and topBarDisplay marks and titles it', () => {
  const s = topBarState({ model: 'claude-opus-5-5', effort: 'high', notices: { model: 'nope' }, theme: THEME });
  assert.strictEqual(s.model.notice, 'nope');
  assert.strictEqual(s.effort.notice, null);
  const classes = new Set();
  const el = { textContent: '', title: '', classList: { add: c => classes.add(c), remove: c => classes.delete(c) } };
  topBarDisplay({ modelEl: el }, s);
  assert.ok(classes.has('notice'));
  assert.strictEqual(el.title, 'nope');
  assert.strictEqual(el.textContent, 'claude-opus-5-5', 'the label still reports the truth');
  topBarDisplay({ modelEl: el }, topBarState({ model: 'claude-opus-5-5', theme: THEME }));
  assert.ok(!classes.has('notice'), 'the mark clears with the notice');
});

// --- [1m] aliases (Dexter r2 N4) -------------------------------------------------
// MEASURED 2026-09-26, v2.1.283: `/model sonnet[1m]` makes the statusLine report
// model.id `claude-sonnet-5[1m]`; `opus[1m]` gives `claude-opus-5-5[1m]`.

test('a [1m] alias is confirmed by its family running with the 1M context', () => {
  assert.strictEqual(modelMatches('claude-sonnet-5[1m]', 'sonnet[1m]'), true);
  assert.strictEqual(modelMatches('claude-opus-5-5[1m]', 'OPUS[1M]'), true);
  assert.strictEqual(modelMatches('claude-opus-5-5[1m]', 'sonnet[1m]'), false);
});

test('the context size must agree: [1m] and plain never confirm each other', () => {
  assert.strictEqual(modelMatches('claude-sonnet-5', 'sonnet[1m]'), false);
  assert.strictEqual(modelMatches('claude-opus-5-5[1m]', 'opus'), false);
});

test('switching from opus[1m] to plain opus is a real switch, not "already running"', () => {
  const p = planSwitch({ kind: 'model', raw: 'opus', current: 'claude-opus-5-5[1m]', screen: 'ready', connected: true });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.alreadyRunning, false);
});

// --- vim mode (Dexter r2 N2) ------------------------------------------------------
// MEASURED (verify/probe-vim-mode.js): INSERT draws `-- INSERT --` on the footer
// line under the box; NORMAL draws nothing, which is also how non-vim looks.

const VIM_INSERT = ['  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)'];
const NO_MARK = ['  ⏵⏵ auto mode on (shift+tab to cycle)'];

test('vimInsertShown sees the INSERT marker only BELOW the live box', () => {
  assert.strictEqual(vimInsertShown(['h', RULE, '❯ abc', RULE, ...VIM_INSERT]), true);
  assert.strictEqual(vimInsertShown(['h', RULE, '❯ abc', RULE, ...NO_MARK]), false);
  // A draft that merely mentions it is not the marker.
  assert.strictEqual(vimInsertShown(['h', RULE, '❯ -- INSERT --', RULE, ...NO_MARK]), false);
  assert.strictEqual(vimInsertShown(null), false);
});

test('with vim known on, a box without the INSERT marker is NORMAL mode, not ready', () => {
  assert.strictEqual(inputState(['h', RULE, '❯ abc', RULE, ...NO_MARK], { vim: true }), 'vim-normal');
  assert.strictEqual(inputState(['h', RULE, '❯ abc', RULE, ...VIM_INSERT], { vim: true }), 'ready');
});

test('without vim, the same box is ready exactly as before', () => {
  assert.strictEqual(inputState(['h', RULE, '❯ abc', RULE, ...NO_MARK]), 'ready');
  assert.strictEqual(inputState(['h', RULE, '❯ abc', RULE, ...NO_MARK], { vim: false }), 'ready');
});

test('vim NORMAL is planned with an `i` first, so the keys land as text', () => {
  const p = planSwitch({ kind: 'effort', raw: 'high', current: 'medium', screen: 'vim-normal', connected: true });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.enterInsert, true);
  const q = planSwitch({ kind: 'effort', raw: 'high', current: 'medium', screen: 'ready', connected: true });
  assert.strictEqual(q.enterInsert, false);
});

// --- read-back before CR (Miguel r2 TOCTOU) ----------------------------------------

test('commandTyped: the live box reads back exactly the command', () => {
  assert.strictEqual(commandTyped(['h', RULE, '❯ /model sonnet', RULE, ...NO_MARK], '/model sonnet'), true);
  assert.strictEqual(commandTyped(['h', RULE, '❯\u00a0/model  sonnet ', RULE, ...NO_MARK], '/model sonnet'), true);
});

test('commandTyped: anything glued on, a dialog, or a second line is refused', () => {
  assert.strictEqual(commandTyped(['h', RULE, '❯ /model sonnetrefactor the parser', RULE], '/model sonnet'), false);
  assert.strictEqual(commandTyped(['h', RULE, '❯ x/model sonnet', RULE], '/model sonnet'), false);
  assert.strictEqual(commandTyped(['h', RULE, '❯ /model sonnet', '  more', RULE], '/model sonnet'), false);
  assert.strictEqual(commandTyped(['  Select model', '  Esc to cancel'], '/model sonnet'), false);
  assert.strictEqual(commandTyped(['h', RULE, '❯ /model sonnet', RULE, ...NO_MARK], '/model sonnet', { vim: true }), false);
  assert.strictEqual(commandTyped(null, '/model sonnet'), false);
});

// --- menuPlacement (the dropdown was clipped by the header) --------------------------

const VIEW = { width: 1200, height: 800 };
const chip = (left, top, w = 60, h = 20) => ({ left, top, right: left + w, bottom: top + h });

test('a menu opens just under its chip, left-aligned', () => {
  assert.deepStrictEqual(menuPlacement(chip(700, 10), { width: 180, height: 200 }, VIEW), { left: 700, top: 32 });
});

test('a menu near the right edge is pulled back inside the window', () => {
  const p = menuPlacement(chip(1150, 10), { width: 180, height: 200 }, VIEW);
  assert.strictEqual(p.left, 1200 - 4 - 180);
});

test('a menu with no room below opens above its chip', () => {
  const p = menuPlacement(chip(100, 700), { width: 180, height: 200 }, VIEW);
  assert.strictEqual(p.top, 700 - 2 - 200);
});

test('PROPERTY: a menu that fits the window is always placed wholly inside it', () => {
  // A view, a menu that fits inside its margins, and a chip anywhere in it.
  const arb = fc.record({ vw: fc.integer({ min: 200, max: 1800 }), vh: fc.integer({ min: 150, max: 1050 }) })
    .chain(({ vw, vh }) => fc.record({
      view: fc.constant({ width: vw, height: vh }),
      menu: fc.record({ width: fc.integer({ min: 20, max: vw - 8 }), height: fc.integer({ min: 20, max: vh - 8 }) }),
      x: fc.integer({ min: 0, max: vw }), y: fc.integer({ min: 0, max: vh }),
      w: fc.integer({ min: 1, max: 80 }), h: fc.integer({ min: 1, max: 30 }),
    }));
  fc.assert(fc.property(arb, ({ view, menu, x, y, w, h }) => {
    const p = menuPlacement(chip(x, y, w, h), menu, view);
    return p.left >= 4 && p.left + menu.width <= view.width - 4
      && p.top >= 4 && p.top + menu.height <= view.height - 4;
  }), { numRuns: 2000 });
});

test('menuPlacement never throws on missing measurements', () => {
  for (const bad of [[null, null, null], [{}, {}, {}], [chip(1, 1), undefined, VIEW]]) {
    const p = menuPlacement(...bad);
    assert.ok(Number.isFinite(p.left) && Number.isFinite(p.top), JSON.stringify(bad));
  }
});

test('a fable model id is its own family, not "other"', () => {
  assert.strictEqual(modelFamily('fable'), 'fable');
  assert.strictEqual(modelFamily('claude-fable-5-1'), 'fable');
  assert.strictEqual(modelFamily('Claude-Fable-5'), 'fable');
});
