'use strict';
/**
 * Is this session in a /bedtime night, and when does it wake next? (backlog #52,
 * documentation/DESIGN_TERMINAL_BAR.md "Bedtime".) Fed by the hooks Claude Code itself fires, and by nothing
 * else. The rule is the one verify/probe-bedtime-signal.js MEASURED (a real interactive CLI run, plus 158
 * ScheduleWakeup calls read out of real overnight transcripts), which is not the one the design first guessed:
 *
 *   START      a main-session ScheduleWakeup whose `prompt` names the word `bedtime`. NOT "the session's first
 *              ScheduleWakeup": one in five real ones is a /loop poll or a `<<autonomous-loop-dynamic>>` tick, and not
 *              a typed `/bedtime` either: that opens the supervised checkpoint chat, and the autonomous half
 *              starts at the skill's Step 6 ScheduleWakeup. (A bedtime loop's prompt starts with "/bedtime" in
 *              103 of 127 real ones; the rest reword it, "Continue the /bedtime autonomous run", so it is the
 *              word anywhere, not a prefix.)
 *   NEXT WAKE  the PostToolUse's `tool_response.scheduledFor` (the CLI's own answer: call time + delaySeconds,
 *              rounded to the minute either way: -47..+63 s over 157 real calls), else call time + delaySeconds clamped to the CLI's [60, 3600].
 *   WAKE       a UserPromptSubmit whose prompt is the scheduled one (the CLI replays it verbatim, about a second
 *              after scheduledFor; or one that names bedtime, in case a slash prompt comes back expanded). It
 *              consumes the schedule: awake, no next wake, until the turn schedules again.
 *   END        ScheduleWakeup `{ stop: true }`; SessionEnd; a fresh SessionStart (a compaction isn't one);
 *              OVERDUE_MS past a wake that never came; a turn that STOPPED with nothing scheduled and stayed
 *              that way OVERDUE_MS; MAX_NIGHT_MS from the start (the skill's budget is ~8 h).
 *
 * A subagent's events (they carry `agent_id`) never count. Overdue is only judged while the session is ASLEEP:
 * a woken turn that runs for hours, or the person typing ahead of a queued wake, is a live session. Overdue is
 * a VIEW, not a state change, so a late wake (evidence) brings the night back; the 12 h cap is a state change,
 * so a wake never revives a night that old (a new bedtime ScheduleWakeup starts a new one).
 *
 *   createBedtime({ now }) -> { handle(event) -> changed, view(atMs) -> {...} | null, snapshot() }
 *   view: { startedAt, nextWakeAt|null, awake, wakes, lastWakeAt|null }  (null = no night; absence, not a guess)
 *
 * Host restarted mid-night: unknown until the next bedtime ScheduleWakeup (one wake cycle). Logged by nobody:
 * the chip is simply absent, never stale.
 */

const OVERDUE_MS = 15 * 60_000;
const MAX_NIGHT_MS = 12 * 3600_000;
const MIN_DELAY_S = 60;
const MAX_DELAY_S = 3600;
// scheduledFor is believed when it lies between now and the longest delay plus the runtime's rounding slack
const SLACK_MS = 120_000;

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const isMain = (p) => !(typeof p.agent_id === 'string' && p.agent_id !== '');
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/** Does this loop prompt name bedtime? The word, any case, anywhere: not "bedtimes", not "overbedtime". */
function mentionsBedtime(prompt) {
  return typeof prompt === 'string' && /\bbedtime\b/i.test(prompt);
}

const clampDelay = (s) => Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, s));

function believableScheduledFor(v, at) {
  return typeof v === 'number' && Number.isFinite(v) && v >= at && v <= at + MAX_DELAY_S * 1000 + SLACK_MS;
}

const fresh = () => null;

function createBedtime({ now = Date.now } = {}) {
  let night = fresh();   // { startedAt, prompt, nextWakeAt, awake, idleSince, wakes, lastWakeAt }

  function applyScheduleWakeup(event, p, at) {
    const input = isObj(p.tool_input) ? p.tool_input : {};
    if (input.stop === true) { night = fresh(); return; }
    const delay = input.delaySeconds;
    if (mentionsBedtime(input.prompt) && typeof delay === 'number' && Number.isFinite(delay)) {
      const estimate = at + clampDelay(delay) * 1000;
      const said = event === 'PostToolUse' && isObj(p.tool_response) ? p.tool_response.scheduledFor : undefined;
      if (night === null) night = { startedAt: at, prompt: input.prompt, nextWakeAt: null, awake: true, idleSince: null, wakes: 0, lastWakeAt: null };
      night.prompt = input.prompt;
      night.nextWakeAt = believableScheduledFor(said, at) ? said : estimate;
      night.awake = true;
      night.idleSince = null;
      return;
    }
    applyTool();     // a poll or an unreadable call: still the session working, never a start
  }

  function applyTool() {
    if (night === null) return;
    night.awake = true;
    night.idleSince = null;
  }

  function apply(event, p, at) {
    if (event === 'SessionEnd' || (event === 'SessionStart' && p.source !== 'compact')) { night = fresh(); return; }
    if (TOOL_EVENTS.has(event)) {
      if (p.tool_name === 'ScheduleWakeup' && event !== 'PostToolUseFailure') applyScheduleWakeup(event, p, at);
      else applyTool();
      return;
    }
    if (night === null) return;
    if (event === 'UserPromptSubmit') {
      const text = typeof p.prompt === 'string' ? p.prompt : '';
      const isWake = text !== '' && (collapse(text) === collapse(night.prompt) || mentionsBedtime(text));
      night.awake = true;
      night.idleSince = null;
      if (isWake) { night.wakes += 1; night.lastWakeAt = at; night.nextWakeAt = null; }
      return;
    }
    if (event === 'Stop') {
      night.awake = false;
      night.idleSince = night.nextWakeAt === null ? at : null;
    }
  }

  function handle(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.event !== 'string') return false;
    const p = isObj(ev.payload) ? ev.payload : {};
    if (!isMain(p)) return false;
    const at = now();
    const before = JSON.stringify(night);
    if (night !== null && at - night.startedAt > MAX_NIGHT_MS) night = fresh();
    apply(ev.event, p, at);
    return JSON.stringify(night) !== before;
  }

  function view(at = now()) {
    if (night === null || at - night.startedAt > MAX_NIGHT_MS) return null;
    if (!night.awake) {
      if (night.nextWakeAt !== null && at > night.nextWakeAt + OVERDUE_MS) return null;
      if (night.nextWakeAt === null && night.idleSince !== null && at > night.idleSince + OVERDUE_MS) return null;
    }
    return { startedAt: night.startedAt, nextWakeAt: night.nextWakeAt, awake: night.awake, wakes: night.wakes, lastWakeAt: night.lastWakeAt };
  }

  return { handle, view, snapshot: () => (night === null ? null : { ...night }) };
}

module.exports = { createBedtime, mentionsBedtime, OVERDUE_MS, MAX_NIGHT_MS };
