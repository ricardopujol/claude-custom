'use strict';
/**
 * The tool-call collector's guards (backlog #60, Mortimer's release-#101 part 2): which blocks of a transcript
 * entry are admitted as calls, which result lines are worth parsing, which results are paired, and what counts
 * as a success. The main suite feeds only well-formed blocks.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createCollector, resultOk } = require('../host/tool-calls');

const T0 = '2026-10-03T10:00:00.000Z';
const T1 = '2026-10-03T10:00:05.000Z';
const entry = (content, timestamp = T0) => ({ timestamp, message: { content } });
const useBlock = (id, name = 'Edit', input = { file_path: 'a' }) => ({ type: 'tool_use', id, name, input });
const resBlock = (id, content = 'ok', extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });
const collector = () => createCollector({ wanted: (n) => n === 'Edit' || n === 'Write' });

// ---- addUse ----

test('only a tool_use block with a string id and a wanted name is admitted', () => {
  const c = collector();
  c.addUse(entry([
    { type: 'text', id: 'x1', name: 'Edit', input: {} },
    { type: 'tool_result', id: 'x2', name: 'Edit', input: {} },
    { id: 'x3', name: 'Edit', input: {} },
    null,
    undefined,
    'tool_use',
    5,
    { type: 'tool_use', id: 7, name: 'Edit', input: {} },
    { type: 'tool_use', id: null, name: 'Edit', input: {} },
    { type: 'tool_use', name: 'Edit', input: {} },
    { type: 'tool_use', id: 'x4', name: 'Bash', input: {} },
    { type: 'tool_use', id: 'x5', name: undefined, input: {} },
  ]));
  assert.deepStrictEqual(c.pending(), []);
});

test('a well-formed wanted tool_use is admitted next to junk, and carries its id, name, input and request time', () => {
  const c = collector();
  c.addUse(entry([null, { type: 'text', id: 'no', name: 'Edit' }, useBlock('t1', 'Write', { file_path: 'b' })]));
  assert.deepStrictEqual(c.pending(), [{ id: 't1', name: 'Write', input: { file_path: 'b' }, at: Date.parse(T0) }]);
});

test('an entry that has no message, no content, or a content that is not an array adds nothing', () => {
  const c = collector();
  for (const e of [null, undefined, {}, { message: null }, { message: {} }, { message: { content: null } },
    { message: { content: 'tool_use' } }, { message: { content: { 0: useBlock('t1') } } }, { message: { content: 7 } }]) {
    c.addUse(e);
  }
  assert.deepStrictEqual(c.pending(), []);
});

test('the wanted filter is asked the block\'s name, and what it refuses is not admitted', () => {
  const asked = [];
  const c = createCollector({ wanted: (n) => { asked.push(n); return n === 'Edit'; } });
  c.addUse(entry([useBlock('t1', 'Edit'), useBlock('t2', 'Read')]));
  assert.deepStrictEqual(asked, ['Edit', 'Read']);
  assert.deepStrictEqual(c.pending().map((u) => u.id), ['t1']);
});

test('an entry with no timestamp still admits the call, with a time that is not a number', () => {
  const c = collector();
  c.addUse({ message: { content: [useBlock('t1')] } });
  assert.strictEqual(c.pending().length, 1);
  assert.ok(Number.isNaN(c.pending()[0].at));
});

test('a collector made with no options exists and has nothing collected', () => {
  const c = createCollector();
  assert.deepStrictEqual(c.pending(), []);
  assert.deepStrictEqual(c.calls(), []);
  assert.strictEqual(c.wantsResultLine('tool_result "tool_use_id":"a"'), false);
  c.addUse(entry([{ type: 'text' }]));
  assert.deepStrictEqual(c.pending(), []);
});

// ---- wantsResultLine ----

test('a line is worth parsing only when it mentions tool_result AND the id of a call collected so far', () => {
  const c = collector();
  const line = (id) => `{"type":"user","content":[{"type":"tool_result","tool_use_id":"${id}"}]}`;
  assert.strictEqual(c.wantsResultLine(line('t1')), false, 'nothing collected yet');
  c.addUse(entry([useBlock('t1')]));
  assert.strictEqual(c.wantsResultLine(line('t1')), true);
  assert.strictEqual(c.wantsResultLine(line('other')), false, 'an id nobody asked for');
  assert.strictEqual(c.wantsResultLine('{"tool_use_id":"t1"}'), false, 'no tool_result in the line');
  assert.strictEqual(c.wantsResultLine(''), false);
});

test('a line that STARTS with tool_result counts (index 0 is a hit)', () => {
  const c = collector();
  c.addUse(entry([useBlock('t1')]));
  assert.strictEqual(c.wantsResultLine('tool_result "tool_use_id":"t1"'), true);
});

test('any one of several ids in a line may be the pending one; whitespace around the colon is fine; an empty id is not an id', () => {
  const c = collector();
  c.addUse(entry([useBlock('t2')]));
  assert.strictEqual(c.wantsResultLine('tool_result "tool_use_id":"t1","x":{"tool_use_id" : "t2"}'), true);
  assert.strictEqual(c.wantsResultLine('tool_result "tool_use_id":"t1" "tool_use_id":"t3"'), false);
  assert.strictEqual(c.wantsResultLine('tool_result "tool_use_id":""'), false);
});

test('a line for a call collected so far is wanted even after it was answered (the doc says "collected so far")', () => {
  const c = collector();
  c.addUse(entry([useBlock('t1')]));
  c.addResult(entry([resBlock('t1')], T1));
  assert.strictEqual(c.wantsResultLine('tool_result "tool_use_id":"t1"'), true);
});

test('the same id seen twice in one line, matched call or not, is still just a yes', () => {
  const c = collector();
  c.addUse(entry([useBlock('t1')]));
  assert.strictEqual(c.wantsResultLine('tool_result "tool_use_id":"zz" "tool_use_id":"t1" "tool_use_id":"t1"'), true);
});

// ---- addResult ----

test('a result for a pending call settles it: it leaves pending() and, when it succeeded, shows in calls() with doneAt', () => {
  const c = collector();
  c.addUse(entry([useBlock('t1'), useBlock('t2')]));
  c.addResult(entry([resBlock('t1')], T1));
  assert.deepStrictEqual(c.pending().map((u) => u.id), ['t2']);
  assert.deepStrictEqual(c.calls(), [{ id: 't1', name: 'Edit', input: { file_path: 'a' }, at: Date.parse(T0), doneAt: Date.parse(T1) }]);
});

test('an entry with no message, no content, or non-array content records nothing', () => {
  const c = collector();
  c.addUse(entry([useBlock('t1')]));
  for (const e of [null, undefined, {}, { message: null }, { message: {} }, { message: { content: null } },
    { message: { content: 'x' } }, { message: { content: { 0: resBlock('t1') } } }]) {
    c.addResult(e);
  }
  assert.deepStrictEqual(c.pending().map((u) => u.id), ['t1']);
  assert.deepStrictEqual(c.calls(), []);
});

test('only a tool_result block for a pending id is paired: other types, null blocks and unknown ids are ignored', () => {
  const c = collector();
  c.addUse(entry([useBlock('t1')]));
  c.addResult(entry([
    { type: 'text', tool_use_id: 't1', content: 'ok' },
    { tool_use_id: 't1', content: 'ok' },
    null,
    undefined,
    resBlock('unknown'),
    { type: 'tool_result', content: 'ok' },
  ], T1));
  assert.deepStrictEqual(c.pending().map((u) => u.id), ['t1']);
  assert.deepStrictEqual(c.calls(), []);
});

test('a result for an id nobody asked about is not remembered: a call that shows up later under that id is still unanswered', () => {
  const c = collector();
  c.addResult(entry([resBlock('late')], T1));
  c.addUse(entry([useBlock('late')]));
  assert.deepStrictEqual(c.calls(), []);
  assert.deepStrictEqual(c.pending().map((u) => u.id), ['late']);
});

test('a failed result settles the call too (no longer pending) but it is never in calls()', () => {
  const c = collector();
  c.addUse(entry([useBlock('t1')]));
  c.addResult(entry([resBlock('t1', 'Found 2 matches', { is_error: true })], T1));
  assert.deepStrictEqual(c.pending(), []);
  assert.deepStrictEqual(c.calls(), []);
});

test('calls() come back in the order the requests were seen, however the results arrived', () => {
  const c = collector();
  c.addUse(entry([useBlock('a'), useBlock('b'), useBlock('c')]));
  c.addResult(entry([resBlock('c')], T1));
  c.addResult(entry([resBlock('a')], T1));
  assert.deepStrictEqual(c.calls().map((x) => x.id), ['a', 'c']);
});

test('pending() and calls() hand back copies: changing one does not change the collector', () => {
  const c = collector();
  c.addUse(entry([useBlock('t1'), useBlock('t2')]));
  c.addResult(entry([resBlock('t2')], T1));
  c.pending()[0].id = 'mutated';
  c.calls()[0].id = 'mutated';
  assert.strictEqual(c.pending()[0].id, 't1');
  assert.strictEqual(c.calls()[0].id, 't2');
});

// ---- resultOk ----

test('resultOk: anything that is not an object is not a success', () => {
  for (const b of [null, undefined, 'ok', 5, true, false, 0, '']) assert.strictEqual(resultOk(b), false, String(b));
});

test('resultOk: is_error must be exactly true to count as an error', () => {
  assert.strictEqual(resultOk({ content: 'ok', is_error: true }), false);
  for (const v of [false, 'true', 1, null, undefined]) assert.strictEqual(resultOk({ content: 'ok', is_error: v }), true, String(v));
});

test('resultOk: a block with no content at all is a success (nothing refused)', () => {
  assert.strictEqual(resultOk({}), true);
  assert.strictEqual(resultOk({ content: null }), true);
  assert.strictEqual(resultOk({ content: 42 }), true);
  assert.strictEqual(resultOk({ content: {} }), true);
});

test('resultOk: each refusal wording is recognised, at the start, in any case, after leading whitespace', () => {
  for (const t of ["The user doesn't want to proceed with this tool use.", '[Request interrupted by user for tool use]',
    'User rejected tool use', "the user doesn't want to proceed", 'USER REJECTED TOOL USE', '  \n User rejected tool use', '\t[Request interrupted by user']) {
    assert.strictEqual(resultOk({ content: t }), false, JSON.stringify(t));
    assert.strictEqual(resultOk({ content: [{ type: 'text', text: t }] }), false, JSON.stringify(t));
  }
});

test('resultOk: a refusal wording that is not at the start of the text is just text', () => {
  for (const t of ['Note: User rejected tool use', 'ok. [Request interrupted by user', "x The user doesn't want to proceed", 'The user wants to proceed', 'User rejected']) {
    assert.strictEqual(resultOk({ content: t }), true, t);
  }
});

test('resultOk: block content is read from the text parts; a part without a string text counts as empty', () => {
  assert.strictEqual(resultOk({ content: [{ text: 'User rejected tool use' }, { text: 'more' }] }), false);
  assert.strictEqual(resultOk({ content: [{ type: 'image' }, { text: 'User rejected tool use' }] }), false);
  assert.strictEqual(resultOk({ content: [null, { text: 5 }, { text: 'User rejected tool use' }] }), false);
  assert.strictEqual(resultOk({ content: [{ text: 'fine' }, { text: 'User rejected tool use' }] }), true);
  assert.strictEqual(resultOk({ content: [{ text: 5 }, null, { type: 'image' }] }), true);
  assert.strictEqual(resultOk({ content: [] }), true);
});

test('resultOk: the text parts of a block are joined with a line break, so a wording split across parts is not the refusal wording', () => {
  assert.strictEqual(resultOk({ content: [{ text: 'User' }, { text: ' rejected tool use' }] }), true);
  assert.strictEqual(resultOk({ content: [{ text: 'User rejected tool' }, { text: 'use' }] }), true);
});
