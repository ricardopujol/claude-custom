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
const { tmpDir } = require('./tmp-dir');

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
  const dir = tmpDir('cc-quota-');
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

// --- kill tests for the release-176 survivors (BACKLOG #94) ----------------------
// Each of these pins a branch the suite above only reached without asserting it.

function credsWith(contents) {
  const dir = tmpDir('cc-quota-');
  const p = path.join(dir, '.credentials.json');
  fs.writeFileSync(p, contents);
  return p;
}

test('an empty access token is ABSENCE with its own reason, and no request is made', async () => {
  let calls = 0;
  const r = await readQuota({
    credentialsPath: credsFile(''),
    fetchImpl: async () => { calls += 1; return okFetch()(); },
  });
  assert.deepStrictEqual(r, { ok: false, state: 'absent', windows: [], error: 'no access token' });
  assert.strictEqual(calls, 0, 'no token, so nothing is sent');
});

test('a credentials file with no claudeAiOauth block is ABSENCE, with the parse error as the reason', async () => {
  const r = await readQuota({ credentialsPath: credsWith('{}'), fetchImpl: okFetch() });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.state, 'absent');
  assert.deepStrictEqual(r.windows, []);
  assert.strictEqual(r.error, "Cannot read properties of undefined (reading 'accessToken')");
});

test('a throw with no message falls back to the stated reason', async () => {
  const r = await readQuota({
    credentialsPath: credsFile(),
    fetchImpl: async () => { throw {}; }, // eslint-disable-line no-throw-literal
  });
  assert.deepStrictEqual(r, { ok: false, state: 'absent', windows: [], error: 'request failed' });
});

test('a network throw reports ok:false with its message and no windows', async () => {
  const r = await readQuota({
    credentialsPath: credsFile(),
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.deepStrictEqual(r, { ok: false, state: 'absent', windows: [], error: 'ENOTFOUND' });
});

test('a 401 carries its status, and a missing response says so', async () => {
  const r401 = await readQuota({
    credentialsPath: credsFile(),
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.deepStrictEqual(r401,
    { ok: false, state: 'absent', windows: [], error: 'usage endpoint returned 401' });
  const none = await readQuota({ credentialsPath: credsFile(), fetchImpl: async () => undefined });
  assert.deepStrictEqual(none,
    { ok: false, state: 'absent', windows: [], error: 'usage endpoint returned no response' });
});

test('an unparseable body is ABSENCE, not an empty fresh read', async () => {
  const r = await readQuota({
    credentialsPath: credsFile(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }),
  });
  assert.deepStrictEqual(r, { ok: false, state: 'absent', windows: [], error: 'x' });
});

test('a body whose json() throws with no message gets the unparseable reason', async () => {
  const r = await readQuota({
    credentialsPath: credsFile(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw {}; } }), // eslint-disable-line no-throw-literal
  });
  assert.deepStrictEqual(r, { ok: false, state: 'absent', windows: [], error: 'unparseable response' });
});

test('a good read has error null', async () => {
  const r = await readQuota({ credentialsPath: credsFile(), fetchImpl: okFetch() });
  assert.strictEqual(r.error, null);
});

test('an error message is cut to 200 characters, and 200 or fewer are kept whole', async () => {
  const fail = (len) => readQuota({
    credentialsPath: credsFile(),
    fetchImpl: async () => { throw new Error('e'.repeat(len)); },
  });
  assert.strictEqual((await fail(201)).error, 'e'.repeat(200));
  assert.strictEqual((await fail(200)).error, 'e'.repeat(200));
  assert.strictEqual((await fail(199)).error, 'e'.repeat(199));
  assert.strictEqual((await fail(1000)).error.length, 200);
});

test('normalizeWindows fills every omitted field with its stated default', () => {
  const [w] = normalizeWindows({ limits: [{ kind: 'session', percent: 10 }] });
  assert.deepStrictEqual(w, {
    key: 'session', label: '5h', percent: 10, resetsAt: null, severity: 'normal',
    isActive: false, usedDollars: null, remainingDollars: null, lockedReason: null,
  });
});

test('normalizeWindows keeps the fields that are present, exactly', () => {
  const [w] = normalizeWindows({ limits: [{
    kind: 'weekly_all', percent: 0, severity: 'warning', resets_at: 'R',
    is_active: true, locked_reason: 'x',
  }] });
  assert.deepStrictEqual(w, {
    key: 'weekly_all', label: 'week', percent: 0, resetsAt: 'R', severity: 'warning',
    isActive: true, usedDollars: null, remainingDollars: null, lockedReason: 'x',
  });
});

test('is_active is true only for the boolean true', () => {
  const act = (v) => normalizeWindows({ limits: [{ kind: 'session', is_active: v }] })[0].isActive;
  assert.strictEqual(act(true), true);
  assert.strictEqual(act(false), false);
  assert.strictEqual(act('true'), false);
  assert.strictEqual(act(1), false);
  assert.strictEqual(act(undefined), false);
});

test('a window with no percent reads as null, never as zero', () => {
  const pct = (v) => normalizeWindows({ limits: [{ kind: 'session', percent: v }] })[0].percent;
  assert.strictEqual(pct(undefined), null);
  assert.strictEqual(pct(null), null);
  assert.strictEqual(pct('50'), null);
  assert.strictEqual(pct(NaN), null);
  assert.strictEqual(pct(Infinity), null);
  assert.strictEqual(pct(0), 0);
});

test('a scoped window is keyed by kind AND scope, an unscoped one by kind alone', () => {
  const [a, b, c] = normalizeWindows({ limits: [
    { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_scoped', scope: { model: { display_name: 'Opus' } } },
    { kind: 'weekly_scoped', scope: { model: { display_name: '' } } },
  ] });
  assert.strictEqual(a.key, 'weekly_scoped:Fable');
  assert.strictEqual(b.key, 'weekly_scoped:Opus');
  assert.strictEqual(c.key, 'weekly_scoped');
});

test('an unknown kind is labelled with its underscores as spaces, and a missing kind as limit', () => {
  const [a, b] = normalizeWindows({ limits: [{ kind: 'monthly_big_one' }, {}] });
  assert.strictEqual(a.label, 'monthly big one');
  assert.strictEqual(b.label, 'limit');
});

test('normalizeWindows reads nothing from a body without a limits array', () => {
  assert.deepStrictEqual(normalizeWindows(null), []);
  assert.deepStrictEqual(normalizeWindows({}), []);
  assert.deepStrictEqual(normalizeWindows({ limits: 'x' }), []);
});

test('a percent exactly on a threshold announces it, one under does not', () => {
  const at = (percent) => ([{ key: 'session', label: '5h', percent, resetsAt: 'A' }]);
  const a = createQuotaAnnouncer();
  assert.strictEqual(a.check(at(QUOTA_THRESHOLDS[0] - 0.1)), null);
  const hit = a.check(at(QUOTA_THRESHOLDS[0]));
  assert.ok(hit);
  assert.strictEqual(hit.threshold, QUOTA_THRESHOLDS[0]);
  assert.strictEqual(createQuotaAnnouncer().check(at(QUOTA_THRESHOLDS[1] - 0.1)).threshold, QUOTA_THRESHOLDS[0]);
  assert.strictEqual(createQuotaAnnouncer().check(at(QUOTA_THRESHOLDS[1])).threshold, QUOTA_THRESHOLDS[1]);
});

test('the announcement carries the window identity and a rounded text', () => {
  const hit = createQuotaAnnouncer().check([
    { key: 'k', label: 'L', percent: 84.6, resetsAt: 'R' },
  ]);
  assert.deepStrictEqual(hit, {
    key: 'k', label: 'L', threshold: 80, percent: 84.6, resetsAt: 'R', text: 'L usage at 85%',
  });
});

test('of two windows crossing in one batch the higher rung wins, and the loser resurfaces next time', () => {
  const a = createQuotaAnnouncer();
  const batch = [
    { key: 'one', label: '1', percent: 85, resetsAt: 'A' },
    { key: 'two', label: '2', percent: 97, resetsAt: 'B' },
  ];
  assert.strictEqual(a.check(batch).key, 'two');
  assert.strictEqual(a.check(batch).key, 'one', 'the loser was not recorded as told');
  assert.strictEqual(a.check(batch), null);
  // The same two in the other order: the higher rung still wins.
  const b = createQuotaAnnouncer();
  assert.strictEqual(b.check([batch[1], batch[0]]).key, 'two');
  // Equal rungs: the first one listed wins, not the last.
  const c = createQuotaAnnouncer();
  assert.strictEqual(c.check([
    { key: 'one', label: '1', percent: 85, resetsAt: 'A' },
    { key: 'two', label: '2', percent: 86, resetsAt: 'B' },
  ]).key, 'one');
});

test('a rung already told for a window instance is not told again', () => {
  const a = createQuotaAnnouncer();
  const w = [{ key: 's', label: '5h', percent: 96, resetsAt: 'A' }];
  assert.strictEqual(a.check(w).threshold, 95);
  assert.strictEqual(a.check(w), null, 'same rung, same instance');
  assert.strictEqual(a.check([{ ...w[0], percent: 99 }]), null);
});

test('a window without a reset time announces every time it is seen, and keeps no ladder', () => {
  const a = createQuotaAnnouncer();
  const w = [{ key: 's', label: '5h', percent: 90, resetsAt: null }];
  assert.ok(a.check(w));
  assert.ok(a.check(w), 'risk announcing twice rather than go permanently silent');
  assert.strictEqual(a.state().size, 0);
});

test('non-numeric and missing percents never announce', () => {
  const a = createQuotaAnnouncer();
  assert.strictEqual(a.check([null, { key: 's', percent: '96', resetsAt: 'A' },
    { key: 's', percent: null, resetsAt: 'A' }, { key: 's', percent: NaN, resetsAt: 'A' },
    { key: 's', percent: Infinity, resetsAt: 'A' }]), null);
  assert.strictEqual(a.check('nope'), null);
  assert.strictEqual(a.check(undefined), null);
});

test('a window that rolls over drops only its own old ladder entries', () => {
  const a = createQuotaAnnouncer();
  const both = [
    { key: 'session', label: '5h', percent: 85, resetsAt: 'S1' },
    { key: 'session2', label: '5h2', percent: 85, resetsAt: 'T1' },
  ];
  a.check(both);
  a.check(both);
  assert.deepStrictEqual([...a.state().keys()].sort(), ['session2@T1', 'session@S1']);
  // session rolls over; its old key goes, session2 (a key that merely shares a prefix) stays.
  a.check([{ key: 'session', label: '5h', percent: 5, resetsAt: 'S2' }]);
  assert.deepStrictEqual([...a.state().keys()], ['session2@T1']);
});

test('a reading with no reset time never wipes the ladder of its own earlier instance', () => {
  const a = createQuotaAnnouncer();
  assert.ok(a.check([{ key: 's', label: '5h', percent: 85, resetsAt: 'A' }]));
  a.check([{ key: 's', label: '5h', percent: 85, resetsAt: null }]);
  assert.deepStrictEqual([...a.state().entries()], [['s@A', 80]]);
});

test('absence of a window from a batch does not forget what was told', () => {
  const a = createQuotaAnnouncer();
  const w = { key: 's', label: '5h', percent: 85, resetsAt: 'A' };
  assert.ok(a.check([w]));
  assert.strictEqual(a.check([]), null);
  assert.strictEqual(a.check([w]), null, 'not re-announced after a partial response');
  assert.deepStrictEqual([...a.state().entries()], [['s@A', 80]]);
});
