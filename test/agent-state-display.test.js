'use strict';
/**
 * BACKLOG #55, look A: a corner badge on the portrait and the state in words under the name. The decisions are in
 * app/agent-state-display.js; the card draws what they return.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { agentStateDisplay } = require('../app/agent-state-display');
const { describeState, badgeHtml, stateWords } = agentStateDisplay;

const FINER = ['reading', 'writing', 'running', 'waiting', 'stuck', 'helper'];

test('each finer state has its badge icon and its words', () => {
  const want = { reading: ['\u{1F4D6}', 'reading'], writing: ['✏️', 'writing'], running: ['▶️', 'running'],
    waiting: ['✋', 'waiting on you'], stuck: ['⚠️', 'stuck'], helper: ['⏳', 'waiting on helper'] };
  for (const s of FINER) {
    const d = describeState('working', s);
    assert.strictEqual(d.detail, s);
    assert.strictEqual(d.badge.icon, want[s][0], s);
    assert.strictEqual(d.words, want[s][1], s);
  }
});

test('today\'s four states keep their ring: no badge, their own name as the words', () => {
  for (const s of ['sleeping', 'working', 'happy', 'stressed']) {
    const d = describeState(s, s);
    assert.strictEqual(d.badge, null, s);
    assert.strictEqual(d.words, s);
    assert.strictEqual(badgeHtml(s, s), '');
  }
});

test('a host that sends no detail (an older one) shows the state', () => {
  assert.deepStrictEqual(describeState('working', undefined), { state: 'working', detail: 'working', words: 'working', badge: null });
  assert.strictEqual(describeState('working', null).detail, 'working');
});

test('a detail that does not fit the state, or is unknown, is not drawn', () => {
  assert.strictEqual(describeState('sleeping', 'reading').detail, 'sleeping');
  assert.strictEqual(describeState('happy', 'waiting').detail, 'happy');
  assert.strictEqual(describeState('working', 'dancing').detail, 'working');
  assert.strictEqual(describeState('working', '<script>').detail, 'working');
  assert.strictEqual(describeState('working', {}).detail, 'working');
  assert.strictEqual(describeState('stressed', 'reading').detail, 'stressed', 'an error outranks what the tool is');
  assert.strictEqual(describeState('stressed', 'stuck').detail, 'stuck');
  assert.strictEqual(describeState('stressed', 'waiting').detail, 'waiting');
  assert.strictEqual(describeState('stressed', 'helper').detail, 'helper');
});

test('the badge markup names its state, carries the words for hover and hides from screen readers', () => {
  const html = badgeHtml('working', 'waiting');
  assert.match(html, /^<span class="state-badge" data-badge="waiting" title="waiting on you" aria-hidden="true">✋<\/span>$/);
  assert.match(badgeHtml('working', 'reading'), /data-badge="reading"/);
});

test('stateWords is the words only', () => {
  assert.strictEqual(stateWords('working', 'helper'), 'waiting on helper');
  assert.strictEqual(stateWords('happy', 'helper'), 'happy');
});

test('a state this file has never heard of is passed through, never relabelled', () => {
  const d = describeState('inactive', 'reading');
  assert.deepStrictEqual(d, { state: 'inactive', detail: 'inactive', words: 'inactive', badge: null });
  assert.strictEqual(describeState(undefined, 'reading').words, '');
  assert.strictEqual(describeState({}, undefined).words, '');
});

test('property: whatever arrives, the result is one of the known details and markup has no raw input', () => {
  const known = new Set(['sleeping', 'working', 'happy', 'stressed', ...FINER]);
  fc.assert(fc.property(fc.constantFrom('sleeping', 'working', 'happy', 'stressed'), fc.anything(), (state, detail) => {
    const d = describeState(state, detail);
    assert.ok(known.has(d.detail), String(d.detail));
    const html = badgeHtml(state, detail);
    assert.ok(!html.includes('<script'));
    assert.strictEqual(html === '', d.badge === null);
  }));
});
