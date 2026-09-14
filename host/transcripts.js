'use strict';
/**
 * Where Claude Code keeps its transcripts, and which of them count.
 *
 * ONE COPY, shared by fog.js and usage.js, for the reason host/project-dir.js
 * already exists: a copy of the enumeration is a copy of the bug. This module
 * was extracted after exactly that happened -- fog.js walked the subagent
 * directories and usage.js did not, so the token counter omitted every
 * subagent's spend while the map beside it included their every file read.
 *
 * MEASURED on this project when the omission was found: 23 top-level
 * transcripts held 1,308,926,474 tokens and 30 subagent transcripts held
 * another 104,427,203 -- the project total understated by 7.4%. That share is
 * not a constant; it grows with how agent-driven the work is, and this repo
 * mandates a multi-agent review gate on every merge.
 *
 * The layout:
 *
 *   <projects>/<encoded-cwd>/<session-uuid>.jsonl              the session
 *   <projects>/<encoded-cwd>/<session-uuid>/subagents/*.jsonl  its agents
 *   <projects>/<encoded-cwd>/<session-uuid>/subagents/*.meta.json   NOT one
 */

const fsp = require('fs/promises');
const path = require('path');

const SUBAGENTS = 'subagents';

/**
 * Every transcript belonging to one project folder, as absolute paths, each
 * tagged with the session it belongs to.
 *
 * Returns null -- never [] -- when the folder itself could not be read. ABSENT
 * is not EMPTY: a caller that cannot tell them apart reports a failure as
 * "this project has spent nothing", which is the shape of wrongness that seeds
 * a false baseline.
 */
async function transcriptFiles(dir) {
  const out = [];
  let top;
  try {
    top = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const item of top) {
    if (item.isFile() && item.name.endsWith('.jsonl')) {
      // The session id is the filename, which is what lets a caller attribute a
      // subagent's spend to the session that spawned it.
      out.push({ file: path.join(dir, item.name), session: item.name.slice(0, -6) });
      continue;
    }
    if (!item.isDirectory()) continue;

    const sub = path.join(dir, item.name, SUBAGENTS);
    try {
      for (const f of await fsp.readdir(sub)) {
        // `.endsWith('.jsonl')` and not merely "not .meta.json": the meta files
        // sit right beside the transcripts, and parsing one would not throw --
        // it would silently contribute nothing and inflate the session count.
        if (f.endsWith('.jsonl')) {
          out.push({ file: path.join(sub, f), session: item.name, subagent: true });
        }
      }
    } catch {
      // A session with no subagents is the ordinary case, not an error.
    }
  }

  return out;
}

module.exports = { transcriptFiles, SUBAGENTS };
