// @ts-nocheck
'use strict';
/**
 * The announcer's edges, all of them found by Dexter at the merge-gate review
 * on 2026-09-17 and reproduced before being written down.
 *
 * The through-line: the announcer's whole reason to exist is that quota percent
 * is NOT monotonic, so `milestones.js`'s "announce a rung once, ever" cannot be
 * reused. Each defect below is a different way that same trap got back in.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createQuotaAnnouncer } = require('../host/quota');

const w = (over) => ({ key: 'session', label: '5h', percent: 50, resetsAt: 'R1',
  severity: 'normal', ...over });

test('two windows crossing a rung in the SAME poll both get announced', () => {
  // REPRODUCED: the ladder was written before the `hit` selection, so the
  // second window was recorded as announced for an announcement that never
  // happened -- permanently silent until 95%. And this is not exotic: the
  // weekly total climbs with the session, and the host polls every 60s, so any
  // two windows crossing inside one bucket collided.
  const a = createQuotaAnnouncer();
  const batch = (s, wk) => ([
    w({ key: 'session', label: '5h', percent: s, resetsAt: 'R1' }),
    w({ key: 'weekly_all', label: 'week', percent: wk, resetsAt: 'R2' }),
  ]);

  const first = a.check(batch(81, 81));
  assert.ok(first, 'something is announced');

  // The other crossing must not have been silently swallowed.
  const second = a.check(batch(82, 82));
  assert.ok(second, 'the window that lost the first round must still be announced');
  assert.notStrictEqual(second.key, first.key, 'and it is the OTHER window');
});

test('a window missing from one batch does not forget its ladder', () => {
  // REPRODUCED: the prune keyed on presence in THIS batch, so a partial
  // response (or `limits: []`, which readQuota reports as ok:true) deleted the
  // ladder and the next poll re-announced a rung already announced. Absence
  // rewriting memory.
  const a = createQuotaAnnouncer();
  assert.ok(a.check([w({ key: 'weekly_all', label: 'week', percent: 85, resetsAt: 'B' })]));
  a.check([]);                                    // a batch that reported nothing
  assert.strictEqual(
    a.check([w({ key: 'weekly_all', label: 'week', percent: 86, resetsAt: 'B' })]), null,
    'same instance, same rung -- must stay silent');
});

test('a window with NO reset time can still announce its next instance', () => {
  // REPRODUCED: every instance collapsed onto the literal 'no-reset', so the
  // first crossing announced and the window was silent for the life of the
  // host -- the exact milestones.js behaviour this module exists to escape,
  // restored whenever the discriminator is absent.
  const a = createQuotaAnnouncer();
  assert.ok(a.check([w({ percent: 85, resetsAt: null })]), 'first crossing announces');
  a.check([w({ percent: 5, resetsAt: null })]);   // rolled over
  assert.ok(a.check([w({ percent: 88, resetsAt: null })]),
    'a later crossing must not be suppressed by a ladder that can never expire');
});

test('two windows of the same KIND keep separate ladders', () => {
  // The fixture already anticipates this: `seven_day_opus` sits in the response
  // as a null waiting to be switched on, and the label logic exists precisely to
  // name multiple scopes. Both rows would be `weekly_scoped@<same reset>`.
  const a = createQuotaAnnouncer();
  const batch = (fable, opus) => ([
    w({ key: 'weekly_scoped:Fable', label: 'Fable', percent: fable, resetsAt: 'W' }),
    w({ key: 'weekly_scoped:Opus', label: 'Opus', percent: opus, resetsAt: 'W' }),
  ]);
  assert.ok(a.check(batch(10, 96)), 'Opus crosses 95');
  const fable = a.check(batch(81, 96));
  assert.ok(fable, 'Fable crossing 80 is its own window and must be announced');
  assert.match(fable.label, /fable/i);
});

test('a non-numeric percent is not coerced into a crossing', () => {
  // The module bans this coercion by name three files over -- `Number('96')` is
  // 96, and `Number(null)` is 0. A value the normaliser classifies as unknown
  // must not announce anything.
  const a = createQuotaAnnouncer();
  assert.strictEqual(a.check([w({ percent: '96' })]), null);
  assert.strictEqual(a.check([w({ percent: null })]), null);
  assert.strictEqual(a.check([w({ percent: undefined })]), null);
});

test('a null percent does not evict the ladder of a live window', () => {
  // The two defects compose: if an unreadable percent both fails to announce
  // AND drops the window out of `live`, the ladder is pruned and the next good
  // reading re-announces.
  const a = createQuotaAnnouncer();
  assert.ok(a.check([w({ percent: 85 })]));
  a.check([w({ percent: null })]);
  assert.strictEqual(a.check([w({ percent: 86 })]), null, 'still the same instance');
});
