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
// theme. Unlike --accent, which is chosen per project, these four colours are
// meant to mean the same model everywhere -- so they are fixed, not derived
// from the active theme.
const FAMILY_COLOURS = {
  opus: '#e0a030',     // amber
  sonnet: '#4c8bf5',   // blue
  haiku: '#4caf6a',    // green
  other: '#c060e0',    // magenta -- anything non-Anthropic
};

// MEASURED 2026-09-23 against `claude` 2.1.280 (see the PR-B brief). `/model`
// accepts these aliases plus a full model id typed as free text; `ultracode`
// is gated out of `/effort` on purpose.
const MODEL_CHOICES = ['opus', 'sonnet', 'haiku'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

// How long a picker waits for the truth (the next `sessionModel` broadcast,
// or the next hook payload's `effort.level`) before it gives up and says the
// switch did not take. `/model` has a documented refusal path
// (`model-switch-blocked`) that sends no further event at all, so a session
// that goes silent must still resolve to something rather than spin forever.
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
 * 'other'  -- a real, non-empty id that matched none of the three families.
 *             This is deliberately a real answer, not an absence: an
 *             OpenRouter model seated in the council is not Anthropic and
 *             that is worth a colour of its own (magenta), not silence.
 */
function modelFamily(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
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
 *   { type: 'truth',   kind, matches }               -- a new truth arrived
 *   { type: 'timeout', kind, now, timeoutMs }         -- a clock check
 *
 * Matching is the CALLER's job (model-family equivalence for `/model`,
 * case-insensitive string equality for `/effort`) precisely so this function
 * stays domain-agnostic and total.
 *
 * Returns `{ pending, result }` where `result` is `null` (nothing changed),
 * `'applied'` (the truth confirmed the request), `'rejected'` (a truth
 * arrived but did not match -- refused, or overridden by someone else), or
 * `'timeout'` (no truth arrived in time).
 *
 * The property this function exists to guarantee, matching the brief's
 * "never flips optimistically": the ONLY event that can produce `'applied'`
 * is a matching `'truth'` event. A `'timeout'` can never produce it, however
 * the clock is fed.
 */
function pendingResolver(pending, event) {
  if (!pending || !event || event.kind !== pending.kind) {
    return { pending: pending || null, result: null };
  }
  if (event.type === 'truth') {
    return event.matches
      ? { pending: null, result: 'applied' }
      : { pending: null, result: 'rejected' };
  }
  if (event.type === 'timeout') {
    const elapsed = event.now - pending.startedAt;
    if (elapsed >= event.timeoutMs) return { pending: null, result: 'timeout' };
  }
  return { pending, result: null };
}

const UNKNOWN = '—';   // em dash, same non-claim as the sibling display modules

function chipState(value, pending) {
  const family = modelFamily(typeof value === 'string' ? value : null);
  return {
    value: typeof value === 'string' && value ? value : null,
    label: typeof value === 'string' && value ? value : UNKNOWN,
    family,
    pending: !!pending,
    pendingLabel: pending ? pending.value : null,
  };
}

/**
 * Render-ready state for the panel: `{ model, effort, accent }`. Pure --
 * no DOM, no clock. The accent is computed from the CURRENT (known) model,
 * never from a pending request, so the colour only ever reports the truth.
 */
function topBarState(input) {
  const { model, effort, pendingModel, pendingEffort, theme } = input || {};
  const family = modelFamily(typeof model === 'string' ? model : null);
  return {
    model: chipState(model, pendingModel),
    effort: chipState(effort, pendingEffort),
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
  el.title = chip.pending
    ? `switching ${verb} to ${chip.pendingLabel}…`
    : `${verb}: ${chip.label}`;
}

function topBarDisplay(els, state) {
  if (!els || !state) return;
  writeChip(els.modelEl, state.model, 'model');
  writeChip(els.effortEl, state.effort, 'effort');
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all. Same shape as
// app/quota-display.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    modelFamily, cueColour, pendingResolver, topBarState, topBarDisplay,
    MODEL_CHOICES, EFFORT_LEVELS, PENDING_TIMEOUT_MS, UNKNOWN,
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
}

})(typeof window !== 'undefined' ? window : globalThis);
