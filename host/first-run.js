'use strict';
/**
 * First-run checks: is this machine ready to run claude-custom?
 *
 * Four checks, each answering one question a new user can't otherwise see:
 *
 *   claude   the `claude` CLI answers `--version`, at or above the version this was built against
 *   helper   .harness/hook-helper.exe exists and starts (without it hooks are off and agents never go Active)
 *   signin   the CLI has a login: the Claude login entry in the credentials file (only its presence is looked at), or a credential in the session's environment
 *   ollama   a local Ollama answers (optional: only the local-model features want it)
 *
 * Every check is pure over what it's handed (a runner, an exists(), a probe), so the unit tests spawn nothing; the spawning wrappers
 * (execOnce, ollamaProbe) take their exec/fetch as arguments, and test/first-run-spawn.test.js runs them against real processes.
 * ABSENCE IS NEVER OK: a missing runner, a throw, an unreadable answer and an empty value all come out as `fail`
 * for a required check and `info` for the optional one. Nothing here ever shows as ok without having seen it work.
 *
 * Result shape: { id, label, required, status: 'ok' | 'fail' | 'info', detail, fix }.
 * `summarize` turns the list into what the window shows: every row for Diagnostics, and at most ONE banner line (the
 * first failing required check's fix). Never a modal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// The CLI this was built and probed against is 2.1.x (verify/ probes print the version they ran on). Older ones are untested,
// not known broken, so the line says "untested".
const MIN_CLAUDE_VERSION = '2.1.0';
const CLAUDE_TIMEOUT_MS = 8000;
const HELPER_TIMEOUT_MS = 5000;

const isStr = (s) => typeof s === 'string';
const nonEmpty = (s) => isStr(s) && s.trim() !== '';

/**
 * The version on the line that names Claude Code, else on the last line that has one. The LAST x.y.z on that line, so a wrapper's
 * "Using node 22.11.0" line, or a path with digits before it, never stands in for the CLI's own number.
 * A prerelease suffix (2.1.0-beta.3) is read as a prerelease: see isPrerelease.
 */
function versionLine(text) {
  if (!isStr(text)) return null;
  const lines = text.split(/\r?\n/).filter(l => /\d+\.\d+\.\d+/.test(l));
  return lines.find(l => /claude code/i.test(l)) || lines[lines.length - 1] || null;
}

function lastVersionMatch(text) {
  const line = versionLine(text);
  if (line === null) return null;
  const all = [...line.matchAll(/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/g)];
  return all.length ? all[all.length - 1] : null;
}

function parseVersion(text) {
  const m = lastVersionMatch(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 2.1.0-beta.3 sorts BELOW 2.1.0 (semver), so a prerelease of the floor fails the floor. */
function isPrerelease(text) {
  const m = lastVersionMatch(text);
  return !!(m && m[4]);
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

const result = (id, label, required, status, detail, fix = null) => ({ id, label, required, status, detail, fix });

async function checkClaude({ run } = {}) {
  const label = 'Claude Code CLI';
  const install = 'Claude Code isn\'t installed: run `npm install -g @anthropic-ai/claude-code`';
  if (typeof run !== 'function') return result('claude', label, true, 'fail', 'not checked: no way to run it', install);
  let r;
  try { r = await run(); } catch (err) { r = { ok: false, error: err && err.message }; }
  if (r && r.timedOut === true) {
    // Not "isn't installed": a cold start of a big exe under a virus scanner can be slow. Say what happened.
    return result('claude', label, true, 'fail', `\`claude --version\` didn't answer in ${CLAUDE_TIMEOUT_MS / 1000} s`,
      `Claude Code didn't answer \`claude --version\` in ${CLAUDE_TIMEOUT_MS / 1000} s: run it in a terminal to see why`);
  }
  if (!r || r.ok !== true) {
    return result('claude', label, true, 'fail', `\`claude --version\` failed${r && r.error ? ` (${r.error})` : ''}`, install);
  }
  const v = parseVersion(r.stdout);
  if (!v) return result('claude', label, true, 'fail', 'its version output wasn\'t readable', install);
  const pre = isPrerelease(r.stdout);
  const shown = v.join('.') + (pre ? ' (prerelease)' : '');
  const cmp = compareVersions(v, parseVersion(MIN_CLAUDE_VERSION));
  if (cmp < 0 || (cmp === 0 && pre)) {
    return result('claude', label, true, 'fail', `${shown}, older than ${MIN_CLAUDE_VERSION} (untested)`,
      `Claude Code ${shown} is older than ${MIN_CLAUDE_VERSION} (untested): run \`claude update\``);
  }
  return result('claude', label, true, 'ok', shown);
}

async function checkHelper({ helperPath, exists, run, packaged = false } = {}) {
  const label = 'Hook helper';
  // An installed build has no checkout to build in: the fix there is the installer, not `npm run build:helper`.
  const fix = packaged ? 'Hooks are off: the hook helper is missing or damaged, so reinstall claude-custom'
    : 'Hooks are off: run `npm run build:helper`';
  if (!nonEmpty(helperPath)) return result('helper', label, true, 'fail', 'no helper path known', fix);
  let there = false;
  try { there = typeof exists === 'function' && exists(helperPath) === true; } catch { there = false; }
  if (!there) return result('helper', label, true, 'fail', `not found at ${helperPath}`, fix);
  if (typeof run !== 'function') return result('helper', label, true, 'fail', 'found, but not run', fix);
  let r;
  try { r = await run(); } catch (err) { r = { ok: false, error: err && err.message }; }
  if (r && r.timedOut === true) return result('helper', label, true, 'fail', `found, but it didn't finish in ${HELPER_TIMEOUT_MS / 1000} s`, fix);
  if (!r || r.ok !== true) {
    return result('helper', label, true, 'fail', `found, but it won't start${r && r.error ? ` (${r.error})` : ''}`, fix);
  }
  return result('helper', label, true, 'ok', helperPath);
}

// What the CLI honours instead of its own login file, in the environment the SESSION gets (the pty's, not the host's): an API key,
// an auth token (which the OpenRouter provider sets), a long-lived OAuth token, or a cloud provider switch. Names only: no value is ever
// kept, logged or shown.
const AUTH_ENV = [
  ['ANTHROPIC_API_KEY', 'an API key'],
  ['ANTHROPIC_AUTH_TOKEN', 'an auth token'],
  ['CLAUDE_CODE_OAUTH_TOKEN', 'an OAuth token'],
];
const CLOUD_ENV = [['CLAUDE_CODE_USE_BEDROCK', 'Amazon Bedrock'], ['CLAUDE_CODE_USE_VERTEX', 'Google Vertex AI']];
const switchedOn = (v) => isStr(v) && /^(1|true|yes)$/i.test(v.trim());

function checkSignedIn({ configDir, env, exists, readJson } = {}) {
  const label = 'Claude Code signed in';
  const fix = 'Claude Code isn\'t signed in: run `claude` once in a terminal and log in';
  const e = env && typeof env === 'object' ? env : {};
  for (const [name, what] of AUTH_ENV) {
    if (nonEmpty(e[name])) return result('signin', label, true, 'ok', `signed in via ${what} in the session's environment`);
  }
  for (const [name, what] of CLOUD_ENV) {
    if (switchedOn(e[name])) return result('signin', label, true, 'ok', `signed in via ${what} (set in the session's environment)`);
  }
  if (!nonEmpty(configDir)) return result('signin', label, true, 'fail', "the CLI's config folder isn't known", fix);
  const file = path.join(configDir, '.credentials.json');
  let there = false;
  try { there = typeof exists === 'function' && exists(file) === true; } catch { there = false; }
  if (!there) return result('signin', label, true, 'fail', `no credentials in ${configDir}`, fix);
  // A file that exists can still hold no login (empty, or only MCP server tokens, as after a logout). Only the PRESENCE of the
  // Claude login entry is looked at (host/quota.js reads the same key); the token itself is neither kept nor shown.
  let doc = null;
  try { doc = typeof readJson === 'function' ? readJson(file) : null; } catch { doc = null; }
  const login = doc && typeof doc === 'object' ? doc.claudeAiOauth : null;
  return login && typeof login === 'object'
    ? result('signin', label, true, 'ok', `signed in via a Claude login (${configDir})`)
    : result('signin', label, true, 'fail', `${file} has no Claude login in it`, fix);
}

async function checkOllama({ probe } = {}) {
  const label = 'Ollama (optional)';
  const none = 'not reachable; only the local-model features need it';
  if (typeof probe !== 'function') return result('ollama', label, false, 'info', none);
  let r;
  try { r = await probe(); } catch { r = null; }
  return r && r.ok === true
    ? result('ollama', label, false, 'ok', 'reachable')
    : result('ollama', label, false, 'info', none);
}

/** All four, in a fixed order. One check throwing can't take the others down. */
async function runChecks(deps = {}) {
  const guard = async (id, label, required, fn) => {
    try { return await fn(); } catch (err) {
      return result(id, label, required, required ? 'fail' : 'info', `check failed: ${err && err.message}`);
    }
  };
  return [
    await guard('claude', 'Claude Code CLI', true, () => checkClaude({ run: deps.run })),
    await guard('helper', 'Hook helper', true, () => checkHelper({ helperPath: deps.helperPath, exists: deps.exists, run: deps.runHelper || deps.run, packaged: deps.packaged === true })),
    await guard('signin', 'Claude Code signed in', true, () => checkSignedIn({ configDir: deps.configDir, env: deps.env, exists: deps.exists, readJson: deps.readJson })),
    await guard('ollama', 'Ollama (optional)', false, () => checkOllama({ probe: deps.probe })),
  ];
}

function summarize(results) {
  const checks = Array.isArray(results) ? results : [];
  const bad = checks.find(c => c && c.required === true && c.status !== 'ok');
  return { checks, banner: bad ? (bad.fix || `${bad.label}: ${bad.detail}`) : null };
}

// --- the real world (kept out of the checks above so they stay testable) -------------------------------------------------

// A .cmd or .bat wrapper (CLAUDE_CUSTOM_BIN may be one) is refused by execFile without a shell, while the pty's CreateProcess runs it:
// so a wrapper goes through the shell, quoted, and everything else stays a direct spawn with fixed argv.
const isScript = (file) => /\.(cmd|bat)$/i.test(file);

// cwd is the temp folder, never the checkout or the project: a stand-in CLI (a probe's cmd.exe) reads `--version` as a folder name and
// MAKES `--version` and `.exe` folders in whatever its cwd is (found as two empty folders in a worktree root).
function execOnce(file, args, timeoutMs, env, exec = execFile) {
  return new Promise((resolve) => {
    try {
      const script = isScript(file);
      const target = script ? `"${file}"` : file;
      exec(target, args, { timeout: timeoutMs, windowsHide: true, env, shell: script, cwd: os.tmpdir() }, (err, stdout) => {
        if (!err) return resolve({ ok: true, stdout: String(stdout || '') });
        // a timeout kills the child: `killed` is true and there is no exit code
        resolve({ ok: false, timedOut: err.killed === true, error: err.code || err.message });
      });
    } catch (err) {
      resolve({ ok: false, error: err && err.message });
    }
  });
}

async function ollamaProbe(baseUrl, timeoutMs = 1500, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return { ok: false };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(String(baseUrl).replace(/\/+$/, '') + '/api/tags', { signal: ctl.signal });
    return { ok: res.ok === true };
  } catch { return { ok: false }; } finally { clearTimeout(timer); }
}

/** The deps `runChecks` wants, wired to this machine. `claudeBin`, `helperPath` and `env` (the PTY's, what the session really gets) come from host.js. */
function realDeps({ claudeBin, helperPath, configDir, env = process.env, ollamaUrl = 'http://127.0.0.1:11434', packaged = false }) {
  return {
    packaged,
    run: () => execOnce(claudeBin, ['--version'], CLAUDE_TIMEOUT_MS, env),
    // No arguments: the helper returns 0 at once when it has no --pipe/--event, without touching stdin.
    runHelper: () => execOnce(helperPath, [], HELPER_TIMEOUT_MS, env),
    helperPath,
    exists: (p) => fs.existsSync(p),
    readJson: (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } },
    configDir,
    env,
    probe: () => ollamaProbe(ollamaUrl),
  };
}

module.exports = {
  MIN_CLAUDE_VERSION, CLAUDE_TIMEOUT_MS, HELPER_TIMEOUT_MS, parseVersion, isPrerelease, compareVersions, execOnce,
  checkClaude, checkHelper, checkSignedIn, checkOllama, runChecks, summarize, realDeps, ollamaProbe,
};
