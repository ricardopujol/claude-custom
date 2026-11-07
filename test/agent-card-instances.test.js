'use strict';
/**
 * BACKLOG #142 b, the card's half: one card per running instance, with the same portrait and name and its own state; the "×N"
 * badge goes. The host sends the rows (host/mood-machine.js instancesOf, on the `mood` frame as `instances`, each with its own
 * portrait); app/agent-state-display.js instanceRows turns one roster row into the cards it draws. Medals, hides and pauses stay
 * keyed by the agent's name (the open question's default): every card of a name carries the same `data-agent`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { agentStateDisplay: D } = require('../app/agent-state-display');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const row = (extra = {}) => ({ agent: 'code-reviewer', state: 'working', detail: 'working', portrait: { tier: 'text' }, ...extra });

test('instanceRows: a row without instances is its one card, unchanged', () => {
  const r = row();
  assert.deepStrictEqual(D.instanceRows(r), [r]);
  assert.deepStrictEqual(D.instanceRows(row({ instances: null })), [row({ instances: null })]);
});

test('instanceRows: two instances are two cards of the same agent, each with its own state, detail, cause and portrait', () => {
  const cards = D.instanceRows(row({ state: 'stressed', instances: [
    { id: 'toolu_A', state: 'working', detail: 'reading', portrait: { tier: 'file', src: 'a' } },
    { id: 'toolu_B', state: 'stressed', detail: 'stressed', cause: 'A Bash call failed' },
  ] }));
  assert.strictEqual(cards.length, 2);
  assert.deepStrictEqual(cards.map(c => [c.agent, c.instance, c.state, c.detail, c.cause]),
    [['code-reviewer', 'toolu_A', 'working', 'reading', undefined], ['code-reviewer', 'toolu_B', 'stressed', 'stressed', 'A Bash call failed']]);
  assert.deepStrictEqual(cards[0].portrait, { tier: 'file', src: 'a' });
  assert.deepStrictEqual(cards[1].portrait, { tier: 'text' }, 'no portrait of its own: the agent\'s');
  assert.ok(cards.every(c => !('instances' in c) || c.instances === undefined), 'a card never carries the list again');
});

test('instanceRows: a malformed instance is skipped, and fewer than two good ones is the one card', () => {
  const r = row({ instances: [{ id: 'toolu_A', state: 'working', detail: 'working' }, { id: 7 }, null, { state: 'working' }] });
  assert.deepStrictEqual(D.instanceRows(r), [r]);
});

test('property: instanceRows never invents a card, and never loses one', () => {
  const inst = fc.record({ id: fc.oneof(fc.string(), fc.constant(null)), state: fc.constantFrom('working', 'stressed', 'happy', 'bogus'), detail: fc.string() });
  fc.assert(fc.property(fc.option(fc.array(inst, { maxLength: 5 })), (instances) => {
    const cards = D.instanceRows(row({ instances }));
    const good = (instances || []).filter(i => typeof i.id === 'string' && i.id !== '' && typeof i.state === 'string');
    assert.strictEqual(cards.length, good.length >= 2 ? good.length : 1);
    assert.ok(cards.every(c => c.agent === 'code-reviewer'));
  }));
});

test('the host puts each instance on the mood frame with its own portrait', () => {
  const host = read('host/host.js');
  assert.match(host, /const instances = mood\.instancesOf\(agent\);/);
  assert.match(host, /out\.instances = instances\.map\(\(i\) => \(\{ \.\.\.i, portrait: portraitOf\(agent, BG_WAIT_DETAILS\.has\(i\.detail\) \? i\.state : i\.detail, i\.state\) \}\)\);/);
});

test('the roster draws one card per instance, and the ×N badge is gone', () => {
  const js = read('app/renderer.js');
  assert.match(js, /\.flatMap\(\(r\) => window\.agentStateDisplay\.instanceRows\(r\)\)/);
  assert.match(js, /\(r\.instance \? ` data-instance="\$\{escapeHtml\(r\.instance\)\}"` : ''\)/);
  assert.doesNotMatch(js, /function countBadgeHtml/);
  assert.doesNotMatch(js, /class="agent-count"/);
});
