'use strict';
/**
 * Per-agent career stats, scoped to the PROJECT.
 *
 * Ricardo: "Next to the agents it should say how many tokens they have spent IN
 * THAT PROJECT, and it should say also how much time they have worked IN THAT
 * PROJECT. Not in that context window or session, in the project."
 *
 * So this is a career record, not a session gauge: the same "this folder, all
 * of its history" scope the project token counter uses.
 *
 * WHERE THE DATA IS. Every subagent gets its own transcript beside its parent
 * session, with a `.meta.json` sibling:
 *
 *   <projects>/<encoded-cwd>/<session>/subagents/agent-*.jsonl
 *   <projects>/<encoded-cwd>/<session>/subagents/agent-*.meta.json
 *
 * The transcript carries `message.usage` per line and an ISO `timestamp`, so
 * both figures fall straight out of it.
 *
 * IDENTITY IS THE HARD PART, and guessing it would have been the `Agent`-vs-
 * `Task` mistake again: an aggregate that looks perfectly reasonable while
 * attributing one agent's work to four strangers. MEASURED against 30 real
 * subagent transcripts rather than assumed:
 *
 *   - An ordinary spawn writes `{ toolUseId, agentType: "code-reviewer" }`, and
 *     `agentType` is already the true type.           19 of 30 here.
 *   - A NAMED spawn runs as `requestShape: "background"`, has NO `toolUseId` at
 *     all, and puts THE NAME in `agentType` -- so this project's 14
 *     `code-reviewer` runs were also filed under `miguel-usage`,
 *     `miguel-review`, `miguel-merged-settings`...   11 of 30 here.
 *
 * Both are recoverable because the parent's `Agent` tool_use block carries
 * `subagent_type` on EVERY spawn (26 of 26 measured, named ones included), next
 * to `input.name`. So there are two join keys, and between them they resolved
 * all 30 with none left over.
 *
 * TIME WORKED is last timestamp minus first, within one transcript, summed over
 * runs. Deliberately NOT wall-clock from spawn to SubagentStop, which would
 * count time an agent spent queued. Two agents running in parallel therefore
 * both count their own minutes, which is correct: it is time WORKED, not time
 * elapsed.
 */

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { projectDirName } = require('./project-dir');
const { transcriptFiles, SUBAGENTS } = require('./transcripts');

const PARSE_BATCH = 500;

// The longest gap between two entries that still counts as working.
//
// MEASURED, and this is why it exists: one real transcript here spans 641
// minutes, of which a SINGLE gap is 637 -- an agent spawned overnight that
// finished the next morning. Every other gap in it is under half a minute. So
// first-to-last is wall-clock wearing the label "time worked", and it reported
// 10.7 hours of labour for about four minutes of it.
//
// Summing gaps instead, each capped here, bounds the error in both directions:
// an overnight wait contributes five minutes rather than eleven hours, and a
// genuinely long tool call contributes five minutes rather than nothing. The
// total can therefore never exceed turns x 5 minutes, which is the honest
// ceiling for a figure derived from timestamps alone.
const IDLE_GAP_MS = 5 * 60 * 1000;
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * The two identity tables, built from every transcript in the project --
 * subagent transcripts included, because an agent can spawn an agent and the
 * inner `Agent` block then lives in the outer agent's transcript rather than in
 * the session's.
 */
async function identityTables(files) {
  const byToolUse = new Map();
  const byName = new Map();

  for (const entry of files) {
    let raw;
    try {
      raw = await fsp.readFile(entry.file, 'utf8');
    } catch {
      continue;                      // one unreadable transcript is not fatal here
    }
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Cheap pre-filter: most lines are not tool calls at all, and this runs
      // over the whole project.
      if (line.indexOf('"tool_use"') !== -1 && line.indexOf('"Agent"') !== -1) {
        try {
          const obj = JSON.parse(line);
          const content = obj && obj.message && obj.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (!block || block.type !== 'tool_use' || block.name !== 'Agent') continue;
              const input = block.input || {};
              if (!input.subagent_type) continue;
              if (block.id) byToolUse.set(block.id, input.subagent_type);
              if (input.name) byName.set(input.name, input.subagent_type);
            }
          }
        } catch { /* a partial final line is normal */ }
      }
      if (i % PARSE_BATCH === PARSE_BATCH - 1) await yieldToLoop();
    }
  }
  return { byToolUse, byName };
}

/**
 * The true agent type for one subagent transcript.
 *
 * Returns `{ agent, source }`. `source` is kept because the fallback is a
 * GUESS -- a name we could not resolve -- and a caller that cannot tell a
 * resolved type from an unresolved label will happily draw them side by side as
 * if they were peers.
 */
function resolveAgent(meta, tables) {
  const label = (meta && meta.agentType) || null;
  if (meta && meta.toolUseId && tables.byToolUse.has(meta.toolUseId)) {
    return { agent: tables.byToolUse.get(meta.toolUseId), source: 'tool-use' };
  }
  if (label && tables.byName.has(label)) {
    return { agent: tables.byName.get(label), source: 'name' };
  }
  return { agent: label, source: label ? 'unresolved' : 'unknown' };
}

async function readTranscript(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const acc = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const stamps = [];
  // One message is one API call with one usage figure, but Claude Code writes
  // each content block on its own line and repeats the usage on every one. A
  // turn with a thinking block and a tool call would otherwise be counted
  // twice -- measured project-wide at a 44.3% overcount. Entries with no id are
  // always counted, so this cannot turn into a silent undercount.
  const seen = new Set();

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed) {
      try {
        const obj = JSON.parse(trimmed);
        const at = Date.parse(obj && obj.timestamp);
        if (Number.isFinite(at)) stamps.push(at);
        const message = obj && obj.message;
        const id = message && message.id;
        const already = id ? seen.has(id) : false;
        if (id) seen.add(id);
        const u = already ? null : (message && message.usage);
        if (u && typeof u === 'object') {
          acc.input += num(u.input_tokens);
          acc.output += num(u.output_tokens);
          acc.cacheWrite += num(u.cache_creation_input_tokens);
          acc.cacheRead += num(u.cache_read_input_tokens);
        }
      } catch { /* a partial final line is normal */ }
    }
    if (i % PARSE_BATCH === PARSE_BATCH - 1) await yieldToLoop();
  }

  const total = acc.input + acc.output + acc.cacheWrite + acc.cacheRead;

  // Sorted, because entries are not guaranteed in order and clock skew is real:
  // an unsorted scan produces negative gaps that subtract from the career.
  stamps.sort((a, b) => a - b);
  let ms = 0;
  for (let i = 1; i < stamps.length; i++) {
    ms += Math.min(stamps[i] - stamps[i - 1], IDLE_GAP_MS);
  }
  // A single-entry transcript is 0ms, which is the honest answer rather than a
  // missing one.
  return { ...acc, total, ms, timed: stamps.length > 0 };
}

/**
 * Career stats for every agent that has ever run in this project folder.
 *
 * Returns `{ ok, agents, unresolved }`, agents sorted by spend. `ok` is false
 * only when the project folder itself could not be read -- ABSENCE, not zero,
 * for the same reason host/usage.js draws that line.
 */
async function readAgentStats({ cwd, projectsDir } = {}) {
  const root = projectsDir || defaultProjectsDir();
  const dir = path.join(root, projectDirName(cwd));

  const { files, errors } = await transcriptFiles(dir);
  if (files === null) return { ok: false, agents: [], unresolved: 0 };

  const tables = await identityTables(files);

  const byAgent = new Map();
  let unresolved = 0;

  for (const entry of files) {
    if (!entry.subagent) continue;

    // The meta sits beside the transcript, same basename.
    const metaPath = entry.file.replace(/\.jsonl$/, '.meta.json');
    let meta = null;
    try {
      meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    } catch { /* a transcript with no meta still has tokens worth counting */ }

    const { agent, source } = resolveAgent(meta, tables);
    if (!agent) continue;                 // nothing to file it under
    if (source === 'unresolved') unresolved++;

    const read = await readTranscript(entry.file);
    if (!read) continue;

    const row = byAgent.get(agent) || {
      agent, runs: 0, tokens: 0, ms: 0,
      input: 0, output: 0, cacheWrite: 0, cacheRead: 0,
      resolved: true,
    };
    row.runs += 1;
    row.tokens += read.total;
    row.ms += read.ms;
    row.input += read.input;
    row.output += read.output;
    row.cacheWrite += read.cacheWrite;
    row.cacheRead += read.cacheRead;
    // One unresolved run makes the whole row a label rather than a type, and the
    // UI should be able to say so instead of implying a clean identity.
    if (source === 'unresolved') row.resolved = false;
    byAgent.set(agent, row);
  }

  const agents = [...byAgent.values()].sort((a, b) => b.tokens - a.tokens);
  return { ok: errors === 0, agents, unresolved };
}

module.exports = { readAgentStats, resolveAgent, identityTables, SUBAGENTS, IDLE_GAP_MS };
