'use strict';
/**
 * Token spend for the current session and for the whole project.
 *
 * Read straight from Claude Code's own transcripts rather than tracked
 * independently — they are the authoritative record, they already exist, and
 * they cover sessions this harness never hosted.
 *
 *   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 *
 * "Project total" is the sum across every session file in that folder, which is
 * what makes it a per-folder lifetime figure rather than a per-window one.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const EMPTY = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, sessions: 0 };

// Claude Code encodes the cwd by replacing every path separator and colon with
// a dash: C:\Users\x\proj -> C--Users-x-proj
function projectDirName(cwd) {
  return String(cwd || '').replace(/\\/g, '/').replace(/[/:]/g, '-');
}

function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

function addUsage(acc, usage) {
  if (!usage || typeof usage !== 'object') return;
  // NOTE: usage.iterations repeats these same numbers per API iteration.
  // Summing both inflates every figure silently, so only the top level counts.
  acc.input += num(usage.input_tokens);
  acc.output += num(usage.output_tokens);
  acc.cacheWrite += num(usage.cache_creation_input_tokens);
  acc.cacheRead += num(usage.cache_read_input_tokens);
}

function readFileUsage(file) {
  const acc = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return acc;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // The transcript is appended to live, so a partial final line is normal.
      continue;
    }
    addUsage(acc, obj && obj.message && obj.message.usage);
  }
  return acc;
}

const withTotal = (acc, sessions) => ({
  ...acc,
  total: acc.input + acc.output + acc.cacheWrite + acc.cacheRead,
  sessions,
});

function readUsage({ cwd, sessionId, projectsDir } = {}) {
  const root = projectsDir || defaultProjectsDir();
  const dir = path.join(root, projectDirName(cwd));

  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return { session: { ...EMPTY }, project: { ...EMPTY } };
  }

  const project = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let session = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  for (const f of files) {
    const acc = readFileUsage(path.join(dir, f));
    project.input += acc.input;
    project.output += acc.output;
    project.cacheWrite += acc.cacheWrite;
    project.cacheRead += acc.cacheRead;
    if (sessionId && f === sessionId + '.jsonl') session = acc;
  }

  return {
    session: withTotal(session, session === EMPTY ? 0 : 1),
    project: withTotal(project, files.length),
  };
}

module.exports = { readUsage, projectDirName, defaultProjectsDir, EMPTY };
