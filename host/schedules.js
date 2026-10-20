'use strict';
/**
 * The Schedules panel's model (BACKLOG #119 A7): what will run, when, from which session. Pure, no I/O, no clock of its own.
 *
 * TWO HALVES.
 *
 *   createSessionSchedule({ now })   ONE session's scheduled work, fed by the hook events the host already receives and by nothing
 *       else (nothing polls). `handle(ev) -> changed`, `rows()`, `restore(rows)`. A row is plain JSON:
 *       { id, kind: 'wakeup' | 'loop' | 'bedtime' | 'cron', at (epoch ms | null), cron, recurring, durable, human, prompt, reason, createdAt }
 *
 *   buildView(entries, now)          EVERY session's entry (host/schedules-control.js keeps them in one install-wide file) -> the grouped,
 *       ordered, dimmed list the panel draws: Next hour, Tonight, Later, Recurring, soonest first inside each.
 *
 * WHAT COUNTS (all measured against the tool schemas in the CLI's sdk-tools.d.ts, and ScheduleWakeup against host/bedtime-state.js):
 *   - ScheduleWakeup's PostToolUse (never the Pre: an intent is not a schedule, a failed call fires neither). `{ stop: true }` removes
 *     it, on the Pre or the Post (the bedtime night's rule: a stop has nothing to wait for). A session has ONE pending wakeup, so a new one REPLACES the last. Its time is the result's `scheduledFor` when that is
 *     believable, else now + the delay clamped to the CLI's [60, 3600]. A prompt that starts `/loop` or is the autonomous-loop sentinel
 *     is a `loop`; a bedtime run's own prompt (isBedtimeLoopPrompt) is a `bedtime` night.
 *   - CronCreate's PostToolUse (the result carries the job's `id`, `humanSchedule`, `recurring`, `durable`, `nextFireAt`) and
 *     CronDelete's. Recurring jobs expire after 7 days (the CLI's rule). A recurring job's next run is recomputed at VIEW time from its
 *     expression (host/cron-next.js); a one-shot's single run is fixed at creation. An expression cron-next cannot read has NO time
 *     (the row says "schedule: <raw>"), never a made-up one.
 *   - The wake itself: the CLI replays the scheduled prompt verbatim as a UserPromptSubmit (verify/probe-bedtime-signal.js). That
 *     consumes a wakeup and a fired one-shot; a recurring job stays.
 *   - SessionEnd, and a SessionStart that is not a compaction, clear what dies with the session. A DURABLE cron job survives both (the CLI
 *     persists it to .claude/scheduled_tasks.json), and `restore()` brings only those back after a host restart.
 *   A subagent's events (they carry `agent_id`) never count.
 *
 * KNOWN LIMITS (reviewed, kept): (1) A bedtime night is its wakeup row, so while the woken turn runs (between the wake and its next
 * ScheduleWakeup) the night has no row; the moon chip on the terminal bar covers that stretch, and a row from `night.payload()` alone is
 * the follow-up if it's wanted. (2) Whether the CLI replays a CRON job's prompt verbatim as a UserPromptSubmit was measured for wakeups only
 * (verify/probe-bedtime-signal.js); if a fire is not verbatim, a one-shot shows "due now" for up to 15 minutes after it ran. (3) DST: a
 * fixed-time job counts twice in a fall-back hour and not at all in a spring-forward gap (cron-next.js); whether the CLI agrees is unmeasured.
 *
 * ABSENCE IS NOT A TIME. `Number(null)` is 0 (CLAUDE.md): every numeric read here is a strict typeof check, so "no value" never
 * becomes the epoch or "due now".
 */

const crypto = require('crypto');
const { isBedtimeLoopPrompt } = require('./bedtime-state');
const { nextRun } = require('./cron-next');

const MIN_DELAY_S = 60;
const MAX_DELAY_S = 3600;
const SLACK_MS = 120_000;                  // the CLI rounds scheduledFor to the minute either way
const OVERDUE_MS = 15 * 60_000;            // a wake this far past its time never came (or is not ours to show any more)
const CRON_LIFE_MS = 7 * 86_400_000;       // the CLI auto-expires a recurring job after 7 days
const HOUR_MS = 3_600_000;
const ENDED_STALE_MS = 3 * 60_000;         // a host that has not heartbeated for this long is gone
const ENDED_DROP_MS = 10 * 60_000;         // ...and its rows are dropped this long after it ended
const MAX_ROWS = 50;
const MAX_PROMPT = 500;                    // what a row keeps and every window gets: the hover text. Never the whole prompt (it can hold anything).
const KEY_PROMPT = 2000;                   // how much of a prompt is the wake's IDENTITY (see promptKey)
const LINE_MAX = 200;

const FOOTER = Object.freeze({
  text: 'Routines on claude.ai/code run in the cloud and are not listed here.',
  linkText: 'claude.ai/code',
  url: 'https://claude.ai/code',
});

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const isMain = (p) => !(isStr(p.agent_id) && p.agent_id !== '');
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const clampDelay = (s) => Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, s));

/**
 * A prompt's identity for matching its replay: a hash of its first 2000 characters, whitespace-collapsed. The row stores only 500
 * characters of text (for the hover), so identity can't be the stored text; and BOTH sides are cut the same way, so a prompt longer than
 * the cut still matches its own wake (PR #200 Dexter 6 / Miguel 4).
 */
const promptKey = (text) => crypto.createHash('sha1').update(collapse(String(text)).slice(0, KEY_PROMPT)).digest('hex');   // collapse FIRST, then cut

function kindOfPrompt(prompt) {
  if (isBedtimeLoopPrompt(prompt)) return 'bedtime';
  if (isStr(prompt) && (/^\s*\/loop\b/i.test(prompt) || /^\s*<<autonomous-loop/i.test(prompt))) return 'loop';
  return 'wakeup';
}

const believableScheduledFor = (v, at) => isNum(v) && v >= at && v <= at + MAX_DELAY_S * 1000 + SLACK_MS;

// ---- one session ---------------------------------------------------------------------------------------------------------------

function createSessionSchedule({ now = Date.now } = {}) {
  let rows = [];                                   // newest last; the wakeup row has id 'wakeup'

  const withoutWakeup = () => rows.filter(r => r.id !== 'wakeup');

  function onSchedule(p, at) {
    const input = isObj(p.tool_input) ? p.tool_input : {};
    if (input.stop === true) {
      const had = rows.some(r => r.id === 'wakeup');
      rows = withoutWakeup();
      return had;
    }
    if (!isNum(input.delaySeconds) || !isStr(input.prompt) || input.prompt === '') return false;
    const said = isObj(p.tool_response) ? p.tool_response.scheduledFor : undefined;
    const whenAt = believableScheduledFor(said, at) ? said : at + clampDelay(input.delaySeconds) * 1000;
    rows = [...withoutWakeup(), {
      id: 'wakeup', kind: kindOfPrompt(input.prompt), at: whenAt, cron: null, recurring: false, durable: false, human: null,
      prompt: input.prompt.slice(0, MAX_PROMPT), pk: promptKey(input.prompt), reason: isStr(input.reason) && input.reason !== '' ? input.reason.slice(0, 500) : null, createdAt: at,
    }];
    return true;
  }

  function onCronCreate(p, at) {
    const input = isObj(p.tool_input) ? p.tool_input : {};
    const out = isObj(p.tool_response) ? p.tool_response : {};
    if (!isStr(input.cron) || input.cron.trim() === '') return false;
    const fullPrompt = isStr(input.prompt) ? input.prompt : '';
    const prompt = fullPrompt.slice(0, MAX_PROMPT);
    const recurring = typeof out.recurring === 'boolean' ? out.recurring : input.recurring !== false;
    const durable = typeof out.durable === 'boolean' ? out.durable : input.durable === true;
    const id = isStr(out.id) && out.id !== '' ? out.id : `cron:${input.cron}|${prompt}`;
    // The CLI's own answer wins (PR #200 Dexter 3, r2 N1): nextFireAt is "the job's next run". Measured on three real jobs (*/7, */11, hourly;
    // test/cron-capture*.fixture.jsonl) it is NOT an expression match (the CLI spreads first runs), so a recurring job shows it while it
    // is still ahead and is recomputed from the expression only after it has passed (viewRow); a one-shot takes it for its one run.
    const said = isNum(out.nextFireAt) && out.nextFireAt >= at ? out.nextFireAt : null;
    const computed = nextRun(input.cron, at);
    let whenAt = null;
    if (!recurring) whenAt = said !== null ? said : computed;
    else if (computed === null) whenAt = said;                                       // an expression we cannot read: the CLI's time
    const row = {
      id, kind: 'cron', at: whenAt, cron: input.cron.trim(), recurring, durable, human: isStr(out.humanSchedule) && out.humanSchedule !== '' ? out.humanSchedule : null,
      prompt, pk: promptKey(fullPrompt), reason: null, createdAt: at, nextFireAt: said,
    };
    rows = [...rows.filter(r => r.id !== id), row].slice(-MAX_ROWS);
    return true;
  }

  function onCronDelete(p) {
    const input = isObj(p.tool_input) ? p.tool_input : {};
    const out = isObj(p.tool_response) ? p.tool_response : {};
    const id = isStr(input.id) ? input.id : (isStr(out.id) ? out.id : null);
    if (id === null) return false;
    const before = rows.length;
    rows = rows.filter(r => r.id !== id);
    return rows.length !== before;
  }

  function onPrompt(p) {
    if (!isStr(p.prompt)) return false;
    const text = promptKey(p.prompt);
    const before = rows.length;
    rows = rows.filter(r => {
      if ((isStr(r.pk) ? r.pk : promptKey(r.prompt || '')) !== text) return true;
      if (r.id === 'wakeup') return false;                      // the wake: this wakeup has fired
      return r.kind === 'cron' && r.recurring;                  // a one-shot has fired; a recurring job stays
    });
    return rows.length !== before;
  }

  function dropSessionBound() {
    const before = rows.length;
    rows = rows.filter(r => r.kind === 'cron' && r.durable === true);
    return rows.length !== before;
  }

  function handle(ev) {
    if (!isObj(ev) || !isStr(ev.event)) return false;
    const p = isObj(ev.payload) ? ev.payload : {};
    if (!isMain(p)) return false;
    const at = now();
    switch (ev.event) {
      case 'SessionEnd': return dropSessionBound();
      case 'SessionStart': return p.source === 'compact' ? false : dropSessionBound();
      case 'UserPromptSubmit': return onPrompt(p);
      default: break;
    }
    if (!TOOL_EVENTS.has(ev.event)) return false;
    if (p.tool_name === 'ScheduleWakeup') {
      // Only the Post schedules (a Pre is an intent), but a stop is honoured on either, as host/bedtime-state.js does.
      const stopping = isObj(p.tool_input) && p.tool_input.stop === true;
      return ev.event === 'PostToolUse' || stopping ? onSchedule(p, at) : false;
    }
    if (ev.event !== 'PostToolUse') return false;
    if (p.tool_name === 'CronCreate') return onCronCreate(p, at);
    if (p.tool_name === 'CronDelete') return onCronDelete(p);
    return false;
  }

  /** After a host restart: only what the CLI itself kept (a durable cron job). Anything else in `saved` died with the session. */
  function restore(saved) {
    const back = [];
    for (const r of Array.isArray(saved) ? saved : []) {
      if (!isObj(r) || r.kind !== 'cron' || r.durable !== true || !isStr(r.cron) || !isStr(r.id) || r.id === '') continue;
      back.push({
        id: r.id, kind: 'cron', at: isNum(r.at) ? r.at : null, cron: r.cron, recurring: r.recurring !== false, durable: true,
        human: isStr(r.human) ? r.human : null, prompt: isStr(r.prompt) ? r.prompt.slice(0, MAX_PROMPT) : '',
        pk: isStr(r.pk) ? r.pk : promptKey(isStr(r.prompt) ? r.prompt : ''), reason: null,
        createdAt: isNum(r.createdAt) ? r.createdAt : now(),
        nextFireAt: isNum(r.nextFireAt) ? r.nextFireAt : null,
      });
    }
    rows = back.slice(-MAX_ROWS);
  }

  return { handle, restore, rows: () => rows.map(r => ({ ...r })) };
}

// ---- the list ------------------------------------------------------------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');
const clock = (d) => `${two(d.getHours())}:${two(d.getMinutes())}`;
const dayStart = (ms, plusDays = 0) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays).getTime(); };

/** "23:30", "tomorrow 02:30", "Sat 09:00", "3 Nov 09:00": a clock time as far from now as it is. */
function clockText(at, now) {
  const d = new Date(at);
  const days = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  if (days === 0) return clock(d);
  if (days === 1) return `tomorrow ${clock(d)}`;
  if (days > 1 && days < 7) return `${DAYS[d.getDay()]} ${clock(d)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(d)}`;
}

function inText(delta) {
  if (delta <= 0) return 'due now';
  if (delta < 60_000) return 'in <1 min';
  return `in ${Math.ceil(delta / 60_000)} min`;
}

/** The night the "Tonight" group means: from 18:00 to the next 06:00 local. */
function tonightWindow(now) {
  const d = new Date(now);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (d.getHours() < 6 ? 0 : 1), 6, 0, 0, 0).getTime();
  const endDay = new Date(end);
  const start = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() - 1, 18, 0, 0, 0).getTime();
  return { start, end };
}

const GROUPS = [
  { id: 'next-hour', label: 'Next hour' },
  { id: 'tonight', label: 'Tonight' },
  { id: 'later', label: 'Later' },
  { id: 'recurring', label: 'Recurring' },
];

function firstLine(prompt) {
  const line = String(prompt).split(/\r?\n/).map(s => s.trim()).find(s => s !== '') || '';
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1).trimEnd()}…` : line;
}

function nightDetail(night) {
  if (!isObj(night) || !isNum(night.startedAt)) return null;
  const parts = [`night since ${clock(new Date(night.startedAt))}`];
  if (isNum(night.wakes) && night.wakes > 0) parts.push(`${night.wakes} ${night.wakes === 1 ? 'wake' : 'wakes'}`);
  if (isNum(night.prs) && night.prs >= 0) parts.push(`${night.prs} ${night.prs === 1 ? 'PR' : 'PRs'}`);
  return parts.join(' · ');
}

/**
 * Is this cron row over? A RECURRING job auto-expires 7 days after it was made (the CLI's schema); a one-shot is kept until its run has
 * come and gone (a quarter hour past it), or, with no time to wait for, for a week. Shared by the view and by the file's prune (r2 N3).
 */
function cronExpired(row, now) {
  if (!isObj(row) || row.kind !== 'cron') return false;
  const createdAt = isNum(row.createdAt) ? row.createdAt : now;
  if (row.recurring !== false) return now - createdAt > CRON_LIFE_MS;
  const at = isNum(row.at) ? row.at : null;
  return at !== null ? now > at + OVERDUE_MS : now - createdAt > CRON_LIFE_MS;
}

/** One stored row -> its view, or null when it should not be listed any more. */
function viewRow(entry, row, ended, now) {
  if (!isObj(row) || !isStr(row.id)) return null;
  const kind = ['wakeup', 'loop', 'bedtime', 'cron'].includes(row.kind) ? row.kind : 'wakeup';
  const createdAt = isNum(row.createdAt) ? row.createdAt : now;
  const recurring = kind === 'cron' && row.recurring !== false;
  const cronText = isStr(row.cron) ? row.cron : null;
  const durable = kind === 'cron' && row.durable === true;
  let at = isNum(row.at) ? row.at : null;
  if (kind === 'cron') {
    if (cronExpired({ kind, recurring, createdAt, at }, now)) return null;
    if (recurring) {
      // The CLI's own first time while it is still ahead; after it has passed, the next match of the expression. A job the matcher
      // cannot read has only the CLI's time (null once it has passed).
      if (isNum(row.nextFireAt) && row.nextFireAt > now) at = row.nextFireAt;
      else if (cronText !== null && nextRun(cronText, now) !== null) at = nextRun(cronText, now);
      else at = at !== null && at >= now ? at : null;
    }
  } else {
    if (at === null || now > at + OVERDUE_MS) return null;                             // it should have fired
  }

  const delta = at === null ? null : at - now;
  let group;
  if (delta !== null && delta <= HOUR_MS) group = 'next-hour';
  else if (recurring) group = 'recurring';
  else if (at === null) group = 'later';
  else {
    const w = tonightWindow(now);
    group = at >= w.start && at < w.end ? 'tonight' : 'later';
  }

  let whenText;
  let nextText = null;
  if (recurring && group === 'recurring') {
    if (at === null) whenText = `schedule: ${cronText === null ? '?' : cronText}`;
    else {
      whenText = isStr(row.human) && row.human !== '' ? row.human : `cron ${cronText}`;
      nextText = `next ${clockText(at, now)}`;
    }
  } else if (at === null) {
    whenText = `schedule: ${cronText === null ? '?' : cronText}`;
  } else {
    // a dead session's countdown is noise: it shows the clock time it was due
    whenText = group === 'next-hour' && !ended ? inText(delta) : clockText(at, now);
  }

  const promptFull = isStr(row.prompt) ? row.prompt.trim() : '';
  const reason = isStr(row.reason) && row.reason !== '' ? row.reason : null;
  const session = isStr(entry.label) && entry.label !== '' ? entry.label : 'a session';
  // The hover text is built by the page from promptFull and reason: the prompt travels once (PR #200 Miguel 5).
  return {
    key: `${entry.key}:${row.id}`, id: row.id, sessionKey: entry.key, cwd: isStr(entry.cwd) ? entry.cwd : null, session, kind,
    at, group, whenText, nextText, recurring, promptLine: firstLine(promptFull), promptFull: promptFull.slice(0, MAX_PROMPT), reason,
    detail: kind === 'bedtime' ? nightDetail(row.night) : null,
    // a durable cron job is the CLI's: it fires whether or not this host is alive
    ended, endedText: ended ? (durable ? 'host ended, still scheduled by the CLI' : 'session ended') : null, durable, createdAt,
  };
}

/**
 * `entries` is `{ [key]: { key, cwd, label, updatedAt, endedAt, rows } }`. Returns
 * `{ groups: [{ id, label, rows }], nextHour, footer }`: empty groups left out, rows soonest first (no time last), the live session's
 * Next-hour rows counted in `nextHour` (the rail badge). A session is ENDED when its host said so (`endedAt`) or stopped heartbeating
 * (`updatedAt` older than 3 minutes); its rows are dimmed and dropped 10 minutes after (its durable cron jobs stay, marked).
 */
function buildView(entries, now) {
  const buckets = new Map(GROUPS.map(g => [g.id, []]));
  const seen = new Set();                                                                // a corrupt file may repeat an id: one row each
  const list = isObj(entries) ? Object.values(entries) : [];
  for (const entry of list) {
    if (!isObj(entry) || !Array.isArray(entry.rows)) continue;
    let endedAt = null;
    if (isNum(entry.endedAt)) endedAt = entry.endedAt;
    else if (isNum(entry.updatedAt) && now - entry.updatedAt > ENDED_STALE_MS) endedAt = entry.updatedAt + ENDED_STALE_MS;
    else if (!isNum(entry.updatedAt)) continue;                                          // nothing says it is alive or when it was
    // Ten minutes after it ended a host's rows go, EXCEPT its durable cron jobs: the CLI still fires those (.claude/scheduled_tasks.json).
    const pastDrop = endedAt !== null && now - endedAt > ENDED_DROP_MS;
    const key = isStr(entry.key) ? entry.key : '';
    const e = { ...entry, key };
    for (const row of entry.rows) {
      if (pastDrop && !(isObj(row) && row.kind === 'cron' && row.durable === true)) continue;
      const v = viewRow(e, row, endedAt !== null, now);
      if (v === null || seen.has(v.key)) continue;
      seen.add(v.key);
      buckets.get(v.group).push(v);
    }
  }
  const groups = [];
  let nextHour = 0;
  for (const g of GROUPS) {
    const rows = buckets.get(g.id);
    if (rows.length === 0) continue;
    rows.sort((a, b) => (a.at === null ? Infinity : a.at) - (b.at === null ? Infinity : b.at) || a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (g.id === 'next-hour') nextHour = rows.filter(r => !r.ended).length;
    groups.push({ id: g.id, label: g.label, rows });
  }
  return { groups, nextHour, footer: { ...FOOTER } };
}

module.exports = { createSessionSchedule, buildView, cronExpired, kindOfPrompt, FOOTER, OVERDUE_MS, CRON_LIFE_MS, ENDED_STALE_MS, ENDED_DROP_MS, clockText };
