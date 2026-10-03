'use strict';
/**
 * Transcript fixtures for the fog / diff tests. Since PR #95 (Dexter D1) an Edit or Write counts only if its
 * tool_result says it happened, so a fixture that lists tool_use entries needs the answers too.
 *
 *   nextId()            a fresh tool_use id
 *   withResults(list)   the same entries with a successful tool_result after every tool_use that has an id
 */
let n = 0;
const nextId = () => `toolu_fixture_${++n}`;

function withResults(entries) {
  const out = [];
  for (const e of entries) {
    out.push(e);
    const content = e && e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === 'tool_use' && typeof b.id === 'string') {
        out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: b.id, content: 'ok' }] } });
      }
    }
  }
  return out;
}

module.exports = { nextId, withResults };
