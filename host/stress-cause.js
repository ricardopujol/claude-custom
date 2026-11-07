'use strict';
/**
 * WHY A CARD IS STRESSED, in one short sentence (BACKLOG #162). The ONE source of that sentence: the roster card's hover uses it
 * today, and #101's card that opens in place (Ricardo, 2026-11-06) reuses it. host/mood-machine.js keeps the record; this only
 * reads it, so the words can never disagree with the state machine about what happened.
 *
 * A record is { failures, retry }:
 *   failures  [{ tool, to, run, n, first }], one entry per kind of failure in the order each FIRST happened (addFailure groups
 *             them): `tool` the tool whose call failed, `to` a SendMessage's recipient, `run` true for the spawn itself failing,
 *             `n` how many, `first` when the first one happened (ms).
 *   retry     { tool, count, from, to } while the same call has come back `count` times running (from..to, ms), else null.
 *
 *   stressCause({ failures: [SendMessage to "the hub" x2], retry: { tool: "Read", count: 3, from: 0, to: 40000 } })
 *     -> "2 messages to the hub failed to send, then it retried the same read 3 times in 40 s"
 *
 * (That's the shape Ricardo asked for. On a default install a read can't be in it: Read, Grep and Glob have no PostToolUse hook
 * (host/settings-writer.js POST_TOOL_MATCHER), so a failed or repeated read never reaches the mood machine. A repeated Bash
 * command, a failed SendMessage, a failed spawn can: PR #239 Dexter 6.)
 *
 * Null when there's nothing to say. Never a number for an unknown: a retry with no readable span says no span. A span reads in
 * seconds under a minute, "M min S s" under ten minutes, whole minutes after (PR #239 Miguel S10: 90 s is "1 min 30 s").
 */

// How many kinds of failure one record keeps. More than this is one count at the end, so the record stays bounded.
const MAX_KINDS = 8;
// How many kinds one sentence names before it says "and N more".
const SHOWN = 3;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
// A SendMessage's `to` is whatever the model typed, kept per kind and drawn in a tooltip: capped, with an ellipsis (Miguel S7).
const TO_MAX = 40;
const capped = (s) => (s !== null && s.length > TO_MAX ? s.slice(0, TO_MAX - 1) + '…' : s);

/** Records one failed call into `failures` (mutated), grouped with an earlier one of the same kind. */
function addFailure(failures, { tool, to, run = false, at } = {}) {
  const t = str(tool);
  const whom = t === 'SendMessage' ? capped(str(to)) : null;
  const same = failures.find((f) => f.tool === t && f.to === whom && f.run === !!run);
  if (same) { same.n++; return failures; }
  if (failures.length >= MAX_KINDS) {
    const rest = failures.find((f) => f.rest);
    if (rest) rest.n++; else failures.push({ rest: true, n: 1, first: finite(at) ? at : null });
    return failures;
  }
  failures.push({ tool: t, to: whom, run: !!run, n: 1, first: finite(at) ? at : null });
  return failures;
}

const AN = /^[aeiou]/i;
const article = (word) => (AN.test(word) ? 'an' : 'a');

function failureWords(f) {
  if (f.run) return f.n === 1 ? 'its run failed' : `${f.n} of its runs failed`;
  if (f.tool === 'SendMessage') {
    const whom = f.to ? ` to ${f.to}` : '';
    return f.n === 1 ? `a message${whom} failed to send` : `${f.n} messages${whom} failed to send`;
  }
  const tool = f.tool || 'tool';
  return f.n === 1 ? `${article(tool)} ${tool} call failed` : `${f.n} ${tool} calls failed`;
}

// What "the same ..." is, for the tools whose calls have a plain name.
const NOUN = { Read: 'read', Grep: 'search', Glob: 'search', WebSearch: 'search', Bash: 'command', Edit: 'edit', Write: 'write',
  NotebookEdit: 'edit', WebFetch: 'fetch' };

function span(ms) {
  if (!finite(ms) || ms < 0) return '';
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return ` in ${s} s`;
  if (s < 600) return ` in ${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return ` in ${Math.round(s / 60)} min`;
}

function retryWords(r) {
  const tool = str(r.tool);
  const what = tool ? (Object.hasOwn(NOUN, tool) ? NOUN[tool] : `${tool} call`) : 'call';
  const count = Number.isInteger(r.count) && r.count > 0 ? ` ${r.count} times` : '';
  return `it retried the same ${what}${count}${finite(r.from) && finite(r.to) ? span(r.to - r.from) : ''}`;
}

function stressCause(record) {
  if (!record || typeof record !== 'object') return null;
  const parts = [];
  const failures = Array.isArray(record.failures) ? record.failures.filter((f) => f && Number.isInteger(f.n) && f.n > 0) : [];
  const kinds = failures.filter((f) => !f.rest);
  const restN = kinds.slice(SHOWN).reduce((s, f) => s + f.n, 0) + failures.filter((f) => f.rest).reduce((s, f) => s + f.n, 0);
  for (const f of kinds.slice(0, SHOWN)) parts.push({ at: f.first, words: failureWords(f) });
  if (restN > 0) parts.push({ at: Infinity, words: `${restN} more call${restN === 1 ? '' : 's'} failed` });
  const r = record.retry;
  if (r && typeof r === 'object') parts.push({ at: finite(r.from) ? r.from : Infinity, words: retryWords(r) });
  if (parts.length === 0) return null;
  // In the order they happened; an unknown time goes last, and a tie keeps the failures first.
  const when = (p) => (finite(p.at) ? p.at : Infinity);
  parts.sort((a, b) => (when(a) === when(b) ? 0 : when(a) < when(b) ? -1 : 1));
  const text = parts.map((p) => p.words).join(', then ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = { stressCause, addFailure, MAX_KINDS, TO_MAX };
