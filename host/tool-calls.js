'use strict';
/**
 * Pairing a tool_use with its tool_result (PR #95 Dexter D1).
 *
 * A transcript records every tool call Claude SENT, including the ones that did nothing: an Edit that
 * answered "Found 2 matches of the string to replace" (is_error), a Write the person refused at the
 * permission prompt, an Edit that was never answered. Counting those as changes put hunks in the Diff for
 * edits that never touched the disk, and a Diff toggle on a file that was never written. A call counts only if
 * its result is there and is not an error or a refusal.
 *
 *   createCollector({ wanted(name) })
 *     addUse(entry)           take the wanted tool_use blocks of one parsed transcript entry
 *     wantsResultLine(line)   cheap: does this raw line carry a result for a call collected so far?
 *                             (result lines are the bulk of a transcript and hold file contents: only the
 *                             ones that answer a wanted call are worth a JSON.parse)
 *     addResult(entry)        record whether each answered call succeeded
 *     calls()                 [{ id, name, input, at }] for calls with a successful result, in order seen
 *   resultOk(block)           is this tool_result block a success?
 *
 * A refusal is recognised by its words as well as by is_error: Claude Code's rejection text is not always
 * flagged. is_error must be exactly `true`.
 */
const REFUSED = /^\s*(The user doesn't want to proceed|\[Request interrupted by user|User rejected tool use)/i;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

function resultOk(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.is_error === true) return false;
  return !REFUSED.test(textOf(block.content));
}

const ID_IN_LINE = /"tool_use_id"\s*:\s*"([^"]+)"/g;

function createCollector({ wanted } = {}) {
  const uses = [];
  const pending = new Set();
  const outcome = new Map();

  return {
    addUse(entry) {
      const content = entry && entry.message && entry.message.content;
      if (!Array.isArray(content)) return;
      const at = Date.parse(entry.timestamp);
      for (const b of content) {
        if (!b || b.type !== 'tool_use' || typeof b.id !== 'string' || !wanted(b.name)) continue;
        uses.push({ id: b.id, name: b.name, input: b.input, at });
        pending.add(b.id);
      }
    },
    wantsResultLine(line) {
      if (pending.size === 0 || line.indexOf('tool_result') === -1) return false;
      for (const m of line.matchAll(ID_IN_LINE)) if (pending.has(m[1])) return true;
      return false;
    },
    addResult(entry) {
      const content = entry && entry.message && entry.message.content;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (b && b.type === 'tool_result' && pending.has(b.tool_use_id)) outcome.set(b.tool_use_id, resultOk(b));
      }
    },
    calls() {
      return uses.filter(u => outcome.get(u.id) === true);
    },
  };
}

module.exports = { createCollector, resultOk };
