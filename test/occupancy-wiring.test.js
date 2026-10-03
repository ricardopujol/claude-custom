'use strict';
/**
 * The strings that join the occupancy feature's files (backlog #44 + #47), asserted against source: main.js
 * <-> preload.js <-> renderer.js <-> renderer.html. The same silent-death class test/bridge-contract.test.js
 * was written for -- a misspelled channel or a script tag nobody added does nothing, with a green suite --
 * and the behaviour itself is exercised in a real window by verify/probe-worktree-occupancy.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const MAIN = strip(read('main.js'));
const PRELOAD = strip(read('preload.js'));
const RENDERER = strip(read('renderer.js'));
const HTML = read('renderer.html');

// --- main.js -------------------------------------------------------------------------------------

function serviceBlock() {
  const start = MAIN.indexOf('createOccupancyService({', MAIN.indexOf('occupancyService = '));
  assert.ok(start !== -1, 'main creates the service');
  return MAIN.slice(start, MAIN.indexOf('log: (...a) => console.log(...a),', start));
}

test('main builds the occupancy service on the project\'s state folder, with the OS start-time proof', () => {
  assert.match(MAIN, /createOccupancyService\(\{[\s\S]*?dir: occupancyDir\(STATE_ROOT\)/);
  assert.match(MAIN, /startTimes[,\s]/);
  assert.match(MAIN, /require\('\.\.\/host\/proc-start'\)/);
});

test('the service creates its folder only through the look folder\'s own guard, and refuses a link', () => {
  const block = serviceBlock();
  assert.match(block, /ensureDir:/);
  assert.match(block, /lookDirState\(STATE_ROOT, fs\) === 'foreign'/);
  assert.match(block, /ensureLookDir\(STATE_ROOT, fs\)/);
});

test('a change in the live claims re-publishes the shell', () => {
  const block = serviceBlock();
  assert.match(block, /onChange: \(\) => \{ if \(tabShell\) tabShell\.refresh\(\); \}/);
});

test('the shell reads the live claims from it, and it starts once the shell is open and stops on quit', () => {
  assert.match(MAIN, /occupancy: \{ claims: \(\) => occupancyService\.current\(\) \}/);
  assert.match(MAIN, /occupancyService\.start\(\)/);
  assert.match(MAIN, /app\.on\('will-quit', \(\) => \{[^}]*occupancyService\.close\(\)/);
});

test('occupancy:get answers only one of this window\'s tab pages', () => {
  assert.match(MAIN, /ipcMain\.handle\('occupancy:get', \(e\) => \(isTabView\(e\.sender\) \? tabShell\.occupancyFor\(e\.sender\) : null\)\)/);
});

// --- preload.js ----------------------------------------------------------------------------------

test('the bridge exposes occupancy.get and a replace-don\'t-accumulate onChange on the same channels main uses', () => {
  const at = PRELOAD.indexOf('occupancy: {');
  assert.ok(at !== -1, 'harness.occupancy');
  const block = PRELOAD.slice(at, PRELOAD.indexOf('\n  },', at));
  assert.match(block, /get: \(\) => ipcRenderer\.invoke\('occupancy:get'\)/);
  assert.match(block, /removeAllListeners\('occupancy'\), ipcRenderer\.on\('occupancy'/);
  assert.match(block, /return \(\) => ipcRenderer\.removeAllListeners\('occupancy'\)|\(\) => ipcRenderer\.removeAllListeners\('occupancy'\)/);
});

// --- renderer.html -------------------------------------------------------------------------------

test('the page loads both occupancy modules, before renderer.js', () => {
  const scripts = [...HTML.matchAll(/<script\s+src="\.\/([^"]+)"><\/script>/g)].map(m => m[1]);
  for (const f of ['occupancy-display.js', 'occupancy-confirm.js']) {
    assert.ok(scripts.includes(f), `${f} is loaded`);
    assert.ok(scripts.indexOf(f) < scripts.indexOf('renderer.js'), `${f} before renderer.js`);
  }
});

test('the banner and the confirm exist, hidden, over the terminal, each with its parts', () => {
  assert.match(HTML, /<div id="occupancy-banner" role="status" hidden>/);
  for (const id of ['occupancy-banner-text', 'occupancy-banner-since', 'occupancy-banner-more', 'occupancy-banner-note', 'occupancy-jump']) {
    assert.match(HTML, new RegExp(`id="${id}"`), id);
  }
  assert.match(HTML, /<div id="occupancy-confirm" role="alertdialog"[^>]*hidden>/);
  assert.match(HTML, /id="occupancy-type"/);
  assert.match(HTML, /id="occupancy-wait"/);
  const termwrap = HTML.slice(HTML.indexOf('<div id="termwrap">'), HTML.indexOf('<aside class="zone" data-zone="right"'));
  assert.ok(termwrap.includes('id="occupancy-banner"') && termwrap.includes('id="occupancy-confirm"'), 'inside #termwrap');
});

test('both carry the coloured left rule, the warn colour for two writers, and never animate', () => {
  const rule = (selector) => {
    const at = HTML.indexOf(selector + ' {');
    return at === -1 ? null : HTML.slice(at, HTML.indexOf('}', at));
  };
  assert.match(rule('#occupancy-banner'), /border-left:[^;]*var\(--agent\)/);
  assert.match(rule('#occupancy-banner.warn'), /var\(--warn\)/);
  assert.match(rule('#occupancy-confirm'), /border-left:[^;]*var\(--agent\)/);
  assert.match(HTML, /--agent:\s*#/);
  assert.match(HTML, /--warn:\s*#/);
  assert.doesNotMatch(rule('#occupancy-banner') + rule('#occupancy-confirm'), /animation|transition/);
});

// --- renderer.js ---------------------------------------------------------------------------------

test('the page asks for its occupancy once and then follows the pushes, guarded like every bridge call', () => {
  assert.match(RENDERER, /window\.harness && window\.harness\.occupancy/);
  assert.match(RENDERER, /window\.harness\.occupancy\.get\(\)/);
  assert.match(RENDERER, /window\.harness\.occupancy\.onChange\(/);
});

test('user input goes through the confirm; the program\'s own typing and the terminal\'s replies do not', () => {
  // the keystroke paths: xterm's onData, Shift+Enter, and a paste
  assert.match(RENDERER, /term\.onData\(\(data\) => \{[\s\S]*?userInput\(data\);[\s\S]*?\}\);/);
  assert.match(RENDERER, /logLine\('Shift\+Enter', '\\x1b\\r'\);\s*userInput\('\\x1b\\r'\);/);
  assert.match(RENDERER, /userInput\(frame\);/);
  // everything else that types (the top bar, Type \/merged, resize) keeps calling send() directly
  assert.match(RENDERER, /const input = data => send\(JSON\.stringify\(\{ type: 'input', data \}\)\);/);
  // userInput itself is the confirm's input, falling back to send when there is no confirm
  assert.match(RENDERER, /function userInput\(data\) \{[\s\S]*?occupancy\.confirm\.input\(data\)/);
});

test('the confirm releases through the same send the keystroke would have used', () => {
  assert.match(RENDERER, /occupancyConfirm\.createConfirm\(\{\s*send: \(data\) => send\(data\)/);
});

test('the two buttons answer the confirm; the card line and Jump go through selectFolder', () => {
  assert.match(RENDERER, /getElementById\('occupancy-type'\)\.addEventListener\('click', \(\) => occupancy\.confirm\.type\(\)\)/);
  assert.match(RENDERER, /getElementById\('occupancy-wait'\)\.addEventListener\('click', \(\) => occupancy\.confirm\.wait\(\)\)/);
  assert.match(RENDERER, /window\.harness\.selectFolder\(/);
  assert.match(RENDERER, /data-where-root=/);
});

test('the roster card draws the where-line from the claims this tab launched', () => {
  assert.match(RENDERER, /occupancyDisplay\.cardLine\(occupancy\.launched, agent\)/);
  assert.match(RENDERER, /agentModelHtml\(r\.agent\) \+\s*occupancyWhereHtml\(r\.agent\) \+\s*careerHtml\(r\.agent\)/);
});

test('a worktree page reports nothing new to the shell: the turn it already sends is what the two-writers warning reads', () => {
  assert.match(RENDERER, /turn: sessionTurn,/);
});
