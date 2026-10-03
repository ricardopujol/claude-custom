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
      'tool_input.file_path': {
        used: 'agent-occupancy.js, the worktree a subagent Read, Edit or Write is in (#44 + #47)',
        onlyWhen: p => ['Read', 'Edit', 'Write'].includes(p && p.tool_name),
      },
      ...COMMON_FIELDS,
    },
  },
  PostToolUse: {
    agentTools: AGENT_TOOLS,
    fields: {
      tool_name: { used: 'processes.js, to close the running entry this completes' },
      tool_response: { used: 'mood-machine.js isFailure(), which decides stressed vs happy' },
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
    // The event itself is the message: host/turn-state.js opens the MAIN session's turn on it, which the
    // Git drawer's Type /merged waits on (PR #93 Dexter F1). Nothing in the payload is read, and `prompt`
    // (the person's own words) is never read or logged outside CLAUDE_CUSTOM_HOOK_DEBUG.
    fields: { ...COMMON_FIELDS },
  },
  SessionEnd: {
    // The session is over; processes.js clears everything. No COMMON_FIELDS:
    // measured, it carries no permission_mode.
    fields: {},
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
