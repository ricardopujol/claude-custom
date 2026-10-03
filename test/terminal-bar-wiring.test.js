'use strict';
/**
 * The terminal bar's page wiring (backlog #49 + #52, documentation/DESIGN_TERMINAL_BAR.md): source assertions in
 * the style of test/occupancy-wiring.test.js, because renderer.js can't be loaded by a unit test. The behaviour
 * runs in a real window in verify/probe-terminal-bar.js (scroll the prompt away, a fake night, the confirm).
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const HTML = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');
const RENDERER = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');
const rule = (selector) => {
  const at = HTML.indexOf(selector + ' {');
  return at === -1 ? null : HTML.slice(at, HTML.indexOf('}', at));
};

test('the page loads terminal-bar.js after the occupancy module it composes, before renderer.js', () => {
  const scripts = [...HTML.matchAll(/<script\s+src="\.\/([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(scripts.includes('terminal-bar.js'));
  assert.ok(scripts.indexOf('terminal-bar.js') > scripts.indexOf('occupancy-display.js'));
  assert.ok(scripts.indexOf('terminal-bar.js') < scripts.indexOf('renderer.js'));
});

test('the bar exists, hidden, inside the terminal area, with the prompt on the left and the chips on the right', () => {
  assert.match(HTML, /<div id="terminal-bar" role="status" hidden>/);
  for (const id of ['bar-prompt', 'bar-prompt-text', 'bar-prompt-age', 'bar-prompt-full', 'bar-chips']) assert.match(HTML, new RegExp(`id="${id}"`), id);
  const bar = HTML.slice(HTML.indexOf('<div id="terminal-bar"'), HTML.indexOf('<div id="occupancy-confirm"'));
  assert.ok(bar.indexOf('id="bar-prompt"') < bar.indexOf('id="bar-chips"'), 'prompt left of the chips');
  const termwrap = HTML.slice(HTML.indexOf('<div id="termwrap">'), HTML.indexOf('<aside class="zone" data-zone="right"'));
  assert.ok(termwrap.includes('id="terminal-bar"'));
});

test('the bar never animates, focus mode hides it, and the other-sessions banner steps below it', () => {
  assert.doesNotMatch(rule('#terminal-bar') + rule('.bar-chip') + rule('#bar-prompt-full'), /animation|transition/);
  assert.match(HTML, /body\.focus-mode[^{]*#terminal-bar/, 'focus mode hides it with the rest of the chrome');
  assert.match(HTML, /body\.bar-open #terminal-banner \{ top: \d+px; \}/);
  assert.doesNotMatch(HTML, /body\.occupied/);
});

test('the chips have a night colour (the strip\'s) and an agent colour, and the warn colour for two writers', () => {
  assert.match(HTML, /--night:\s*#/);
  assert.match(rule('.bar-chip.bedtime'), /var\(--night/);
  assert.match(rule('.bar-chip.occupancy'), /var\(--agent\)/);
  assert.match(rule('.bar-chip.occupancy.warn'), /var\(--warn\)/);
});

test('the page paints through the one pure model, and sets text, never HTML, from the person\'s words', () => {
  assert.match(RENDERER, /terminalBar\.barModel\(\{/);
  assert.match(RENDERER, /occupancyDisplay\.chipModel\(occupancy\.here/);
  const paint = RENDERER.slice(RENDERER.indexOf('function paintBarNow'), RENDERER.indexOf('function paintBarNow') + 4000);
  assert.doesNotMatch(paint, /innerHTML/);
  assert.match(paint, /textContent/);
});

test('the prompt is anchored AFTER the terminal has parsed what came before it, at baseY + cursorY', () => {
  assert.match(RENDERER, /term\.write\('', \(\) => \{[\s\S]*?terminalBar\.makeAnchor\(/);
  assert.match(RENDERER, /baseY: buf\.baseY, cursorY: buf\.cursorY, epoch: bar\.epoch/);
});

test('a resize, an erased scrollback (CSI 3 J) and a shrinking buffer each start a new epoch, so the prompt fails visible', () => {
  assert.match(RENDERER, /registerCsiHandler\(\{ final: 'J' \}[\s\S]*?params\[0\] === 3[\s\S]*?bar\.epoch \+= 1/);
  assert.match(RENDERER, /buf\.length < bar\.lastLength\) bar\.epoch \+= 1/);
  assert.match(RENDERER, /term\.onResize\(\(\) => \{[\s\S]*?bar\.epoch \+= 1/);
  assert.match(RENDERER, /term\.onScroll\(\(\) => paintBar\(\)\)/);
});

test('hello and the two control messages feed the bar; a dropped socket forgets the night (unknown, not the last word)', () => {
  assert.match(RENDERER, /msg\.type === 'prompt'/);
  assert.match(RENDERER, /msg\.type === 'bedtime'/);
  const at = RENDERER.indexOf('applyBarPrompt(msg.prompt, false)');
  assert.ok(at !== -1, 'hello applies the prompt');
  const hello = RENDERER.slice(at - 600, at + 300);
  assert.ok(hello.includes('sessionTurn = msg.turn === undefined ? null : msg.turn;'), 'inside the hello handler, beside the turn');
  assert.match(hello, /applyBarPrompt\(msg\.prompt, false\)/);
  assert.match(hello, /applyBedtime\(msg\.bedtime\)/);
  const close = RENDERER.slice(RENDERER.indexOf('ws.onclose = () => {'), RENDERER.indexOf('ws.onerror'));
  assert.match(close, /applyBedtime\(null\)/);
});

test('the night is reported to the shell (the night tab) and feeds the confirm as a run of its own', () => {
  assert.match(RENDERER, /turn: sessionTurn,\s*night: bar\.bedtime !== null,/);
  assert.match(RENDERER, /nightClaim\(\)/);
  assert.match(RENDERER, /An overnight run is going\./);
  assert.match(RENDERER, /confirm\.setClaims\(confirmClaims\(\)\)/);
});

test('the occupancy chip\'s Jump and the bar\'s minutes refresh share the page\'s existing paths', () => {
  assert.match(RENDERER, /jumpToFolder\(/);
  assert.match(RENDERER, /setInterval\(\(\) => \{ paintBar\(\); \}, 30000\)|setInterval\(\(\) => paintBar\(\), 30000\)/);
});
