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
 * THE 12 h CAP ENDS THE RUN (F5). It latches ONLY a run that was still alive when it hit the cap (awake, or asleep
 * with its wake not yet overdue): a night the grace verdict had already ended (idle, overdue) is dropped as that, and
 * a dormant one that nobody revived is dropped at its own limit; neither feeds the latch (PR #99 Dexter r2 F1). The latch
 * then suppresses only THAT run's own loop: its prompts vary every call and carry no run identity, so a call counts as
 * its continuation while it arrives within one wake cycle (the longest delay + the CLI's slack + the grace, 77 min) of the
 * capped run's last sign of life; a later call, or one after a quiet gap, is a new run and clears the latch. The latch
 * also clears on `stop: true`, SessionEnd and a fresh SessionStart.
 *
 * A TURN THAT ENDS WITHOUT A STOP (an interrupt; a usage-limit StopFailure, which is not hooked) is put to sleep by the
 * CLI's own `idle_prompt` Notification (host/turn-state.js reads it the same way). Nothing else is measurable: a
 * session that dies with neither signal stays awake until the 12 h cap, which now drops it WITHOUT latching only if
 * it had already ended; a genuinely stuck-awake run is the one case the latch cannot tell from a live loop.
 *
 * KNOWN LIMIT of the start rule: no token rule on free text separates a bedtime run from a poll that names it
 * (`check whether the bedtime overnight run's PRs are green`, `Bedtime PR check: is #99 merged?`). A `/loop ...` prompt is
 * rejected outright (no real bedtime run is /loop-wrapped: 0 of 161). Closing the rest needs a run identity the skill
 * writes into its prompt and a person never would.
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
// A call after a capped run counts as that run's continuation within one wake cycle of its last sign of life
const CONTINUATION_MS = MAX_DELAY_S * 1000 + SLACK_MS + OVERDUE_MS;

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
  if (/^\s*\/loop\b/i.test(prompt)) return false;          // a /loop wrapper is somebody's poll about the run, not the run
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
  // { startedAt, prompt, nextWakeAt, awake, idleSince, wakes, lastWakeAt, dormant, lastActivity }
  let night = null;
  let capped = null;      // { prompt, lastSeen }: a run that was ALIVE at 12 h; its own loop starts no new night

  // The clock's verdict on a night that is asleep: overdue, or a Stop with nothing scheduled that stayed that way.
  function asleepPastGrace(n, at) {
    if (n.awake) return false;
    if (n.nextWakeAt !== null) return at > n.nextWakeAt + OVERDUE_MS;
    return n.idleSince !== null && at > n.idleSince + OVERDUE_MS;
  }

  // Called before every event: an end the clock already reached becomes STATE, so no later event can undo it.
  function latchEnd(at) {
    if (night === null) return;
    // the grace verdict first: a night that already ended that way ended THEN, whatever the cap says now
    if (!night.dormant && asleepPastGrace(night, at)) {
      if (night.nextWakeAt !== null) night.dormant = true; else { night = null; return; }
    }
    if (at - night.startedAt > MAX_NIGHT_MS) {
      if (!night.dormant) capped = { prompt: night.prompt, lastSeen: night.lastActivity };
      night = null;
    }
  }

  const running = () => night !== null && !night.dormant;

  function applyTool() {
    if (!running()) return;
    night.awake = true;
    night.idleSince = null;
  }

  function schedule(event, p, at) {
    const input = isObj(p.tool_input) ? p.tool_input : {};
    if (input.stop === true) { night = null; capped = null; return; }
    const delay = input.delaySeconds;
    if (!isBedtimeLoopPrompt(input.prompt) || typeof delay !== 'number' || !Number.isFinite(delay)) { applyTool(); return; }
    if (event !== 'PostToolUse') { applyTool(); return; }          // the call's intent: nothing is scheduled yet
    if (capped !== null) {
      if (at - capped.lastSeen <= CONTINUATION_MS) { capped.lastSeen = at; capped.prompt = input.prompt; return; }   // its own loop
      capped = null;                                               // no continuation: a new run
    }
    const said = isObj(p.tool_response) ? p.tool_response.scheduledFor : undefined;
    const believed = believableScheduledFor(said, at);
    if (running()) {
      night.prompt = input.prompt;
      night.nextWakeAt = believed ? said : at + clampDelay(delay) * 1000;
      night.awake = true;
      night.idleSince = null;
    } else if (believed) {
      night = { startedAt: at, prompt: input.prompt, nextWakeAt: said, awake: true, idleSince: null, wakes: 0, lastWakeAt: null, dormant: false, lastActivity: at };
    }
  }

  function apply(event, p, at) {
    if (event === 'SessionEnd' || (event === 'SessionStart' && p.source !== 'compact')) { night = null; capped = null; return; }
    if (TOOL_EVENTS.has(event)) {
      if (p.tool_name === 'ScheduleWakeup' && event !== 'PostToolUseFailure') schedule(event, p, at); else applyTool();
      return;
    }
    if (night === null) {
      // a capped run's replayed wake proves its loop is still going
      if (event === 'UserPromptSubmit' && capped !== null && typeof p.prompt === 'string' && collapse(p.prompt) === collapse(capped.prompt)) capped.lastSeen = at;
      return;
    }
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
    const idle = event === 'Notification' && p.notification_type === 'idle_prompt' && running() && night.awake;
    if ((event === 'Stop' && running()) || idle) {
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
    if (night !== null && !night.dormant) night.lastActivity = at;
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
