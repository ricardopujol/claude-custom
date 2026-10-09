'use strict';
/**
 * BACKLOG #55 + #13: the finer card states (reading, writing, running, waiting, stuck, helper) are portrait slots.
 * A picture for the state itself wins; with none, the nearest state of the original four stands in -- at every
 * tier, never a blank.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { portraitFor, NEAREST_STATE, BUILTIN_STATES, EXTRA_STATES } = require('../host/portraits');
const { tmpDir } = require('./tmp-dir');

function forge(tree) {
  const dir = tmpDir('cc-portraits-states-');
  for (const [agent, states] of Object.entries(tree)) {
    fs.mkdirSync(path.join(dir, agent), { recursive: true });
    for (const s of states) fs.writeFileSync(path.join(dir, agent, s + '.png'), 'x');
  }
  return dir;
}

test('every finer state has a nearest state among the original four', () => {
  assert.deepStrictEqual([...EXTRA_STATES].sort(), ['helper', 'reading', 'running', 'stuck', 'waiting', 'writing']);
  for (const s of EXTRA_STATES) assert.ok(BUILTIN_STATES.includes(NEAREST_STATE[s]), s);
  assert.strictEqual(NEAREST_STATE.stuck, 'stressed');
  assert.strictEqual(NEAREST_STATE.reading, 'working');
});

test('a picture for the finer state itself is used', () => {
  const dir = forge({ miguel: ['working', 'reading'] });
  const p = portraitFor('miguel', 'reading', { portraitsDir: dir });
  assert.ok(p.path.endsWith('reading.png'));
  assert.strictEqual(p.state, 'reading');
});

test('with none, the nearest state stands in', () => {
  const dir = forge({ miguel: ['working', 'stressed'] });
  assert.ok(portraitFor('miguel', 'reading', { portraitsDir: dir }).path.endsWith('working.png'));
  assert.ok(portraitFor('miguel', 'helper', { portraitsDir: dir }).path.endsWith('working.png'));
  assert.ok(portraitFor('miguel', 'stuck', { portraitsDir: dir }).path.endsWith('stressed.png'));
});

test('an uploaded picture of the nearest state beats a shared forge default', () => {
  const portraitsDir = forge({ _default: ['working'] });
  const uploadsDir = tmpDir('cc-uploads-states-');
  fs.mkdirSync(path.join(uploadsDir, 'miguel'));
  fs.writeFileSync(path.join(uploadsDir, 'miguel', 'working.gif'), 'x');
  const p = portraitFor('miguel', 'writing', { portraitsDir, uploadsDir });
  assert.strictEqual(p.tier, 'uploaded');
  assert.ok(p.path.endsWith('working.gif'));
});

test('a finer state with nothing at all is a placeholder, like any other', () => {
  const dir = forge({});
  assert.strictEqual(portraitFor('miguel', 'waiting', { portraitsDir: dir }).kind, 'placeholder');
});

test('an unknown state name is not given a nearest state', () => {
  const dir = forge({ miguel: ['working'] });
  assert.strictEqual(portraitFor('miguel', 'dancing', { portraitsDir: dir }).kind, 'placeholder');
});
