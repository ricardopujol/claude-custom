'use strict';
/**
 * renderer.js's half of Claude's panel (BACKLOG #71): source assertions in the style of test/renderer-wand-wiring.test.js, because
 * renderer.js needs a real DOM. The decisions are pure and tested (test/canvas-display.test.js); verify/probe-canvas-panel.js
 * drives the same paths in a real window with a real host.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAW = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const JS = strip(RAW);
const BLOCK = (() => {
  const a = RAW.indexOf('// CANVAS-BEGIN');
  const b = RAW.indexOf('// CANVAS-END');
  assert.ok(a !== -1 && b > a, 'renderer.js must have a CANVAS-BEGIN / CANVAS-END block');
  return strip(RAW.slice(a, b));
})();

test('the block takes its bridge from the page and its decisions from canvasDisplay', () => {
  assert.match(BLOCK, /const canvasBridge = window\.harness && window\.harness\.canvas;/);
  assert.match(BLOCK, /let canvasState = window\.canvasDisplay\.emptyState\(\);/);
  assert.match(BLOCK, /document\.getElementById\('canvas-root'\)/);
});

test("every attaching window's hello feeds the panel's state, and a `canvas` frame is handled and returns", () => {
  const hello = JS.slice(JS.indexOf("if (msg.type === 'hello') {"), JS.indexOf("if (msg.type === 'loadout') {"));
  assert.match(hello, /canvasOnFrame\(msg\.canvas\);/);
  assert.match(JS, /if \(msg\.type === 'canvas'\) \{\s*canvasOnFrame\(msg\);\s*return;\s*\}/);
});

test('the panel docks itself only when canvasDisplay says Claude wrote a page: shown if hidden, selected if shown', () => {
  const dock = BLOCK.slice(BLOCK.indexOf('function canvasOnFrame('), BLOCK.indexOf('function canvasOnFrame(') + 900);
  assert.match(dock, /if \(window\.canvasDisplay\.shouldDock\(frame\)\) canvasDock\(\);/);
  // hidden: shown; unpinned (#85): opened from its rail, held; docked: selected: all three in the one shared helper
  assert.match(BLOCK, /function canvasDock\(\) \{\s*revealModule\('canvas'\);/);
  assert.match(JS, /function revealModule\(id\) \{[\s\S]*?commitPlacement\(DTm\.show\(settledLayout\(\), id\), \{ select: id \}\)[\s\S]*?\} else selectModule\(id\);/);
});

test('hidden means stopped: the native view exists only while the module shows, the page is visible and there is a page to show', () => {
  const sync = BLOCK.slice(BLOCK.indexOf('function syncCanvasView('), BLOCK.indexOf('function syncCanvasView(') + 1800);
  assert.match(sync, /shownModules\.has\('canvas'\) && document\.visibilityState === 'visible' && window\.canvasDisplay\.canShow\(canvasState\)/);
  assert.match(sync, /canvasBridge\.hide\(\);/);
  assert.match(BLOCK, /document\.addEventListener\('visibilitychange', syncCanvasView\);/);
});

test('every redraw of the dock re-lays the native view, and opening the module asks for the page', () => {
  const layout = JS.slice(JS.indexOf('function renderLayout('), JS.indexOf('\n}', JS.indexOf('function renderLayout(')));
  assert.match(layout, /syncCanvasView\(\);/);
  const shown = JS.slice(JS.indexOf('function onModuleShown('), JS.indexOf('\n}', JS.indexOf('function onModuleShown(')));
  assert.match(shown, /if \(id === 'canvas'\) \{ canvasFetchIfNeeded\(\); renderCanvas\(\); \}/);
});

test('the native view is laid over the slot the display draws, measured, never over anything else', () => {
  assert.match(BLOCK, /canvasRoot\.querySelector\('#canvas-slot'\)/);
  assert.match(BLOCK, /getBoundingClientRect\(\)/);
  assert.match(BLOCK, /new ResizeObserver\(/);
});

test('a question or the host list covers the native view; nothing takes focus away from the terminal for it', () => {
  assert.match(BLOCK, /window\.canvasDisplay\.covered\(canvasState\)/);
  assert.match(BLOCK, /canvasBridge\.cover\(covered\);/);
  assert.doesNotMatch(BLOCK, /\.focus\(\)/, 'an Enter meant for the terminal must not land on "Allow"');
});

test('clicks are read through actionOf; an answer goes to main and is kept by the host for this panel', () => {
  assert.match(BLOCK, /window\.canvasDisplay\.actionOf\(el\.dataset\)/);
  assert.match(BLOCK, /canvasBridge\.answerHost\(a\.id, a\.act\);/);
  assert.match(BLOCK, /type: 'canvas-hosts', action: a\.act, origin: ask\.origin/);
  assert.match(BLOCK, /type: 'canvas-hosts', action: 'remove', origin: a\.origin/);
});

test('a page is asked for with canvas-get, once per signature, and retried if the answer never came', () => {
  assert.match(BLOCK, /ws\.send\(JSON\.stringify\(\{ type: 'canvas-get' \}\)\);/);
  assert.match(BLOCK, /canvasFetchSig === sig/);
  assert.match(BLOCK, /setTimeout\(\(\) => \{ if \(canvasFetchSig === sig\) canvasFetchSig = null; \}, 3000\);/);
});

test("a button's message is typed through typeCommand (the wand's path), as the line canvasDisplay builds, and nothing here writes a CR or an input frame", () => {
  const fn = BLOCK.slice(BLOCK.indexOf('function canvasSendToSession('), BLOCK.indexOf('if (canvasBridge && canvasRoot) {'));
  assert.match(fn, /const line = window\.canvasDisplay\.sessionLine\(text\);/);
  assert.match(fn, /typeCommand\(line, \(r\) => \{/);
  assert.match(fn, /\}, 'panel', \{ submit: true \}\);/, "kind 'panel' (app/top-bar-display.js PANEL_LINE), and Enter is the submit gate's decision, not this block's");
  assert.match(fn, /if \(canvasTyping\) \{ showCanvasStatus\(window\.canvasDisplay\.unsent\(canvasState, 'the previous message is still being typed'\)\); return; \}/, 'one at a time, and a second click says so instead of vanishing (PR #125 Dexter #10)');
  assert.match(fn, /if \(!line\) \{ showCanvasStatus\(window\.canvasDisplay\.unsent\(canvasState, window\.canvasDisplay\.whyNot\(text\)/, 'a message that cannot be typed says why on the status line, never silently (PR #125 Dexter #1, #10)');
  assert.match(BLOCK, /canvasBridge\.onMessage\(\(msg\) => \{ if \(msg && msg\.kind === 'send'\) canvasSendToSession\(msg\.text\); \}\);/);
  assert.doesNotMatch(BLOCK, /submitTyped|type: 'input'|\\r/);
});

test('the shelf follows the page: given with it, and sent again only when it changes', () => {
  assert.match(BLOCK, /canvasBridge\.show\(\{ html: req\.html, hosts: req\.hosts, shelf: req\.shelf,/);
  assert.match(BLOCK, /if \(shelfKey !== canvasShownShelf\) \{ canvasShownShelf = shelfKey; canvasBridge\.shelf\(req\.shelf\); \}/);
});

test('the "already asked" memo is cleared whenever there is nothing to fetch, so the same page written again is fetched again', () => {
  const fn = BLOCK.slice(BLOCK.indexOf('function canvasOnFrame('), BLOCK.indexOf('function canvasHostsSend('));
  assert.match(fn, /if \(!window\.canvasDisplay\.needsFetch\(canvasState\)\) canvasFetchSig = null;/);
  assert.ok(fn.indexOf('canvasFetchSig = null') < fn.indexOf('canvasFetchIfNeeded();'), 'cleared BEFORE the next fetch decision');
});

test('anything else drawn over the slot hides the native view, and the page looks again after interactions, drags and on a tick (PR #122 Dexter F5)', () => {
  const sync = BLOCK.slice(BLOCK.indexOf('function syncCanvasView('), BLOCK.indexOf('function syncCanvasView(') + 1500);
  assert.match(sync, /const covered = window\.canvasDisplay\.covered\(canvasState\) \|\| \(rect !== null && window\.canvasDisplay\.slotObstructed\(rect, canvasIsSlotAt\)\);/);
  assert.match(BLOCK, /function canvasIsSlotAt\(x, y\) \{[^}]*document\.elementFromPoint\(x, y\)/);
  for (const ev of ['pointerup', 'click', 'keyup', 'contextmenu', 'wheel', 'resize']) assert.ok(BLOCK.includes(`'${ev}'`), ev);
  assert.match(BLOCK, /window\.addEventListener\('pointermove', \(e\) => \{ if \(e\.buttons\) canvasSchedule\(\); \}, true\);/);
  assert.match(BLOCK, /setInterval\(\(\) => \{ if \(canvasLive && !document\.hidden\) canvasSchedule\(\); \}, 250\);/);
});

test('a show main refuses is said in the module and not retried; a stale answer is ignored; the questions go when the view goes (PR #122 Dexter F9, Miguel G4)', () => {
  const sync = BLOCK.slice(BLOCK.indexOf('function syncCanvasView('), BLOCK.indexOf('function syncCanvasView(') + 2600);
  assert.match(sync, /canvasBridge\.show\(\{ html: req\.html, hosts: req\.hosts, shelf: req\.shelf, rect: canvasLastRect, covered \}\)\.then\(\(res\) => \{/);
  assert.match(sync, /if \(res && res\.ok === false && res\.stale !== true\) \{/);
  assert.match(sync, /canvasState = window\.canvasDisplay\.withRefusal\(canvasState, sig, res\.error\);\s*renderCanvas\(\);/);
  assert.match(sync, /canvasBridge\.hide\(\); canvasLive = false;[^\n]*const had = canvasState\.asks\.length > 0; canvasState = window\.canvasDisplay\.withoutAsks\(canvasState\); if \(had\) renderCanvas\(\);/);
});

test("the Style tab's switch for Claude's panel: a checkbox that sends the desired state, settles on main's answer and re-reads on null (#71 question 8)", () => {
  assert.match(JS, /if \(section\.id === 'panel' && v\) \{/);
  assert.match(JS, /id="style-canvas-mcp"\$\{v\.mcp === true \? ' checked' : ''\}\$\{v\.mcp === null \? ' disabled' : ''\}/);
  assert.match(JS, /window\.harness\.canvas\.settingsSet\(canvasMcpBox\.checked\)\.then\(settledCanvasMcp\)\.catch\(\(\) => refreshCanvasMcp\(\)\);/);
  assert.match(JS, /function settledCanvasMcp\(value\) \{\s*if \(typeof value === 'boolean'\) \{ styleState = reduceCanvasMcp\(styleState, value\); renderStylePanel\(\); \} else refreshCanvasMcp\(\);/);
  assert.match(JS, /^refreshCanvasMcp\(\);/m);
});

// PR #125 Miguel M3: the switch's re-read loop backs off, stops, and never stacks. Run the real function against a fake clock and bridge.
function loopRig(answers) {
  const start = JS.indexOf('function settledCanvasMcp(value) {');
  const body = JS.slice(start, JS.indexOf('function settledChrome(saved) {'));
  const timers = []; const asks = []; const settled = [];
  const window_ = { harness: { canvas: { settingsGet: () => { asks.push(timers.length); const a = answers.shift(); return a === 'throw' ? Promise.reject(new Error('x')) : Promise.resolve(a); } } } };
  const delay = (n) => (Number.isInteger(n) && n >= 0 && n + 1 < 8 ? Math.min(1000 * 2 ** n, 30000) : null);
  const f = new Function('window', 'setTimeout', 'canvasMcpRetryDelay', 'styleState', 'reduceCanvasMcp', 'renderStylePanel', `${body}; return { refreshCanvasMcp, settledCanvasMcp };`);
  const api = f(window_, (fn, ms) => { timers.push({ fn, ms }); }, delay, {}, (st, v) => { settled.push(v); return st; }, () => {});
  return { ...api, timers, asks, settled };
}
const flush = () => new Promise((r) => setImmediate(r));

test('M3: the re-read backs off 1 s, 2 s, 4 s ... and gives up after 8 asks', async () => {
  const r = loopRig(Array(20).fill(null));
  r.refreshCanvasMcp();
  const waits = [];
  for (let i = 0; i < 20; i++) { await flush(); const t = r.timers.shift(); if (!t) break; waits.push(t.ms); t.fn(); }
  assert.deepStrictEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.strictEqual(r.asks.length, 8);
  await flush();
  assert.strictEqual(r.timers.length, 0, 'it stopped');
});

test('M3: a failed save while a loop runs does not stack a second loop; after a boolean answer a new loop may start', async () => {
  const r = loopRig([null, null, true, null, true]);
  r.refreshCanvasMcp();
  await flush();
  r.settledCanvasMcp(null);              // a failed save
  r.settledCanvasMcp(null);
  assert.strictEqual(r.asks.length, 1, 'no second loop while one is waiting');
  assert.strictEqual(r.timers.length, 1, 'one timer');
  r.timers.shift().fn(); await flush();
  r.timers.shift().fn(); await flush();   // the third ask answers true
  assert.deepStrictEqual(r.settled, [true]);
  r.settledCanvasMcp(null); await flush(); // a fresh loop is allowed now
  assert.strictEqual(r.asks.length, 4);
});

test('M3: a rejected read retries the same way', async () => {
  const r = loopRig(['throw', true]);
  r.refreshCanvasMcp(); await flush();
  assert.strictEqual(r.timers[0].ms, 1000);
  r.timers.shift().fn(); await flush();
  assert.deepStrictEqual(r.settled, [true]);
});
