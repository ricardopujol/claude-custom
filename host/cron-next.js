'use strict';
/**
 * A small 5-field cron matcher and "when does this next run?" (BACKLOG #119 A7, the Schedules panel).
 *
 * Claude Code's CronCreate takes a standard 5-field expression in LOCAL time ("M H DoM Mon DoW"). The panel shows when it
 * fires next, so this computes it. It understands exactly: `*`, `n`, `a-b`, `a-b/s`, a star with a step, `n/s` and comma lists of those, with
 * Sunday as 0 or 7. Anything else (names, `?`, `L`, `W`, `#`, `@daily`, a wrong field count, a value out of range, a zero step) is
 * REFUSED as null: the panel then shows "schedule: <raw>" rather than a time this file made up.
 *
 * The day rule is Vixie cron's: when BOTH day-of-month and day-of-week are restricted (neither starts with `*`) a day matches if
 * EITHER does; if one is a star, the other alone decides.
 *
 * `nextRun(expr, fromMs)` is the first whole local minute strictly AFTER `fromMs`, or null when the expression can never fire, or does not
 * within 8 years (a Feb 29 that must also be a given weekday can be 28 years away: it reads as "schedule: <raw>", never a wrong date)
 * (31 Feb) or `fromMs` is not a finite number (absence is not the epoch: `Number(null)` is 0). A wall-clock time that does not exist
 * (the hour a spring-forward skips) is skipped; one that exists twice (the hour a fall-back repeats) counts at both instants.
 *
 * Pure: no I/O, no clock. WRAPPING NOT NEEDED: this is a host (Node) module, never a renderer <script>.
 */

const FIELDS = [
  { name: 'min', lo: 0, hi: 59 },
  { name: 'hour', lo: 0, hi: 23 },
  { name: 'dom', lo: 1, hi: 31 },
  { name: 'mon', lo: 1, hi: 12 },
  { name: 'dow', lo: 0, hi: 7 },
];

const INT = /^\d{1,2}$/;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// a leap day on a given weekday can wait 28 years in theory; eight covers every ordinary "Feb 29" and bounds the search
const SEARCH_DAYS = 366 * 8;

/** One comma item -> an array of values, or null. */
function expandItem(item, { lo, hi }) {
  const parts = item.split('/');
  if (parts.length > 2) return null;
  let step = 1;
  if (parts.length === 2) {
    if (!INT.test(parts[1])) return null;
    step = Number(parts[1]);
    if (step < 1) return null;
  }
  const range = parts[0];
  let from;
  let to;
  if (range === '*') { from = lo; to = hi; }
  else if (INT.test(range)) {
    from = Number(range);
    to = parts.length === 2 ? hi : from;                  // "n/s" runs from n to the top; plain "n" is one value
  } else {
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(range);
    if (!m) return null;
    from = Number(m[1]);
    to = Number(m[2]);
  }
  if (from < lo || to > hi || from > to) return null;
  const out = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
}

/** { min, hour, dom, mon, dow: Set<number>, domStar, dowStar } or null. Sunday is 0 in `dow` (7 folds into it). */
function parseCron(expr) {
  if (typeof expr !== 'string') return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === '') return null;
  const sets = {};
  for (let i = 0; i < 5; i++) {
    const f = FIELDS[i];
    const values = new Set();
    for (const item of parts[i].split(',')) {
      if (item === '') return null;
      const got = expandItem(item, f);
      if (got === null) return null;
      for (const v of got) values.add(f.name === 'dow' && v === 7 ? 0 : v);
    }
    sets[f.name] = values;
  }
  return { ...sets, domStar: parts[2].startsWith('*'), dowStar: parts[4].startsWith('*') };
}

function dayMatches(p, year, monthIdx, day, weekday) {
  if (!p.mon.has(monthIdx + 1)) return false;
  const domOk = p.dom.has(day);
  const dowOk = p.dow.has(weekday);
  if (!p.domStar && !p.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

/** Does this (already parsed) expression fire in the local minute of `date`? */
function matches(p, date) {
  if (!p || !(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  return p.min.has(date.getMinutes()) && p.hour.has(date.getHours())
    && dayMatches(p, date.getFullYear(), date.getMonth(), date.getDate(), date.getDay());
}

const sorted = (set) => [...set].sort((a, b) => a - b);

function nextRun(expr, fromMs) {
  if (typeof fromMs !== 'number' || !Number.isFinite(fromMs)) return null;
  const p = typeof expr === 'string' ? parseCron(expr) : expr;
  if (!p) return null;
  const hours = sorted(p.hour);
  const minutes = sorted(p.min);
  const start = new Date(fromMs);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    // Date normalises the day overflow, and a local midnight that does not exist (some zones) lands on the next valid time of day
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12, 0, 0, 0);
    const y = day.getFullYear();
    const mo = day.getMonth();
    const d = day.getDate();
    if (!dayMatches(p, y, mo, d, day.getDay())) continue;
    let best = null;
    for (const h of hours) {
      for (const mi of minutes) {
        const c = new Date(y, mo, d, h, mi, 0, 0);
        if (c.getHours() !== h || c.getMinutes() !== mi) continue;            // in a spring-forward gap: no such time
        const t = c.getTime();
        if (t > fromMs && (best === null || t < best)) best = t;
        // a fall-back repeats this wall-clock time an hour later: that instant matches too
        const again = new Date(t + HOUR_MS);
        if (again.getDate() === d && again.getHours() === h && again.getMinutes() === mi) {
          const t2 = again.getTime();
          if (t2 > fromMs && (best === null || t2 < best)) best = t2;
        }
      }
    }
    if (best !== null) return best;
  }
  return null;
}

module.exports = { parseCron, matches, nextRun, DAY_MS };
