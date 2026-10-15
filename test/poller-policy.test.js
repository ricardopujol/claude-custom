'use strict';
/**
 * host/poller-policy.js (BACKLOG #100 c): the pure half of the shared resource poller. The cadence table (the design
 * call that is Ricardo's, held in ONE constant), the level an instance wants, and the verdict on a recorded owner.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const P = require('../host/poller-policy');

test('the cadence table is one frozen constant: 10 s with the panel in view, 30 s chip only, nothing while hidden', () => {
  assert.deepStrictEqual(P.CADENCE.panel, { intervalMs: 10000, mode: 'full' });
  assert.deepStrictEqual(P.CADENCE.chip, { intervalMs: 30000, mode: 'full' });
  assert.strictEqual(P.CADENCE.hidden, null);
  assert.ok(Object.isFrozen(P.CADENCE) && Object.isFrozen(P.CADENCE.panel) && Object.isFrozen(P.CADENCE.chip));
  assert.deepStrictEqual(P.LEVELS, ['hidden', 'chip', 'panel']);
});

test('cadenceOf: a known level is its row, an unknown one is nothing (never a guess)', () => {
  assert.strictEqual(P.cadenceOf('panel'), P.CADENCE.panel);
  assert.strictEqual(P.cadenceOf('hidden'), null);
  assert.strictEqual(P.cadenceOf('turbo'), null);
  assert.strictEqual(P.cadenceOf(undefined), null);
  assert.strictEqual(P.cadenceOf('constructor'), null, 'not an inherited property');
});

test('levelOf: minimised is hidden whatever else is true; the panel in view is panel; otherwise chip', () => {
  assert.strictEqual(P.levelOf({ minimised: true, panelShown: true }), 'hidden');
  assert.strictEqual(P.levelOf({ minimised: false, panelShown: true }), 'panel');
  assert.strictEqual(P.levelOf({ minimised: false, panelShown: false }), 'chip');
  assert.strictEqual(P.levelOf({}), 'chip', 'unknown is the cheap-but-alive level, not hidden');
  assert.strictEqual(P.levelOf({ minimised: 'yes', panelShown: 1 }), 'chip', 'only real booleans count');
});

test('fromWanted: the sampler\'s { panel, chip, viewing } as a level; nothing wanted is hidden', () => {
  assert.strictEqual(P.fromWanted({ panel: false, chip: false }), 'hidden');
  assert.strictEqual(P.fromWanted({ panel: true, chip: true }), 'chip');
  assert.strictEqual(P.fromWanted({ panel: true, chip: true, viewing: true }), 'panel');
  assert.strictEqual(P.fromWanted({ panel: false, chip: true, viewing: true }), 'panel');
  assert.strictEqual(P.fromWanted({ panel: false, chip: false, viewing: true }), 'hidden', 'minimised wins over a page that says it is showing');
  assert.strictEqual(P.fromWanted(null), 'hidden');
});

test('strongest: the highest level wins; no instance, or only junk, is hidden', () => {
  assert.strictEqual(P.strongest([]), 'hidden');
  assert.strictEqual(P.strongest(['hidden', 'chip']), 'chip');
  assert.strictEqual(P.strongest(['chip', 'panel', 'hidden']), 'panel');
  assert.strictEqual(P.strongest(['bogus', null, 7]), 'hidden');
  assert.strictEqual(P.strongest('panel'), 'hidden', 'not a list');
});

test('property: strongest is the maximum under hidden < chip < panel (order-free, idempotent, never below a member)', () => {
  const lvl = fc.constantFrom(...P.LEVELS);
  const rank = (l) => P.LEVELS.indexOf(l);
  fc.assert(fc.property(fc.array(lvl, { maxLength: 8 }), fc.array(lvl, { maxLength: 8 }), (a, b) => {
    const s = P.strongest([...a, ...b]);
    assert.strictEqual(P.strongest([...b, ...a]), s);
    assert.strictEqual(P.strongest([P.strongest(a), P.strongest(b)]), s);
    for (const l of [...a, ...b]) assert.ok(rank(s) >= rank(l));
    if (a.length + b.length > 0) assert.ok([...a, ...b].includes(s));
  }));
});

test('property: showing the panel never lowers a level, and minimising always hides it', () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), (minimised, panelShown) => {
    const l = P.levelOf({ minimised, panelShown });
    if (minimised) assert.strictEqual(l, 'hidden');
    else assert.ok(P.LEVELS.indexOf(P.levelOf({ minimised, panelShown: true })) >= P.LEVELS.indexOf(P.levelOf({ minimised, panelShown: false })));
  }));
});

const SELF = { pid: 500, start: '777' };
const verdict = (over = {}) => P.ownerVerdict({
  owner: { pid: 100, start: '1' }, self: SELF, pidAlive: true, beatAgeMs: 1000, startsMatch: undefined, ...over,
});

test('ownerVerdict: nobody recorded, or a record that is not an owner, means claim', () => {
  assert.strictEqual(verdict({ owner: null }), 'claim');
  assert.strictEqual(verdict({ owner: {} }), 'claim');
  assert.strictEqual(verdict({ owner: { pid: -1, start: '1' } }), 'claim');
  assert.strictEqual(verdict({ owner: { pid: 1.5, start: '1' } }), 'claim');
});

test('ownerVerdict: the record names this very process (pid AND start) is mine; same pid, another start, is a dead earlier holder', () => {
  assert.strictEqual(verdict({ owner: { pid: 500, start: '777' } }), 'mine');
  assert.strictEqual(verdict({ owner: { pid: 500, start: '123' }, pidAlive: true }), 'claim');
});

test('ownerVerdict: a dead owner is claimed at once; an owner whose liveness cannot be told is kept (doubt keeps)', () => {
  assert.strictEqual(verdict({ pidAlive: false }), 'claim');
  assert.strictEqual(verdict({ pidAlive: null }), 'keep');
});

test('ownerVerdict: alive with a fresh beat is kept; alive with a stale beat asks for the start-time proof', () => {
  assert.strictEqual(verdict({ beatAgeMs: 1000 }), 'keep');
  assert.strictEqual(verdict({ beatAgeMs: P.STALE_BEAT_MS + 1 }), 'verify');
});

test('ownerVerdict: the proof decides a stale one: another start means the pid was reused (claim); the same start is a hung but live owner (keep); no answer keeps', () => {
  const stale = P.STALE_BEAT_MS + 1;
  assert.strictEqual(verdict({ beatAgeMs: stale, startsMatch: false }), 'claim');
  assert.strictEqual(verdict({ beatAgeMs: stale, startsMatch: true }), 'keep');
  assert.strictEqual(verdict({ beatAgeMs: stale, startsMatch: null }), 'keep');
});

test('ownerVerdict: an owner recorded without a start cannot be proved reused, so a live pid keeps it', () => {
  assert.strictEqual(verdict({ owner: { pid: 100, start: null }, beatAgeMs: P.STALE_BEAT_MS + 1, startsMatch: false }), 'keep');
});

test('property: a live owner is never taken from while its beat is fresh or its start is proved the same', () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 10 * P.STALE_BEAT_MS }), fc.constantFrom(true, false, null, undefined), fc.constantFrom('1', null),
    (beatAgeMs, startsMatch, start) => {
      const v = P.ownerVerdict({ owner: { pid: 100, start }, self: SELF, pidAlive: true, beatAgeMs, startsMatch });
      if (v === 'claim') {
        assert.ok(beatAgeMs > P.STALE_BEAT_MS && startsMatch === false && start !== null, 'only a stale beat plus a proved different start takes a live owner');
      }
    }));
});
