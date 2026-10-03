'use strict';
/**
 * The reader's Diff source (#32): what Claude changed in ONE file, shown as before -> now.
 *
 *   claudeCallsFor({ root, rel, projectsDir }) -> { ok: true, calls, transcripts, truncated? }
 *   renderCalls(calls)                         -> unified-style text (`@@ header`, `-old`, `+new`)
 *   pickDiff({ calls, gitText })               -> { source: 'claude' | 'git' | null, text }
 *   gitDiffHead(root, rel, { execFile })       -> { ok: true, text } | { ok: false, error }
 *   diffFor({ root, rel, projectsDir, execFile }) -> { ok: true, source, text, ... } | { ok: false, error }
 *
 * CLAUDE'S OWN CALLS FIRST. The transcripts record every Edit (old_string -> new_string) and Write (the whole
 * content), so the reader can show exactly what Claude did, in order, with no git involved: it works for an
 * uncommitted file, a committed one, and a file git has never seen. `git diff HEAD -- <file>` is the
 * fallback, for when no call is found. Neither: no diff (source null), which the page shows as "no changes
 * recorded", and a git that FAILS with no calls is an error, never "no changes".
 *
 * READ ON DEMAND, ONE FILE: the page asks when the Diff toggle is pressed. fog.js caches parsed transcripts
 * but keeps no old / new strings (they would be megabytes); this scans for the one file, pre-filtering each
 * line on the file's name before parsing JSON, and yields to the loop as fog.js does (this host's event
 * loop delivers the CLI's hook events and the helper gives up after 80ms).
 *
 * Bounded: the latest MAX_CALLS calls, each string capped, a Write drawn to MAX_WRITE_LINES, a git diff to
 * MAX_GIT_CHARS. Each cut says so in the text.
 */
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const { projectDirName } = require('./project-dir');
const { transcriptFiles } = require('./transcripts');
const { relativeTo } = require('./fog');
const { createCollector } = require('./tool-calls');

const MAX_CALLS = 200;
const MAX_STRING = 400 * 1024;
const MAX_WRITE_LINES = 400;
const MAX_GIT_CHARS = 512 * 1024;
const PARSE_BATCH = 500;
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

const clip = (s) => (s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s);

// `at` is a call's own time; a call whose input is for another file, or malformed, is no call here.
function callFrom(block, root, rel, at) {
  if (!block || (block.name !== 'Edit' && block.name !== 'Write')) return null;
  const input = block.input;
  if (!input || typeof input.file_path !== 'string') return null;
  const seen = relativeTo(root, input.file_path);
  if (seen === null || seen.toLowerCase() !== rel.toLowerCase()) return null;
  if (block.name === 'Write') {
    return typeof input.content === 'string' ? { tool: 'Write', at, content: clip(input.content) } : null;
  }
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return null;
  return { tool: 'Edit', at, oldString: clip(input.old_string), newString: clip(input.new_string) };
}

async function claudeCallsFor({ root, rel, projectsDir } = {}) {
  const dir = path.join(projectsDir || path.join(os.homedir(), '.claude', 'projects'), projectDirName(String(root).replace(/\\/g, '/')));
  const { files } = await transcriptFiles(dir);
  if (files === null) return { ok: true, calls: [], transcripts: false };
  const base = String(rel).split('/').pop().toLowerCase();
  const found = [];
  for (const { file } of files) {
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch { continue; }
    // A call counts only once its tool_result says it happened (PR #95 Dexter D1): an Edit that answered "Found
    // 2 matches", a Write refused at the prompt and a call never answered are not changes.
    const collector = createCollector({ wanted: name => name === 'Edit' || name === 'Write' });
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        if (collector.wantsResultLine(line)) collector.addResult(JSON.parse(line));
        else if (line.indexOf('"tool_use"') !== -1 && line.toLowerCase().indexOf(base) !== -1) collector.addUse(JSON.parse(line));
      } catch { /* appended live: a partial final line is normal */ }
      if (i % PARSE_BATCH === PARSE_BATCH - 1) await yieldToLoop();
    }
    for (const call of collector.calls()) {
      const c = callFrom(call, root, rel, call.at);
      if (c) found.push(c);
    }
    await yieldToLoop();
  }
  // Oldest first. A call with no usable time keeps its place (the sort is stable and NaN compares as 0).
  const order = found.map((c, i) => ({ c, i })).sort((a, b) => ((a.c.at || 0) - (b.c.at || 0)) || (a.i - b.i)).map(x => x.c);
  const truncated = order.length > MAX_CALLS;
  return { ok: true, calls: truncated ? order.slice(order.length - MAX_CALLS) : order, transcripts: true, ...(truncated ? { truncated: true } : {}) };
}

// ---- drawing ----

function lineList(s) {
  const lines = String(s).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();      // a trailing newline is not a blank line
  return lines;
}

function stamp(at) {
  return Number.isFinite(at) ? `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
}

function capped(lines, sign) {
  const out = lines.slice(0, MAX_WRITE_LINES).map(l => sign + l);
  if (lines.length > MAX_WRITE_LINES) out.push(`… ${lines.length - MAX_WRITE_LINES} more lines`);
  return out;
}

function renderCalls(calls) {
  const out = [];
  for (const c of calls) {
    const t = stamp(c.at);
    if (c.tool === 'Write') {
      const lines = lineList(c.content);
      out.push(`@@ Write (${lines.length} line${lines.length === 1 ? '' : 's'})${t ? ` · ${t}` : ''} @@`);
      out.push(...capped(lines, '+'));
    } else {
      out.push(`@@ Edit${t ? ` · ${t}` : ''} @@`);
      if (c.oldString !== '') out.push(...capped(lineList(c.oldString), '-'));
      if (c.newString !== '') out.push(...capped(lineList(c.newString), '+'));
    }
  }
  return out.join('\n');
}

function pickDiff({ calls, gitText } = {}) {
  if (Array.isArray(calls) && calls.length) return { source: 'claude', text: renderCalls(calls) };
  if (typeof gitText === 'string' && gitText !== '') return { source: 'git', text: gitText };
  return { source: null, text: '' };
}

// ---- git ----

function gitDiffHead(root, rel, { execFile = childProcess.execFile } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('git', ['-C', root, '-c', 'core.quotePath=false', 'diff', 'HEAD', '--', rel],
        { encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const first = String(stderr || '').split(/\r?\n/).find(Boolean) || err.message || 'unknown error';
            resolve({ ok: false, error: `git diff failed: ${first}` });
            return;
          }
          const text = String(stdout || '');
          resolve({ ok: true, text: text.length > MAX_GIT_CHARS ? `${text.slice(0, MAX_GIT_CHARS)}\n… diff cut at ${MAX_GIT_CHARS / 1024} KB` : text });
        });
    } catch (err) {
      resolve({ ok: false, error: `git diff failed: ${err && err.message}` });
    }
  });
}

async function diffFor({ root, rel, projectsDir, execFile } = {}) {
  const found = await claudeCallsFor({ root, rel, projectsDir });
  if (found.calls.length) {
    const r = pickDiff({ calls: found.calls });
    return { ok: true, ...r, count: found.calls.length, ...(found.truncated ? { truncated: true } : {}) };
  }
  const git = await gitDiffHead(root, rel, execFile ? { execFile } : undefined);
  if (!git.ok) return { ok: false, error: git.error };
  return { ok: true, ...pickDiff({ calls: [], gitText: git.text }), count: 0 };
}

module.exports = { claudeCallsFor, renderCalls, pickDiff, gitDiffHead, diffFor, MAX_CALLS, MAX_WRITE_LINES, MAX_STRING, MAX_GIT_CHARS };
