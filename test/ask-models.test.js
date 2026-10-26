'use strict';
/**
 * host/ask-models.js (BACKLOG #33, Round 8): Local / Haiku / Sonnet, how each is labelled, and the per-model "passed the bar" record
 * that switches the explainer on. The record is DATA, read at run time and re-checked against the bar, never a hard-coded flag.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createModels, parseRecord, passesBar, BAR, DEFAULT_MODEL, CHOICES } = require('../host/ask-models');

const rec = (passed) => JSON.stringify({ version: 1, passed });
const make = (record, extra = {}) => createModels({ localModel: 'qwen3.5:4b', readRecord: () => record, ...extra });

test('the choices are Local, Haiku, Sonnet; Local is the default', () => {
  assert.deepStrictEqual(CHOICES, ['local', 'haiku', 'sonnet']);
  assert.strictEqual(DEFAULT_MODEL, 'local');
  const m = make(rec({}));
  assert.deepStrictEqual(m.list().map(x => x.id), ['local', 'haiku', 'sonnet']);
  assert.deepStrictEqual(m.list().map(x => x.kind), ['ollama', 'claude', 'claude']);
});

test('an unknown or missing choice falls back to Local', () => {
  const m = make(rec({}));
  assert.strictEqual(m.choose('haiku'), 'haiku');
  assert.strictEqual(m.choose('opus'), 'local');
  assert.strictEqual(m.choose(undefined), 'local');
  assert.strictEqual(m.choose(null), 'local');
});

test('the label: name, model, and where it runs; a Claude model says it uses the plan', () => {
  const m = make(rec({}));
  assert.strictEqual(m.label('local', 'Professor Byte'), 'Professor Byte · qwen3.5:4b · local');
  assert.strictEqual(m.label('haiku', 'Professor Byte'), 'Professor Byte · Haiku · Claude, uses your plan');
  assert.strictEqual(m.label('sonnet', 'Ada'), 'Ada · Sonnet · Claude, uses your plan');
  assert.strictEqual(m.label('local', ''), 'qwen3.5:4b · local');
  assert.strictEqual(m.label('haiku', undefined), 'Haiku · Claude, uses your plan');
});

test('no record, or one that cannot be read: the explainer is off everywhere', () => {
  for (const r of [null, undefined, '', 'not json', '[]', '{}', rec(null), rec([])]) {
    const m = make(r);
    for (const id of CHOICES) assert.strictEqual(m.explainerOn(id), false, String(r));
  }
  const throws = createModels({ localModel: 'q', readRecord: () => { throw new Error('EACCES'); } });
  assert.strictEqual(throws.explainerOn('local'), false);
});

test('the bar: 8 of 10 at BOTH measured levels, checked here and not taken from the record\'s say-so', () => {
  assert.deepStrictEqual(BAR, { min: 8, of: 10 });
  assert.strictEqual(passesBar({ new: 8, comfortable: 8, of: 10 }), true);
  assert.strictEqual(passesBar({ new: 10, comfortable: 10, of: 10 }), true);
  assert.strictEqual(passesBar({ new: 9, comfortable: 7, of: 10 }), false);
  assert.strictEqual(passesBar({ new: 7, comfortable: 9, of: 10 }), false);
  assert.strictEqual(passesBar({ new: 4, comfortable: 4, of: 5 }), false, 'a different sample size is not this bar');
  assert.strictEqual(passesBar({ new: '9', comfortable: '9', of: 10 }), false);
  assert.strictEqual(passesBar({ new: null, comfortable: 9, of: 10 }), false);
  assert.strictEqual(passesBar({ passed: true }), false);
  assert.strictEqual(passesBar(null), false);
});

test('a passed model gets its explainer; the others stay off', () => {
  const m = make(rec({ haiku: { new: 9, comfortable: 8, of: 10 }, sonnet: { new: 9, comfortable: 6, of: 10 } }));
  assert.strictEqual(m.explainerOn('haiku'), true);
  assert.strictEqual(m.explainerOn('sonnet'), false);
  assert.strictEqual(m.explainerOn('local'), false);
});

test('the local record is keyed by the MODEL it measured, so swapping the local model switches the explainer off again', () => {
  const record = rec({ 'qwen3.5:4b': { new: 9, comfortable: 9, of: 10 } });
  assert.strictEqual(make(record).explainerOn('local'), true);
  assert.strictEqual(make(record, { localModel: 'qwen3.5:9b' }).explainerOn('local'), false);
});

test('list() says where each runs, for the page to build its label', () => {
  const m = make(rec({}));
  assert.deepStrictEqual(m.list().map(x => x.where), ['qwen3.5:4b · local', 'Haiku · Claude, uses your plan', 'Sonnet · Claude, uses your plan']);
});

test('list() carries the explainer flag for the page', () => {
  const m = make(rec({ haiku: { new: 8, comfortable: 8, of: 10 } }));
  assert.deepStrictEqual(m.list().map(x => [x.id, x.explainer]), [['local', false], ['haiku', true], ['sonnet', false]]);
});

test('parseRecord: only well-formed entries survive; prototype keys are not entries', () => {
  const r = parseRecord(rec({ haiku: { new: 9, comfortable: 9, of: 10 }, '__proto__': { new: 10, comfortable: 10, of: 10 }, junk: 5 }));
  assert.deepStrictEqual(Object.keys(r).sort(), ['haiku']);
  assert.strictEqual(Object.getPrototypeOf(r), null);
});

test('the shipped record file parses and no model passes on a measurement that missed', () => {
  const real = createModels({ localModel: 'qwen3.5:4b' });
  assert.strictEqual(real.explainerOn('local'), false, 'qwen3.5:4b missed the bar (7/10 and 3/10 on the blind grade)');
});

test('the shipped record: Haiku and Sonnet passed (the lower of two graders\' readings, blind check passed); the local model did not', () => {
  const fs = require('fs');
  const { RECORD_FILE } = require('../host/ask-models');
  const rec = JSON.parse(fs.readFileSync(RECORD_FILE, 'utf8')).passed;
  const real = createModels({ localModel: 'qwen3.5:4b' });
  assert.strictEqual(real.explainerOn('haiku'), true);
  assert.strictEqual(real.explainerOn('sonnet'), true);
  assert.strictEqual(real.explainerOn('local'), false);
  assert.deepStrictEqual([rec.haiku.new, rec.haiku.comfortable, rec.haiku.blindCheck], [9, 8, 'passed'], 'Haiku Comfortable is exactly at the bar');
  assert.deepStrictEqual([rec.sonnet.new, rec.sonnet.comfortable, rec.sonnet.blindCheck], [9, 10, 'passed']);
});
