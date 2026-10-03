'use strict';
/**
 * PR #95 Dexter D1: a tool_use is only a CHANGE if its tool_result says it happened. An Edit that answered
 * "Found 2 matches" (is_error), a Write refused at the permission prompt, and a call that never got an answer
 * are not changes. host/tool-calls.js pairs each call with its result.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createCollector, resultOk } = require('../host/tool-calls');

const use = (id, name, input, at = 1000) => ({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, is_error) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(is_error === undefined ? {} : { is_error }) }] } });
const WANT = (n) => n === 'Edit' || n === 'Write';

function run(entries) {
  const c = createCollector({ wanted: WANT });
  for (const e of entries) {
    const line = JSON.stringify(e);
    if (line.includes('"tool_use"')) c.addUse(e);
    else if (c.wantsResultLine(line)) c.addResult(e);
  }
  return c.calls();
}

test('a call with a plain successful result is kept, with its id, name, input and time', () => {
  const calls = run([use('t1', 'Edit', { file_path: 'a' }, 5000), result('t1', 'The file a has been updated.')]);
  assert.deepStrictEqual(calls, [{ id: 't1', name: 'Edit', input: { file_path: 'a' }, at: 5000 }]);
});

test('is_error: true drops the call ("Found 2 matches"), and the retry that worked stays', () => {
  const calls = run([
    use('t1', 'Edit', { file_path: 'a', old_string: 'foo()' }),
    result('t1', 'Found 2 matches of the string to replace', true),
    use('t2', 'Edit', { file_path: 'a', old_string: 'x\nfoo()' }),
    result('t2', 'ok'),
  ]);
  assert.deepStrictEqual(calls.map(c => c.id), ['t2']);
});

test('a call refused at the permission prompt is not a change, with or without is_error', () => {
  for (const text of ["The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).",
    '[Request interrupted by user for tool use]', 'User rejected tool use']) {
    assert.deepStrictEqual(run([use('t1', 'Write', { file_path: 'b' }), result('t1', text)]), [], text);
    assert.deepStrictEqual(run([use('t1', 'Write', { file_path: 'b' }), result('t1', [{ type: 'text', text }], true)]), [], text);
  }
});

test('a call that never got a result is not counted (it may be mid-flight, or never ran)', () => {
  assert.deepStrictEqual(run([use('t1', 'Edit', { file_path: 'a' })]), []);
});

test('results pair by id, whatever their order and however many share a message', () => {
  const both = { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'b', content: 'boom', is_error: true },
    { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
  ] } };
  const calls = run([use('a', 'Edit', { file_path: 'x' }), use('b', 'Edit', { file_path: 'y' }), both]);
  assert.deepStrictEqual(calls.map(c => c.id), ['a']);
});

test('only wanted tools are collected, and an unrelated result line is not even parsed', () => {
  const c = createCollector({ wanted: WANT });
  c.addUse(use('r1', 'Read', { file_path: 'a' }));
  assert.strictEqual(c.wantsResultLine(JSON.stringify(result('r1', 'text'))), false);
  c.addUse(use('e1', 'Edit', { file_path: 'a' }));
  assert.strictEqual(c.wantsResultLine(JSON.stringify(result('zzz', 'text'))), false);
  assert.strictEqual(c.wantsResultLine(JSON.stringify(result('e1', 'text'))), true);
});

test('a use without a string id can never be paired, so it is dropped', () => {
  const c = createCollector({ wanted: WANT });
  c.addUse({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } });
  assert.deepStrictEqual(c.calls(), []);
});

test('resultOk: content as a string or as text blocks; is_error must be exactly true', () => {
  assert.strictEqual(resultOk({ content: 'fine' }), true);
  assert.strictEqual(resultOk({ content: [{ type: 'text', text: 'fine' }] }), true);
  assert.strictEqual(resultOk({ content: 'x', is_error: true }), false);
  assert.strictEqual(resultOk({ content: 'x', is_error: 'true' }), true, 'only the boolean true is an error');
  assert.strictEqual(resultOk({}), true);
  assert.strictEqual(resultOk(null), false);
});
