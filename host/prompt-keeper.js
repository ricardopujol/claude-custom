'use strict';
/**
 * The main session's latest prompt (backlog #49, documentation/DESIGN_TERMINAL_BAR.md "Sources").
 *
 *   createPromptKeeper({ now }) -> { handle(event) -> changed, snapshot() -> { text, at, seq } | null }
 *
 * It is `UserPromptSubmit.prompt`, from the hook the harness already registers, and from nothing else:
 *   - a subagent's event (it carries `agent_id`) is not the person's prompt and never counts;
 *   - a UserPromptSubmit without usable text clears the old prompt: a new turn opened, so the old one is no
 *     longer "the last prompt" (absence, never a stale one);
 *   - SessionStart (startup / resume / clear) and SessionEnd clear it; a compaction changes nothing;
 *   - `seq` moves on every prompt, even the same words twice, so the page re-anchors it in the terminal
 *     (app/terminal-bar.js); `at` only feeds the "4 min ago" label.
 * A wake of a /loop (the bedtime run) is a UserPromptSubmit too, with the scheduled prompt as its text: it is
 * what the CLI shows as the latest turn, so it is kept like any other (verify/probe-bedtime-signal.js).
 *
 * The text is capped at PROMPT_MAX so a pasted file can't ride every `hello` to every window; the cap never
 * splits a surrogate pair. The person's own words are never logged here.
 */

const PROMPT_MAX = 4000;

const isMain = (p) => !(typeof p.agent_id === 'string' && p.agent_id !== '');

function capped(text) {
  if (text.length <= PROMPT_MAX) return text;
  let cut = text.slice(0, PROMPT_MAX);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

function createPromptKeeper({ now = Date.now } = {}) {
  let current = null;
  let seq = 0;

  function clear() {
    if (current === null) return false;
    current = null;
    return true;
  }

  function handle(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.event !== 'string') return false;
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    switch (ev.event) {
      case 'UserPromptSubmit': {
        if (!isMain(p)) return false;
        if (typeof p.prompt !== 'string' || p.prompt.trim() === '') return clear();
        current = { text: capped(p.prompt), at: now(), seq: ++seq };
        return true;
      }
      case 'SessionStart':
        return p.source === 'compact' ? false : clear();
      case 'SessionEnd':
        return clear();
      default:
        return false;
    }
  }

  return { handle, snapshot: () => (current === null ? null : { ...current }) };
}

module.exports = { createPromptKeeper, PROMPT_MAX };
