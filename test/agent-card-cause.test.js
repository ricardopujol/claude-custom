'use strict';
/**
 * BACKLOG #162, the card's half: a stressed card's hover says why. The sentence is the host's (host/stress-cause.js through
 * host/mood-machine.js causeOf, carried on the `mood` frame as `cause`); app/agent-state-display.js causeTitle decides whether a
 * card shows it, and the renderer puts it in the card's `title` and on the words under the name. The look itself is
 * verify/probe-agent-cards.js, in a real window.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { agentStateDisplay: D } = require('../app/agent-state-display');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('causeTitle: a stressed card with a cause shows it', () => {
  assert.strictEqual(D.causeTitle('stressed', 'A Bash call failed'), 'A Bash call failed');
  assert.strictEqual(D.causeTitle('stressed', '  2 Read calls failed \n'), '2 Read calls failed');
});

test('causeTitle: nothing to show is the empty string, never a guess', () => {
  assert.strictEqual(D.causeTitle('stressed', null), '');
  assert.strictEqual(D.causeTitle('stressed', undefined), '');
  assert.strictEqual(D.causeTitle('stressed', '   '), '');
  assert.strictEqual(D.causeTitle('stressed', 42), '');
  // a cause left on a card that isn't stressed any more is not drawn: the words leave with the state
  for (const s of ['working', 'happy', 'sleeping', 'inactive', undefined]) assert.strictEqual(D.causeTitle(s, 'A Bash call failed'), '', String(s));
});

test('the host puts the cause on the mood frame, and re-sends the frame when only the cause moved', () => {
  const host = read('host/host.js');
  assert.match(host, /const cause = state === 'stressed' \? mood\.causeOf\(agent\) : null;\s*if \(cause\) out\.cause = cause;/);
  assert.match(host, /mood\.on\('cards', \(\{ agent \}\) =>/);
});

test('the roster card draws the cause as its title and on the words under the name', () => {
  const js = read('app/renderer.js');
  assert.match(js, /const cause = window\.agentStateDisplay\.causeTitle\(r\.state, r\.cause\);/);
  assert.match(js, /\(cause \? ` title="\$\{escapeHtml\(cause\)\}"` : ''\)/);
  assert.match(js, /<div class="state"\$\{cause \? ` title="\$\{escapeHtml\(cause\)\}"` : ''\}>/);
});
