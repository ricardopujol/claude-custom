'use strict';
/**
 * The roster row interpolated the agent's name into both `title="…"` and the
 * row text without escapeHtml (Miguel, PR #34 review, S3). An agent name is a
 * file name or a hook payload's `agent_type` -- neither is ours -- so a `"` in
 * it closed the attribute and a `<` in it opened a tag.
 *
 * renderer.js needs a real DOM and no test can load it (see
 * renderer-scope.test.js), so this reads the source, as that file does.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');

test('the roster never interpolates an agent name raw into markup', () => {
  const raw = src.match(/\$\{r\.agent\}/g) || [];
  assert.deepStrictEqual(raw, [],
    'every ${r.agent} in renderer.js must go through escapeHtml');
});
