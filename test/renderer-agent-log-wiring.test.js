'use strict';
/**
 * BACKLOG #10, the renderer's wiring lines. renderer.js needs a real DOM and no
 * test can load it (see renderer-scope.test.js), so this reads the source, as
 * roster-escape.test.js does. The logic is tested in agent-log-display.test.js;
 * what only THIS file can catch is a wiring line going missing or being
 * reordered so a click on a portrait opens a log instead of taking a drop.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const src = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');

function handlerBody(after) {
  const i = src.indexOf(after);
  assert.ok(i !== -1, `renderer.js must contain ${after}`);
  return src.slice(i, src.indexOf('\n});', i));
}

test('a click on a card opens the log, but a click on the FACE never does', () => {
  const body = handlerBody("agentsEl.addEventListener('click'");
  const guard = body.indexOf("e.target.closest('.face')");
  const open = body.indexOf('openAgentLog(');
  assert.ok(guard !== -1, 'the face must be excluded');
  assert.ok(open !== -1, 'the click must open the log');
  assert.ok(guard < open, 'the face guard must come BEFORE the open');
  assert.ok(/return;/.test(body.slice(guard, open)), 'the face guard must return');
});

test('the close control and the incoming frames are wired', () => {
  assert.ok(src.includes("closest('[data-agent-log-close]')"));
  assert.ok(/msg\.type === 'agent-log'[\s\S]{0,80}handleAgentLogFrame\(msg\)/.test(src));
});

test('an open log is asked for again after a reattach', () => {
  const at = src.indexOf('ws.onopen = ');
  assert.ok(at !== -1);
  assert.ok(src.slice(at, at + 1500).includes('if (agentLog.open) openAgentLog(agentLog.agent)'));
});

test('the panel markup and the module are in the page, the module before renderer.js', () => {
  assert.ok(html.includes('id="agent-log"'));
  const mod = html.indexOf('<script src="./agent-log-display.js"></script>');
  const rend = html.indexOf('<script src="./renderer.js"></script>');
  assert.ok(mod !== -1 && rend !== -1 && mod < rend);
});

test('renderer.js reaches the module only through its one published name', () => {
  const uses = src.match(/agentLogDisplay\.\w+/g) || [];
  assert.ok(uses.length > 0);
  const known = new Set(['emptyLog', 'openLog', 'closeLog', 'applyFrame', 'renderAgentLog', 'shouldFollow', 'paint']);
  for (const u of uses) assert.ok(known.has(u.split('.')[1]), u);
});
