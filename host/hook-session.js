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

module.exports = { readSessionHook, cliModeToKey, CLI_MODE_KEYS };
