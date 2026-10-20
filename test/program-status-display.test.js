'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const d = require('../app/program-status-display');

const root = (state, extra = {}) => ({ id: '', state, kind: null, progress: null, app: null, title: null, msg: null, ...extra });

test('hostListsProgramStatus: only an exact entry of an array counts', () => {
  assert.strictEqual(d.hostListsProgramStatus(['resize', 'program-status']), true);
  for (const c of [null, undefined, 'program-status', ['program-status-x'], [], {}, 5]) assert.strictEqual(d.hostListsProgramStatus(c), false, String(c));
});

test('clean keeps the five known states and the few fields the window shows', () => {
  for (const s of ['idle', 'working', 'done', 'blocked', 'error']) assert.strictEqual(d.clean(root(s)).state, s);
  assert.deepStrictEqual(d.clean(root('blocked', { kind: 'permission', msg: 'Allow?', progress: 3, app: 'x', title: 't' })),
    { state: 'blocked', kind: 'permission', msg: 'Allow?', progress: 3 });
});

test('clean: absence is null, never a guessed idle', () => {
  for (const r of [null, undefined, {}, { state: 'busy' }, { state: 'clear' }, 'working', 5, []]) assert.strictEqual(d.clean(r), null, JSON.stringify(r));
});

test('clean drops what is not a real value: a kind off the list, a progress that is not 0..100, a non-string msg', () => {
  assert.deepStrictEqual(d.clean({ state: 'blocked', kind: 'banana', progress: 101, msg: 5 }), { state: 'blocked', kind: null, msg: null, progress: null });
  assert.strictEqual(d.clean({ state: 'working', progress: null }).progress, null, 'null is not zero');
  assert.strictEqual(d.clean({ state: 'working', progress: 0 }).progress, 0);
  assert.strictEqual(d.clean({ state: 'working', progress: '5' }).progress, null);
});

test('clean caps a message at what a tooltip can hold', () => {
  assert.ok(d.clean({ state: 'blocked', msg: 'x'.repeat(5000) }).msg.length <= 300);
});

test('cueEvents: a start of work clears a finished cue; leaving blocked or error without finishing clears the need', () => {
  const ev = (a, b) => d.cueEvents(a === null ? null : { state: a }, b === null ? null : { state: b });
  assert.deepStrictEqual(ev(null, 'working'), ['working']);
  assert.deepStrictEqual(ev('done', 'working'), ['working']);
  assert.deepStrictEqual(ev('blocked', 'working'), ['working', 'answered']);
  assert.deepStrictEqual(ev('blocked', 'idle'), ['answered']);
  assert.deepStrictEqual(ev('error', null), ['answered']);
  assert.deepStrictEqual(ev('working', 'working'), []);
  assert.deepStrictEqual(ev('working', 'blocked'), []);       // the host's attention frame raises the need
  assert.deepStrictEqual(ev('working', 'done'), []);          // ... and the finished one
  assert.deepStrictEqual(ev('blocked', 'done'), []);          // done's own frame answers the need
  assert.deepStrictEqual(ev(null, null), []);
});

test('headerView: a class and a tooltip per state, nothing for none or idle', () => {
  assert.strictEqual(d.headerView(null), null);
  assert.strictEqual(d.headerView({ state: 'idle' }), null);
  assert.strictEqual(d.headerView({ state: 'working' }).cls, 'ps-working');
  assert.strictEqual(d.headerView({ state: 'blocked', kind: 'permission' }).cls, 'ps-blocked');
  assert.strictEqual(d.headerView({ state: 'done' }).cls, 'ps-done');
  assert.strictEqual(d.headerView({ state: 'error' }).cls, 'ps-error');
});

test('tooltips carry the kind and the decoded message, as text', () => {
  const v = d.headerView({ state: 'blocked', kind: 'permission', msg: 'Allow Edit on a.js?' });
  assert.match(v.title, /permission/);
  assert.match(v.title, /Allow Edit on a\.js\?/);
  assert.match(d.headerView({ state: 'working', progress: 40 }).title, /40%/);
  assert.doesNotMatch(d.headerView({ state: 'working', progress: null }).title, /%|null/);
});

test('stripDots: with no program state it is exactly the dots the strip always drew', () => {
  assert.deepStrictEqual(d.stripDots({ working: false, needsInput: false, program: null }), []);
  assert.deepStrictEqual(d.stripDots({ working: true, needsInput: true, program: null }),
    [{ cls: 'working', title: 'Working' }, { cls: 'needs', title: 'Needs your input' }]);
});

test('stripDots: blocked puts its kind and message in the needs tooltip', () => {
  const dots = d.stripDots({ working: false, needsInput: true, program: { state: 'blocked', kind: 'question', msg: 'Which file?' } });
  assert.strictEqual(dots.length, 1);
  assert.strictEqual(dots[0].cls, 'needs');
  assert.match(dots[0].title, /question/);
  assert.match(dots[0].title, /Which file\?/);
});

test('stripDots: an error is its own colour, done shows a calm dot only when nothing else is going on', () => {
  assert.deepStrictEqual(d.stripDots({ working: false, needsInput: true, program: { state: 'error', msg: 'Rate limited' } }).map(x => x.cls), ['needs error']);
  assert.deepStrictEqual(d.stripDots({ working: false, needsInput: false, program: { state: 'done' } }).map(x => x.cls), ['done']);
  assert.deepStrictEqual(d.stripDots({ working: true, needsInput: false, program: { state: 'done' } }).map(x => x.cls), ['working']);
  assert.deepStrictEqual(d.stripDots({ working: false, needsInput: true, program: { state: 'done' } }).map(x => x.cls), ['needs']);
});

test('stripDots: a working program with progress says so', () => {
  const dots = d.stripDots({ working: true, needsInput: false, program: { state: 'working', progress: 55 } });
  assert.match(dots[0].title, /55%/);
});

test('property: clean never throws and only ever returns a known state or null', () => {
  fc.assert(fc.property(fc.anything(), (x) => {
    const c = d.clean(x);
    assert.ok(c === null || ['idle', 'working', 'done', 'blocked', 'error'].includes(c.state));
  }), { numRuns: 300 });
});
