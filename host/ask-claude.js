'use strict';
/**
 * A Claude model (Haiku / Sonnet) as the "Ask the repo" answerer (BACKLOG #33, DESIGN_ASK_REPO.md Round 8).
 *
 *   createClaudeAnswerer({ spawn, claudeBin, env, cwd, timeoutMs, killFn, maxOutputBytes })
 *     .generate({ model: 'haiku' | 'sonnet', system, prompt })
 *       -> { ok: true, text }
 *        | { ok: false, reason: 'unknown-model' | 'empty-prompt' | 'claude-missing' | 'not-signed-in' | 'claude-failed' | 'timeout'
 *                              | 'bad-reply', detail? }
 *
 * THE FOUNDING BET: it drives the real `claude` CLI on the person's plan and never touches the API. So:
 *   - the child's environment is an ALLOW-LIST (PR #169 Dexter 1, 2, 7, Miguel Y1): only what a process needs to run and to find the person's own
 *     claude login (PATH, the profile and temp folders, CLAUDE_CONFIG_DIR, the plan's OAuth token). Everything else is dropped, so no
 *     ANTHROPIC_* (key, token, BASE_URL, custom headers, model remaps), no Bedrock / Vertex / Foundry switch, no AWS / GCP credential and no
 *     proxy can route the prompt anywhere but Anthropic on the plan, whatever the host's own environment holds. Names are matched without
 *     regard to case (Windows env names are case-insensitive: `anthropic_api_key` is the same variable). `--bare` is NOT used: it only
 *     authenticates with an API key.
 *   - it is read-only by what the CLI is given, not by what it is told: `--tools ""` (no built-in tool exists in it), `--strict-mcp-config`
 *     with no MCP config (no MCP server), `--no-session-persistence` (nothing saved), `--disable-slash-commands` (no skills),
 *     `--setting-sources ""` (no user, project or local settings, so none of their hooks, rules or CLAUDE.md memory is loaded).
 *     The excerpts the model needs are IN the prompt, so it has nothing to read.
 *   - it runs in an empty folder of its own, so no project memory file is found from the working directory either.
 *   - the prompt goes in on stdin (a long prompt would overrun the Windows command line); the answer is the CLI's own `--output-format json`.
 * Measured 2026-10-13 (claude 2.1.296): a "hi" costs ~690 input tokens and ~1.3 s on Haiku with these flags, which also shows no memory
 * file was loaded.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { killChildTree } = require('./kill-tree');

const CLAUDE_MODELS = Object.freeze({ haiku: 'haiku', sonnet: 'sonnet' });
// What the child may inherit, upper-cased. A name not listed here (and not LC_*) does not reach it.
const ENV_ALLOW = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'LOGNAME', 'USER', 'SHELL',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  // where the CLI keeps (or is told) the person's own login: the plan, not an API key
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN',
]);
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const DETAIL_CHARS = 300;
const SIGNED_OUT = /\/login|not logged in|invalid api key/i;

const usable = (n, fallback) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback);

/** The environment the child gets: only the allow-listed names of the caller's (any case), and only string values. */
function childEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    const up = String(k).toUpperCase();
    if (typeof v !== 'string' || !(ENV_ALLOW.includes(up) || up.startsWith('LC_'))) continue;
    out[k] = v;
  }
  return out;
}

function neutralCwd() {
  const dir = path.join(os.tmpdir(), 'claude-custom-ask-claude');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* spawn reports it */ }
  return dir;
}

const missingOrFailed = (e) => (e && e.code === 'ENOENT' ? { ok: false, reason: 'claude-missing' } : { ok: false, reason: 'claude-failed', detail: short((e && e.message) || e) });
const short = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, DETAIL_CHARS);

function createClaudeAnswerer({
  spawn = childProcess.spawn, claudeBin = 'claude', env = process.env, cwd, timeoutMs, killFn = killChildTree, maxOutputBytes,
} = {}) {
  const deadline = usable(timeoutMs, TIMEOUT_MS);
  const cap = usable(maxOutputBytes, MAX_OUTPUT_BYTES);

  function generate({ model, system, prompt } = {}) {
    if (!Object.prototype.hasOwnProperty.call(CLAUDE_MODELS, model)) return Promise.resolve({ ok: false, reason: 'unknown-model', model });
    if (typeof prompt !== 'string' || !prompt.trim()) return Promise.resolve({ ok: false, reason: 'empty-prompt' });
    const args = [
      '-p', '--model', CLAUDE_MODELS[model], '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--disable-slash-commands', '--setting-sources', '', '--output-format', 'json',
      ...(typeof system === 'string' && system ? ['--system-prompt', system] : []),
    ];
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let child = null;
      const settle = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      try {
        child = spawn(claudeBin, args, { cwd: cwd || neutralCwd(), env: childEnv(env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        settle(missingOrFailed(err));
        return;
      }
      let out = '';
      let err = '';
      let outBytes = 0;
      let overflow = false;
      child.stdout.on('data', (d) => {
        outBytes += d.length;
        if (outBytes > cap) {
          // a runaway child is ended now, not at the deadline
          if (!overflow) { overflow = true; settle({ ok: false, reason: 'bad-reply' }); try { killFn(child); } catch { /* it ends on its own */ } }
          return;
        }
        out += d.toString('utf8');
      });
      child.stderr.on('data', (d) => { if (err.length < 4000) err += d.toString('utf8'); });
      child.on('error', (e) => {
        settle(missingOrFailed(e));
      });
      child.on('close', (code) => {
        if (settled) return;
        if (overflow) { settle({ ok: false, reason: 'bad-reply' }); return; }
        let j = null;
        try { j = JSON.parse(out); } catch { j = null; }
        const isObj = j !== null && typeof j === 'object' && !Array.isArray(j);
        if (isObj && j.is_error === true) {
          const words = typeof j.result === 'string' ? j.result : '';
          const signedOut = j.api_error_status === 401 || SIGNED_OUT.test(words);
          settle(signedOut ? { ok: false, reason: 'not-signed-in', detail: short(words) } : { ok: false, reason: 'claude-failed', detail: short(words || err) });
          return;
        }
        if (code !== 0) {
          // a logged-out CLI may say so on stderr with no JSON at all (PR #169 Dexter 6)
          const words = err || out;
          settle(SIGNED_OUT.test(words) ? { ok: false, reason: 'not-signed-in', detail: short(words) } : { ok: false, reason: 'claude-failed', detail: short(words) });
          return;
        }
        const text = isObj && typeof j.result === 'string' ? j.result.trim() : '';
        settle(text ? { ok: true, text } : { ok: false, reason: 'bad-reply' });
      });
      timer = setTimeout(() => {
        settle({ ok: false, reason: 'timeout' });
        try { killFn(child); } catch { /* it ends on its own, or the machine is shutting down */ }
      }, deadline);
      try {
        child.stdin.on('error', () => {});
        child.stdin.write(prompt);
        child.stdin.end();
      } catch { /* close or error reports it */ }
    });
  }

  return { generate };
}

module.exports = { createClaudeAnswerer, CLAUDE_MODELS, ENV_ALLOW, childEnv };
