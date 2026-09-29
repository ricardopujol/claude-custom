'use strict';
/**
 * What one hook payload says about the MAIN session's permission mode and
 * effort level. Pure, so the rules live somewhere a test can reach -- host.js
 * is module-level wiring that spawns a pty.
 *
 * Returns {} when the payload says nothing about the main session:
 *   - a subagent's call (it carries `agent_id`). A subagent can run its own
 *     mode, or a model with no effort at all, and neither is the main chip's.
 *   - a payload with no `permission_mode` (SessionEnd). Every event that
 *     carries the common fields carries that one; one without it carries none.
 * Otherwise { permissionMode, effort }, where null means ABSENT:
 *   - effort is null when `effort.level` is missing. MEASURED: on
 *     `--model haiku` no event carries it (test/hooks-real-subagent-failure
 *     .fixture.jsonl), because Haiku has no effort levels. Keeping the last
 *     Opus value would show a stale level as live.
 *   - permissionMode is a host/mode.js MODES key, or null when the CLI sends a
 *     value this table does not know. Never a guess.
 */

// The CLI's --permission-mode vocabulary, onto the keys host/mode.js's MODES
// table (and so the badge) uses. The raw value used to reach the badge, miss
// the table, and draw bypass as one harmless skull.
const CLI_MODE_KEYS = Object.freeze({
  default: 'manual',
  acceptEdits: 'accept edits',
  plan: 'plan',
  auto: 'auto',
  dontAsk: 'dont ask',
  bypassPermissions: 'bypass',
});

function cliModeToKey(value) {
  if (typeof value !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(CLI_MODE_KEYS, value) ? CLI_MODE_KEYS[value] : null;
}

function readSessionHook(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.agent_id) return {};
  if (typeof payload.permission_mode !== 'string') return {};
  const level = payload.effort && payload.effort.level;
  return {
    permissionMode: cliModeToKey(payload.permission_mode),
    effort: typeof level === 'string' && level !== '' ? level : null,
  };
}

/**
 * What the statusLine document (forwarded by host/status-relay.js) says about
 * the main session: `{ model, effort }`, or {} when it carries no model id --
 * without one it is not the document we measured, and half-trusting it could
 * clear a real effort level. `model` is the id, never the display name.
 * `effort` is null when absent, as on a model with no effort levels.
 */
function readStatus(doc) {
  if (!doc || typeof doc !== 'object') return {};
  const id = doc.model && typeof doc.model === 'object' ? doc.model.id : null;
  if (typeof id !== 'string' || !id) return {};
  const level = doc.effort && typeof doc.effort === 'object' ? doc.effort.level : null;
  return { model: id, effort: typeof level === 'string' && level !== '' ? level : null };
}

// Strict number checks. `typeof`, never a coercion: Number(null) is 0, and
// "the CLI has not counted yet" must not become a confident 0%.
const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const nonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// Tokens the context window is holding, from statusLine's `current_usage`
// object: input + cache_creation + cache_read (output is not context). These
// field names come from Claude Code's statusLine documentation and are NOT
// measured here (a populated one needs a billed turn). Anything but a
// well-formed object -- all three present, each a finite number >= 0 -- is
// null, so the caller falls through instead of guessing.
function usageTokens(cu) {
  if (!cu || typeof cu !== 'object' || Array.isArray(cu)) return null;
  const { input_tokens: i, cache_creation_input_tokens: c, cache_read_input_tokens: r } = cu;
  if (!nonNegative(i) || !nonNegative(c) || !nonNegative(r)) return null;
  const sum = i + c + r;
  return Number.isFinite(sum) ? sum : null;
}

/**
 * How full the context window is, from the statusLine document: `{ used, size }`
 * in tokens, or null when the document cannot say.
 *
 * MEASURED (verify/probe-context-window.js, claude 2.1.284): `context_window`
 * carries `context_window_size` (200000, or 1000000 on a [1m] model), and BEFORE
 * the first turn `used_percentage` and `current_usage` are null -- the CLI's own
 * "not counted yet" -- so a fresh session is unknown here, not 0.
 * NOT MEASURED: their populated forms. So this fails toward unknown:
 *   1. a well-formed `current_usage` wins (absolute tokens: no percent scale to
 *      get wrong, and no stale-window recompute after a mid-session /model);
 *   2. else `used_percentage` (assumed 0..100) x the current window;
 *   3. else null.
 * A COUNTED zero is a known, empty context (used: 0); only `size` must be
 * strictly positive. No `model.id` -> null: the same trust rule as readStatus
 * (without one it is not the document we measured).
 */
function readContext(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const id = doc.model && typeof doc.model === 'object' ? doc.model.id : null;
  if (typeof id !== 'string' || !id) return null;
  const cw = doc.context_window;
  if (!cw || typeof cw !== 'object') return null;
  const size = cw.context_window_size;
  if (!positive(size)) return null;
  const counted = usageTokens(cw.current_usage);
  if (counted !== null) return { used: counted, size };
  const pct = cw.used_percentage;
  if (!nonNegative(pct)) return null;
  const used = Math.round((pct * size) / 100);
  return Number.isFinite(used) ? { used, size } : null;
}

module.exports = { readSessionHook, cliModeToKey, readStatus, readContext, CLI_MODE_KEYS };
