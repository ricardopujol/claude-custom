'use strict';
/**
 * How a quota meter should be DRAWN, given how well it is known.
 *
 * Extracted from renderer.js for the reason app/usage-display.js and
 * app/career-display.js were: a decision living inside a browser script is a
 * decision nothing can test, and this project has already shipped a fix into
 * exactly that kind of region.
 *
 * The rule this whole file exists to keep: a meter at 0% says "you have used
 * nothing". That is a CLAIM, and a false one whenever the truth is "we could
 * not find out". So absence draws no bar at all, and an unknown percentage
 * draws an em dash rather than a number.
 *
 * The plan reports PERCENT ONLY -- `limit_dollars`, `used_dollars` and
 * `remaining_dollars` are null on a Max account. Nothing here converts a
 * percentage into tokens or dollars, and a test asserts that the tooltip never
 * mentions either.
 *
 * WRAPPED IN AN IIFE, and that is not style. The renderer loads these as plain
 * <script> tags, which share ONE global scope -- so a top-level `const UNKNOWN`
 * here collided with the identical one in app/usage-display.js and threw
 * "Identifier 'UNKNOWN' has already been declared", which killed this whole
 * file and left `quotaDisplay` undefined. No unit test can see that: each test
 * requires the module into its own scope, where there is nothing to collide
 * with. It was found by rendering the real header in a real window.
 */

(function (root) {

const UNKNOWN = '—';          // em dash

// STRICTLY a number. `Number(null)` is 0 and so is `Number('')`, so a
// coercing check turns "no value" into a confident zero -- which is the one
// claim this file exists to never make. This is the SECOND time that exact
// coercion produced an absence-reported-as-zero bug in this app on the same
// day (app/career-display.js has the twin), so it is a named helper here
// rather than an inline check waiting to be got wrong a third time.
const finiteOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A percentage the server could not possibly mean. Out of domain is UNKNOWN --
// the module has that state -- not a number drawn confidently with a healthy
// tone. (Over 100 IS drawn, clamped: a server reporting 140% is saying
// something real about being over the limit.)
const percentOrNull = v => { const n = finiteOrNull(v); return n === null || n < 0 ? null : n; };

// Colour thresholds for a window the API calls "normal". The account's own
// `severity` outranks these whenever it is anything else: a scoped window can
// be throttled at a percentage that looks harmless from here, and the server
// knows things the client does not.
const WARN_AT = 80;
const CRITICAL_AT = 95;

function formatPercent(pct) {
  if (pct > 0 && pct < 1) return '<1%';
  if (pct > 99 && pct < 100) return '>99%';
  return `${Math.round(pct)}%`;
}

function toneFor(w) {
  if (!w) return 'unknown';
  if (w.lockedReason) return 'critical';           // it has already stopped working
  const sev = String(w.severity || 'normal').toLowerCase();
  if (sev === 'critical' || sev === 'severe') return 'critical';
  if (sev === 'warning' || sev === 'warn') return 'warn';
  const pct = percentOrNull(w.percent);
  if (pct === null) return 'unknown';
  if (pct >= CRITICAL_AT) return 'critical';
  if (pct >= WARN_AT) return 'warn';
  return 'normal';
}

/**
 * Time remaining until a reset, as something you can read at a glance.
 *
 * A raw "resets 17:37Z" makes you do arithmetic while watching a bar fill up,
 * which is the moment you least want to. A reset already in the past reads as
 * `due` rather than as a negative number -- the window is rolling over and the
 * next read will show it.
 */
function formatCountdown(resetsAt, now = Date.now()) {
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return UNKNOWN;
  const ms = at - now;
  if (ms <= 0) return 'due';
  const mins = Math.floor(ms / 60000);
  // "resets in 0m" is the same self-contradicting zero the sibling module
  // refuses for minutes worked.
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const m = mins % 60;
    return m ? `${hours}h${m}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days}d${h}h` : `${days}d`;
}

/**
 * The reset as the header shows it (#42): the local clock time when it is within a day, the short weekday beyond, null when
 * there is no usable future time (the tooltip says "reset time unknown" / "resetting now" instead).
 */
function formatResetClock(resetsAt, now = Date.now()) {
  if (typeof resetsAt !== 'string') return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const d = new Date(at);
  if (at - now < 24 * 3600000) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}

/**
 * @param quota the `{ ok, state, windows, error }` payload from host/quota.js
 * @param now   injected so the countdown is testable
 *
 * Returns `{ state, note, meters }` where `state` is:
 *
 *   reading  nothing has been read yet. A number here would be invented.
 *   absent   the read failed. We know NOTHING -- so no bars, and a note
 *            saying why rather than three bars sitting confidently at zero.
 *   none     the read WORKED and the server listed no limits. Still no bars,
 *            but the note must not say the read failed (Dexter, PR #73 F1).
 *   ready    draw the meters.
 */
function quotaDisplay(quota, now = Date.now()) {
  if (!quota) {
    return { state: 'reading', note: 'reading account limits…', meters: [] };
  }
  // Only `ok: true` makes an empty list mean "none": host/quota.js sends
  // `windows: []` on every failure too.
  if (quota.ok === true && Array.isArray(quota.windows) && quota.windows.length === 0) {
    return { state: 'none', note: 'no usage limits reported', meters: [] };
  }
  if (quota.ok === false || !Array.isArray(quota.windows) || quota.windows.length === 0) {
    const why = quota.error ? String(quota.error) : 'could not read account limits';
    return { state: 'absent', note: why, meters: [] };
  }

  const meters = quota.windows.map((w) => {
    const pct = percentOrNull(w.percent);
    const countdown = formatCountdown(w.resetsAt, now);
    const parts = [
      `${w.label}: ${pct === null ? 'unknown' : formatPercent(pct) + ' used'}`,
      countdown === UNKNOWN ? 'reset time unknown' : (countdown === 'due' ? 'resetting now' : `resets in ${countdown}`),
    ];
    if (w.isActive) parts.push('currently the binding limit');
    if (w.lockedReason) parts.push(`LOCKED: ${w.lockedReason}`);
    return {
      key: w.key,
      label: w.label,
      percent: pct,
      // What goes in the bar's own text. An unknown percentage is an em dash,
      // never a zero.
      // `0%` claims "you have used nothing" and `100%` claims "you are out".
      // Rounding 0.4 and 99.6 into them makes the meter say the two things this
      // file exists to never say falsely. The twin module reached the same
      // answer for `<1m`, on the same day, for the same reason.
      text: pct === null ? UNKNOWN : formatPercent(pct),
      // The header's wording (#42): "41% · 18:00", the reset on the binding window only so three meters fit a 1200px header. The tooltip (`title`) keeps the long form.
      short: pct === null ? UNKNOWN : (!w.isActive || formatResetClock(w.resetsAt, now) === null ? formatPercent(pct) : `${formatPercent(pct)} · ${formatResetClock(w.resetsAt, now)}`),
      // How full to draw the bar. Clamped, because a server that ever reports
      // over 100 should overflow the meaning, not the layout.
      fill: pct === null ? 0 : Math.max(0, Math.min(100, pct)),
      tone: toneFor(w),
      countdown,
      isActive: !!w.isActive,
      title: parts.join(' · '),
    };
  });

  return { state: 'ready', note: null, meters };
}

// Loaded two ways: require() from tests, and a plain <script> tag in the
// renderer, which has no module system at all.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { quotaDisplay, formatResetClock, formatCountdown, formatPercent, toneFor, UNKNOWN, WARN_AT, CRITICAL_AT };
} else {
  root.quotaDisplay = quotaDisplay;
  // The warning flourish needs the countdown too, and a second implementation
  // of it in renderer.js is a second definition free to drift from this one.
  root.formatQuotaCountdown = formatCountdown;
}

})(typeof window !== 'undefined' ? window : globalThis);
