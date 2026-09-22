// @ts-nocheck
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

const CONTRACT = {
  SessionStart: {
    fields: {
      session_id: { used: 'host.js -> usage.js, to read this session\'s transcript for token spend' },
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
      'tool_input.command': {
        used: 'processes.js, the label shown in the Running panel',
        onlyWhen: p => (p && p.tool_name) === 'Bash',
      },
    },
  },
  PostToolUse: {
    agentTools: AGENT_TOOLS,
    fields: {
      tool_name: { used: 'processes.js, to close the running entry this completes' },
      tool_response: { used: 'mood-machine.js isFailure(), which decides stressed vs happy' },
    },
  },
  SubagentStop: {
    fields: {
      agent_type: {
        used: 'mood-machine.js + cooldowns, to credit the agent that ACTUALLY '
            + 'finished rather than the top of the delegation stack',
      },
    },
    // Also arrives, unread for now, and worth knowing about:
    //   permission_mode  -- authoritative hazard level, currently scraped from
    //                       the TUI text instead. Every payload carries it.
    //   last_assistant_message -- what the agent concluded; would make the
    //                       "finished" notification say what it finished.
    //   agent_transcript_path  -- per-agent token spend, per agent.
  },
  Stop: {
    fields: {},   // likewise: the turn ended, which is the whole message
  },
  Notification: {
    fields: {
      message: { used: 'attention-summary.js, to say what is being asked for' },
    },
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
