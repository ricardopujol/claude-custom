'use strict';
/**
 * How a quota meter should be DRAWN, given how well it is known.
 *
 * Extracted from renderer.js for the reason app/usage-display.js and
 * app/career-display.js were: a decision living inside a browser script is a
 * decision nothing can test.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { inspect } = require('node:util');

const { quotaDisplay, formatCountdown, toneFor, UNKNOWN } = require('../app/quota-display');

const NOW = Date.parse('2026-09-15T16:00:00Z');
const win = (over = {}) => ({
  key: 'session', label: '5h', percent: 24, severity: 'normal',
  resetsAt: '2026-09-15T17:37:00Z', isActive: true, lockedReason: null, ...over,
});
const ready = (windows) => ({ ok: true, state: 'fresh', windows });

// --- absence is not zero -------------------------------------------------------

test('before the first read the meters say they are reading, not 0%', () => {
  const d = quotaDisplay(null, NOW);
  assert.strictEqual(d.state, 'reading');
  assert.deepStrictEqual(d.meters, []);
});

test('a failed read is ABSENT and draws no bars at all', () => {
  // A bar at 0% reads as "you have used nothing", which is the opposite of
  // "we could not find out".
  const d = quotaDisplay({ ok: false, state: 'absent', windows: [], error: 'usage endpoint returned 401' }, NOW);
  assert.strictEqual(d.state, 'absent');
  assert.deepStrictEqual(d.meters, []);
  assert.match(d.note, /401|could not/i);
});

test('a good read draws one meter per window', () => {
  const d = quotaDisplay(ready([win(), win({ key: 'weekly_all', label: 'week', percent: 24, isActive: false })]), NOW);
  assert.strictEqual(d.state, 'ready');
  assert.strictEqual(d.meters.length, 2);
  assert.strictEqual(d.meters[0].label, '5h');
  assert.strictEqual(d.meters[0].percent, 24);
});

test('a window with an unknown percent is drawn as unknown, not as zero', () => {
  const d = quotaDisplay(ready([win({ percent: null })]), NOW);
  assert.strictEqual(d.meters[0].percent, null);
  assert.strictEqual(d.meters[0].text, '—');
});

// --- tone ----------------------------------------------------------------------

test("the API's own severity wins when it is not normal", () => {
  // The account knows things we do not -- a scoped window can be throttled at
  // a percentage that looks harmless from here.
  assert.strictEqual(toneFor({ severity: 'warning', percent: 10 }), 'warn');
  assert.strictEqual(toneFor({ severity: 'critical', percent: 10 }), 'critical');
});

test('with normal severity the tone follows the percentage', () => {
  assert.strictEqual(toneFor({ severity: 'normal', percent: 10 }), 'normal');
  assert.strictEqual(toneFor({ severity: 'normal', percent: 85 }), 'warn');
  assert.strictEqual(toneFor({ severity: 'normal', percent: 96 }), 'critical');
});

test('a locked window is critical whatever the numbers say', () => {
  assert.strictEqual(toneFor({ severity: 'normal', percent: 12, lockedReason: 'limit_reached' }), 'critical');
});

test('an unknown percent has no tone to claim', () => {
  assert.strictEqual(toneFor({ severity: 'normal', percent: null }), 'unknown');
});

// --- the countdown -------------------------------------------------------------

test('the countdown is the time until reset, not the timestamp', () => {
  // "resets 17:37Z" makes you do arithmetic while watching a bar fill up.
  assert.strictEqual(formatCountdown('2026-09-15T17:37:00Z', NOW), '1h37m');
  assert.strictEqual(formatCountdown('2026-09-15T16:45:00Z', NOW), '45m');
  assert.strictEqual(formatCountdown('2026-09-21T18:00:00Z', NOW), '6d2h');
});

test('a reset in the past reads as due, never as a negative countdown', () => {
  assert.strictEqual(formatCountdown('2026-09-15T15:00:00Z', NOW), 'due');
});

test('a missing or unparseable reset is unknown, not zero', () => {
  assert.strictEqual(formatCountdown(null, NOW), '—');
  assert.strictEqual(formatCountdown('not a date', NOW), '—');
});

// --- the tooltip ---------------------------------------------------------------

test('the tooltip says which window, how much, and when it resets', () => {
  const d = quotaDisplay(ready([win()]), NOW);
  const title = d.meters[0].title;
  assert.match(title, /5h/);
  assert.match(title, /24%/);
  assert.match(title, /1h37m/);
});

test('the tooltip names the active window as the binding one', () => {
  const d = quotaDisplay(ready([win({ isActive: true })]), NOW);
  assert.match(d.meters[0].title, /currently the binding limit/i);
});

test('a percentage is never described as tokens or dollars', () => {
  // This plan reports no money and no token counts -- only percent. Inventing
  // either would be the fabrication the display audit exists to catch.
  const d = quotaDisplay(ready([win()]), NOW);
  assert.ok(!/token|\$|dollar/i.test(d.meters[0].title), d.meters[0].title);
});

// --- boundaries, pinned literally (Stryker survivors + Dexter F7) ---------------

test('real usage below half a percent is "<1%", not the one sentence this file bans', () => {
  // Dexter, 2026-09-17: percent 0.4 drew "0% used" -- "a meter at 0% says you
  // have used nothing. That is a CLAIM, and a false one." The twin module
  // already solved this exact problem with "<1m" for the same reason.
  const at = (p) => quotaDisplay(ready([win({ percent: p })]), NOW).meters[0].text;
  assert.strictEqual(at(0.4), '<1%');
  assert.strictEqual(at(0.01), '<1%');
  assert.strictEqual(at(0), '0%', 'a genuine zero stays honest');
});

test('usage just short of the limit is ">99%", not a false 100%', () => {
  const at = (p) => quotaDisplay(ready([win({ percent: p })]), NOW).meters[0].text;
  assert.strictEqual(at(99.6), '>99%');
  assert.strictEqual(at(100), '100%', 'actually full stays full');
});

test('a negative percent is unknown, not a confident measurement', () => {
  const m = quotaDisplay(ready([win({ percent: -5 })]), NOW).meters[0];
  assert.strictEqual(m.percent, null);
  assert.strictEqual(m.text, UNKNOWN);
  assert.strictEqual(m.tone, 'unknown');
});

test('the tone thresholds are pinned AT the boundary, not near it', () => {
  // Stryker killed nothing here: `>=` mutated to `>` survived, because no test
  // sat exactly on 80 or 95. These are the assertions a mutant demands.
  assert.strictEqual(toneFor({ severity: 'normal', percent: 79.9 }), 'normal');
  assert.strictEqual(toneFor({ severity: 'normal', percent: 80 }), 'warn');
  assert.strictEqual(toneFor({ severity: 'normal', percent: 94.9 }), 'warn');
  assert.strictEqual(toneFor({ severity: 'normal', percent: 95 }), 'critical');
});

test('a reset under a minute away is not "0m"', () => {
  assert.strictEqual(formatCountdown('2026-09-15T16:00:59Z', NOW), '<1m');
  assert.strictEqual(formatCountdown('2026-09-15T16:01:00Z', NOW), '1m');
});

// =============================================================================
// KILLS FOR MUTATION SURVIVORS (Mortimer, PR #73).
//
// Each block names the mutants it kills, because a test written against a
// survivor and not against a behaviour is how a suite ends up asserting nothing.
// The mutants left alive on purpose, and why, are in the build log.
// =============================================================================

const meterFor = (over) => quotaDisplay(ready([win(over)]), NOW).meters[0];

// --- finiteOrNull: strictly a finite NUMBER -----------------------------------

test('a percent that is not a finite number is unknown, whatever it coerces to', () => {
  // Kills finiteOrNull `-> true` (a string '50' would pass straight through as
  // the percent) and `&&` -> `||` (NaN and +-Infinity are typeof 'number', so
  // they would be believed). `Number('50')` is 50 and `Number(null)` is 0: this
  // file exists to never turn "no value" into a confident number.
  for (const bad of ['50', '', NaN, Infinity, -Infinity, undefined, {}, [], true]) {
    const m = meterFor({ percent: bad });
    assert.strictEqual(m.percent, null, `percent ${inspect(bad)} must be unknown`);
    assert.strictEqual(m.text, UNKNOWN, `text for ${inspect(bad)}`);
    assert.strictEqual(m.fill, 0);
    assert.strictEqual(m.tone, 'unknown');
  }
});

// --- formatPercent boundaries, pinned ON the edge ------------------------------

test('exactly 1% is "1%", not "<1%"', () => {
  // Kills `pct < 1` -> `pct <= 1`.
  assert.strictEqual(meterFor({ percent: 1 }).text, '1%');
  assert.strictEqual(meterFor({ percent: 0.99 }).text, '<1%');
});

test('exactly 99% is "99%", not ">99%"', () => {
  // Kills `pct > 99` -> `pct >= 99`.
  assert.strictEqual(meterFor({ percent: 99 }).text, '99%');
  assert.strictEqual(meterFor({ percent: 99.01 }).text, '>99%');
});

// --- toneFor -------------------------------------------------------------------

test('toneFor of nothing is unknown, and does not throw', () => {
  // Kills `!w` -> false (TypeError on w.lockedReason) and the 'unknown' literal.
  assert.strictEqual(toneFor(null), 'unknown');
  assert.strictEqual(toneFor(undefined), 'unknown');
});

test('every spelling of a server severity is honoured, in any case', () => {
  // Kills `sev === 'severe'` -> false, `sev === 'warn'` -> false, and both of
  // their literals. Percent 10 looks harmless from here, so ONLY the severity
  // can produce these tones.
  assert.strictEqual(toneFor({ severity: 'severe', percent: 10 }), 'critical');
  assert.strictEqual(toneFor({ severity: 'warn', percent: 10 }), 'warn');
  assert.strictEqual(toneFor({ severity: 'SEVERE', percent: 10 }), 'critical');
  assert.strictEqual(toneFor({ severity: 'Warning', percent: 10 }), 'warn');
  assert.strictEqual(toneFor({ severity: 'Critical', percent: 10 }), 'critical');
});

// --- formatCountdown boundaries ------------------------------------------------

test('a reset at exactly this instant is "due", not "<1m"', () => {
  // Kills `ms <= 0` -> `ms < 0`.
  assert.strictEqual(formatCountdown('2026-09-15T16:00:00Z', NOW), 'due');
});

test('exactly one hour is "1h", not "60m"', () => {
  // Kills `mins < 60` -> `mins <= 60`, and the `${hours}h` template.
  assert.strictEqual(formatCountdown('2026-09-15T17:00:00Z', NOW), '1h');
  assert.strictEqual(formatCountdown('2026-09-15T16:59:00Z', NOW), '59m');
  assert.strictEqual(formatCountdown('2026-09-15T18:00:00Z', NOW), '2h');
});

test('exactly one day is "1d", not "24h"', () => {
  // Kills `hours < 24` -> `hours <= 24`, and the `${days}d` template.
  assert.strictEqual(formatCountdown('2026-09-16T16:00:00Z', NOW), '1d');
  assert.strictEqual(formatCountdown('2026-09-16T15:59:00Z', NOW), '23h59m');
  assert.strictEqual(formatCountdown('2026-09-18T16:00:00Z', NOW), '3d');
});

// --- quotaDisplay: the three states, exactly -----------------------------------

test('the reading state says so in words', () => {
  // Kills the 'reading account limits…' literal. Matched by phrase, so a copy
  // edit (the ellipsis, say) is not a test failure (Dexter, PR #73 F6).
  assert.match(quotaDisplay(null, NOW).note, /reading account limits/);
  assert.match(quotaDisplay(undefined, NOW).note, /reading account limits/);
});

test('a read that FAILED is absent even when it still carries windows', () => {
  // Kills `quota.ok === false` -> false (and the `||` -> `&&` twins): a payload
  // that says ok:false is a failed read no matter what else rides along, and
  // drawing its windows would be drawing numbers we were told not to trust.
  const d = quotaDisplay({ ok: false, error: 'stale', windows: [win()] }, NOW);
  assert.strictEqual(d.state, 'absent');
  assert.deepStrictEqual(d.meters, []);
  assert.strictEqual(d.note, 'stale');
});

test('an ok read with malformed windows is absent, not a header of zero meters', () => {
  // Kills `Array.isArray(quota.windows)` -> true and the `||` regroupings.
  for (const q of [{ ok: true }, { ok: true, windows: null }, { ok: true, windows: 'x' }, {}]) {
    const d = quotaDisplay(q, NOW);
    assert.strictEqual(d.state, 'absent', JSON.stringify(q));
    assert.deepStrictEqual(d.meters, []);
    assert.match(d.note, /could not read account limits/, JSON.stringify(q));
  }
});

test('an ok read that lists NO windows says so, and never claims the read failed', () => {
  // Dexter, PR #73 F1: `{ ok: true, windows: [] }` is a SUCCESSFUL read of an
  // account the server lists no limits for (host/quota.js). "could not read
  // account limits" is untrue there. Ricardo chose "no usage limits reported"
  // (2026-09-30): true whether the account has no limits or the reply's format
  // changed under normalizeWindows, so it claims neither.
  const d = quotaDisplay({ ok: true, state: 'fresh', windows: [], error: null }, NOW);
  assert.strictEqual(d.state, 'none');
  assert.deepStrictEqual(d.meters, []);
  assert.match(d.note, /no usage limits reported/);
});

test('an EMPTY read that is not ok is still a failure, not "no limits"', () => {
  // Kills `quota.ok === true` -> true in the no-windows branch: host/quota.js
  // sends `windows: []` on EVERY failure, so an empty list alone proves nothing.
  for (const q of [{ ok: false, windows: [] }, { windows: [] }]) {
    const d = quotaDisplay(q, NOW);
    assert.strictEqual(d.state, 'absent', JSON.stringify(q));
    assert.match(d.note, /could not read account limits/, JSON.stringify(q));
  }
});

test('the absent note is the server error, stringified, when there is one', () => {
  // With an error present it must win over the fallback.
  assert.strictEqual(quotaDisplay({ ok: false, error: 401 }, NOW).note, '401');
});

// --- the tooltip, pinned as a whole --------------------------------------------

test('the tooltip is exactly: label, percent, reset, binding flag -- joined by " · "', () => {
  // Kills every string in the parts list at once: the ' used' suffix, the ' · '
  // separator, 'resets in', and the binding sentence.
  assert.strictEqual(meterFor({}).title,
    '5h: 24% used · resets in 1h37m · currently the binding limit');
});

test('an unknown percent reads "unknown" in the tooltip, never "0% used"', () => {
  // Kills `pct === null` -> false in the parts line and the 'unknown' literal.
  assert.strictEqual(meterFor({ percent: null, isActive: false }).title,
    '5h: unknown · resets in 1h37m');
});

test('an unknown reset time reads "reset time unknown"', () => {
  // Kills `countdown === UNKNOWN` -> false and the literal.
  assert.strictEqual(meterFor({ resetsAt: null, isActive: false }).title,
    '5h: 24% used · reset time unknown');
});

test('a reset already past reads "resetting now", not "resets in due"', () => {
  // Kills `countdown === 'due'` -> false, the 'due' literal, and the
  // 'resetting now' literal.
  assert.strictEqual(meterFor({ resetsAt: '2026-09-15T15:00:00Z', isActive: false }).title,
    '5h: 24% used · resetting now');
});

test('the binding sentence appears only for the active window', () => {
  // Kills `if (w.isActive)` -> true.
  assert.doesNotMatch(meterFor({ isActive: false }).title, /binding/);
  assert.doesNotMatch(meterFor({ isActive: undefined }).title, /binding/);
});

test('a locked window says LOCKED and why -- and an unlocked one says nothing', () => {
  // Kills `if (w.lockedReason)` -> true / -> false and the template literal.
  assert.strictEqual(meterFor({ lockedReason: 'limit_reached', isActive: false }).title,
    '5h: 24% used · resets in 1h37m · LOCKED: limit_reached');
  assert.doesNotMatch(meterFor({ lockedReason: null }).title, /LOCKED/);
  assert.doesNotMatch(meterFor({ lockedReason: '' }).title, /LOCKED/);
});

// --- fill and isActive ---------------------------------------------------------

test('fill follows the percent, is clamped to 100, and is 0 when unknown', () => {
  // Kills `pct === null` -> true / `!==` (fill stuck at 0), Math.max -> Math.min
  // (fill stuck at 0), and Math.min(100, ..) -> Math.max(100, ..) (fill never
  // below 100). Over 100 is drawn full, not overflowing the layout.
  assert.strictEqual(meterFor({ percent: 24 }).fill, 24);
  assert.strictEqual(meterFor({ percent: 0 }).fill, 0);
  assert.strictEqual(meterFor({ percent: 100 }).fill, 100);
  assert.strictEqual(meterFor({ percent: 140 }).fill, 100);
  assert.strictEqual(meterFor({ percent: null }).fill, 0);
  assert.strictEqual(meterFor({ percent: -5 }).fill, 0);
});

test('isActive is a real boolean, coerced the right way round', () => {
  // Kills `!!w.isActive` -> `!w.isActive` and -> `w.isActive`.
  assert.strictEqual(meterFor({ isActive: true }).isActive, true);
  assert.strictEqual(meterFor({ isActive: 1 }).isActive, true);
  assert.strictEqual(meterFor({ isActive: false }).isActive, false);
  assert.strictEqual(meterFor({ isActive: undefined }).isActive, false);
});

// --- the plain <script> path ---------------------------------------------------
//
// THE ONLY WAY TO REACH THE `else` BRANCH: renderer.js loads this file as a
// <script>, where there is no `module`. `require` never takes that branch, so
// every mutant on the load-path guard used to survive -- and it is the guard whose
// failure took the whole header down once (see the IIFE note at the top of
// app/quota-display.js).
//
// `process` is injected into the context ON PURPOSE. Stryker decides which mutant
// is live by reading process.env.__STRYKER_ACTIVE_MUTANT__ through the global; a
// bare vm context has no `process`, so a mutant in a file evaluated there never
// activates (test/renderer-scope.test.js is blind to it for that reason). The
// real code never touches `process`, so this changes nothing outside a mutation run.

function loadAsScript(sandbox = {}) {
  // The file `require` resolves, evaluated as a script. Resolved rather than named so
  // this reads the code to RUN it, never to assert on its text: instrumentation
  // rewrites that text, which is what test/stryker-config.test.js guards against.
  const src = fs.readFileSync(require.resolve('../app/quota-display'), 'utf8');
  const ctx = vm.createContext({ process, ...sandbox });
  vm.runInContext(src, ctx, { filename: 'quota-display-as-script' });
  return ctx;
}

test('as a plain <script> with a window, it publishes on the WINDOW', () => {
  // Kills `typeof module !== 'undefined' && module.exports` -> true / `||` /
  // `typeof module !== ''` (a ReferenceError: `module` does not exist there),
  // the emptied else block, and `typeof window !== 'undefined'` -> false (which
  // would publish on the context global instead of on the window).
  const w = {};
  const ctx = loadAsScript({ window: w });
  assert.strictEqual(typeof w.quotaDisplay, 'function');
  assert.strictEqual(typeof w.formatQuotaCountdown, 'function');
  assert.strictEqual(w.quotaDisplay(null).state, 'reading');
  assert.strictEqual(w.formatQuotaCountdown('2026-09-15T17:00:00Z', NOW), '1h');
  assert.strictEqual(ctx.quotaDisplay, undefined, 'must not leak onto the global when a window exists');
  // The trap the IIFE exists for (CLAUDE.md): every plain <script> shares ONE
  // global lexical scope, so a top-level `const UNKNOWN` here would make the
  // next script's own `const UNKNOWN` a SyntaxError. A vm context shares that
  // scope across runInContext calls the same way. (Checking ctx.UNKNOWN could
  // never fail -- a top-level const never becomes a property; Dexter PR #73 F3.)
  assert.doesNotThrow(() => vm.runInContext('const UNKNOWN = 1; const quotaDisplay = 2;', ctx),
    'the file leaked a top-level binding into the shared script scope');
});

test('as a plain <script> with no window, it publishes on the global', () => {
  // The other side of `typeof window !== 'undefined'`.
  const ctx = loadAsScript();
  assert.strictEqual(typeof ctx.quotaDisplay, 'function');
  assert.strictEqual(typeof ctx.formatQuotaCountdown, 'function');
});

// --- #42: the header's short wording ("41% · 18:00") ---------------------------------

const { formatResetClock } = require('../app/quota-display');
const pad2 = (n) => String(n).padStart(2, '0');
const localClock = (iso) => { const d = new Date(iso); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

test('formatResetClock: a reset within a day is the local clock time', () => {
  assert.strictEqual(formatResetClock('2026-09-15T17:37:00Z', NOW), localClock('2026-09-15T17:37:00Z'));
  assert.strictEqual(formatResetClock('2026-09-16T15:59:00Z', NOW), localClock('2026-09-16T15:59:00Z'));
});

test('formatResetClock: a reset further out is the short weekday, so the row stays short', () => {
  const iso = '2026-09-19T12:00:00Z';
  const day = new Date(iso).toLocaleDateString('en-US', { weekday: 'short' });
  assert.strictEqual(formatResetClock(iso, NOW), day);
  assert.match(day, /^[A-Z][a-z]{2}$/);
});

test('formatResetClock: no usable time is null (the title says "reset time unknown"), and so is a reset already due', () => {
  for (const bad of [null, undefined, '', 'soon', 'NaN', 42, {}]) assert.strictEqual(formatResetClock(bad, NOW), null, String(bad));
  assert.strictEqual(formatResetClock('2026-09-15T15:00:00Z', NOW), null);
  assert.strictEqual(formatResetClock('2026-09-15T16:00:00Z', NOW), null);
});

test('a meter\'s short wording is "pct · reset"; without a reset it is the percent alone; unknown stays a dash', () => {
  const m = (over) => quotaDisplay(ready([win(over)]), NOW).meters[0];
  assert.strictEqual(m({ percent: 41, resetsAt: '2026-09-15T17:37:00Z' }).short, `41% · ${localClock('2026-09-15T17:37:00Z')}`);
  assert.strictEqual(m({ percent: 41, resetsAt: null }).short, '41%');
  assert.strictEqual(m({ percent: null, resetsAt: '2026-09-15T17:37:00Z' }).short, UNKNOWN, 'no percent, no reset clock beside a dash');
  assert.strictEqual(m({ percent: 0.4, resetsAt: '2026-09-15T17:37:00Z' }).short, `<1% · ${localClock('2026-09-15T17:37:00Z')}`);
});

test('only the binding window carries its reset in the header; the others are the percent (their reset is in the tooltip), so three meters fit', () => {
  const d = quotaDisplay(ready([
    win({ key: 'session', label: '5h', percent: 41, isActive: true, resetsAt: '2026-09-15T17:37:00Z' }),
    win({ key: 'weekly_all', label: 'week', percent: 62, isActive: false, resetsAt: '2026-09-18T12:00:00Z' }),
    win({ key: 'weekly_scoped', label: 'Fable', percent: 18, isActive: false, resetsAt: '2026-09-18T12:00:00Z' }),
  ]), NOW);
  assert.deepStrictEqual(d.meters.map(x => x.short), [`41% · ${localClock('2026-09-15T17:37:00Z')}`, '62%', '18%']);
  assert.match(d.meters[1].title, /resets in 2d/);
});

test('the long wording is still in the tooltip, and "text" is still the percent alone', () => {
  const m = quotaDisplay(ready([win({ percent: 41, resetsAt: '2026-09-15T17:37:00Z' })]), NOW).meters[0];
  assert.strictEqual(m.text, '41%');
  assert.match(m.title, /41% used/);
  assert.match(m.title, /resets in 1h37m/);
});
