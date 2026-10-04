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
  assert.match(HTML, /<div id="terminal-bar" role="group" aria-label="[^"]+" hidden>/, 'a group, not a live region: the prompt is not announced on every repaint (Miguel G3)');
  assert.doesNotMatch(HTML, /id="terminal-bar" role="status"/);
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

test('F6: the prompt is anchored on the line its echo was FOUND on, by its text, never on the cursor', () => {
  assert.doesNotMatch(RENDERER, /makeAnchor\([^)]*(baseY|cursorY)/);
  assert.match(RENDERER, /terminalBar\.echoNeedle\(p\.text\)/);
  assert.match(RENDERER, /terminalBar\.findEcho\(bufferTexts\(from\), loc\.needle\)/);
  assert.match(RENDERER, /terminalBar\.makeAnchor\(bar\.prompt, \{ line, epoch: bar\.epoch \}\)/);
  // searched once the terminal has parsed what came before it, and again as output is parsed
  assert.match(RENDERER, /term\.write\('', \(\) => \{ if \(bar\.locate === loc\) locateEcho\(\); \}\);/);
  assert.match(RENDERER, /term\.onWriteParsed\(\(\) => \{\s*const loc = bar\.locate;/);
  // the vim latch's handler (renderer-top-bar.test.js) stays the FIRST onWriteParsed in the file
  assert.ok(RENDERER.indexOf('term.onWriteParsed(() => {\r\n  if (!vimSeen') < RENDERER.indexOf('term.onWriteParsed(() => {\r\n  const loc = bar.locate;') || RENDERER.indexOf('term.onWriteParsed(() => {\n  if (!vimSeen') < RENDERER.indexOf('term.onWriteParsed(() => {\n  const loc = bar.locate;'));
});

test('F6: until the echo is found the anchor is "locating" (no flash), and one never found within LOCATE_MS fails visible', () => {
  assert.match(RENDERER, /const LOCATE_MS = 3000;/);
  assert.match(RENDERER, /bar\.anchor = terminalBar\.locatingAnchor\(p, bar\.epoch\)/);
  assert.match(RENDERER, /if \(bar\.anchor && bar\.anchor\.locating === true\) \{ bar\.anchor = null; paintBar\(\); \}/);
  // a hello prompt (not live) is never searched for: it has no place in this buffer
  assert.match(RENDERER, /const needle = p && live \? terminalBar\.echoNeedle\(p\.text\) : null;/);
});

test('F7: a chip keeps the bar open over the first rows, so the page tells the rule how many rows it covers', () => {
  assert.match(RENDERER, /const coveredRows = \(bar\.bedtime !== null \|\| chip !== null\) && rowPx > 0 \? Math\.ceil\(BAR_COVER_PX \/ rowPx\) : 0;/);
  assert.match(RENDERER, /epoch: bar\.epoch, coveredRows \}/);
});

test('Y1 + G1: a paint with nothing new writes nothing (a selection in the whole prompt survives), and text is only set when it differs', () => {
  const paint = RENDERER.slice(RENDERER.indexOf('function paintBarNow'), RENDERER.indexOf('function paintBarNow') + 5000);
  assert.match(paint, /const key = JSON\.stringify\(\[m, bar\.fullOpen\]\);\s*if \(key !== bar\.paintKey\) \{/);
  assert.match(paint, /setText\(barEls\.full, m\.prompt\.full\)/);
  assert.doesNotMatch(paint, /barEls\.(text|age|full)\.textContent =/);
  assert.match(RENDERER, /function setText\(el, value\) \{\s*if \(el\.textContent !== value\) el\.textContent = value;/);
});

test('G3: the prompt toggle says whether it is open, and Escape inside the bar closes it without taking the terminal\'s own Escape', () => {
  assert.match(HTML, /id="bar-prompt" hidden aria-expanded="false" aria-controls="bar-prompt-full"/);
  assert.match(RENDERER, /barEls\.prompt\.setAttribute\('aria-expanded', String\(!!\(m\.prompt && bar\.fullOpen\)\)\)/);
  assert.match(RENDERER, /barEls\.bar\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key !== 'Escape'\) return;[\s\S]*?if \(!bar\.fullOpen\) return;/);
  assert.match(RENDERER, /setAttribute\('role', 'note'\)/);
});

test('G4: an unbroken token cannot overflow the whole-prompt view', () => {
  assert.match(rule('#bar-prompt-full'), /overflow-wrap:\s*anywhere/);
});

test('G6: leaving or entering focus mode repaints the bar (bar-open and the banner offset follow)', () => {
  const focus = RENDERER.slice(RENDERER.indexOf('function applyFocusMode'), RENDERER.indexOf('if (focusBridge) focusBridge.onChange(applyFocusMode)'));
  assert.match(focus, /paintBar\(\);/);
});

test('Y3: the night chip carries its own colour pair, not one mixed from the look\'s variables', () => {
  const r = rule('.bar-chip.bedtime');
  assert.match(r, /background:\s*var\(--night\);/);
  assert.match(r, /color:\s*var\(--night-text\)/);
  assert.doesNotMatch(r, /color-mix|--chrome|--text\b/);
  assert.match(HTML, /--night-text:\s*#/);
});

test('G1: the 30 s repaint only runs where there is something on the bar', () => {
  assert.match(RENDERER, /setInterval\(\(\) => \{ if \(bar\.prompt \|\| bar\.bedtime !== null \|\| occupancy\.here\.length > 0 \|\| sum\.pinned\) paintBar\(\); \}, 30000\)/);
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

test('the probe\'s page actions for the bar exist, and a clear is the real escape sequence through xterm\'s own parser', () => {
  for (const a of ['barState', 'barScroll', 'barClick', 'barClear', 'barLook', 'barSelection']) assert.match(RENDERER, new RegExp(`case '${a}'`), a);
  assert.match(RENDERER, /case 'barClear': return new Promise\(\(resolve\) => \{\s*term\.write\('\\x1b\[3J'/);
});

test('the occupancy chip\'s Jump and the bar\'s minutes refresh share the page\'s existing paths', () => {
  assert.match(RENDERER, /jumpToFolder\(/);
  assert.match(RENDERER, /setInterval\(/);
});

test('F4: the night is a persistent run for the confirm, and a new night forgets the last one', () => {
  assert.match(RENDERER, /agentId: 'bedtime:' \+ bar\.bedtime\.startedAt, persist: true/);
  assert.match(RENDERER, /bar\.nightKey !== key && occupancy\.confirm\) occupancy\.confirm\.forget\(bar\.nightKey\)/);
  const close = RENDERER.slice(RENDERER.indexOf('ws.onclose = () => {'), RENDERER.indexOf('ws.onerror'));
  assert.match(close, /applyBedtime\(null\)/, 'a drop still clears the night; the confirm remembers it');
});
