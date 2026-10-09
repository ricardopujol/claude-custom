'use strict';
/**
 * Whether Claude's panel's MCP server is injected into `claude` (BACKLOG #71, DESIGN_LIVE_PANEL.md call 3: "A setting turns the
 * injection off, and #62's lean mode will turn it off too"). Read once, when the host builds `claude`'s arguments, so a change
 * takes effect on the next session, as every spawn flag does.
 *
 * Off when CLAUDE_CUSTOM_CANVAS_MCP is 0 / off / false / no, or <state>/canvas-settings.json says { "mcp": false }, or the binary is
 * overridden (CLAUDE_CUSTOM_BIN) and CLAUDE_CUSTOM_CANVAS_MCP does not say 1 / on / true / yes. Anything
 * unreadable or unknown means ON: the default is the feature, and a corrupt file must not silently remove it.
 *
 * The switch is a checkbox in the Style tab (Ricardo, 2026-10-06, #71 question 8: the recommendation); it writes the same file with
 * writeMcpSetting and reads it back with readMcpSetting. The environment still wins in the "off" direction and says so nowhere in the
 * window: the checkbox shows the file's own choice.
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const OFF_WORDS = new Set(['0', 'off', 'false', 'no']);
const ON_WORDS = new Set(['1', 'on', 'true', 'yes']);

function canvasMcpEnabled({ env = process.env, stateDir } = {}) {
  const v = env && env.CLAUDE_CUSTOM_CANVAS_MCP;
  const word = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (OFF_WORDS.has(word)) return false;
  // A binary override (CLAUDE_CUSTOM_BIN) is a stand-in or a custom build, not assumed to understand --mcp-config: verify/ probes run
  // cmd.exe as a fake CLI, which takes the flag's JSON for a command line, prints errors and exits. Ask for it with =1.
  if (env && typeof env.CLAUDE_CUSTOM_BIN === 'string' && env.CLAUDE_CUSTOM_BIN !== '' && !ON_WORDS.has(word)) return false;
  if (typeof stateDir === 'string' && stateDir) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'canvas-settings.json'), 'utf8'));
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && raw.mcp === false) return false;
    } catch { /* missing or corrupt: on */ }
  }
  return true;
}

/**
 * The file's own choice, for the checkbox: false only for { "mcp": false }; true when there is no file or it is not a settings object
 * (the same reading canvasMcpEnabled gives it); null when the file can't be read for any other reason (busy, no permission): unknown,
 * never a guessed answer.
 */
function readMcpSetting(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'canvas-settings.json'), 'utf8'));
    return !(raw !== null && typeof raw === 'object' && !Array.isArray(raw) && raw.mcp === false);
  } catch (err) {
    return err && (err.code === 'ENOENT' || err instanceof SyntaxError) ? true : null;
  }
}

/** Turn the injection on or off in the file, keeping any other key. Atomic. Returns the value written, or null when nothing was (a non-boolean, or a failed write). */
function writeMcpSetting(stateDir, on) {
  if (typeof on !== 'boolean' || typeof stateDir !== 'string' || !stateDir) return null;
  const file = path.join(stateDir, 'canvas-settings.json');
  try {
    let rec = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) rec = raw;
    } catch { /* missing or corrupt: start again from nothing */ }
    fs.mkdirSync(stateDir, { recursive: true });
    writeFileAtomic(file, JSON.stringify({ ...rec, mcp: on }, null, 2));
    return on;
  } catch { return null; }
}

module.exports = { canvasMcpEnabled, readMcpSetting, writeMcpSetting };
