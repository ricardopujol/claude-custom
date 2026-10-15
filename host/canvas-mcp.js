'use strict';
/**
 * The MCP server claude-custom injects into every tab's `claude` with `--mcp-config` (BACKLOG #71, DESIGN_LIVE_PANEL.md call 3).
 * It is how the running Claude learns Claude's panel exists and how it fills it, and it adds NOTHING to the CLI: `--mcp-config`
 * is a documented flag that ADDS to the user's own servers (never `--strict-mcp-config`), and the CLI writes no config file for
 * it (measured: verify/probe71/probe-mcp-config.js, verify/probe-canvas-mcp.js).
 *
 * Two tools:
 *   canvas_render(html)         write the page the host watches (<state>/canvas/<session-id>/index.html), atomically
 *   canvas_list_artifacts()     read the shelf the host keeps (host/canvas-shelf.js); read-only
 * A third, `canvas_add_button`, was considered and left out: a button is one line of HTML that calls `claudePanel.send(...)`,
 * which the render tool's description teaches; a tool would add always-on context for nothing.
 *
 * Each tool's description says the panel changes only when the user asks (design call 3). The descriptions are the contract the
 * running Claude reads, so they are the one place the page's API is written down: keep them true (test/canvas-mcp.test.js holds
 * them to the words), and short (they ride in every request of every session this is injected into).
 *
 * THE SESSION. The CLI's session id does not exist when this process is spawned, so the host keeps a POINTER FILE with it
 * (host/canvas-control.js: <state>/canvas/_tab-<port>.json) and this server re-reads it on every call, so `/clear` and
 * `--resume` follow. Env: CLAUDE_CUSTOM_CANVAS_ROOT (the state dir) and CLAUDE_CUSTOM_CANVAS_POINTER. With neither, every call is
 * an error answer, never a throw, and nothing is written. The id is checked before it becomes a path (host/canvas-store.js).
 *
 * Stdio, newline-delimited JSON-RPC 2.0, as the CLI speaks to MCP servers.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { panelDir, MAX_HTML_BYTES } = require('./canvas-store');
const { readShelf } = require('./canvas-shelf');
const { writeFileAtomic } = require('./atomic-write');

const RENDER_DESCRIPTION = [
  'Replace the page in the user\'s "Claude\'s panel", a side panel in claude-custom\'s window. Do this ONLY when the user asks you to build or change something in that panel; never change it on your own.',
  '`html` is one complete HTML page: inline CSS and JavaScript, at most 1 MB, no external files (images as data: URIs).',
  'The page runs in a sandbox: no access to the user\'s files, other tabs, clipboard or cookies, and timers run only while the panel is visible. What it can do:',
  '- `fetch(url, { method, headers, body })` (string bodies) to a website. The user is asked to allow each new host the first time, per panel; nothing else reaches the network (no XHR, WebSocket, EventSource, external scripts or images). No secrets: only keyless APIs.',
  '- `claudePanel.send(text)`: types ONE line into the user\'s prompt as "(from Claude\'s panel) <text>". It only works from a click handler on a real click (or an Enter or Space press on a focused button), so build a button that calls it.',
  '- `claudePanel.shelf()` (a Promise of [{ title, url, time }], the artifacts published in this session, newest first), `claudePanel.onShelf(fn)` for updates, and `claudePanel.open(url)` to open one of those addresses in the browser (on a click).',
  'Calling this again replaces the whole page. Keep the page small and self-contained.',
].join('\n');

const TOOLS = Object.freeze([
  {
    name: 'canvas_render',
    description: RENDER_DESCRIPTION,
    inputSchema: { type: 'object', properties: { html: { type: 'string', description: 'The complete HTML page.' } }, required: ['html'], additionalProperties: false },
  },
  {
    name: 'canvas_list_artifacts',
    description: 'List the artifacts published in this session (newest first) as title, address and time. Read-only. The panel\'s shelf shows the same list and is filled automatically: you cannot add to it. Use it only to answer the user, or to build a page in the panel when the user asks.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]);

const INSTRUCTIONS = 'claude-custom has a side panel, "Claude\'s panel", that shows a page you write with canvas_render. Change it only when the user asks you to; it is theirs. canvas_list_artifacts reads the artifacts published in this session.';

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

function createCanvasMcp({ root, pointerFile } = {}) {
  function sessionDir() {
    if (!root || !pointerFile) return null;
    try {
      const id = JSON.parse(fs.readFileSync(pointerFile, 'utf8')).sessionId;
      return panelDir(root, id);
    } catch { return null; }
  }

  function render(args) {
    const html = args && typeof args === 'object' ? args.html : undefined;
    if (typeof html !== 'string') return fail('canvas_render needs `html`: the complete page, as a string.');
    const bytes = Buffer.byteLength(html);
    if (bytes > MAX_HTML_BYTES) return fail(`The page is too big (${bytes} bytes, the limit is ${MAX_HTML_BYTES}). Make it smaller: inline only what it needs.`);
    const dir = sessionDir();
    if (!dir) return fail('The panel is not ready yet (no session). Try again in a moment.');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'index.html');
      writeFileAtomic(file, html);
    } catch (err) { return fail(`Could not write the panel: ${err && err.message ? err.message : 'unknown error'}`); }
    return ok(`Rendered ${bytes} bytes into the user's Claude's panel. It shows when the panel is open; the user was not notified.`);
  }

  function list() {
    const dir = sessionDir();
    const shelf = dir ? readShelf(dir) : [];
    if (!shelf.length) return ok('The shelf is empty: no artifacts have been published in this session yet.');
    return ok(shelf.map((i) => `${i.title} - ${i.url} (${i.time})`).join('\n'));
  }

  function call(params) {
    const name = params && typeof params === 'object' ? params.name : undefined;
    if (name === 'canvas_render') return render(params.arguments);
    if (name === 'canvas_list_artifacts') return list();
    return fail(`Unknown tool: ${String(name).slice(0, 80)}`);
  }

  /** One JSON-RPC message in, its answer out (null for a notification or junk). */
  function handle(msg) {
    if (msg === null || typeof msg !== 'object' || typeof msg.method !== 'string') return null;
    const id = msg.id;
    if (id === undefined || id === null) return null;            // a notification (notifications/initialized, ...): no answer
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05';
        return reply({ protocolVersion: asked, capabilities: { tools: {} }, serverInfo: { name: 'claude-custom-canvas', version: '1.0.0' }, instructions: INSTRUCTIONS });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': return reply(call(msg.params));
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method.slice(0, 80)}` } };
    }
  }

  return { handle };
}

function run() {
  const mcp = createCanvasMcp({ root: process.env.CLAUDE_CUSTOM_CANVAS_ROOT, pointerFile: process.env.CLAUDE_CUSTOM_CANVAS_POINTER });
  // The CLI may exit before we have written our last answer: that EPIPE is the end of the conversation, not an uncaught exception in its MCP log.
  process.stdout.on('error', () => process.exit(0));
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    let answer = null;
    try { answer = mcp.handle(msg); } catch { answer = msg && msg.id !== undefined ? { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'internal error' } } : null; }
    if (answer) process.stdout.write(JSON.stringify(answer) + '\n');
  });
}

if (require.main === module) run();

module.exports = { createCanvasMcp, TOOLS, INSTRUCTIONS };
