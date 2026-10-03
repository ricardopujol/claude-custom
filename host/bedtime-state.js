'use strict';
/**
 * Is this session in a /bedtime night, and when does it wake next? (backlog #52,
 * documentation/DESIGN_TERMINAL_BAR.md "Bedtime".) Fed by the hooks Claude Code itself fires, and by nothing
 * else. The rule is the one verify/probe-bedtime-signal.js MEASURED (a real interactive CLI run, plus every
 * ScheduleWakeup call read out of real overnight transcripts), which is not the one the design first guessed:
 *
 *   START      a main-session ScheduleWakeup that SUCCEEDED (its PostToolUse carries a believable `scheduledFor`)
 *              and whose `prompt` is a bedtime loop's (isBedtimeLoopPrompt). Never on the PreToolUse alone (a call
 *              that is then refused or fails would leave a phantom night), NOT "the session's first ScheduleWakeup"
 *              (one in five real ones is a /loop poll or a `<<autonomous-loop-dynamic>>` tick), and not a typed
 *              `/bedtime` (that opens the supervised checkpoint chat; the autonomous half starts at the skill's Step 6).
 *   NEXT WAKE  the PostToolUse's `tool_response.scheduledFor` (the CLI's own answer: call time + delaySeconds,
 *              rounded to the minute either way), else, for a night that is already running, call time +
 *              delaySeconds clamped to the CLI's [60, 3600].
 *   WAKE       a UserPromptSubmit whose prompt EXACTLY equals the last ScheduleWakeup's (the CLI replays it
 *              verbatim, about a second after scheduledFor). A typed prompt is never a wake, even one that says
 *              "bedtime". It consumes the schedule: awake, no next wake, until the turn schedules again.
 *   END        ScheduleWakeup `{ stop: true }`; SessionEnd; a fresh SessionStart (a compaction isn't one);
 *              OVERDUE_MS past a wake that never came; a turn that STOPPED with nothing scheduled and stayed
 *              that way OVERDUE_MS; MAX_NIGHT_MS from the start.
 *
 * AN ENDED NIGHT STAYS ENDED, IN THE STATE, not only in the view (PR #99 Dexter F1): the end is latched by the
 * next event that sees it (so a person typing at 08:00 into a run that stopped rescheduling at 05:00 doesn't
 * get "overnight - working" back). Nothing but a new bedtime ScheduleWakeup starts a night again, with ONE
 * exception: a night that went overdue while a wake was still pending is dormant, not gone, and only the exact
 * scheduled prompt replayed (a late wake after the PC slept) wakes it. Nothing is pending after a Stop with
 * nothing scheduled, so that one is gone for good.
 *
 * THE 12 h CAP ENDS THE RUN (F5). It also latches: a loop that is still scheduling after the cap starts no new
 * night, because its prompts vary every call and carry no run identity to tell a continuation from a new run.
 * The latch clears on `stop: true`, SessionEnd and a fresh SessionStart; a bedtime ScheduleWakeup after that is a
 * new night.
 *
 * A subagent's events (they carry `agent_id`) never count. Overdue is only judged while the session is ASLEEP: a
 * woken turn that runs for hours, or the person typing ahead of a queued wake, is a live session.
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

/**
 * Is this ScheduleWakeup prompt a bedtime run's own? Measured on every ScheduleWakeup call in this machine's real
 * transcripts (162): the `/bedtime` command token anywhere (`/bedtime overnight run`, `Continue the /bedtime
 * autonomous run`), the word leading the prompt (`bedtime - overnight run`), or the skill's own phrase (`the bedtime
 * overnight run`, older `bedtime protocol run`). NOT the word anywhere: `/loop 5m run the bedtime-state tests` and
 * `check whether the bedtime PR merged` are polls about a feature, not a night (PR #99 Dexter F2).
 */
function isBedtimeLoopPrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  return /(^|[\s("'])\/bedtime(?![\w-])/i.test(prompt)
    || /^\s*bedtime(?![\w-])/i.test(prompt)
    || /\bbedtime (?:overnight|autonomous|protocol) run\b/i.test(prompt);
}

/**
 * A ScheduleWakeup's PreToolUse / PostToolUse: the events only the bedtime matcher asked for. The host feeds them
 * to the night and goes no further: the mood engine would read the tool as work, and the Running panel would show
 * a ScheduleWakeup as a process (its Post is hooked, but it is not a command that runs).
 */
function isBedtimeOnly(ev) {
  return !!ev && typeof ev === 'object' && (ev.event === 'PreToolUse' || ev.event === 'PostToolUse')
    && isObj(ev.payload) && ev.payload.tool_name === 'ScheduleWakeup';
}

const clampDelay = (s) => Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, s));

function believableScheduledFor(v, at) {
  return typeof v === 'number' && Number.isFinite(v) && v >= at && v <= at + MAX_DELAY_S * 1000 + SLACK_MS;
}

function createBedtime({ now = Date.now } = {}) {
  // { startedAt, prompt, nextWakeAt, awake, idleSince, wakes, lastWakeAt, dormant }
  let night = null;
  let capped = false;     // the 12 h cap ended a run: no new night until stop / SessionEnd / SessionStart

  // The clock's verdict on a night that is asleep: overdue, or a Stop with nothing scheduled that stayed that way.
  function asleepPastGrace(n, at) {
    if (n.awake) return false;
    if (n.nextWakeAt !== null) return at > n.nextWakeAt + OVERDUE_MS;
    return n.idleSince !== null && at > n.idleSince + OVERDUE_MS;
  }

  // Called before every event: an end the clock already reached becomes STATE, so no later event can undo it.
  function latchEnd(at) {
    if (night === null) return;
    if (at - night.startedAt > MAX_NIGHT_MS) { night = null; capped = true; return; }
    if (night.dormant || !asleepPastGrace(night, at)) return;
    if (night.nextWakeAt !== null) night.dormant = true; else night = null;
  }

  const running = () => night !== null && !night.dormant;

  function applyTool() {
    if (!running()) return;
    night.awake = true;
    night.idleSince = null;
  }

  function schedule(event, p, at) {
    const input = isObj(p.tool_input) ? p.tool_input : {};
    if (input.stop === true) { night = null; capped = false; return; }
    const delay = input.delaySeconds;
    if (!isBedtimeLoopPrompt(input.prompt) || typeof delay !== 'number' || !Number.isFinite(delay)) { applyTool(); return; }
    if (event !== 'PostToolUse') { applyTool(); return; }          // the call's intent: nothing is scheduled yet
    if (capped) return;                                            // a capped run's loop never starts a new night
    const said = isObj(p.tool_response) ? p.tool_response.scheduledFor : undefined;
    const believed = believableScheduledFor(said, at);
    if (running()) {
      night.prompt = input.prompt;
      night.nextWakeAt = believed ? said : at + clampDelay(delay) * 1000;
      night.awake = true;
      night.idleSince = null;
    } else if (believed) {
      night = { startedAt: at, prompt: input.prompt, nextWakeAt: said, awake: true, idleSince: null, wakes: 0, lastWakeAt: null, dormant: false };
    }
  }

  function apply(event, p, at) {
    if (event === 'SessionEnd' || (event === 'SessionStart' && p.source !== 'compact')) { night = null; capped = false; return; }
    if (TOOL_EVENTS.has(event)) {
      if (p.tool_name === 'ScheduleWakeup' && event !== 'PostToolUseFailure') schedule(event, p, at); else applyTool();
      return;
    }
    if (night === null) return;
    if (event === 'UserPromptSubmit') {
      const text = typeof p.prompt === 'string' ? p.prompt : '';
      const isWake = night.nextWakeAt !== null && collapse(text) === collapse(night.prompt);
      if (night.dormant) {
        if (!isWake) return;                                       // only the scheduled prompt replayed revives it
        night.dormant = false;
      }
      night.awake = true;
      night.idleSince = null;
      if (isWake) { night.wakes += 1; night.lastWakeAt = at; night.nextWakeAt = null; }
      return;
    }
    if (event === 'Stop' && running()) {
      night.awake = false;
      night.idleSince = night.nextWakeAt === null ? at : null;
    }
  }

  function handle(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.event !== 'string') return false;
    const p = isObj(ev.payload) ? ev.payload : {};
    if (!isMain(p)) return false;
    const at = now();
    const before = JSON.stringify([night, capped]);
    latchEnd(at);
    apply(ev.event, p, at);
    return JSON.stringify([night, capped]) !== before;
  }

  function view(at = now()) {
    if (night === null || night.dormant || at - night.startedAt > MAX_NIGHT_MS || asleepPastGrace(night, at)) return null;
    return { startedAt: night.startedAt, nextWakeAt: night.nextWakeAt, awake: night.awake, wakes: night.wakes, lastWakeAt: night.lastWakeAt };
  }

  return { handle, view, snapshot: () => (night === null ? null : { ...night }) };
}

module.exports = { createBedtime, isBedtimeLoopPrompt, isBedtimeOnly, OVERDUE_MS, MAX_NIGHT_MS };
