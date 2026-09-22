// @ts-nocheck
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { summarize, MAX_WORDS } = require('../host/attention-summary');

const words = s => s.trim().split(/\s+/).filter(Boolean).length;

test('every summary fits in ten words or fewer', () => {
  // The body is read at a glance in a toast corner. Anything longer is
  // truncated by the OS anyway, so the useful part must come first.
  const cases = [
    ['Notification', { message: 'Claude needs your permission to use Bash' }],
    ['Notification', { message: 'Claude is waiting for your input' }],
    ['Notification', {}],
    ['Stop', {}],
    ['Stop', { agents: ['code-reviewer', 'logic-reviewer'] }],
  ];
  for (const [event, payload] of cases) {
    const body = summarize(event, payload, {});
    assert.ok(words(body) <= MAX_WORDS, `${words(body)} words: "${body}"`);
    assert.ok(body.length > 0, `empty summary for ${event}`);
  }
});

test('a permission request names the tool being asked about', () => {
  // "Need permission?" is the question; which tool answers "permission for
  // what", which is the part that decides whether to get up.
  const body = summarize('Notification', { message: 'Claude needs your permission to use Bash' }, {});
  assert.ok(/permission/i.test(body), body);
  assert.ok(/Bash/.test(body), body);
});

test('a permission request for a tool with a longer name still names it', () => {
  const body = summarize('Notification', { message: 'Claude needs your permission to use WebFetch' }, {});
  assert.ok(/WebFetch/.test(body), body);
});

test('an idle prompt says it is waiting, not that it needs permission', () => {
  const body = summarize('Notification', { message: 'Claude is waiting for your input' }, {});
  assert.ok(/waiting|input/i.test(body), body);
  assert.ok(!/permission/i.test(body), body);
});

test('a finished turn with no agents says the turn finished', () => {
  const body = summarize('Stop', {}, {});
  assert.ok(/finish|done|complete/i.test(body), body);
});

test('a finished turn reports how many agents ran', () => {
  // "agents finished work" is a different event from "the turn ended", and the
  // count is what tells them apart at a glance.
  const body = summarize('Stop', {}, { agents: ['code-reviewer', 'logic-reviewer'] });
  assert.ok(/2/.test(body), body);
  assert.ok(/agent/i.test(body), body);
  assert.ok(words(body) <= MAX_WORDS, body);
});

test('one agent is not called "1 agents"', () => {
  const body = summarize('Stop', {}, { agents: ['code-reviewer'] });
  assert.ok(/1 agent\b/.test(body), body);
});

test('many agents still fit the word budget', () => {
  const many = Array.from({ length: 12 }, (_, i) => 'agent-' + i);
  const body = summarize('Stop', {}, { agents: many });
  assert.ok(words(body) <= MAX_WORDS, `${words(body)} words: "${body}"`);
  assert.ok(/12/.test(body), body);
});

test('an unknown message is used, trimmed to the budget', () => {
  const long = 'Claude has encountered something entirely new and wishes to describe it in tedious detail forever';
  const body = summarize('Notification', { message: long }, {});
  assert.ok(words(body) <= MAX_WORDS, `${words(body)} words: "${body}"`);
});

test('a trimmed message is marked as trimmed rather than just stopping', () => {
  const long = 'Claude has encountered something entirely new and wishes to describe it in tedious detail forever';
  assert.ok(/…$/.test(summarize('Notification', { message: long }, {})));
});

test('a short message is passed through untouched', () => {
  assert.strictEqual(summarize('Notification', { message: 'Permission needed' }, {}), 'Permission needed');
});

test('never returns the empty string, whatever it is handed', () => {
  for (const p of [null, undefined, {}, { message: '' }, { message: '   ' }]) {
    for (const e of ['Notification', 'Stop', 'Whatever']) {
      assert.ok(summarize(e, p, {}).trim().length > 0, `${e} ${JSON.stringify(p)}`);
    }
  }
});

test('no newlines, which a toast renders as a run-on', () => {
  const body = summarize('Notification', { message: 'line one\nline two\nline three' }, {});
  assert.ok(!/[\r\n]/.test(body), JSON.stringify(body));
});
