'use strict';
/**
 * The text of `node scripts/usage-report.js`: the usage counters (host/usage-counters.js) as a table, most used first, with
 * "last used N days ago". Pure: the file read and the clock are the script's.
 *
 *   rowsOf(counters, nowMs)      -> [{ key, count, last, days }]   sorted by count (then key); days null when `last` isn't a date
 *   formatReport(counters, nowMs) -> string
 */

const MS_PER_DAY = 86_400_000;

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

function rowsOf(counters, nowMs) {
  if (!isObject(counters)) return [];
  const rows = [];
  for (const [key, e] of Object.entries(counters)) {
    if (!isObject(e) || !Number.isSafeInteger(e.count) || e.count < 0) continue;
    const at = typeof e.last === 'string' ? Date.parse(e.last) : NaN;
    rows.push({ key, count: e.count, last: Number.isNaN(at) ? null : e.last, days: Number.isNaN(at) ? null : Math.max(0, Math.floor((nowMs - at) / MS_PER_DAY)) });
  }
  return rows.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const agoText = (days) => (days === null ? 'unknown' : days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`);

function formatReport(counters, nowMs) {
  const rows = rowsOf(counters, nowMs);
  if (!rows.length) return 'No usage recorded yet.';
  const keyW = Math.max(3, ...rows.map((r) => r.key.length));
  const countW = Math.max(5, ...rows.map((r) => String(r.count).length));
  const line = (a, b, c) => `${a.padEnd(keyW)}  ${b.padStart(countW)}  ${c}`;
  return [line('key', 'count', 'last used'), ...rows.map((r) => line(r.key, String(r.count), agoText(r.days)))].join('\n');
}

module.exports = { rowsOf, formatReport };
