'use strict';
/**
 * How much of the Max plan is left, and when it resets.
 *
 * Ricardo: "I want the meters of how much Claude from my max account I have
 * left until my reset (daily, weekly and fable)."
 *
 * MEASURED against the real endpoint before any of this was designed, because
 * the request and the reality did not match: there is NO daily window. The
 * account reports a 5-HOUR rolling session, a weekly total, and a weekly
 * allowance scoped to Fable. Shipping a "daily" meter would have drawn a
 * window that does not exist.
 *
 * The second measured constraint: `limit_dollars`, `used_dollars` and
 * `remaining_dollars` are all null on this plan. Percent and reset time are
 * the only magnitudes that exist, so they are the only ones drawn.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readQuota, normalizeWindows, createQuotaAnnouncer, QUOTA_THRESHOLDS } =
  require('../host/quota');

// The real response shape, trimmed to what this module reads. Captured from
// the live endpoint 2026-09-15 (verify/probe-quota.js re-captures it).
const LIVE = () => ({
  five_hour: { utilization: 58.0, resets_at: '2026-09-15T17:30:00.091589+00:00' },
  seven_day: { utilization: 17.0, resets_at: '2026-09-21T18:00:00.091609+00:00' },
  seven_day_opus: null,
  tangelo: null,
  limits: [
    { kind: 'session', group: 'session', percent: 58, severity: 'normal',
      resets_at: '2026-09-15T17:30:00.091589+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 17, severity: 'normal',
      resets_at: '2026-09-21T18:00:00.091609+00:00', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 4, severity: 'normal',
      resets_at: '2026-09-21T18:00:00.091820+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
});

function credsFile(token = 'tok-' + 'x'.repeat(40)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-quota-'));
  const p = path.join(dir, '.credentials.json');
  fs.writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  return p;
}

const okFetch = (body = LIVE()) => async () => ({
  ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
});

// --- normalising the windows ---------------------------------------------------

test('the three real windows are named for what they ARE, not what was asked for', () => {
  const w = normalizeWindows(LIVE());
  assert.deepStrictEqual(w.map(x => x.label), ['5h', 'week', 'Fable']);
  // "daily" must not appear anywhere: the account has no daily window.
  assert.ok(!w.some(x => /daily/i.test(x.label)));
});

test('percent, reset and severity come straight from the API', () => {
  const [session, week, fable] = normalizeWindows(LIVE());
  assert.strictEqual(session.percent, 58);
  assert.strictEqual(session.isActive, true);
  assert.strictEqual(session.severity, 'normal');
  assert.strictEqual(session.resetsAt, '2026-09-15T17:30:00.091589+00:00');
  assert.strictEqual(week.percent, 17);
  assert.strictEqual(fable.percent, 4);
});

test('the Fable window is identified by its SCOPE, not by a hardcoded model name', () => {
  const body = LIVE();
  body.limits[2].scope.model.display_name = 'Sonnet';
  const w = normalizeWindows(body);
  assert.strictEqual(w[2].label, 'Sonnet', 'the label follows whatever the API scopes it to');
});

test('a window kind we have never seen is still drawn, not silently dropped', () => {
  // The response carries a dozen null codenames (tangelo, nimbus_quill...),
  // which look like server-side flags waiting to be switched on. A new window
  // appearing must not vanish just because this module predates it.
  const body = LIVE();
  body.limits.push({ kind: 'monthly_whatever', group: 'monthly', percent: 3,
    severity: 'normal', resets_at: '2026-10-01T00:00:00Z', scope: null, is_active: false });
  const w = normalizeWindows(body);
  assert.strictEqual(w.length, 4);
  assert.ok(w[3].label && w[3].label.length > 0, 'an unknown kind still gets a label');
});

test('windows are read from limits[], not the legacy top-level keys', () => {
  // five_hour/seven_day duplicate the first two rows and carry no scope, so
  // they cannot express the Fable window at all.
  const body = LIVE();
  body.five_hour.utilization = 99;          // legacy key disagrees
  const w = normalizeWindows(body);
  assert.strictEqual(w[0].percent, 58, 'limits[] is the source of truth');
});

test('dollars are never invented when the plan does not report them', () => {
  const w = normalizeWindows(LIVE());
  for (const x of w) {
    assert.ok(!('usedDollars' in x) || x.usedDollars === null);
    assert.ok(!('remainingDollars' in x) || x.remainingDollars === null);
  }
});

// --- reading, and failing honestly ---------------------------------------------

test('a good read reports fresh, with the windows', async () => {
  const r = await readQuota({ credentialsPath: credsFile(), fetchImpl: okFetch() });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state, 'fresh');
  assert.strictEqual(r.windows.length, 3);
});

test('no credentials file is ABSENCE, never zero percent', async () => {
  const r = await readQuota({
    credentialsPath: path.join(os.tmpdir(), 'definitely-not-here.json'),
    fetchImpl: okFetch(),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.state, 'absent');
  assert.deepStrictEqual(r.windows, [], 'no windows -- NOT windows at 0%');
});

test('an HTTP failure is ABSENCE, never zero percent', async () => {
  const r = await readQuota({
    credentialsPath: credsFile(),
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.state, 'absent');
  assert.deepStrictEqual(r.windows, []);
  // 0% would read as "you have used nothing", which is the opposite of unknown.
  assert.ok(!r.windows.some(w => w.percent === 0));
});

test('a network throw is ABSENCE, not a crash', async () => {
  const r = await readQuota({
    credentialsPath: credsFile(),
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.state, 'absent');
});

test('a failed read never leaks the token, in any field', async () => {
  const token = 'sk-secret-' + 'y'.repeat(40);
  const r = await readQuota({
    credentialsPath: credsFile(token),
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  });
  assert.ok(!JSON.stringify(r).includes(token), 'the token must not appear in the result');
});

test('the token travels as a Bearer header and nowhere else', async () => {
  const token = 'tok-' + 'z'.repeat(40);
  let seenUrl = null; let seenHeaders = null;
  await readQuota({
    credentialsPath: credsFile(token),
    fetchImpl: async (url, opts) => {
      seenUrl = url; seenHeaders = opts.headers;
      return okFetch()();
    },
  });
  assert.ok(!String(seenUrl).includes(token), 'never in the URL');
  assert.strictEqual(seenHeaders.Authorization, 'Bearer ' + token);
});

// --- the announcer, and the trap the milestone ladder would have walked into ----

test('a threshold announces once per window, not once per read', () => {
  const a = createQuotaAnnouncer();
  const at = (percent) => ([{ key: 'session', label: '5h', percent,
    resetsAt: '2026-09-15T17:30:00Z', severity: 'normal' }]);
  assert.strictEqual(a.check(at(50)), null, 'below the first threshold');
  const first = a.check(at(85));
  assert.ok(first, 'crossing 80 announces');
  assert.strictEqual(a.check(at(86)), null, 'the same threshold does not announce twice');
  assert.ok(a.check(at(96)), 'a HIGHER threshold still announces');
});

test('a window that RESETS can announce again -- the ladder is per window instance', () => {
  // THE TRAP. host/milestones.js announces a rung once, ever, and refuses to
  // celebrate downward -- correct for lifetime token spend, which only grows.
  // Quota percent is NOT monotonic: it climbs toward 100 and drops to zero
  // every five hours. Keyed on a global highest, "80% of your 5-hour window"
  // would announce once and then stay silent for the life of the account.
  const a = createQuotaAnnouncer();
  const win = (percent, resetsAt) => ([{ key: 'session', label: '5h', percent, resetsAt,
    severity: 'normal' }]);

  assert.ok(a.check(win(85, '2026-09-15T17:30:00Z')), 'first window announces');
  assert.strictEqual(a.check(win(90, '2026-09-15T17:30:00Z')), null, 'same window, same rung');

  // The window rolled over: new resets_at, percent back near zero, then climbing.
  assert.strictEqual(a.check(win(5, '2026-09-15T22:30:00Z')), null, 'fresh window, low');
  assert.ok(a.check(win(85, '2026-09-15T22:30:00Z')),
    'the NEXT window must be able to announce the same rung again');
});

test('each window keeps its own ladder', () => {
  const a = createQuotaAnnouncer();
  const both = (sessionPct, weekPct) => ([
    { key: 'session', label: '5h', percent: sessionPct, resetsAt: 'A', severity: 'normal' },
    { key: 'weekly_all', label: 'week', percent: weekPct, resetsAt: 'B', severity: 'normal' },
  ]);
  assert.ok(a.check(both(85, 10)), 'session crosses');
  const weekly = a.check(both(85, 85));
  assert.ok(weekly, 'the weekly window crossing is its own announcement');
  assert.match(weekly.text, /week/i);
});

test('the announcer never celebrates a drop', () => {
  const a = createQuotaAnnouncer();
  const at = (percent) => ([{ key: 'session', label: '5h', percent, resetsAt: 'A',
    severity: 'normal' }]);
  a.check(at(96));
  assert.strictEqual(a.check(at(85)), null, 'falling back through a rung says nothing');
});

test('the thresholds are a stated ladder, not magic numbers in a branch', () => {
  assert.ok(Array.isArray(QUOTA_THRESHOLDS) && QUOTA_THRESHOLDS.length >= 2);
  assert.ok(QUOTA_THRESHOLDS.every(t => typeof t === 'number' && t > 0 && t <= 100));
});
