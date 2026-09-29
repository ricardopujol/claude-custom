'use strict';
/**
 * One handler per control message type in app/renderer.js.
 *
 * handleControl is a chain of `if (msg.type === 'X') { ...; return; }`. A second
 * branch for the same type is DEAD: the first one returns. That is how PR #37
 * (FF12), rebased onto #34, ended up with two `sessionModel` handlers -- #34's
 * updated the roster and returned, so FF12's never ran, the model chip never
 * updated, and a pending model switch never resolved. Git merged it without a
 * conflict marker, and every unit test passed, because each tested module was
 * fine; only the dispatch was broken.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');

test('renderer.js has at most ONE `msg.type === ...` branch per message type', () => {
  const counts = new Map();
  for (const m of SRC.matchAll(/if \(msg\.type === '([A-Za-z0-9_-]+)'\)/g)) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  const dupes = [...counts].filter(([, n]) => n > 1).map(([t, n]) => `${t} x${n}`);
  assert.ok(counts.size > 5, 'the scan found the dispatch at all');
  assert.deepStrictEqual(dupes, [], `a second branch for one type is dead code: ${dupes.join(', ')}`);
});
