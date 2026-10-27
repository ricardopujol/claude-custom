'use strict';
/**
 * What the host reads out of Claude Code's hook payloads, written down.
 *
 * Every entry here is an assumption about somebody else's data. `tool_name` was
 * one: the host read "Task", Claude Code sends "Agent", and the roster stayed
 * empty through a green test suite, two passing probes and a screenshot --
 * because each fixture supplied the shape it expected and then confirmed the
 * code understood that shape.
 *
 * So the fixtures cannot be the check. This file is the list of reads;
 * verify/probe-payloads.js drives the REAL CLI and compares what arrives
 * against it. A field that is renamed upstream then shows up as a failing
 * probe, rather than as a feature that quietly stops doing anything.
 *
 * `used` is not decoration. A field with no recorded consumer cannot be judged
 * when it disappears -- broken feature, or leftover nobody reads?
 */

// Tool names that mean "a subagent is being launched". Claude Code calls it
// Agent; older versions called it Task. This is the exact field that moved.
const AGENT_TOOLS = ['Agent', 'Task'];

// hooks.md's "common input fields". permission_mode is present on every
// hooked event but SessionEnd (measured 2026-09-23 and 2026-09-25), so it is
// spread into every entry below rather than listed once and hoped for. It is
// read only as a HANDSHAKE fallback (see host.js) -- the TUI scrape in
// host/mode.js remains authoritative once it has drawn anything, by design.
//
// NOT required, though read: `effort.level`, FF12's truth source for a pending
// /effort switch. It is ABSENT on every event when the model has no effort
// levels -- measured on `--model haiku` (test/hooks-real-subagent-failure
// .fixture.jsonl) -- and host/hook-session.js reads that absence as "no effort",
// not as a missing field.
const COMMON_FIELDS = {
  permission_mode: {
    used: 'host.js -> hello handshake fallback for the mode badge, before the '
        + 'TUI has drawn a status line for host/mode.js to scrape',
  },
};

const CONTRACT = {
  SessionStart: {
    fields: {
      session_id: { used: 'host.js -> usage.js, to read this session\'s transcript for token spend' },
      ...COMMON_FIELDS,
    },
  },
  PreToolUse: {
    agentTools: AGENT_TOOLS,
    fields: {
      tool_name: { used: 'mood-machine.js, to tell an agent launch from any other tool' },
      'tool_input.subagent_type': {
        used: 'mood-machine.js + portraits.js, the agent identity the roster renders',
        onlyWhen: p => AGENT_TOOLS.includes(p && p.tool_name),
      },
      'tool_input.prompt': {
        used: 'loadout-hook.js, the prompt a Method item prepends its instruction to (BACKLOG #17)',
        onlyWhen: p => AGENT_TOOLS.includes(p && p.tool_name),
      },
      'tool_input.command': {
        used: 'processes.js, the label shown in the Running panel; agent-occupancy.js, which worktree a subagent command names (#44 + #47)',
        onlyWhen: p => (p && p.tool_name) === 'Bash',
      },
      // Worktree occupancy (#44 + #47). MEASURED against the real CLI by verify/probe-occupancy-payloads.js
      // (claude 2.1.x, haiku): a subagent's Read, Edit and Write each fire PreToolUse under the occupancy
      // matcher with `agent_id` + `agent_type` and an absolute `tool_input.file_path`; the agent_id is the one
      // SubagentStop carries; a main-session call carries no agent_id. NOT measured: NotebookEdit's
      // `notebook_path` (its documented field).
      // A TEAMMATE (verify/probe-teammate-occupancy.js, interactive CLI): the same fields, with agent_id
      // `a<name>-<hex>` and its NAME as agent_type. Grep and Glob carry the searched folder as an absolute
      // `tool_input.path` WHEN ONE IS GIVEN (measured with forward slashes: `C:/Users/...`); it is optional, so
      // it is not a contracted field here.
      // Also read, but not required here: `session_id`. agent-occupancy.js names it in a subagent's claim so a hub
      // card matches its OWN session's run (#57); every real capture carries it, a subagent's calls with the main
      // session's own id (test/agent-occupancy.test.js MEASURED). Absent, the claim names no session (no card).
      'tool_input.file_path': {
        used: 'agent-occupancy.js, the worktree a subagent Read, Edit or Write is in (#44 + #47)',
        onlyWhen: p => ['Read', 'Edit', 'Write'].includes(p && p.tool_name),
      },
      // The bedtime night (#52). MEASURED against a real interactive CLI by verify/probe-bedtime-signal.js
      // --capture (2.1.288, haiku): a ScheduleWakeup call is { delaySeconds, reason, prompt, noop }, or { stop: true }
      // alone, and carries no agent_id on the main session's call.
      'tool_input.delaySeconds': {
        used: 'bedtime-state.js, the clamped fallback for a running night\'s next wake when the result carries no believable scheduledFor',
        onlyWhen: p => !!p && p.tool_name === 'ScheduleWakeup' && !(p.tool_input && p.tool_input.stop === true),
      },
      // (The Schedules panel reads CronCreate / CronDelete on the PostToolUse only: a Pre is an intent, so nothing is required of it here.)
      ...COMMON_FIELDS,
    },
  },
  PostToolUse: {
    agentTools: AGENT_TOOLS,
    fields: {
      tool_name: { used: 'processes.js, to close the running entry this completes' },
      tool_response: { used: 'mood-machine.js isFailure(), which decides stressed vs happy' },
      // MEASURED by verify/probe-bedtime-signal.js --capture: a ScheduleWakeup's result is { scheduledFor (epoch ms,
      // the CLI's own answer, rounded to the minute), clampedDelaySeconds, wasClamped }; a stop call's has none.
      'tool_response.scheduledFor': {
        used: 'bedtime-state.js, the night\'s next wake, shown on the bedtime chip (#52)',
        onlyWhen: p => !!p && p.tool_name === 'ScheduleWakeup' && !(p.tool_input && p.tool_input.stop === true),
      },
      // The Schedules panel (BACKLOG #119 A7). MEASURED with a real `claude -p` run (2.1.304, haiku; test/cron-capture.fixture.jsonl): CronCreate
      // is { tool_input: { cron, prompt, recurring, durable }, tool_response: { id, humanSchedule, recurring, durable, nextFireAt } } and CronDelete
      // { tool_input: { id }, tool_response: { id } }. recurring, durable, humanSchedule and nextFireAt are optional by the schema, so not required.
      'tool_input.cron': {
        used: 'schedules.js, the cron expression whose next run the Schedules panel computes',
        onlyWhen: p => !!p && p.tool_name === 'CronCreate',
      },
      'tool_input.id': {
        used: 'schedules.js, the cron job a CronDelete removes from the Schedules panel',
        onlyWhen: p => !!p && p.tool_name === 'CronDelete',
      },
      // CronCreate's result: the id is what a CronDelete names.
      'tool_response.id': {
        used: 'schedules.js, the key of a cron job in the Schedules panel',
        onlyWhen: p => !!p && p.tool_name === 'CronCreate',
      },
      ...COMMON_FIELDS,
    },
    // Also read, but legitimately ABSENT on a main-session call, so it cannot
    // be a required field here: agent_id, the owner processes.js ends a call
    // with when its subagent stops. verify/probe-failure-payloads.js checks it
    // arrives on a subagent's calls and matches that subagent's SubagentStop.
    //
    // Also read by mood-machine.js (backlog #7), optional by nature:
    //   agent_id / agent_type -- which invocation made the call, so activity
    //     keeps THAT run and its parents alive, not every running agent;
    //   tool_use_id + tool_response.agentId on the Agent tool's own result --
    //     the only field that joins a spawn to the subagent's agent_id.
    //     Measured shapes: background { isAsync: true, status:
    //     "async_launched", agentId } at once; foreground { status:
    //     "completed", agentId } at the end. Absent on older CLIs and on
    //     truncated captures, so the machine falls back to binding a new
    //     agent_id to the oldest unbound invocation of its type;
    //   a NAMED TEAMMATE's spawn result (Agent with `name`, in an
    //     interactive session; measured 2026-10-03 from a transcript's
    //     toolUseResult, the hook's tool_response is assumed equal):
    //     { status: "teammate_spawned", agent_id: "<name>@<team>", teammate_id,
    //       agent_type, name, team_name, ... } -- snake_case `agent_id`, an
    //     ADDRESS and not the id the teammate's own events carry (its runtime
    //     id is "a<name>-<16 hex>", unmeasured at hook level). No
    //     run_in_background in its input. A named Agent call under
    //     `claude -p` instead returns async_launched (captured:
    //     test/hooks-real-named-agent.fixture.jsonl);
    //   tool_response.interrupted -- that call was killed; never a failure,
    //     and the run continues. Never yet observed true (32,137 real Bash
    //     results, all false, 2026-09-27); cancellation is
    //     PostToolUseFailure.is_interrupt;
    //   on SendMessage's result: tool_response.success, .resumedAgentId (the
    //     ended run it RESUMED) and .pin.id (the run it was queued for) --
    //     the run a message brought back, named by id however `to` said it.
    //     Measured 2026-09-29 on 2.1.285 by verify/probe-resume-queued-message.js,
    //     which is also the check if they move (probe-payloads.js sends none).
  },
  // A failed call fires this INSTEAD of PostToolUse. Measured 2026-09-25.
  PostToolUseFailure: {
    fields: {
      tool_name: { used: 'processes.js label fallback + mood-machine.js attribution' },
      tool_use_id: { used: 'processes.js, to close the running entry this failure ends' },
      is_interrupt: { used: 'mood-machine.js: an Esc interrupt is not the agent failing' },
      ...COMMON_FIELDS,
    },
    // agent_id / agent_type: read by mood-machine.js to credit the failing
    // subagent; ABSENT on a main-session call, so not required here.
  },
  SubagentStop: {
    fields: {
      agent_type: {
        used: 'mood-machine.js + cooldowns, to credit the agent that ACTUALLY '
            + 'finished rather than the top of the delegation stack',
      },
      agent_id: { used: 'processes.js, to end every call that subagent still has open; '
                      + 'mood-machine.js, to end THAT invocation and its foreground children' },
      // MEASURED by verify/probe-teammate-occupancy.js (interactive CLI, 2026-10-03): present on a teammate's
      // and a plain subagent's SubagentStop alike; the .meta.json beside it says `taskKind`.
      agent_transcript_path: {
        used: 'occupancy-producer.js teammateFromMeta: the .meta.json beside it says whether the agent that '
            + 'stopped is an in_process_teammate (idle, its claim stays) or a subagent that finished',
      },
      ...COMMON_FIELDS,
    },
    // Also arrives, unread for now, and worth knowing about:
    //   last_assistant_message -- what the agent concluded; would make the
    //                       "finished" notification say what it finished.
  },
  Stop: {
    fields: { ...COMMON_FIELDS },   // otherwise: the turn ended, which is the whole message
    // Also read, optional: background_tasks [{ id: <agent_id>, agent_type,
    // description, status }]. mood-machine.js ends the main session's
    // FOREGROUND runs on Stop and spares the ones listed here -- measured,
    // Stop fires while a background agent is still running
    // (test/hooks-real-subagent-failure.fixture.jsonl). attention.js holds
    // "finished" back while one of them runs.
  },
  UserPromptSubmit: {
    // The event itself opens the MAIN session's turn (host/turn-state.js, which the Git drawer's Type /merged
    // waits on, PR #93 Dexter F1). `prompt` (the person's own words) is read by host/prompt-keeper.js for the
    // terminal bar's "last prompt" (#49), and by host/bedtime-state.js to recognise a /loop wake (#52): the CLI
    // replays the scheduled prompt verbatim (verify/probe-bedtime-signal.js). It is still never logged outside
    // CLAUDE_CUSTOM_HOOK_DEBUG.
    fields: {
      prompt: { used: 'prompt-keeper.js, the terminal bar\'s last prompt (#49); bedtime-state.js, to recognise a wake (#52)' },
      ...COMMON_FIELDS,
    },
  },
  SessionEnd: {
    // The session is over; processes.js clears everything. No COMMON_FIELDS:
    // measured, it carries no permission_mode.
    fields: {},
  },
  // The permission prompt's own hook (BACKLOG #55). Bundle 2.1.296: base fields + tool_name, tool_input, permission_suggestions?, mcp_server?;
  // built with the tool-use context, so agent_id / agent_type are present inside a subagent and absent for the main session's own prompt.
  // Observe-only: the helper prints nothing, so mood-machine.js only ever marks the named agent "waiting on you".
  PermissionRequest: {
    fields: {
      tool_name: { used: 'mood-machine.js, which only needs to know a prompt is opening for the agent that named itself' },
      ...COMMON_FIELDS,
    },
  },
  Notification: {
    fields: {
      message: { used: 'attention-summary.js, to say what is being asked for' },
      ...COMMON_FIELDS,
    },
    // Also read, optional: notification_type. attention.js raises only for
    // permission_prompt, elicitation_dialog, elicitation_url_dialog and
    // agent_needs_input (idle_prompt only as a held "finished"'s backstop); an
    // older CLI that sends none raises as before. Measured in CLI 2.1.286's own
    // input schema; verify/probe-notification-type.js is the tripwire.
    // NOT read for a card (BACKLOG #55): a Notification never carries agent_id (CLI 2.1.296 builds it with no tool context,
    // verify/probe-agent-states.js), so it can't say which agent is waiting; the PermissionRequest hook above does.
  },
};

const at = (payload, path) =>
  path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), payload);

function fieldsFor(event) {
  const spec = CONTRACT[event];
  if (!spec) return [];
  return Object.keys(spec.fields).map(path => ({ path, ...spec.fields[path] }));
}

function checkPayload(event, payload) {
  const spec = CONTRACT[event];
  if (!spec) return { ok: false, error: `unknown event ${event}`, missing: [] };

  const missing = [];
  for (const field of fieldsFor(event)) {
    // A field read only for certain tools is not missing when those tools are
    // not in play. Flagging subagent_type on every Bash call would train
    // everyone to ignore the report, which is how a real absence gets through.
    if (field.onlyWhen && !field.onlyWhen(payload)) continue;
    if (at(payload, field.path) === undefined) missing.push(field.path);
  }
  return { ok: missing.length === 0, missing, error: null };
}

module.exports = { CONTRACT, AGENT_TOOLS, fieldsFor, checkPayload };
