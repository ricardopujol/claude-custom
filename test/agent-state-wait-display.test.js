'use strict';
/**
 * BACKLOG #155 (agent cues, part 1), the display half: a card whose host says `bgwait` / `bgwaitlate` shows an hourglass, the words
 * "waiting…", what it waits on and the minutes waited; the Map shows the same state and never hides it as asleep.
 */
const test = require('node:test');
const assert = require('node:assert');
const { agentStateDisplay: D } = require('../app/agent-state-display');
const M = require('../app/map-model');

const MIN = 60_000;

test('bgwait and bgwaitlate fit a working or stressed card, with the hourglass and the words "waiting…"', () => {
  for (const state of ['working', 'stressed']) {
    for (const detail of ['bgwait', 'bgwaitlate']) {
      const look = D.describeState(state, detail);
      assert.strictEqual(look.detail, detail);
      assert.strictEqual(look.words, 'waiting…');
      assert.ok(look.badge && look.badge.icon);
    }
  }
  assert.strictEqual(D.describeState('sleeping', 'bgwait').detail, 'sleeping', 'a card at rest never claims a wait');
  assert.strictEqual(D.describeState('happy', 'bgwaitlate').detail, 'happy');
});

test('the wait note says what it waits on and the minutes, and is red from bgwaitlate', () => {
  const since = 10_000_000;
  const note = D.waitNote('bgwait', { on: 'npm test', since }, since + 7 * MIN + 5_000);
  assert.deepStrictEqual(note, { text: 'on: npm test · 7 min', late: false });
  assert.deepStrictEqual(D.waitNote('bgwaitlate', { on: 'npm test', since }, since + 31 * MIN), { text: 'on: npm test · 31 min', late: true });
  assert.deepStrictEqual(D.waitNote('bgwait', { on: 'npm test', since }, since + 20_000), { text: 'on: npm test · <1 min', late: false });
});

test('an unknown is never a number: no since gives no minutes, no "on" gives no "on:"', () => {
  assert.deepStrictEqual(D.waitNote('bgwait', { on: 'x', since: null }, 5), { text: 'on: x', late: false });
  assert.deepStrictEqual(D.waitNote('bgwait', { on: null, since: 1_000 }, 1_000 + 3 * MIN), { text: '3 min', late: false });
  assert.deepStrictEqual(D.waitNote('bgwait', { on: null, since: null }, 5), { text: '', late: false });
  assert.deepStrictEqual(D.waitNote('bgwait', undefined, 5), { text: '', late: false });
  assert.deepStrictEqual(D.waitNote('bgwait', { on: 'x', since: Number.NaN }, 5), { text: 'on: x', late: false });
  assert.deepStrictEqual(D.waitNote('bgwait', { on: 'x', since: 100 }, 50), { text: 'on: x', late: false }, 'a clock that went back is no minutes');
});

test('only a waiting detail has a note', () => {
  for (const d of ['working', 'waiting', 'helper', 'stuck', undefined]) assert.strictEqual(D.waitNote(d, { on: 'x', since: 1 }, 2), null);
});

test('the note is escaped markup and carries its colour as data', () => {
  assert.strictEqual(D.waitNoteHtml('working', { on: 'x' }, 0), '');
  const html = D.waitNoteHtml('bgwaitlate', { on: '<b>"x"</b>', since: 0 }, 40 * MIN);
  assert.ok(html.includes('data-late="true"'));
  assert.ok(!html.includes('<b>'), 'what the task is called is text, not markup');
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(D.waitNoteHtml('bgwait', { on: 'x', since: 0 }, MIN).includes('data-late="false"'));
});

test('a card waiting on a task sorts like any working card, not above one waiting on you', () => {
  const rows = D.sortRows([{ agent: 'a', state: 'working', detail: 'bgwait' }, { agent: 'b', state: 'working', detail: 'waiting' }]);
  assert.deepStrictEqual(rows.map(r => r.agent), ['b', 'a']);
});

test('the Map draws a waiting agent, in its own state, and red when it is late', () => {
  assert.deepStrictEqual(M.agentLook({ state: 'working', detail: 'bgwait' }), { state: 'waiting', active: true });
  assert.deepStrictEqual(M.agentLook({ state: 'working', detail: 'bgwaitlate' }), { state: 'late', active: true });
  assert.deepStrictEqual(M.agentLook({ state: 'stressed', detail: 'bgwait' }), { state: 'waiting', active: true });
  const g = M.buildGraph({ project: { name: 'p' }, sessions: [{ id: 's', label: 's', folder: 'C:\\p\\s', state: 'working', self: true }],
    agents: [{ name: 'miguel', state: 'working', detail: 'bgwait', session: 's' }] });
  const node = g.nodes.find(n => n.kind === 'agent');
  assert.ok(node, 'never hidden as asleep');
  assert.strictEqual(node.state, 'waiting');
  assert.ok(!g.edges.some(e => e.flow > 0 && (e.to === node.id || e.from === node.id)), 'a waiting agent streams nothing');
});
