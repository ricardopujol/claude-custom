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
  assert.match(MAIN, /occupancy: \{ claims: \(\) => occupancyService\.current\(\), known: \(folder\) => occupancyService\.known\(folder\) \}/);
  assert.match(MAIN, /occupancyService\.start\(\)/);
  assert.match(MAIN, /app\.on\('will-quit', \(\) => \{[^}]*occupancyService\.close\(\)/);
});

// The fallback producer (host/occupancy-transcripts.js): claims read off the subagent transcripts, for the
// sessions no host of this build runs.
function scannerBlock() {
  const start = MAIN.indexOf('createTranscriptScanner({', MAIN.indexOf('transcriptOccupancy = '));
  assert.ok(start !== -1, 'main creates the transcript scanner');
  return MAIN.slice(start, MAIN.indexOf('log: (...a) => console.log(...a),', start));
}

test('main runs the transcript scanner over the project\'s worktrees, into the SAME store, with its own pid and start time as the proof', () => {
  const block = scannerBlock();
  assert.match(block, /projectsDir: seams\.projectsDir \|\| defaultProjectsDir\(\)/);
  assert.match(block, /roots: createRootsProvider\(\{ cwd: STATE_ROOT/);
  assert.match(block, /writer: createClaimWriter\(\{ stateRoot: STATE_ROOT/);
  assert.match(block, /dir: occupancyDir\(STATE_ROOT\)/);
  assert.match(block, /ownPid: process\.pid/);
  assert.match(block, /ownStartedAt: createSelfStartTime\(\)/);
});

test('the scanner leaves an agent to the producer the readers already show (the live claims of the service)', () => {
  assert.match(scannerBlock(), /liveClaims: \(\) => occupancyService\.current\(\)/);
});

test('the scanner starts after the reader, and on quit it removes the claims it still owns', () => {
  const service = MAIN.indexOf('occupancyService.start()');
  const scanner = MAIN.indexOf('transcriptOccupancy.start()');
  assert.ok(service !== -1 && scanner > service, 'the reader first: the scanner asks it who is live');
  assert.match(MAIN, /app\.on\('will-quit', \(\) => \{[^}]*transcriptOccupancy\.close\(\)/);
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

test('the banner is retired into the terminal bar\'s chip; the confirm exists, hidden, over the terminal, with its parts', () => {
  assert.doesNotMatch(HTML, /id="occupancy-banner/, 'one bar, not a banner beside it (backlog #47 folded into #49 + #52)');
  assert.doesNotMatch(HTML, /id="occupancy-jump"/);
  assert.match(HTML, /<div id="occupancy-confirm" role="alertdialog"[^>]*hidden>/);
  assert.match(HTML, /id="occupancy-type"/);
  assert.match(HTML, /id="occupancy-wait"/);
  // focus stays in the terminal, so each answer says the key that gives it (app/occupancy-confirm.js: Enter, Esc)
  assert.match(HTML, /<button type="button" id="occupancy-type">Type <kbd>Enter<\/kbd><\/button>/);
  assert.match(HTML, /<button type="button" id="occupancy-wait">Wait <kbd>Esc<\/kbd><\/button>/);
  const termwrap = HTML.slice(HTML.indexOf('<div id="termwrap">'), HTML.indexOf('<aside class="zone" data-zone="right"'));
  assert.ok(termwrap.includes('id="terminal-bar"') && termwrap.includes('id="occupancy-confirm"'), 'inside #termwrap');
});

test('the confirm and the occupancy chip carry the coloured left rule, the warn colour for two writers, and never animate', () => {
  const rule = (selector) => {
    const at = HTML.indexOf(selector + ' {');
    return at === -1 ? null : HTML.slice(at, HTML.indexOf('}', at));
  };
  assert.match(rule('.bar-chip.occupancy'), /border-left:[^;]*var\(--agent\)/);
  assert.match(rule('.bar-chip.occupancy.warn'), /var\(--warn\)/);
  assert.match(rule('#occupancy-confirm'), /border-left:[^;]*var\(--agent\)/);
  // The agent colour lives in the shared stylesheet both pages load (backlog #65).
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'app', 'agent-colour.css'), 'utf8'), /--agent:\s*#/);
  assert.match(HTML, /--warn:\s*#/);
  assert.doesNotMatch(rule('.bar-chip.occupancy') + rule('#occupancy-confirm'), /animation|transition/);
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

test('a dropped file goes through the confirm too: its path is the person typing into the prompt (PR #96 Miguel S5)', () => {
  assert.match(RENDERER, /userInput\(JSON\.stringify\(\{ type: 'drop', entries \}\)\);/);
  assert.doesNotMatch(RENDERER, /ws\.send\(JSON\.stringify\(\{ type: 'drop'/);
});

test('the confirm releases through the same send the keystroke would have used', () => {
  assert.match(RENDERER, /occupancyConfirm\.createConfirm\(\{\s*send: \(data\) => send\(data\)/);
});

test('the two buttons answer the confirm; the card line and the chip\'s Jump go through selectFolder', () => {
  assert.match(RENDERER, /getElementById\('occupancy-type'\)\.addEventListener\('click', \(\) => occupancy\.confirm\.type\(\)\)/);
  assert.match(RENDERER, /getElementById\('occupancy-wait'\)\.addEventListener\('click', \(\) => occupancy\.confirm\.wait\(\)\)/);
  assert.match(RENDERER, /window\.harness\.selectFolder\(/);
  assert.match(RENDERER, /data-where-root=/);
});

test('the roster card draws the where-line from the claims this tab launched', () => {
  assert.match(RENDERER, /occupancyDisplay\.cardLine\(occupancy\.launched, agent, occupancy\.session\)/);
  assert.match(RENDERER, /agentModelHtml\(r\.agent\) \+\s*occupancyWhereHtml\(r\.agent\) \+\s*careerHtml\(r\.agent\)/);
});

test('the card\'s session is the host\'s: from `hello`, then every `session` message, and a change repaints the roster (backlog #57)', () => {
  assert.match(RENDERER, /const occupancy = \{[^}]*session: null[^}]*\}/);
  assert.match(RENDERER, /const sessionIdOf = id => \(typeof id === 'string' && id !== '' \? id : null\);/);
  // hello: set before the roster's own first paint, so that paint already matches on it
  const helloAt = RENDERER.indexOf("if (msg.type === 'hello') {");
  const hello = RENDERER.slice(helloAt, RENDERER.indexOf("if (msg.type === 'loadout') {", helloAt));
  const set = hello.indexOf('occupancy.session = sessionIdOf(msg.sessionId);');
  assert.ok(set !== -1 && set < hello.lastIndexOf('renderRoster();'), 'set in hello, before its renderRoster');
  assert.match(RENDERER, /if \(msg\.type === 'session'\) \{\s*(?:agentPauses\.sessionIs\(msg\.sessionId\);[^\n]*\s*)?occupancy\.session = sessionIdOf\(msg\.sessionId\);\s*renderRoster\(\);\s*return;\s*\}/);
});

test('a `session` message, run as written, sets the card\'s session and repaints; an empty or non-string id is "not known" (PR #124 Miguel M3)', () => {
  const at = RENDERER.indexOf("if (msg.type === 'session') {");
  assert.ok(at !== -1);
  const block = RENDERER.slice(at, RENDERER.indexOf("if (msg.type === 'loadout') {", at));
  const sessionIdOf = RENDERER.match(/const sessionIdOf = (id => [^\n]*);/);
  assert.ok(sessionIdOf, 'the helper is found');
  const run = (msg) => {
    const calls = [];
    const occupancy = { session: 'old' };
    const handle = new Function('msg', 'occupancy', 'renderRoster', 'sessionIdOf', 'agentPauses', `${block}\n return 'fell through';`);
    const out = handle(msg, occupancy, () => calls.push(occupancy.session), new Function(`return ${sessionIdOf[1]}`)(), { sessionIs() {} });
    return { out, calls, session: occupancy.session };
  };
  assert.deepStrictEqual(run({ type: 'session', sessionId: 'S2' }), { out: undefined, calls: ['S2'], session: 'S2' });
  assert.strictEqual(run({ type: 'session', sessionId: '' }).session, null);
  assert.strictEqual(run({ type: 'session', sessionId: 7 }).session, null);
  assert.strictEqual(run({ type: 'hello' }).out, 'fell through');
});

test('a worktree page reports nothing new to the shell: the turn it already sends is what the two-writers warning reads', () => {
  assert.match(RENDERER, /turn: sessionTurn,/);
});

// --- the probe's own hooks (verify/probe-worktree-occupancy.js) -----------------------------------

// (That the driver may call them, by name only, is pinned in test/tab-shell.test.js: it loads app/tab-shell.js,
// which Stryker mutates, and this file is not in Stryker's command.)
test('each of the probe\'s page actions exists on the ?probe=1 page, and a probe keystroke goes through xterm\'s own input path', () => {
  for (const a of ['occState', 'occKey', 'occClick', 'occTurn', 'barState', 'barScroll', 'barClick', 'barLook']) assert.match(RENDERER, new RegExp(`case '${a}'`), a);
  assert.match(RENDERER, /term\.input\(a\.data, true\)/);
});

test('the driver\'s state reads the strip\'s occupancy as painted', () => {
  assert.match(MAIN, /stripOccupancy/);
  assert.match(MAIN, /classList\.contains\('occupied'\)/);
});
