'use strict';
/**
 * Whether the claude-custom mod (mods/claude-custom) is loaded into `claude` (BACKLOG #119 A2). Read once, when the host builds
 * `claude`'s arguments, so a change takes effect on the next session, as every spawn flag does. The pattern is
 * host/canvas-settings.js, the switch for Claude's panel.
 *
 * THREE GATES:
 *   1. The switch. Off when CLAUDE_CUSTOM_MOD is 0 / off / false / no, or <state>/cc-mod-settings.json says { "mod": false }. A
 *      binary override (CLAUDE_CUSTOM_BIN) is a stand-in that may not understand --plugin-dir, so it is off unless CLAUDE_CUSTOM_MOD
 *      says 1 / on / true / yes. Anything unreadable or unknown means ON: the default is the feature, and a corrupt file must not
 *      silently remove it. The Style tab's checkbox writes the same file.
 *   2. The CLI. Mods exist from 2.1.287, and the mod uses tool.check's agentId (2.1.290) and the waiting/idle agent statuses
 *      (2.1.289), so 2.1.290 is the floor. An older CLI, or one whose version cannot be read, gets no flag.
 *   3. The directory must exist.
 * The mod is a CLI flag (--plugin-dir), so nothing is written to the user's own config: the founding bet holds.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { writeFileAtomic } = require('./atomic-write');

const OFF_WORDS = new Set(['0', 'off', 'false', 'no']);
const ON_WORDS = new Set(['1', 'on', 'true', 'yes']);
const MIN_CLI_VERSION = Object.freeze([2, 1, 290]);
const FILE = 'cc-mod-settings.json';

const wordOf = (env) => {
  const v = env && env.CLAUDE_CUSTOM_MOD;
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
};

function modEnabled({ env = process.env, stateDir } = {}) {
  const word = wordOf(env);
  if (OFF_WORDS.has(word)) return false;
  if (env && typeof env.CLAUDE_CUSTOM_BIN === 'string' && env.CLAUDE_CUSTOM_BIN !== '' && !ON_WORDS.has(word)) return false;
  if (typeof stateDir === 'string' && stateDir) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), 'utf8'));
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && raw.mod === false) return false;
    } catch { /* missing or corrupt: on */ }
  }
  return true;
}

/** The file's own choice, for the checkbox: false only for { "mod": false }; true when there is none or it is not a settings object; null when it cannot be read for any other reason. */
function readModSetting(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), 'utf8'));
    return !(raw !== null && typeof raw === 'object' && !Array.isArray(raw) && raw.mod === false);
  } catch (err) {
    return err && (err.code === 'ENOENT' || err instanceof SyntaxError) ? true : null;
  }
}

/** Turn the mod on or off in the file, keeping any other key. Atomic. The value written, or null when nothing was (a non-boolean, or a failed write). */
function writeModSetting(stateDir, on) {
  if (typeof on !== 'boolean' || typeof stateDir !== 'string' || !stateDir) return null;
  const file = path.join(stateDir, FILE);
  try {
    let rec = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) rec = raw;
    } catch { /* missing or corrupt: start again from nothing */ }
    fs.mkdirSync(stateDir, { recursive: true });
    writeFileAtomic(file, JSON.stringify({ ...rec, mod: on }, null, 2));
    return on;
  } catch { return null; }
}

/** `[major, minor, patch]` from the first x.y.z in the text, or null. */
function parseCliVersion(text) {
  if (typeof text !== 'string') return null;
  const m = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z][0-9A-Za-z.-]*)?/.exec(text);
  if (!m) return null;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4]) v.pre = true;          // a prerelease (2.1.290-beta.1) precedes its release
  return v;
}

function versionAtLeast(version, min) {
  if (!Array.isArray(version) || version.length !== 3 || !version.every(Number.isInteger)) return false;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== min[i]) return version[i] > min[i];
  }
  return version.pre !== true;      // equal numbers: a prerelease of the floor is below it
}

/**
 * The directory to hand to `--plugin-dir`, or null for no flag. `forced` is the =1 on a stand-in binary: its version cannot be
 * known, so the check is skipped, but the switch and the directory still apply.
 */
function modPluginDirFor({ enabled, version, dir, exists = fs.existsSync, forced = false } = {}) {
  if (enabled !== true || typeof dir !== 'string' || !dir) return null;
  if (forced !== true && !versionAtLeast(version, MIN_CLI_VERSION)) return null;
  try { return exists(dir) ? dir : null; } catch { return null; }
}

/** Ask a binary for its version: `[major, minor, patch]` or null (missing, slow, or not a version). Never throws. */
function readCliVersion(bin, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(bin, ['--version'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : parseCliVersion(String(stdout)));
      });
    } catch { resolve(null); }
  });
}

module.exports = {
  modEnabled, readModSetting, writeModSetting, parseCliVersion, versionAtLeast, modPluginDirFor, readCliVersion,
  MIN_CLI_VERSION,
};
