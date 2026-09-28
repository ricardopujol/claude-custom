'use strict';
/**
 * FF12 -- the top-bar control panel: current model, effort, and the
 * persistent colour cue for the model family.
 *
 * Pure decisions only, for the reason app/quota-display.js and
 * app/career-display.js exist: a decision living inside a browser script is a
 * decision nothing can test. renderer.js owns the actual wiring (the ws.send
 * that types `/model sonnet\r` into the pty, the click handlers that open a
 * picker) -- everything here is inputs in, a render-ready shape out, no DOM
 * reads, no clock reads, no network.
 *
 * WRAPPED IN AN IIFE, and that is not style. renderer.html loads these as
 * plain <script> tags sharing ONE global scope -- see
 * test/renderer-scope.test.js, which enforces the exact `(function (root) {`
 * prefix below so its skip-regex can find this file.
 */
(function (root) {

// Approved 2026-09-23 (Ricardo): a PERSISTENT recognition cue, independent of
// theme. Unlike --accent, which is chosen per project, these colours are
// meant to mean the same model everywhere -- so they are fixed, not derived
// from the active theme.
const FAMILY_COLOURS = {
  fable: '#2bb5a8',    // teal (added 2026-09-28 with the fable alias)
  opus: '#e0a030',     // amber
  sonnet: '#4c8bf5',   // blue
  haiku: '#4caf6a',    // green
  other: '#c060e0',    // magenta -- anything non-Anthropic
};

// MEASURED 2026-09-23 against `claude` 2.1.280 (see the PR-B brief). `/model`
// accepts these aliases plus a full model id typed as free text; `ultracode`
// is gated out of `/effort` on purpose. `fable` added 2026-09-28: claude
// 2.1.283 accepts it as an alias (verify/probe-model-list.js). Newest first.
const MODEL_CHOICES = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

// How long a picker waits for the truth before it gives up and says the
// switch did not take. The truth is the statusLine document (host/status-
// relay.js), MEASURED to re-fire ~1s after /model and /effort with no turn
// (verify/probe-top-bar-truth.js), so 15s is generous. `/model` has a
// documented refusal path (`model-switch-blocked`) that changes nothing, so a
// session that goes silent must still resolve rather than spin forever.
const PENDING_TIMEOUT_MS = 15000;

/**
 * Which family a model id belongs to. TOTAL: never throws, whatever arrives,
 * because this reads a field (`sessionModel.session.model`, or a hook
 * payload's `effort`/`permission_mode`) this PR does not control the shape
 * of -- PR-A ships the model field, and `model: null` for "not known yet" is
 * documented as correct, not a bug to guard against once.
 *
 * `null`   -- no model known yet; there is nothing to name, so nothing is
 *             guessed.
 * 'other'  -- a real, non-empty id that matched none of the known families.
 *             This is deliberately a real answer, not an absence: an
 *             OpenRouter model seated in the council is not Anthropic and
 *             that is worth a colour of its own (magenta), not silence.
 */
function modelFamily(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.indexOf('fable') !== -1) return 'fable';
  if (lower.indexOf('opus') !== -1) return 'opus';
  if (lower.indexOf('sonnet') !== -1) return 'sonnet';
  if (lower.indexOf('haiku') !== -1) return 'haiku';
  return 'other';
}

/**
 * The colour cue for a family. Unknown (`family` is null, i.e. no model has
 * been reported yet) draws the theme's own accent, UNTINTED -- there is
 * nothing yet to tint, and this is the byte-equal fallback so an unresolved
 * model changes nothing about how the header already looks.
 */
function cueColour(family, theme) {
  if (family && Object.prototype.hasOwnProperty.call(FAMILY_COLOURS, family)) {
    return FAMILY_COLOURS[family];
  }
  const chromeAccent = theme && theme.chrome && theme.chrome.accent;
  return typeof chromeAccent === 'string' && chromeAccent ? chromeAccent : '#d08c4a';
}

/**
 * The pending-switch state machine. `pending` is `{ kind, value, startedAt }`
 * or `null`. `event` is one of:
 *
 *   { type: 'truth',   kind, matches, at }           -- a new truth arrived
 *   { type: 'timeout', kind, now, timeoutMs }         -- a clock check
 *
 * Matching is the CALLER's job (modelMatches / effortMatches below) so this
 * function stays domain-agnostic and total.
 *
 * Returns `{ pending, result }` where `result` is `null` (nothing changed),
 * `'applied'` (a truth confirmed the request) or `'timeout'` (none did in
 * time).
 *
 * A truth that does NOT match keeps waiting rather than rejecting: it may be
 * a status the CLI wrote before it processed the command (Dexter #2), and a
 * switch that then succeeds must not read as refused. A truth OLDER than the
 * request (`at < startedAt`), or with no usable `at`, is ignored outright
 * (Dexter #1): it cannot know about the request, so it cannot confirm it.
 *
 * The property this function exists to guarantee, matching the brief's
 * "never flips optimistically": the ONLY event that can produce `'applied'`
 * is a matching `'truth'` event no older than the request. A `'timeout'` can
 * never produce it, however the clock is fed.
 */
function pendingResolver(pending, event) {
  if (!pending || !event || event.kind !== pending.kind) {
    return { pending: pending || null, result: null };
  }
  if (event.type === 'truth') {
    const fresh = typeof event.at === 'number' && Number.isFinite(event.at)
      && event.at >= pending.startedAt;
    return fresh && event.matches
      ? { pending: null, result: 'applied' }
      : { pending, result: null };
  }
  if (event.type === 'timeout') {
    const elapsed = event.now - pending.startedAt;
    if (elapsed >= event.timeoutMs) return { pending: null, result: 'timeout' };
  }
  return { pending, result: null };
}

const UNKNOWN = '—';   // em dash, same non-claim as the sibling display modules

function chipState(value, pending, notice) {
  const family = modelFamily(typeof value === 'string' ? value : null);
  return {
    value: typeof value === 'string' && value ? value : null,
    label: typeof value === 'string' && value ? value : UNKNOWN,
    family,
    pending: !!pending,
    pendingLabel: pending ? pending.value : null,
    notice: typeof notice === 'string' && notice ? notice : null,
  };
}

/**
 * Render-ready state for the panel: `{ model, effort, accent }`. Pure --
 * no DOM, no clock. The accent is computed from the CURRENT (known) model,
 * never from a pending request, so the colour only ever reports the truth.
 */
function topBarState(input) {
  const { model, effort, pendingModel, pendingEffort, theme, notices } = input || {};
  const family = modelFamily(typeof model === 'string' ? model : null);
  const n = notices && typeof notices === 'object' ? notices : {};
  return {
    model: chipState(model, pendingModel, n.model),
    effort: chipState(effort, pendingEffort, n.effort),
    accent: cueColour(family, theme),
  };
}

/**
 * The DOM write. `els` is `{ modelEl, effortEl }`; either may be absent (a
 * fast attach, before the header has rendered) and this must tolerate that
 * rather than throw and take the rest of the handshake down with it -- the
 * exact failure mode test/renderer-scope.test.js's id-existence check exists
 * to catch one layer up.
 */
function writeChip(el, chip, verb) {
  if (!el) return;
  el.textContent = chip.pending ? `${chip.pendingLabel}…` : chip.label;
  if (chip.pending) el.classList.add('pending'); else el.classList.remove('pending');
  // A switch that did not take is MARKED, while the label keeps reporting the
  // truth: the notice says what happened, never what we hoped.
  if (chip.notice && !chip.pending) el.classList.add('notice'); else el.classList.remove('notice');
  el.title = chip.pending
    ? `switching ${verb} to ${chip.pendingLabel}…`
    : (chip.notice || `${verb}: ${chip.label}`);
}

function topBarDisplay(els, state) {
  if (!els || !state) return;
  writeChip(els.modelEl, state.model, 'model');
  writeChip(els.effortEl, state.effort, 'effort');
}

/**
 * The main session's model from the host's session-model payload, or null.
 *
 * The contract is #34's (host/session-model.js): `{ session: { model, at },
 * agents, errors }`, the same on hello's `sessionModel` and on the
 * `sessionModel` broadcast (which carries those fields at top level). FF12
 * was written before #34 merged and read `sessionModel.model`, which never
 * exists -- the chip stayed "—" for good. One reader, used for both paths.
 * Absence and anything that is not a non-empty string is null, never a guess.
 */
function mainModelOf(payload) {
  const session = payload && typeof payload === 'object' ? payload.session : null;
  const model = session && typeof session === 'object' ? session.model : null;
  return typeof model === 'string' && model ? model : null;
}

/**
 * Does the running model (`truth`, a full id like "claude-sonnet-5") satisfy
 * the request? A menu alias resolves to "the current model of that family",
 * so family is the whole test. A free-typed id is not an alias: it matches
 * only itself (Dexter #1, #5) -- family would call opus-4-5 a success for
 * opus-4-7, and 'other' would call any two provider models equal.
 */
function modelMatches(truth, requested) {
  if (typeof truth !== 'string' || !truth || typeof requested !== 'string' || !requested) return false;
  const req = requested.trim().toLowerCase();
  if (MODEL_CHOICES.indexOf(req) !== -1) return modelFamily(truth) === req;
  return truth.trim().toLowerCase() === req;
}

function effortMatches(truth, requested) {
  if (typeof truth !== 'string' || !truth || typeof requested !== 'string' || !requested) return false;
  return truth.trim().toLowerCase() === requested.trim().toLowerCase();
}

// A model id's whole alphabet. It is typed into a live pty after `/model `,
// so anything else -- above all an embedded CR or LF, which would submit a
// SECOND command (Miguel #1) -- refuses the value outright rather than being
// stripped: a mangled id is not what the user asked for either.
const MODEL_ID = /^[A-Za-z0-9._/:\-[\]]+$/;
const MODEL_ID_MAX = 100;
// Aliases whose running model can never be matched against them: `default`
// names no family, and `opusplan` runs sonnet outside plan mode (Dexter #5).
const UNCONFIRMABLE = ['default', 'opusplan'];

function validModelInput(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'not a model id' };
  const v = value.trim();
  if (!v) return { ok: false, reason: 'type a model id' };
  if (v.length > MODEL_ID_MAX) return { ok: false, reason: 'too long for a model id' };
  if (!MODEL_ID.test(v)) {
    return { ok: false, reason: 'only letters, digits and . _ / : - [ ] belong in a model id' };
  }
  if (UNCONFIRMABLE.indexOf(v.toLowerCase()) !== -1) {
    return { ok: false, reason: `"${v}" can't be confirmed against the running model; type a full id` };
  }
  return { ok: true, value: v };
}

/**
 * Is the TUI's input box safe to type a slash command into? `lines` is the
 * visible screen, top to bottom. MEASURED (verify/probe-top-bar-truth.js):
 * the live box is a `❯` line between the LAST two full-width `─` rules, and an
 * open dialog (bare /model's picker, a permission prompt) draws no such box.
 *
 *   'ready'     -- one input line; Ctrl-U clears it without submitting
 *   'multiline' -- a draft over several lines; Ctrl-U clears only the last,
 *                  and the rest would be submitted WITH the command
 *   'dialog'    -- no input box: the keys would land in the dialog, and the
 *                  CR would confirm whatever it has highlighted (Dexter #4)
 *   'unknown'   -- nothing on screen to judge by
 */
const RULE_LINE = /^─{10,}$/;

function inputState(lines) {
  if (!Array.isArray(lines)) return 'unknown';
  const text = lines.map(l => (typeof l === 'string' ? l.trim() : ''));
  if (!text.some(Boolean)) return 'unknown';
  const rules = [];
  text.forEach((l, i) => { if (RULE_LINE.test(l)) rules.push(i); });
  if (rules.length < 2) return 'dialog';
  const top = rules[rules.length - 2];
  const bottom = rules[rules.length - 1];
  const box = text.slice(top + 1, bottom);
  if (!box.length || box[0].charAt(0) !== '❯') return 'dialog';
  return box.length > 1 ? 'multiline' : 'ready';
}

const SCREEN_REFUSALS = {
  dialog: 'a dialog is open in the terminal; answer it or press Esc first',
  multiline: 'your draft spans several lines; send or clear it first',
  unknown: "the terminal's input box isn't on screen yet",
};

/**
 * Everything decided before a key reaches the pty. `raw` is the chosen or
 * typed value, `current` the running value, `screen` inputState()'s answer,
 * `connected` whether the socket is open. Returns
 *   { ok: true, value, command, alreadyRunning }   -- send `command`
 *   { ok: false, notice }                           -- send nothing, say why
 * `alreadyRunning`: the choice is what runs now. The truth is broadcast only
 * on a change, so a pending switch would always time out (Dexter #6); the
 * caller resolves it at once instead.
 */
function planSwitch({ kind, raw, current, screen, connected } = {}) {
  let value;
  if (kind === 'model') {
    const v = validModelInput(raw);
    if (!v.ok) return { ok: false, notice: `didn't switch model: ${v.reason}` };
    value = v.value;
  } else if (kind === 'effort') {
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (EFFORT_LEVELS.indexOf(v) === -1) return { ok: false, notice: "didn't switch effort: not a level /effort accepts" };
    value = v;
  } else {
    return { ok: false, notice: 'nothing to switch' };
  }
  if (!connected) return { ok: false, notice: `didn't send /${kind} ${value}: not connected to the session` };
  if (screen !== 'ready') {
    return { ok: false, notice: `didn't send /${kind} ${value}: ${SCREEN_REFUSALS[screen] || SCREEN_REFUSALS.unknown}` };
  }
  const alreadyRunning = kind === 'model' ? modelMatches(current, value) : effortMatches(current, value);
  return { ok: true, value, command: `/${kind} ${value}`, alreadyRunning };
}

/**
 * What a chip says about a switch that did not take (Dexter #9: a result
 * computed and thrown away looked exactly like never having clicked).
 * `result` is pendingResolver's, or 'refused' with planSwitch's `notice`.
 */
function switchNotice(r) {
  if (!r || !r.result || r.result === 'applied') return null;
  if (r.result === 'refused') return r.notice || null;
  if (r.result === 'timeout') {
    const now = typeof r.current === 'string' && r.current ? r.current : UNKNOWN;
    return `couldn't confirm the switch to ${r.value}; the session reports ${now}`;
  }
  return null;
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all. Same shape as
// app/quota-display.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    modelFamily, cueColour, pendingResolver, topBarState, topBarDisplay,
    MODEL_CHOICES, EFFORT_LEVELS, PENDING_TIMEOUT_MS, UNKNOWN, mainModelOf,
    modelMatches, effortMatches, validModelInput, inputState, planSwitch, switchNotice,
  };
} else {
  root.modelFamily = modelFamily;
  root.cueColour = cueColour;
  root.pendingResolver = pendingResolver;
  root.topBarState = topBarState;
  root.topBarDisplay = topBarDisplay;
  root.MODEL_CHOICES = MODEL_CHOICES;
  root.EFFORT_LEVELS = EFFORT_LEVELS;
  root.PENDING_TIMEOUT_MS = PENDING_TIMEOUT_MS;
  root.mainModelOf = mainModelOf;
  root.modelMatches = modelMatches;
  root.effortMatches = effortMatches;
  root.validModelInput = validModelInput;
  root.inputState = inputState;
  root.planSwitch = planSwitch;
  root.switchNotice = switchNotice;
}

})(typeof window !== 'undefined' ? window : globalThis);
