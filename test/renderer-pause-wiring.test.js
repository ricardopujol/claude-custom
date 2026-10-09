'use strict';
/**
 * The wiring of Pause / Resume (BACKLOG #19): source assertions in the style of test/renderer-resources-wiring.test.js, because
 * main.js, preload.js and renderer.js need Electron or a DOM. The rules live in host/resource-pause.js, host/process-suspend.js,
 * host/pause-state.js and app/resources-display.js (tested directly); verify/probe-pause-panel.js drives the same paths in a real window.
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
const BLOCK = strip(RAW.slice(RAW.indexOf('// RESOURCES-BEGIN'), RAW.indexOf('// RESOURCES-END')));

test('main answers resources:pause and resources:resume only for a tab page, and refuses anything else', () => {
  for (const ch of ['pause', 'resume']) {
    const m = new RegExp(`ipcMain\\.handle\\('resources:${ch}',[^;]*?isTabView\\(e\\.sender\\)[^;]*?resources\\s*\\n?\\s*\\?\\s*resources\\.${ch}\\(req\\)\\s*:\\s*\\{ ok: false, reason: 'refused'`).exec(MAIN);
    assert.ok(m, `resources:${ch} is gated on a tab page and forwards to the service`);
  }
});

test('main builds the service with a suspend that is host/process-suspend.js through a PowerShell exec', () => {
  assert.match(MAIN, /require\('\.\.\/host\/process-suspend'\)/);
  assert.match(MAIN, /suspend:\s*\(action, targets\)\s*=>\s*suspendVerified\(action, targets, \{ exec: createPowerShellExec\(\d+\) \}\)/);
});

test('a quit wakes whatever this window paused: will-quit is held once while resumeAll runs, then asked for again', () => {
  const at = MAIN.indexOf('resources.hasPaused()');
  assert.ok(at !== -1);
  const body = MAIN.slice(MAIN.lastIndexOf("app.on('will-quit'", at), MAIN.indexOf('});', at) + 3);
  assert.match(body, /pausedWoken/);
  assert.match(body, /e\.preventDefault\(\)/);
  assert.match(body, /resources\.resumeAll\(\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => app\.quit\(\)\)/);
});

test('the probe can quit the way a closed window does, so a quit with a paused process is testable (the hard exit skips will-quit)', () => {
  const SHELL = strip(fs.readFileSync(path.join(APP, 'tab-shell.js'), 'utf8'));
  assert.match(SHELL, /case 'quit': return await api\.quit\(cmd\.graceful === true\);/);
  assert.match(MAIN, /async quit\(graceful\)/);
  assert.match(MAIN, /graceful === true \? app\.quit\(\) : app\.exit\(0\)/);
});

test('the preload bridge carries pause and resume with the request only', () => {
  assert.match(PRELOAD, /pause:\s*\(req\)\s*=>\s*ipcRenderer\.invoke\('resources:pause', req\)/);
  assert.match(PRELOAD, /resume:\s*\(req\)\s*=>\s*ipcRenderer\.invoke\('resources:resume', req\)/);
});

test('the page sends pause and resume by pid and start time, one at a time, and shows the answer', () => {
  assert.match(BLOCK, /a\.act === 'pause' \|\| a\.act === 'resume'/);
  assert.match(BLOCK, /resState\.pauseBusy/);
  assert.match(BLOCK, /D\.beginPause\(resState, a\)/);
  assert.match(BLOCK, /resBridge\[a\.act\]\(\{ pid: a\.pid, startTime: a\.start \}\)/);
  assert.match(BLOCK, /D\.pauseResult\(resState, a, /);
});

test('the pause button and the paused row have styles', () => {
  assert.match(HTML, /\.res-pause\b/);
  assert.match(HTML, /\.res-paused-row\b/);
  assert.match(HTML, /\.res-paused\b/);
});

test('the agent card\'s Pause / Resume: the script loads before renderer.js, the card draws the control, and the click types through the submit gate', () => {
  const at = HTML.indexOf('<script src="./agent-pause-display.js"></script>');
  assert.ok(at !== -1 && at < HTML.indexOf('<script src="./renderer.js"></script>'));
  const code = strip(RAW);
  assert.match(code, /const agentPauses = window\.agentPauseDisplay\.createAgentPauses\(\)/);
  assert.match(code, /agentPauseHtml\(r\.agent, counts\)/, 'the live roster card carries the control');
  assert.match(code, /agentPauses\.seen\(counts, Date\.now\(\)\)/, 'every roster draw is where an agent is SEEN stopped');
  // the click: validated, then typed with the gate (submit true, not type-only), and a refusal puts the phase back
  const click = code.slice(code.indexOf("closest('.agent-pause-btn')"), code.indexOf('function countBadgeHtml'));
  assert.match(click, /window\.agentPauseDisplay\.clickAction\(b\.dataset\)/);
  assert.match(click, /window\.agentPauseDisplay\.commandFor\(act\.act, act\.agent\)/);
  assert.match(click, /agentPauses\.begin\(act\.agent, act\.act, Date\.now\(\)\)/);
  assert.match(click, /typeCommand\(command, [\s\S]*\{ submit: true, typeOnly: false \}\)/);
  assert.match(click, /agentPauses\.refused\(act\.agent\)/);
  assert.match(click, /r\.submitted !== true/, 'typed-but-not-sent is not a Pause either');
});
