'use strict';
/**
 * Backlog #65: one shared "agent" colour. The tab page and the tab strip both read it from
 * app/agent-colour.css, and the agent cards' working state uses it, never the user's accent.
 * Source contract: no unit test can see a stylesheet link, so the files are read as text.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const app = path.join(__dirname, '..', 'app');
const read = (f) => fs.readFileSync(path.join(app, f), 'utf8');
const renderer = read('renderer.html');
const strip = read('tab-strip.html');
const shared = read('agent-colour.css');

test('the agent colour is defined once, in the shared stylesheet', () => {
  assert.match(shared, /--agent:\s*#6aa5d8\s*;/i);
  assert.strictEqual((shared.match(/--agent\s*:/g) || []).length, 1);
  assert.doesNotMatch(renderer, /--agent\s*:/);
  assert.doesNotMatch(strip, /--agent\s*:/);
});

test('both documents load the shared stylesheet', () => {
  const link = /<link[^>]+rel="stylesheet"[^>]+href="agent-colour\.css"/;
  assert.match(renderer, link);
  assert.match(strip, link);
});

test('the agent cards\' working state uses the agent colour, not the accent', () => {
  const rules = renderer.split('\n').filter((l) => /\.agent\[data-state="working"\] \.(face|state)/.test(l));
  assert.strictEqual(rules.length, 2);
  for (const r of rules) {
    assert.match(r, /var\(--agent\)/);
    assert.doesNotMatch(r, /var\(--accent\)/);
  }
});
