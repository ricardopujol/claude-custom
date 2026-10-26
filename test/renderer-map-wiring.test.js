'use strict';
/**
 * The wiring of the Map panel (BACKLOG #120): source assertions in the style of test/renderer-games-wiring.test.js, because renderer.js
 * needs a real DOM. The decisions are tested directly (map-model*.test.js, map-layout.test.js, map-feed.test.js) and the panel through a
 * fake document (map-display.test.js); verify/probe-activity-map.js drives the same paths in a real window.
 *
 * THE POINT OF THE ASSERTIONS HERE is the frame-budget rule: the page must tell the panel all three facts (shown, focused, lean) after
 * every change to any of them, and must stop asking the host for anything while the panel can't move.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const HOST = path.join(__dirname, '..', 'host');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const RAW = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
const HTML = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8').replace(/\r\n/g, '\n');
const HOST_SRC = strip(fs.readFileSync(path.join(HOST, 'host.js'), 'utf8').replace(/\r\n/g, '\n'));
const SHELL = strip(fs.readFileSync(path.join(APP, 'tab-shell.js'), 'utf8').replace(/\r\n/g, '\n'));
const DOCK = fs.readFileSync(path.join(APP, 'dock-tree.js'), 'utf8');
const { TABS } = require('../app/side-tabs');
const { CONTROL_TYPES, parseControlFrame } = require('../host/control');
const icons = require('../app/rail-icons');

const START = RAW.indexOf('// MAP-BEGIN');
const BLOCK = strip(RAW.slice(START, RAW.indexOf('// MAP-END')));
const RENDERER = strip(RAW);

test('the Map is an ordinary module: one TABS entry, one icon, one panel, three scripts in order before renderer.js, 520 px of its own', () => {
  assert.ok(TABS.some(t => t.id === 'map' && t.label === 'Map' && t.title), 'side-tabs TABS lists it');
  assert.ok(icons.svgFor('map').includes('<svg'), 'the rail has an icon for it');
  assert.match(HTML, /<div class="panel" data-panel="map" id="map-body">\s*<div id="map-root"/);
  const at = n => HTML.indexOf(`<script src="./${n}.js"></script>`);
  assert.ok(at('map-model') !== -1 && at('map-model') < at('map-layout') && at('map-layout') < at('map-display'));
  assert.ok(at('map-display') < at('renderer'));
  assert.match(DOCK, /OWN_ROW_SIZE = Object\.freeze\(\{[^}]*\bmap: 520\b/);
});

test('the glue is findable, and the page hands the panel only what it alone knows', () => {
  assert.ok(START !== -1 && BLOCK.length > 1500);
  assert.doesNotMatch(BLOCK, /require\(|child_process|process\./);
  assert.match(BLOCK, /window\.mapDisplay\.mount\(\{/);
  assert.match(BLOCK, /onAgent: \(name\) => \{ selectModule\('agents'\); openAgentLog\(name\); \}/);
  assert.match(BLOCK, /window\.harness\.selectFolder\(s\.folder\)/);
});

test('FRAME BUDGET: the panel is told shown x focused x lean, and a page the OS hides is not focused', () => {
  assert.match(BLOCK, /mapPanel\.setView\(\{ shown: shownModules\.has\('map'\), focused, lean: leanOn \}\)/);
  assert.match(BLOCK, /const focused = windowFocused === null \? null : \(windowFocused === true && document\.visibilityState === 'visible'\)/);
});

test('FRAME BUDGET: every change to any of the three facts calls mapView', () => {
  assert.match(RENDERER, /shownModules = now;\s*gamesView\(\);[^\n]*\n\s*askView\(\);[^\n]*\n\s*mapView\(\);/, 'after every layout');
  assert.match(RENDERER, /windowFocused = focused === true;\s*syncLeanMotion\(\);\s*mapView\(\);/, 'when main says focus changed');
  assert.match(RENDERER, /leanOn = on;\s*mapView\(\);/, 'when lean switches');
  assert.match(BLOCK, /document\.addEventListener\('visibilitychange', \(\) => \{ mapView\(\);/, 'when the page is hidden or shown');
});

test('FRAME BUDGET: nothing is asked of the host, the tabs or the tree unless the map can move', () => {
  assert.match(BLOCK, /function mapWanted\(\) \{ return !!mapPanel && shownModules\.has\('map'\) && !leanOn && windowFocused === true && document\.visibilityState === 'visible'; \}/);
  assert.match(BLOCK, /function mapPoll\(\) \{\s*if \(!mapWanted\(\)\) return;/);
  assert.strictEqual((BLOCK.match(/setInterval\(/g) || []).length, 1, 'one timer, and it is the guarded poll');
  assert.match(BLOCK, /setInterval\(mapPoll, MAP_POLL_MS\)/);
  assert.match(BLOCK, /function mapRefresh\(\) \{ if \(mapLive && mapPanel && shownModules\.has\('map'\) && !leanOn\)/);
});

test('the animation runs at 20 frames a second by default (the probe measured the price of a presented frame), and the panel can be swapped for the probe', () => {
  assert.match(BLOCK, /const MAP_FRAME_MS = 33;/);
  assert.match(BLOCK, /frameMs: MAP_FRAME_MS,/);
  assert.match(BLOCK, /const mapMountPanel = \(extra\) => window\.mapDisplay\.mount\(\{ \.\.\.mapMountOptions, \.\.\.extra \}\);/);
  assert.match(BLOCK, /let mapPanel = mapRoot \? mapMountPanel\(\{\}\) : null;/);
  assert.match(RENDERER, /a\.op === 'remount'\) \{ mapPanel\.destroy\(\);/, 'the old panel is stopped before the new one is built');
});

test('the host is asked only if it lists the control (an older host would type the frame into the session)', () => {
  assert.match(BLOCK, /if \(!hostControls \|\| !hostControls\.includes\('map'\) \|\| !ws \|\| ws\.readyState !== WebSocket\.OPEN\) return;/);
});

test('the page reads nothing until the first hello (the consts it reads are not yet initialised before it)', () => {
  assert.match(RENDERER, /mapLive = true;\s*[^\n]*\n\s*mapSince\.clear\(\);/);
});

test('the answer from the host is sanitised: numbers or null, objects or empty, then drawn', () => {
  assert.match(BLOCK, /function mapOnMap\(msg\)/);
  assert.match(BLOCK, /typeof v === 'number' && Number\.isFinite\(v\) \? v : null/);
  assert.match(RENDERER, /if \(msg\.type === 'map'\) \{\s*mapOnMap\(msg\);\s*return;\s*\}/);
  assert.match(BLOCK, /mapOwn\(mapRates\.perMinute, r\.agent\)/, 'an agent called constructor is not a property of the rates');
});

test('"since when" is learned from the mood message only: an agent already working when the page attached has no elapsed time', () => {
  assert.match(RENDERER, /if \(msg\.type === 'mood'\) \{\s*mapNoteMood\(msg\);\s*roster\.set\(msg\.agent, msg\);/);
  assert.match(BLOCK, /since: mapSince\.has\(r\.agent\) \? mapSince\.get\(r\.agent\) : null/);
});

test('the roster, the tree and the turn all refresh the map', () => {
  assert.match(RENDERER, /function renderRoster\(\) \{\s*mapRefresh\(\);/);
  assert.match(RENDERER, /renderGitGraph\(\);[^\n]*\n\s*mapRefresh\(\);/);
  // the turn handler may do its own work first (PR #158's agent-pause clock sits there), but it ends by repainting and refreshing the map
  assert.match(RENDERER, /sessionTurn = msg\.turn === undefined \? null : msg\.turn;(?:(?!\n {2}\}|sessionTurn = msg)[\s\S]){0,800}?paintBar\(\);\s*reportTabStatus\(\);\s*mapRefresh\(\);\s*return;/);
});

test('opening the panel, or the window coming back to the front, asks at once', () => {
  assert.match(RENDERER, /if \(id === 'map'\) mapPollNow\(\);/);
  assert.match(RENDERER, /mapView\(\);[^\n]*\n\s*if \(windowFocused\) mapPollNow\(\);/);
});

test('the probe can read and drive the panel (and the shell lets those two controls through)', () => {
  assert.match(RENDERER, /case 'mapState': \{/);
  assert.match(RENDERER, /case 'mapDo': \{/);
  assert.match(SHELL, /'mapState', 'mapDo'/);
});

test('HOST: `map` is a control type, so a frame of it is never typed into the pty', () => {
  assert.ok(CONTROL_TYPES.has('map'));
  const parsed = parseControlFrame(JSON.stringify({ type: 'map' }));
  assert.ok(parsed && parsed.type === 'map');
});

test('HOST: every hook event is counted, before the early returns that would hide some of them', () => {
  const note = HOST_SRC.indexOf('mapFeed.note(ev)');
  const firstReturn = HOST_SRC.indexOf('if (isOccupancyOnly(ev)) { mood.handle(ev); return; }');
  assert.ok(note !== -1 && firstReturn !== -1 && note < firstReturn);
  assert.match(HOST_SRC, /if \(msg\.type === 'map'\) \{[^}]*ws\.send\(JSON\.stringify\(\{ type: 'map', \.\.\.mapFeed\.snapshot\(\) \}\)\)/);
  assert.match(HOST_SRC, /const mapFeed = createMapFeed\(\{ startedAt: Date\.now\(\) \}\)/);
});

test('every class the panel builds has a rule in renderer.html', () => {
  const src = fs.readFileSync(path.join(APP, 'map-display.js'), 'utf8');
  const used = new Set([...src.matchAll(/class: '(map-[a-z-]+)'/g)].map(m => m[1]));
  assert.ok(used.size >= 10, 'the scan finds the panel\'s classes');
  const unstyled = [...used].filter(c => !HTML.includes(`.${c}`));
  assert.deepStrictEqual(unstyled, [], `unstyled: ${unstyled.join(', ')}`);
});

test('the colours are the project\'s tokens, and every token the canvas reads is one the page defines', () => {
  const src = fs.readFileSync(path.join(APP, 'map-display.js'), 'utf8');
  const read = new Set([...src.matchAll(/tok\('(--[a-z-]+)'\)/g)].map(m => m[1]));
  const defined = (name) => new RegExp(`${name}\\s*:`).test(HTML) || /\.setProperty\('(--[a-z-]+)'/.test(RAW);
  // --cue is asked for first and falls back to --warn: the project has no --cue token today
  for (const t of read) if (t !== '--cue' && t !== '--font-ui') assert.ok(defined(t), `${t} is defined by the page`);
  assert.ok(read.has('--accent') && read.has('--ok') && read.has('--bad') && read.has('--dim') && read.has('--chrome'));
  assert.ok(/--warn\s*:/.test(HTML), 'the fallback for --cue exists');
});

test('REVIEW FIXES: every message asks for a rebuild (invalidate), the page marks which claims are its own, and the panel hears motion and ratio changes', () => {
  assert.match(BLOCK, /mapPanel\.invalidate\(\)/);
  assert.match(BLOCK, /source: \(\) => mapInput\(\),/);
  assert.doesNotMatch(BLOCK, /mapPanel\.setData\(/, 'nothing rebuilds the graph outside the coalescing');
  assert.match(BLOCK, /claims\.push\(\{ \.\.\.c, own: mine\.has\(c\.agentId\) \}\)/);
  assert.match(BLOCK, /now: Date\.now\(\),/);
  assert.match(BLOCK, /path: lastGitTree && typeof lastGitTree\.project === 'string'/);
  assert.match(BLOCK, /\(prefers-reduced-motion: reduce\)'\)\.addEventListener\('change', \(\) => \{ if \(mapPanel\) mapPanel\.refresh\(\); \}\)/);
  assert.match(BLOCK, /\(resolution: \$\{window\.devicePixelRatio\}dppx\)/);
});
