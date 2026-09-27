'use strict';
/**
 * Recently worked-on projects, for the launcher.
 *
 * Needs no tracking of its own: Claude Code already keeps one folder per project
 * under ~/.claude/projects/, and every transcript in it records the real cwd.
 *
 * IMPORTANT: the folder name is a LOSSY encoding of the path — separators are
 * replaced with dashes, so "claude-custom" is indistinguishable from
 * "claude/custom" and decoding the name would produce a plausible wrong answer.
 * The `cwd` recorded inside the transcript is authoritative, so it is read
 * instead, with the folder name kept only as a marked-approximate fallback.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { projectDirName } = require('./project-dir');

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Reads only as far as it needs to: the cwd appears on early entries, and the
// alternative is parsing every line of a multi-megabyte transcript for a value
// that never changes within a session.
function scanTranscript(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { cwd: null, tokens: 0 };
  }

  let cwd = null;
  let tokens = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // Normal: the newest transcript is appended to live, so the final line is
      // routinely a partial write.
      continue;
    }
    if (!cwd && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;

    const u = obj.message && obj.message.usage;
    if (u) {
      // Same accounting as usage.js: top level only. usage.iterations repeats
      // these numbers and summing both inflates every figure silently.
      tokens += num(u.input_tokens) + num(u.output_tokens) +
                num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
    }
  }
  return { cwd, tokens };
}

function listRecentProjects({ projectsDir, limit = 12, cache, onRead } = {}) {
  const root = projectsDir || defaultProjectsDir();

  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    return [];
  }

  // PASS 1 — stat only. Ranking needs mtime, which is cheap; token totals need
  // a full read, which measured 3s across 71 projects on this machine. Far too
  // slow for a launcher, and entirely wasted on rows that will not be shown.
  const ranked = [];
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (!files.length) continue;          // a folder with no sessions is not a project

    let lastUsed = 0;
    const stats = [];
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        lastUsed = Math.max(lastUsed, st.mtimeMs);
        stats.push({ file, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* vanished mid-scan */ }
    }
    ranked.push({ dirName: d.name, lastUsed, stats, sessions: files.length });
  }

  ranked.sort((a, b) => b.lastUsed - a.lastUsed);

  // PASS 2 — read only the rows that will be shown.
  const out = [];
  for (const r of ranked.slice(0, limit)) {
    let tokens = 0;
    let cwd = null;

    for (const s of r.stats) {
      // A finished session never changes, so a total keyed on mtime+size is
      // valid until the file is appended to.
      const key = `${s.file}|${s.mtimeMs}|${s.size}`;
      let scanned = cache && cache[key];
      if (!scanned) {
        if (onRead) onRead(s.file);
        scanned = scanTranscript(s.file);
        if (cache) cache[key] = scanned;
      }
      tokens += scanned.tokens;
      if (!cwd && scanned.cwd) cwd = scanned.cwd;
    }

    const d = { name: r.dirName };
    const lastUsed = r.lastUsed;
    const files = { length: r.sessions };
    const approximate = !cwd;
    const projectPath = cwd || d.name;
    const name = cwd
      ? (projectPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || projectPath)
      : d.name.split('-').filter(Boolean).pop();

    out.push({
      path: projectPath,
      name,
      approximate,          // true when the path had to be guessed from the folder
      lastUsed: r.lastUsed,
      tokens,
      sessions: r.sessions,
    });
  }

  return out;
}

/**
 * Has Claude Code ever run in `cwd`? True when its transcript folder
 * (host/project-dir.js names it) holds at least one .jsonl.
 *
 * Used to decide whether a folder is a NEW project (backlog #15), which is
 * the one case a look may be written unasked. So every doubt answers TRUE:
 * a projects root that exists but can't be read, or no cwd at all, is "maybe
 * it has history", and a maybe never gets a look written over it. Only a root
 * that is not there at all (Claude has never run on this machine) is a
 * confident "no".
 *
 * Compared case-insensitively: the same folder is recorded as both `C--...`
 * and `c--...` on this machine, depending on how the session was started.
 * The encoding is lossy (`a-b` and `a/b` collide), and a collision can only
 * report history that isn't there -- the safe direction.
 */
function hasClaudeHistory(cwd, { projectsDir } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) return true;
  const root = projectsDir || defaultProjectsDir();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return !(err && err.code === 'ENOENT');
  }
  const want = projectDirName(cwd).toLowerCase();
  for (const d of entries) {
    if (!d.isDirectory() || d.name.toLowerCase() !== want) continue;
    try {
      if (fs.readdirSync(path.join(root, d.name)).some(f => f.endsWith('.jsonl'))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

module.exports = { listRecentProjects, defaultProjectsDir, hasClaudeHistory };
