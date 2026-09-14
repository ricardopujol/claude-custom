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
 * Returns `{ files, errors }`, and `files: null` -- never [] -- when the folder
 * itself could not be read. ABSENT is not EMPTY: a caller that cannot tell them
 * apart reports a failure as "this project has spent nothing", which is the
 * shape of wrongness that seeds a false baseline.
 *
 * `errors` exists because the SAME conflation hid one level down. The subagent
 * walk used to swallow every readdir failure under a comment reading "a session
 * with no subagents is the normal case" -- true for ENOENT, and a silent lie for
 * every other errno. An indexer holding one subagents directory would drop all
 * of its transcripts, increment nothing, and let the caller report a 7.4%
 * undercount as complete. A failure nobody counts is indistinguishable from
 * an absence of work.
 */
async function transcriptFiles(dir) {
  const out = [];
  let errors = 0;
  let top;
  try {
    top = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { files: null, errors: 0 };
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
    let names;
    try {
      names = await fsp.readdir(sub);
    } catch (err) {
      // ENOENT ONLY. A session that spawned no agents has no such directory,
      // and that is genuinely nothing to report. Every other errno -- EBUSY,
      // EPERM, ENOTDIR, EACCES -- means the transcripts may be there and we
      // could not look, which is absence and must reach `ok`.
      if (!err || err.code !== 'ENOENT') errors++;
      continue;
    }
    for (const f of names) {
      // `.endsWith('.jsonl')` and not merely "not .meta.json": the meta files
      // sit right beside the transcripts, and parsing one would not throw --
      // it would silently contribute nothing and inflate the session count.
      if (f.endsWith('.jsonl')) {
        out.push({ file: path.join(sub, f), session: item.name, subagent: true });
      }
    }
  }

  return { files: out, errors };
}

module.exports = { transcriptFiles, SUBAGENTS };
