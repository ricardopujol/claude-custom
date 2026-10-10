'use strict';
/**
 * The standing read-only side session (BACKLOG #81, documentation/DESIGN_ROUND_2026-10-09B.md).
 *
 * A tab's menu opens a second real `claude` in the same folder, in the CLI's own plan mode (it can read and answer, it
 * can't write). It is a HOST of its own on its own port, told so by CLAUDE_CUSTOM_SIDE_SESSION=1:
 *   - claude runs with `--permission-mode plan` and not `--dangerously-skip-permissions`, and is offered ONLY the read-only
 *     built-in tools: `--tools Read,Grep,...` (host/settings-writer.js). Plan mode is only where the session STARTS (Shift+Tab, or
 *     accepting the plan, leaves it); what keeps it read-only is that the tools that could write don't exist in it. An allow-list,
 *     not a list of what to deny: a tool the CLI adds tomorrow (PowerShell and Monitor were not in the first list) is off until it is
 *     read and classified (test/side-session-r2.test.js reads the installed CLI's own tool declarations). The explicit deny list is
 *     a second wall, never relied on alone, and never relies on the CLI's "deny Bash => deny PowerShell" fallback, which a user's own
 *     `PowerShell(...)` allow rules switch off. No MCP server is loaded (`--strict-mcp-config`): an MCP tool can write anywhere.
 *   - it takes no session lock, so it never holds the worktree's writer role (host/host.js);
 *   - its identity file says `side: true`, so the port walk never mistakes it for the folder's own host
 *     (host/handshake.js, host/port-for-project.js);
 *   - the claims its subagents make carry role "reader" (host/agent-occupancy.js).
 *
 * In the tab shell it is a tab of its own, keyed by its branch tab's key plus SIDE_SUFFIX. The suffix ends in a character
 * no Windows path can contain, and a branch tab's key is a normalised path, so a side key never equals a branch key.
 */

const SIDE_SUFFIX = '|side';
// Not CLAUDE_CUSTOM_SIDE_TAB's neighbour by one letter: that one is the picker's (app/main.js), this one marks a side HOST.
const SIDE_ENV = 'CLAUDE_CUSTOM_SIDE_SESSION';
const SIDE_PERMISSION_MODE = 'plan';
// Plain tool names: a rule with a pattern in it is one a permission prompt could be answered into widening.
// MEASURED, no billed call (claude -p ... --output-format stream-json --verbose prints its init message, with the tool list, before
// any model request; ANTHROPIC_BASE_URL on a dead port sends nothing): --tools "<names>" makes that list exactly those built-in
// tools, and naming a tool the CLI gates (PowerShell, Monitor) turns it ON. So the allow-list is the whole fence.
// Read-only by what they do: Read, Grep, Glob (they only look), WebFetch / WebSearch (a GET: nothing in the worktree changes),
// TodoWrite (the session's own list, in memory). Skill, Agent/Task, ExitPlanMode, MCP and everything else are left out.
const SIDE_ALLOWED_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite']);
// The second wall (never the only one): tools that run a command or write a file or a git ref, by name.
const SIDE_DENIED_TOOLS = Object.freeze([
  'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash', 'PowerShell', 'Monitor', 'EnterWorktree', 'ExitWorktree', 'Task', 'Agent', 'Workflow', 'Skill',
]);
// Every tool name the CLI (2.1.296) declared or showed when this was reviewed. A name the installed CLI declares that is not in this list
// fails test/side-session-r2.test.js: read what the tool does, then either add it to SIDE_ALLOWED_TOOLS or leave it off, and list it here.
const SIDE_REVIEWED_TOOLS = Object.freeze([
  ...SIDE_ALLOWED_TOOLS, ...SIDE_DENIED_TOOLS,
  'ExitPlanMode', 'TaskStop', 'ListMcpResources', 'RefreshMcpTools', 'mcp', 'ReadMcpResourceDir', 'ReadMcpResource', 'ReportFindings',
  'AskUserQuestion', 'SendFeedback', 'ClaudeDesign', 'Projects', 'EnterPlanMode', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'ShowOnboardingRolePicker', 'OfferChromeSetup',
  'ReadNotifications', 'DesignSync', 'ProposeSkills', 'ProposeGoal', 'Artifact', 'PushNotification', 'ListAgents', 'SendMessage', 'LS', 'NotebookRead',
]);

const { samePath } = require('./project-layout');

const nonEmpty = s => typeof s === 'string' && s !== '';
const posInt = n => Number.isInteger(n) && n > 0;
const asList = l => (Array.isArray(l) ? l : []);

function isSideKey(k) {
  return nonEmpty(k) && k.length > SIDE_SUFFIX.length && k.endsWith(SIDE_SUFFIX);
}

/** The side tab's key for a branch tab's key; null for no key and for a key that is already a side's. */
function sideKeyOf(parentKey) {
  if (!nonEmpty(parentKey) || isSideKey(parentKey)) return null;
  return parentKey + SIDE_SUFFIX;
}

/** The branch tab's key a side key belongs to; null for anything that is not a side key. */
function parentKeyOf(k) {
  return isSideKey(k) ? k.slice(0, -SIDE_SUFFIX.length) : null;
}

/** What the side tab says: its branch tab's label, then " · side". */
function sideLabel(label) {
  return `${label} · side`;
}

/** Is this host's environment a side host's? Only the exact string "1" (anything else is an ordinary host). */
function isSideEnv(env) {
  return !!env && env[SIDE_ENV] === '1';
}

/**
 * The claude pids and session ids of the OTHER hosts serving the same folder that a host must not count as "another claude
 * session in this worktree" (host/session-registry.js, the collision banner): a branch tab's host leaves its folder's side
 * hosts out, a side host leaves the folder's own host out. `identities` is host/background-hosts.js identitiesIn(): [{ port,
 * parsed }]. A side host and the folder's own host are the same folder on purpose; neither is a second writer.
 */
function siblingSessions(identities, { cwd, side = false, ownPort } = {}) {
  const out = { pids: [], sessionIds: [] };
  if (!nonEmpty(cwd)) return out;
  for (const e of asList(identities)) {
    const p = e && typeof e === 'object' ? e.parsed : null;
    if (!p || typeof p !== 'object' || !nonEmpty(p.cwd) || p.port === ownPort || e.port === ownPort) continue;
    if (!samePath(p.cwd, cwd) || (p.side === true) === (side === true)) continue;
    if (posInt(p.claudePid) && !out.pids.includes(p.claudePid)) out.pids.push(p.claudePid);
    if (nonEmpty(p.sessionId) && !out.sessionIds.includes(p.sessionId)) out.sessionIds.push(p.sessionId);
  }
  return out;
}

/**
 * [{ port, cwd }] of the side hosts among `identities`: what a window looks for when it opens (app/tab-shell.js adoptSide). NULL when
 * that can't be told: no list, or an identity file that couldn't be READ (it may be a live side host's). "Couldn't read" is not "nothing
 * there": the shell then looks for a side host under every tab (PR #149 Dexter R2-3).
 */
function sideHostsOf(identities) {
  if (!Array.isArray(identities) || identities.some(e => e && e.unreadable === true)) return null;
  const out = [];
  for (const e of identities) {
    const p = e && typeof e === 'object' ? e.parsed : null;
    if (p && p.side === true && nonEmpty(p.cwd) && posInt(e.port)) out.push({ port: e.port, cwd: p.cwd });
  }
  return out;
}

/** The session ids the side hosts among `identities` published: the sessions whose agents are readers (host/occupancy-transcripts.js). */
function readerSessionIds(identities) {
  const out = [];
  for (const e of asList(identities)) {
    const p = e && typeof e === 'object' ? e.parsed : null;
    if (p && p.side === true && nonEmpty(p.sessionId) && !out.includes(p.sessionId)) out.push(p.sessionId);
  }
  return out;
}

module.exports = {
  SIDE_SUFFIX, SIDE_ENV, SIDE_PERMISSION_MODE, SIDE_ALLOWED_TOOLS, SIDE_DENIED_TOOLS, SIDE_REVIEWED_TOOLS, isSideKey, sideKeyOf, parentKeyOf, sideLabel, isSideEnv,
  siblingSessions, sideHostsOf, readerSessionIds,
};
