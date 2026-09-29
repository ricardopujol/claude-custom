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

test('the card click handler opens a log ONLY for the agent cardClickAgent names', () => {
  // The face / button / data-no-card-click decisions live in the display module
  // and are tested behaviourally in agent-log-display.test.js; what only this
  // file can pin is that the handler asks it, with the click's target, and
  // opens nothing on its own.
  const body = handlerBody("agentsEl.addEventListener('click'");
  const ask = body.indexOf('cardClickAgent(e.target)');
  const open = body.indexOf('openAgentLog(');
  assert.ok(ask !== -1, 'the handler must ask cardClickAgent about the click target');
  assert.ok(open > ask, 'and open only after asking');
  assert.ok(/if \(agent\) openAgentLog\(agent\)/.test(body), 'opening is conditional on its answer');
  assert.ok(!body.includes('dataset.agent'), 'the handler must not decide for itself');
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
  const known = new Set(['emptyLog', 'openLog', 'closeLog', 'applyFrame', 'renderAgentLog', 'shouldFollow', 'paint', 'cardClickAgent']);
  for (const u of uses) assert.ok(known.has(u.split('.')[1]), u);
});
