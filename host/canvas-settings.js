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
 * There is no switch for it in the window yet: where that goes is a design question (documentation/handoffs).
 */
const fs = require('fs');
const path = require('path');

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

module.exports = { canvasMcpEnabled };
