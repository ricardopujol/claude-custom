'use strict';
/**
 * Runs agent-creator's worktree scripts (PR 3, worktree tabs) and turns each
 * run into one value. Contracts: agent-creator
 * designs/claude-custom-worktree-tabs.md
 *   A  new-worktree.ps1    -Project <container> -Branch <feat/x>
 *   C  remove-worktree.ps1 -Path <worktree>
 *   E  setup-worktree.ps1  -Path <worktree>
 * Nothing here decides WHEN to run one (host/tab-lifecycle.js and
 * app/tab-shell.js do); the parsers are pure and the effects are injected.
 *
 * THE RULES THAT COST SOMETHING (each has a test):
 *   - Completion is keyed on the process's `exit`, never `close` (Contract E):
 *     a command in the setup manifest can leave a background process holding
 *     setup's stdout open, so `close` may never come. Output written just
 *     before the exit can still be in the pipe, so `exit` waits up to
 *     STREAM_GRACE_MS for `close` and then settles with what has arrived.
 *   - A script is NEVER killed on a timeout. A killed remover can leave a
 *     half-removed folder; a killed creator, a worktree locked "initializing".
 *     The runner stops waiting and says the script may still finish.
 *   - Every argument is bound `-Name:value`. PowerShell's -File binding reads a
 *     value that starts with `-` as a parameter name otherwise.
 *   - A failure's text is the script's stderr WORD FOR WORD (criterion 2), on
 *     one line, minus a BOM and a CLIXML progress block.
 *   - stdout is decoded in the console code page by PowerShell 5.1, so a
 *     non-ASCII project path isn't supported here. A path the creator returns
 *     must be a sibling under the container, or the answer counts as unread.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { StringDecoder } = require('string_decoder');
const { POWERSHELL, BOM_AT_START } = require('./proc-start');
const { resolveWorktreeGitDir } = require('./git-branch');
const { isSibling } = require('./worktree-list');

const STREAM_GRACE_MS = 2000;
const SCRIPTS = Object.freeze({ create: 'new-worktree.ps1', setup: 'setup-worktree.ps1', remove: 'remove-worktree.ps1' });
const TIMEOUT_MS = Object.freeze({ create: 5 * 60 * 1000, remove: 10 * 60 * 1000, setup: 2 * 60 * 60 * 1000 });
const LOG_POLL_MS = 500;
const LINE_MAX = 200;
// Miguel Y1: a setup can run for hours. Each stream keeps only its TAIL (the
// answer is the last line), and the one line shown in the strip is capped.
const STREAM_KEEP = 64 * 1024;
const LINE_SHOWN_MAX = 600;
// Zero-width and bidi controls (U+200B-200F, 202A-202E, 2060-2069, FEFF).
// Built from code points, never typed: a literal one in source is invisible,
// and test/renderer-scope.test.js rejects it.
const INVISIBLE = new RegExp(`[${[[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]]
  .map(([a, z]) => `${String.fromCharCode(a)}-${String.fromCharCode(z)}`).join('')}]`);

const message = (err) => (err && err.message) || String(err);

function scriptsDir(env = process.env) {
  const own = env && env.CLAUDE_CUSTOM_WORKTREE_SCRIPTS;
  if (typeof own === 'string' && own !== '') return own;
  return path.join(os.homedir(), '.claude', 'skills', 'worktree', 'scripts');
}

function available(dir, exists = fs.existsSync) {
  const has = (name) => {
    try { return exists(path.join(dir, name)) === true; } catch { return false; }
  };
  return { create: has(SCRIPTS.create), setup: has(SCRIPTS.setup), remove: has(SCRIPTS.remove) };
}

const psArg = (name, value) => `-${name}:${value}`;

/**
 * Null when `branch` can be handed to Contract A, else why not. Only what can't
 * be passed SAFELY is refused here; the script owns the naming rules, so `demo`
 * passes and is refused by the script, word for word (criterion 2).
 */
function checkBranch(branch) {
  if (typeof branch !== 'string' || branch.trim() === '') return 'Type a branch name, like feat/my-change.';
  const b = branch.trim();
  if (b.startsWith('-')) return 'A branch name can\'t start with "-".';
  if (/\s/.test(b)) return 'A branch name can\'t contain spaces.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f"]/.test(b)) return 'A branch name can\'t contain quotes or control characters.';
  // Miguel G3: zero-width and bidi controls make a name read as something else.
  if (INVISIBLE.test(b)) return "A branch name can't contain invisible characters.";
  return null;
}

/** stderr as one line, word for word: no BOM, no CLIXML progress block. */
function cleanStderr(text) {
  if (typeof text !== 'string') return '';
  const line = text.replace(BOM_AT_START, '')
    .replace(/<Objs[\s\S]*?<\/Objs>/g, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('#< CLIXML'))
    .join(' ');
  return line.length > LINE_SHOWN_MAX ? `${line.slice(0, LINE_SHOWN_MAX - 1)}…` : line;
}

// Text from a stream, decoded across chunk boundaries, keeping only the tail.
function streamTail() {
  const decoder = new StringDecoder('utf8');
  let text = '';
  return {
    push(chunk) {
      text += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (text.length > STREAM_KEEP) text = text.slice(text.length - STREAM_KEEP);
    },
    get text() { return text; },
  };
}

/** The last stdout line that parses as a JSON object, or null. */
function jsonLine(stdout) {
  if (typeof stdout !== 'string') return null;
  const lines = stdout.replace(BOM_AT_START, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* not this line */ }
  }
  return null;
}

/**
 * Run one script. Resolves `{ code, stdout, stderr, timedOut, spawnError }` and
 * never rejects. `code` is null when the process hasn't exited (timeout), was
 * ended by a signal, or never started.
 */
function runScript({ script, args = [], timeoutMs, spawn = childProcess.spawn, graceMs = STREAM_GRACE_MS, exe = POWERSHELL } = {}) {
  return new Promise((resolve) => {
    const stdout = streamTail();
    const stderr = streamTail();
    let code = null;
    let exited = false;
    let settled = false;
    let timer = null;
    let grace = null;
    let child = null;

    const settle = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      // Stop holding the event loop for streams a background process may keep
      // open. Never destroyed: that would break that process's writes.
      for (const s of child ? [child.stdout, child.stderr] : []) {
        if (s && typeof s.unref === 'function') { try { s.unref(); } catch { /* fine */ } }
      }
      resolve({ code, stdout: stdout.text, stderr: stderr.text, timedOut: false, spawnError: null, ...extra });
    };

    try {
      child = spawn(exe, ['-NoProfile', '-NonInteractive', '-File', script, ...args], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return settle({ spawnError: message(err) });
    }

    if (child.stdout) child.stdout.on('data', (d) => stdout.push(d));
    if (child.stderr) child.stderr.on('data', (d) => stderr.push(d));
    child.on('error', (err) => settle({ spawnError: message(err) }));
    child.on('exit', (c) => {
      exited = true;
      code = Number.isInteger(c) ? c : null;
      grace = setTimeout(() => settle(), graceMs);
    });
    child.on('close', (c) => {
      if (!exited) code = Number.isInteger(c) ? c : null;
      settle();
    });
    timer = setTimeout(() => (exited ? settle() : settle({ timedOut: true })), timeoutMs);
  });
}

const exitText = (code) => (code === null ? 'no exit code' : `exit ${code}`);

// The texts every parser shares for the runs that never produced an answer.
function unrun(name, r) {
  if (r.spawnError) return `couldn't run ${name}: ${r.spawnError}`;
  if (r.timedOut) return null;   // each parser says what a timeout means for it
  return cleanStderr(r.stderr) || `${name} failed (${exitText(r.code)})`;
}

function parseCreate(run, container) {
  const r = run || {};
  // PR #80 Dexter F6: when the answer is lost, the worktree may still appear
  // as a tab, but nothing set it up. Say so, rather than start it silently bare.
  if (r.timedOut) {
    return {
      ok: false,
      error: `${SCRIPTS.create} didn't finish in time (it may still finish; a worktree it makes appears as a tab, ` +
        `but ${SCRIPTS.setup} did not run for it).`,
    };
  }
  if (r.spawnError || r.code !== 0) return { ok: false, error: unrun(SCRIPTS.create, r) };
  const j = jsonLine(r.stdout);
  if (j && typeof j.path === 'string' && isSibling(container, j.path) && typeof j.branch === 'string' && j.branch) {
    return { ok: true, path: j.path, branch: j.branch, warning: typeof j.warning === 'string' && j.warning ? j.warning : null };
  }
  const shown = String(r.stdout || '').replace(BOM_AT_START, '').trim().slice(0, 200);
  return {
    ok: false,
    error: `${SCRIPTS.create} finished, but its answer couldn't be read (${shown || 'no output'}). ` +
      `If the worktree was made, it appears as a tab, but ${SCRIPTS.setup} did not run for it.`,
  };
}

const LOG_IN_TEXT = /\((?:log: |output in )(.+?)\)\.?$/;

function parseSetup(run) {
  const r = run || {};
  if (r.timedOut) return { ok: false, error: `${SCRIPTS.setup} didn't finish in time (it may still be running).`, log: null };
  if (r.spawnError || r.code !== 0) {
    const error = unrun(SCRIPTS.setup, r);
    const m = LOG_IN_TEXT.exec(error);
    return { ok: false, error, log: m ? m[1] : null };
  }
  return { ok: true, result: jsonLine(r.stdout) };
}

function parseRemove(run) {
  const r = run || {};
  if (r.timedOut) {
    return { ok: false, error: `${SCRIPTS.remove} didn't finish in time; it may still be running, and the tab closes if it removes the folder.` };
  }
  if (!r.spawnError && r.code === 0) {
    return { ok: true, already: /^already removed:/m.test(String(r.stdout || '').replace(BOM_AT_START, '')) };
  }
  if (!r.spawnError && r.code === 2) {
    return { ok: false, kept: true, reason: cleanStderr(r.stderr) || 'kept: the branch still has a handoff brief' };
  }
  return { ok: false, error: unrun(SCRIPTS.remove, r) };
}

/** `<git-dir of the worktree>\claude-setup.log`, or null. */
function setupLogPath(worktree) {
  const gitDir = resolveWorktreeGitDir(path.join(worktree, '.git'));
  return gitDir ? path.join(gitDir, 'claude-setup.log') : null;
}

function lastLine(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, LINE_MAX) : null;
}

// --- the lane's brief (BACKLOG #119 A6) ------------------------------------------------------
// sync-docs' brief-path.ps1 prints where a worktree's handoff brief lives. It's the same script /handoff and
// /pickup use, so a brief written there is found by both. Not one of the three contract scripts: it isn't in SCRIPTS
// or `available()`, and a lane without it simply starts without a brief (the caller says so).
const BRIEF_SCRIPT = 'brief-path.ps1';

function syncDocsScriptsDir(env = process.env) {
  const own = env && env.CLAUDE_CUSTOM_SYNCDOCS_SCRIPTS;
  if (typeof own === 'string' && own !== '') return own;
  return path.join(os.homedir(), '.claude', 'skills', 'sync-docs', 'scripts');
}

/** `{ ok: true, path }` when the script's last line is an absolute .md path, else `{ ok: false, error }`. */
function parseBriefPath(run) {
  const r = run || {};
  if (r.timedOut) return { ok: false, error: `${BRIEF_SCRIPT} didn't finish in time (it may still be running).` };
  if (r.spawnError || r.code !== 0) return { ok: false, error: unrun(BRIEF_SCRIPT, r) };
  const lines = String(r.stdout || '').replace(BOM_AT_START, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  // eslint-disable-next-line no-control-regex
  if (last !== '' && path.isAbsolute(last) && /\.md$/i.test(last) && !/[\u0000-\u001f]/.test(last)) return { ok: true, path: last };
  return { ok: false, error: `${BRIEF_SCRIPT} finished, but its answer wasn't a brief path (${last.slice(0, 200) || 'no output'}).` };
}

function createOps({
  dir, spawn = childProcess.spawn, exists = fs.existsSync, pollMs = LOG_POLL_MS,
  logPath = setupLogPath, readFile = (p) => fs.readFileSync(p, 'utf8'),
  syncDir = syncDocsScriptsDir(),
} = {}) {
  const scriptPath = (k) => path.join(dir, SCRIPTS[k]);
  const missing = (k) => `${SCRIPTS[k]} isn't installed (looked in ${dir}).`;

  return {
    available: () => available(dir, exists),

    /** Where the handoff brief of `path`'s worktree goes: `{ ok, path }` | `{ ok: false, error }`. */
    async briefPath({ path: wt } = {}) {
      if (typeof wt !== 'string' || wt === '') return { ok: false, error: 'no worktree to find a brief for' };
      const script = path.join(syncDir, BRIEF_SCRIPT);
      let there = false;
      try { there = exists(script) === true; } catch { there = false; }
      if (!there) return { ok: false, error: `${BRIEF_SCRIPT} isn't installed (looked in ${syncDir}).` };
      const r = await runScript({ script, timeoutMs: TIMEOUT_MS.create, spawn, args: [psArg('Path', wt)] });
      return parseBriefPath(r);
    },

    async create({ container, branch } = {}) {
      const bad = checkBranch(branch);
      if (bad) return { ok: false, error: bad };
      if (!available(dir, exists).create) return { ok: false, error: missing('create') };
      const r = await runScript({
        script: scriptPath('create'), timeoutMs: TIMEOUT_MS.create, spawn,
        args: [psArg('Project', container), psArg('Branch', branch.trim())],
      });
      return parseCreate(r, container);
    },

    async remove({ path: wt } = {}) {
      if (!available(dir, exists).remove) return { ok: false, error: missing('remove') };
      const r = await runScript({ script: scriptPath('remove'), timeoutMs: TIMEOUT_MS.remove, spawn, args: [psArg('Path', wt)] });
      return parseRemove(r);
    },

    async setup({ path: wt, onLine = () => {} } = {}) {
      if (!available(dir, exists).setup) return { ok: false, error: missing('setup'), log: null };
      let shown = null;
      let poller = null;
      const tail = () => {
        let line = null;
        try {
          const p = logPath(wt);
          line = p ? lastLine(readFile(p)) : null;
        } catch { line = null; }       // not written yet, or unreadable: no progress
        if (line !== null && line !== shown) {
          shown = line;
          try { onLine(line); } catch { /* the caller's problem, not setup's */ }
        }
      };
      poller = setInterval(tail, pollMs);
      try {
        const r = await runScript({ script: scriptPath('setup'), timeoutMs: TIMEOUT_MS.setup, spawn, args: [psArg('Path', wt)] });
        return parseSetup(r);
      } finally {
        clearInterval(poller);
      }
    },
  };
}

module.exports = {
  scriptsDir, syncDocsScriptsDir, parseBriefPath, available, psArg, checkBranch, cleanStderr, runScript, parseCreate, parseSetup, parseRemove,
  setupLogPath, lastLine, createOps, STREAM_GRACE_MS, SCRIPTS, STREAM_KEEP, LINE_SHOWN_MAX,
};
