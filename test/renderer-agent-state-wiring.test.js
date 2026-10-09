'use strict';
/**
 * BACKLOG #55 wiring, asserted on source text (the look itself is verify/probe-agent-states.js --window, in a real
 * window; the decisions are app/agent-state-display.js's own tests). Deliberately NOT in Stryker's command: it reads
 * renderer.js / renderer.html / host.js as text.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the page loads the state display before renderer.js, as a plain script', () => {
  const html = read('app/renderer.html');
  const display = html.indexOf('<script src="./agent-state-display.js"></script>');
  const renderer = html.indexOf('<script src="./renderer.js"></script>');
  assert.ok(display !== -1, 'renderer.html must load app/agent-state-display.js');
  assert.ok(renderer !== -1 && display < renderer, 'and before renderer.js, which calls it while painting');
});

test('the roster card keeps data-state for the base state and adds data-detail, the badge and the words', () => {
  const js = read('app/renderer.js');
  assert.match(js, /data-state="\$\{r\.state\}" data-detail="\$\{escapeHtml\(look\.detail\)\}"/);
  assert.match(js, /window\.agentStateDisplay\.badgeHtml\(r\.state, r\.detail\)/);
  assert.match(js, /<div class="state">\$\{escapeHtml\(look\.words\)\}<\/div>/);
});

test('the waiting badge pulses, and not under prefers-reduced-motion', () => {
  const html = read('app/renderer.html');
  assert.match(html, /\.agent\[data-detail="waiting"\] \.state-badge \{[^}]*animation: badge-pulse/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{ \.agent\[data-detail="waiting"\] \.state-badge \{ animation: none; \} \}/);
});

test('the host sends the detail with every mood message, and the file tools reach the mood engine', () => {
  const host = read('host/host.js');
  assert.match(host, /return \{ agent, state, detail: d, portrait: portraitOf\(agent, d\) \}/);
  assert.match(host, /mood\.on\('change', \(\{ agent, state, detail \}\) =>/);
  assert.match(host, /if \(isOccupancyOnly\(ev\)\) \{ mood\.handle\(ev\); return; \}/);
});
