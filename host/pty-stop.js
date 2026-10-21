'use strict';
/**
 * Ending the session's pty (PR #201 Miguel R1). node-pty's own kill() does two different things: on the OS's ConPTY it walks the
 * console's process list and kills every one, so a Bash-tool tree or an MCP server under `claude` dies with the session; with
 * `useConptyDll` (the bundled ConPTY) it only closes the pseudoconsole and never touches that list. Whether the children then die
 * depends on OpenConsole delivering a close to each of them. So the tree is killed by pid through host/kill-tree.js (the one
 * sanctioned path, proven by start time and only once), and kill() is the polite second step either way.
 */
function stopPty(term, { killChildTree } = {}) {
  if (!term) return;
  try { if (typeof killChildTree === 'function') killChildTree(term); } catch { /* the pty's own kill below still runs */ }
  try { term.kill(); } catch { /* already gone */ }
}

module.exports = { stopPty };
