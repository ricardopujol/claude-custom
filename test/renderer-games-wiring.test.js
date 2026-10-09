'use strict';
/**
 * The wiring of the Games panel (BACKLOG #41): source assertions in the style of test/renderer-resources-wiring.test.js, because
 * renderer.js needs a real DOM. The rules are tested directly (games-rules*.test.js, games-round.test.js, game-scores.test.js) and
 * the panel through a fake document (games-display.test.js); verify/probe-games.js drives the same paths in a real window.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const RAW = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');
const PRELOAD = strip(fs.readFileSync(path.join(APP, 'preload.js'), 'utf8'));
const MAIN = strip(fs.readFileSync(path.join(APP, 'main.js'), 'utf8'));
const { TABS } = require('../app/side-tabs');

const START = RAW.indexOf('// GAMES-BEGIN');
const BLOCK = strip(RAW.slice(START, RAW.indexOf('// GAMES-END')));
const RENDERER = strip(RAW);

test('the Games panel is an ordinary module: one TABS entry, one panel, three scripts in order before renderer.js', () => {
  assert.ok(TABS.some(t => t.id === 'games' && t.label === 'Games' && t.title), 'side-tabs TABS lists it');
  assert.match(HTML, /<div class="panel" data-panel="games" id="games-body">\s*<div id="games-root"/);
  const at = n => HTML.indexOf(`<script src="./${n}.js"></script>`);
  assert.ok(at('games-rules') !== -1 && at('games-rules') < at('games-round') && at('games-round') < at('games-display'));
  assert.ok(at('games-display') < at('renderer'));
});

test('the glue is findable, and the page hands the game only what it alone knows', () => {
  assert.ok(START !== -1 && BLOCK.length > 400);
  assert.match(BLOCK, /focusTerminal: \(\) => term\.focus\(\)/);
  assert.match(BLOCK, /terminalHasFocus: \(\) => !!\(term\.element && term\.element\.contains\(document\.activeElement\)\)/);
  assert.match(BLOCK, /bridge: window\.harness && window\.harness\.games \? window\.harness\.games : null/);
  assert.doesNotMatch(BLOCK, /require\(|child_process|process\./);
});

test('HAND-BACK: every attention message calls gamesHandBack, before anything that could return', () => {
  const at = RENDERER.indexOf("msg.type === 'attention'");
  assert.ok(at !== -1);
  const body = RENDERER.slice(at, RENDERER.indexOf("msg.type === 'milestone'"));
  assert.match(body, /^[^{]*\{\s*gamesHandBack\(\);/, 'the first statement of the attention branch');
  assert.match(BLOCK, /function gamesHandBack\(\) \{ if \(gamesPanel\) gamesPanel\.handBack\(\); \}/);
});

test('the panel is told whether it is on screen after every layout, and when the page is shown or hidden', () => {
  assert.match(RENDERER, /shownModules = now;\s*gamesView\(\);/);
  assert.match(BLOCK, /document\.addEventListener\('visibilitychange', \(\) => \{[^}]*\}[^}]*gamesView\(\); \}\)/);
  assert.match(BLOCK, /window\.addEventListener\('pagehide', \(\) => \{ if \(gamesPanel\) gamesPanel\.bankNow\(\); \}\)/);
  assert.match(BLOCK, /shown: shownModules\.has\('games'\), pageVisible: document\.visibilityState === 'visible'/);
});

test('the bests travel main <-> page by the same two channels, and the page can only ask for them', () => {
  assert.match(PRELOAD, /games: \{\s*scores: \(\) => ipcRenderer\.invoke\('games:scores'\),\s*submit: \(game, score\) => ipcRenderer\.invoke\('games:submit', game, score\),\s*\}/);
  assert.match(MAIN, /ipcMain\.handle\('games:scores', \(e\) => \(isTabView\(e\.sender\) \? gameScores\.read\(\) : null\)\)/);
  assert.match(MAIN, /ipcMain\.handle\('games:submit', \(e, game, score\) => \(isTabView\(e\.sender\) \? gameScores\.submit\(game, score\) : null\)\)/);
  assert.match(MAIN, /const gameScores = createScoreStore\(uiStore\)/);
});

test('every class the panel builds has a rule in renderer.html', () => {
  const src = fs.readFileSync(path.join(APP, 'games-display.js'), 'utf8');
  const used = new Set([...src.matchAll(/class: '(games-[a-z-]+)'/g)].map(m => m[1]));
  assert.ok(used.size >= 8, 'the scan finds the panel\'s classes');
  const unstyled = [...used].filter(c => !HTML.includes(`.${c}`));
  assert.deepStrictEqual(unstyled, [], `unstyled: ${unstyled.join(', ')}`);
});

test('there are no sounds', () => {
  const src = fs.readFileSync(path.join(APP, 'games-display.js'), 'utf8');
  assert.doesNotMatch(strip(src), /\bAudio\b|AudioContext|\.play\(|<audio|beep/);
});
