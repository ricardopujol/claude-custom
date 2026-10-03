'use strict';
/**
 * Which worktree is an agent working in? (backlog #44 + #47, documentation/DESIGN_WORKTREE_OCCUPANCY.md)
 *
 *   claimFrom(event, roots, ownRoot) -> { agentId, agent, worktree } | null
 *   latest(touches)                  -> { worktree, also, touch } | null
 *   buildClaim / serializeClaim / parseClaim / claimFileName   the claim FILE (see below)
 *
 * PROVEN ONLY. A claim exists once one of the agent's OWN tool calls touches a worktree:
 *   - Read / Edit / Write: `tool_input.file_path`; NotebookEdit names it `notebook_path`. Inside a known
 *     root, by the same containment the tabs use (host/project-layout.js isInside). The longest root that
 *     contains the path wins, so `dev` never swallows a worktree nested under it.
 *   - Bash: the command string contains a known root's absolute path (either slash form, doubled
 *     backslashes, and Git Bash's /c/... on Windows), on a path boundary, case-insensitively on Windows.
 *     This is NOT shell parsing: it only looks for the handful of roots `git worktree list` returned
 *     (fog.js's "never extract paths from Bash" rule is about arbitrary paths, which this never does).
 *     The longest root that is NOT the launching session's own wins.
 *   - Nothing else: not the Agent prompt, not Grep or Glob, not a relative path (it would resolve against
 *     the host, not the agent), not an event without an `agent_id` (the main session's own call).
 *   - The launching session's own folder never counts.
 *
 * The agent_id becomes a FILE NAME (`<agent_id>.json`) and comes from somebody else's process: only
 * `[A-Za-z0-9_-]{1,64}` is accepted anywhere here, so no id can name a path outside the claims folder.
 *
 * `hostStartedAt` is the launching host's OS start time (a FILETIME string, host/proc-start.js). It's the
 * proof a reader checks before it shows a claim, so one that is missing or isn't a FILETIME is read as null
 * ("can't be proven"), never as a value.
 */

const path = require('path');
const { normPath, samePath, isInside } = require('./project-layout');
const { filetimeToMs } = require('./background-hosts');

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ALSO_MAX = 8;
const WIN = process.platform === 'win32';

const isStr = s => typeof s === 'string' && s !== '';
const safeAgentId = id => (typeof id === 'string' && SAFE_ID.test(id) ? id : null);
const isFiletime = s => typeof s === 'string' && filetimeToMs(s) !== null;

function claimFileName(agentId) {
  const id = safeAgentId(agentId);
  return id === null ? null : `${id}.json`;
}

// The roots that can be compared at all: absolute strings that normalise to something. Raw form kept
// (a claim names the root as it was given), plus the normalised form every comparison uses.
function cleanRoots(roots) {
  if (!Array.isArray(roots)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of roots) {
    if (!isStr(raw) || !path.isAbsolute(raw)) continue;
    const norm = normPath(raw);
    if (norm === null || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ raw, norm });
  }
  return out;
}

// One slash form, runs of separators collapsed (a doubled backslash is one separator), case folded where
// the filesystem is: the shape both a root and a command are compared in.
function squash(s) {
  const t = String(s).replace(/[\\/]+/g, '/');
  return WIN ? t.toLowerCase() : t;
}

// What a root can be spelled as inside a command: its own squashed form, and on Windows Git Bash's
// /c/rest form.
function spellings(norm) {
  const own = squash(norm);
  const m = WIN ? /^([a-z]):\/(.*)$/.exec(own) : null;
  return m ? [own, `/${m[1]}/${m[2]}`] : [own];
}

// A name character: what a longer folder name would continue with. Before a match only a separator-ish
// character may stand (or nothing); after it, anything that isn't a name character.
const BEFORE_OK = /[\s"'`=(;&|<>:,]/;
const NAME_CHAR = /[\w.\-~]/;

function mentions(command, spelling) {
  let from = 0;
  for (;;) {
    const at = command.indexOf(spelling, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : command[at - 1];
    const after = command[at + spelling.length];
    if ((before === '' || BEFORE_OK.test(before)) && (after === undefined || !NAME_CHAR.test(after))) return true;
    from = at + 1;
  }
}

function worktreeOfPath(file, roots, ownRoot) {
  if (!isStr(file) || !path.isAbsolute(file)) return null;
  let best = null;
  for (const r of roots) {
    if (isInside(file, r.norm) && (best === null || r.norm.length > best.norm.length)) best = r;
  }
  if (best === null || samePath(best.raw, ownRoot)) return null;
  return best.raw;
}

function worktreeOfCommand(command, roots, ownRoot) {
  if (!isStr(command)) return null;
  const text = squash(command);
  let best = null;
  for (const r of roots) {
    if (samePath(r.raw, ownRoot)) continue;
    if (best !== null && r.norm.length <= best.norm.length) continue;
    if (spellings(r.norm).some(s => mentions(text, s))) best = r;
  }
  return best === null ? null : best.raw;
}

/**
 * The claim one hook event makes, or null. `event` is `{ event, payload }` as the hook bridge delivers it;
 * `roots` the absolute worktree folders `git worktree list` gave; `ownRoot` the launching session's folder.
 */
function claimFrom(event, roots, ownRoot) {
  if (!event || typeof event !== 'object' || event.event !== 'PreToolUse') return null;
  const p = event.payload;
  if (!p || typeof p !== 'object') return null;
  const agentId = safeAgentId(p.agent_id);
  if (agentId === null) return null;
  const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : null;
  if (input === null) return null;
  const known = cleanRoots(roots);
  if (known.length === 0) return null;

  let worktree = null;
  if (FILE_TOOLS.has(p.tool_name)) {
    worktree = worktreeOfPath(p.tool_name === 'NotebookEdit' ? input.notebook_path : input.file_path, known, ownRoot);
  } else if (p.tool_name === 'Bash') {
    worktree = worktreeOfCommand(input.command, known, ownRoot);
  }
  if (worktree === null) return null;
  return { agentId, agent: isStr(p.agent_type) ? p.agent_type : null, worktree };
}

const validTouch = t => !!t && typeof t === 'object' && isStr(t.worktree) && normPath(t.worktree) !== null
  && typeof t.lastAt === 'number' && Number.isFinite(t.lastAt);

/**
 * An agent that touched two worktrees: the latest wins, the rest are `also` (newest first, each worktree
 * once however it was spelled). `touch` is the winning record itself. null when nothing usable was given.
 * `touches` are `{ worktree, lastAt, ... }`; a tie goes to the later entry.
 */
function latest(touches) {
  if (!Array.isArray(touches)) return null;
  const byKey = new Map();
  touches.forEach((t, i) => {
    if (!validTouch(t)) return;
    const key = normPath(t.worktree);
    const seen = byKey.get(key);
    if (!seen || t.lastAt >= seen.touch.lastAt) byKey.set(key, { touch: t, i });
  });
  const ranked = [...byKey.values()].sort((a, b) => (b.touch.lastAt - a.touch.lastAt) || (b.i - a.i));
  if (ranked.length === 0) return null;
  return {
    worktree: ranked[0].touch.worktree,
    also: ranked.slice(1).map(r => r.touch.worktree),
    touch: ranked[0].touch,
  };
}

// --- the claim file ---------------------------------------------------------------------------------

const positiveInt = n => Number.isInteger(n) && n > 0;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const absStr = s => isStr(s) && path.isAbsolute(s);

/** The claim record for one agent, from its touches and the launching host's facts; null with no touches. */
function buildClaim({ agentId, agent, fromBranch, fromRoot, hostPid, hostStartedAt, touches } = {}) {
  const l = latest(touches);
  if (l === null) return null;
  const t = l.touch;
  return {
    agentId,
    agent: isStr(agent) ? agent : null,
    worktree: l.worktree,
    also: l.also.slice(0, ALSO_MAX),
    fromBranch: isStr(fromBranch) ? fromBranch : null,
    fromRoot,
    hostPid,
    hostStartedAt: isFiletime(hostStartedAt) ? hostStartedAt : null,
    firstAt: finite(t.firstAt) ? t.firstAt : t.lastAt,
    lastAt: t.lastAt,
    count: positiveInt(t.count) ? t.count : 1,
  };
}

function serializeClaim(c) {
  return JSON.stringify({
    agentId: c.agentId, agent: c.agent, worktree: c.worktree, also: c.also, fromBranch: c.fromBranch,
    fromRoot: c.fromRoot, hostPid: c.hostPid, hostStartedAt: c.hostStartedAt,
    firstAt: c.firstAt, lastAt: c.lastAt, count: c.count,
  }, null, 2) + '\n';
}

/** `{ ok: true, claim }`, or `{ ok: false, reason }`. Never throws; never trusts a field it didn't check. */
function parseClaim(text) {
  let d;
  try { d = JSON.parse(text); } catch { return { ok: false, reason: 'not JSON' }; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, reason: 'not an object' };
  if (safeAgentId(d.agentId) === null) return { ok: false, reason: 'agentId is not a safe id' };
  if (!absStr(d.worktree)) return { ok: false, reason: 'worktree is not an absolute path' };
  if (!absStr(d.fromRoot)) return { ok: false, reason: 'fromRoot is not an absolute path' };
  if (!positiveInt(d.hostPid)) return { ok: false, reason: 'hostPid is not a pid' };
  if (!finite(d.firstAt) || !finite(d.lastAt)) return { ok: false, reason: 'firstAt / lastAt are not times' };
  if (!positiveInt(d.count)) return { ok: false, reason: 'count is not a positive integer' };
  return {
    ok: true,
    claim: {
      agentId: d.agentId,
      agent: isStr(d.agent) ? d.agent : null,
      worktree: d.worktree,
      also: (Array.isArray(d.also) ? d.also : []).filter(absStr).slice(0, ALSO_MAX),
      fromBranch: isStr(d.fromBranch) ? d.fromBranch : null,
      fromRoot: d.fromRoot,
      hostPid: d.hostPid,
      hostStartedAt: isFiletime(d.hostStartedAt) ? d.hostStartedAt : null,
      firstAt: d.firstAt,
      lastAt: d.lastAt,
      count: d.count,
    },
  };
}

module.exports = {
  claimFrom, latest, buildClaim, serializeClaim, parseClaim, claimFileName, safeAgentId, ALSO_MAX, FILE_TOOLS,
};
